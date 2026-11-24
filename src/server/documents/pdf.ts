import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/**
 * Supplier PDF validation (doc 22 §23 B4, F13, TKT-3).
 *
 * A supplier PDF is stored and served only when every check passes:
 *
 *  - not empty and at most `maxBytes` (`too_large`);
 *  - `%PDF-` at offset 0 (`bad_magic`): no leading junk, no HTML error page,
 *    no polyglot with another format in front;
 *  - `%%EOF` within the last 1024 bytes (`no_eof`), the window readers use, so
 *    a truncated download is refused;
 *  - the file tokenises cleanly (`malformed`): literal strings `( … )` with
 *    their escapes and nesting, hex strings `< … >`, comments, balanced
 *    dictionaries and arrays, and a `stream` keyword only right after the
 *    dictionary that is the value of an `N G obj`, with its `endstream`;
 *  - not encrypted (`encrypted`): encrypted objects cannot be inspected;
 *  - no active content (`active_content`): any of the names in
 *    `ACTIVE_CONTENT_NAMES`, also when spelt with `#xx` escapes
 *    (`/J#61vaScript`). Every name token outside stream bodies is checked,
 *    and so are the raw contents of literal strings and comments. Object
 *    streams (`/Type /ObjStm`, or any stream with `/N` and `/First`, which is
 *    all a reader needs) are decoded and checked whole, because a dictionary
 *    can hide behind FlateDecode. An object stream that cannot be decoded is
 *    refused (`unsupported_object_stream`, `unreadable_object_stream`), as is
 *    one that inflates past the limit (`inflate_limit`);
 *  - no object syntax where the tokeniser does not look (`hidden_object`): an
 *    `obj` or `xref` keyword inside a literal string, a comment or a raw
 *    stream body. A reader follows cross-reference offsets, which can point
 *    anywhere in the file, so an object placed there would otherwise be read
 *    by the viewer and never seen here.
 *
 * This is a deny-list check, not a sanitiser: it refuses, it never rewrites.
 * It fails closed: anything it cannot parse without doubt is refused, and a
 * harmless PDF that happens to contain one of the names (for example in a
 * document-info string) is quarantined too; staff then see the reason code. A
 * document that fails is quarantined and never served.
 */

export const ACTIVE_CONTENT_NAMES: ReadonlySet<string> = new Set([
  "JavaScript",
  "JS",
  "OpenAction",
  "AA",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
  "XFA",
  "SubmitForm",
  "ImportData",
  // Embedded files reachable without /Type /EmbeddedFile (a FileAttachment
  // annotation's /EF), and actions that open other files or media (R-B4 recheck).
  "EF",
  "FileAttachment",
  "GoToE",
  "GoToR",
  "Rendition",
  "Sound",
  "Movie",
]);

export type PdfRejection =
  | "empty"
  | "too_large"
  | "bad_magic"
  | "no_eof"
  | "encrypted"
  | "active_content"
  | "unsupported_object_stream"
  | "unreadable_object_stream"
  | "inflate_limit"
  | "malformed"
  | "hidden_object";

export type PdfVerdict = { ok: true; sha256: string; byteSize: number } | { ok: false; reason: PdfRejection };

/** Where `%%EOF` must appear, counted from the end. */
const EOF_WINDOW = 1024;
/** Total bytes all object streams of one document may inflate to. */
const MAX_INFLATED_TOTAL = 32 * 1024 * 1024;

const MAGIC = "%PDF-";
const EOF = "%%EOF";

/**
 * A name in raw text. PDF whitespace (including NUL) and delimiters end a name
 * (ISO 32000-1 §7.2.2); JavaScript's `\s` also ends one here, which can only
 * make a name shorter, so the check errs towards refusing.
 */
const NAME = /\/([^\s\0/[\]<>(){}%]*)/g;

/**
 * Object syntax in text the tokeniser skips: an `obj` keyword (a reader at a
 * cross-reference offset parses `N G obj`), or `xref` (a `startxref` offset
 * lands on it directly, so nothing need precede it). Readers end a number at
 * the first non-digit, so `1 0obj` and `0.obj` count: `obj` is hidden syntax
 * unless a letter is glued to its front. A `trailer` counts too: a reader that
 * falls back to recovery (a bad `startxref`) scans for trailers and can take
 * its `/Root` from one hidden in a stream body (review R-B4-13). `startxref`
 * already matches through `xref`. In compressed stream bodies this refuses the
 * odd harmless file by chance; that errs on the safe side.
 */
const HIDDEN_OBJECT = /(?<![A-Za-z])obj(?=$|[\s\0/[\]<>(){}%])|xref|(?<![A-Za-z])trailer(?![A-Za-z])/;

function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

/** True when `text` contains any active-content name, escaped or not. */
export function hasActiveContentName(text: string): boolean {
  for (const m of text.matchAll(NAME)) {
    if (ACTIVE_CONTENT_NAMES.has(decodeName(m[1]))) return true;
  }
  return false;
}

/** True when `text` contains the name `/name` (escapes decoded). */
function hasName(text: string, name: string): boolean {
  for (const m of text.matchAll(NAME)) if (decodeName(m[1]) === name) return true;
  return false;
}

/* ---------------------------------------------------------------------------
 * Tokeniser (ISO 32000-1 §7.2, §7.3)
 * ------------------------------------------------------------------------ */

const WHITE = 1;
const DELIM = 2;
/** Character classes of the 256 latin1 code units: 0 regular, WHITE, DELIM. */
const CLASS = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) CLASS[c] = WHITE;
for (const c of "()<>[]{}/%") CLASS[c.charCodeAt(0)] = DELIM;

const HEX_BODY = /^[0-9A-Fa-f\0\t\n\f\r ]*$/;
const UINT = /^\d+$/;

/** A doubt about the file's syntax: the caller refuses the file. */
class Malformed extends Error {}

type TokenType = "name" | "word" | "string" | "hex" | "<<" | ">>" | "[" | "]" | "comment";

interface Token {
  type: TokenType;
  /** Decoded for a name; raw contents for a string or comment; the text otherwise. */
  value: string;
}

class Lexer {
  pos = 0;
  constructor(private readonly s: string) {}

  next(): Token | null {
    const s = this.s;
    while (this.pos < s.length && CLASS[s.charCodeAt(this.pos)] === WHITE) this.pos++;
    if (this.pos >= s.length) return null;
    const start = this.pos;
    switch (s[start]) {
      case "%": {
        let e = start + 1;
        while (e < s.length && s[e] !== "\n" && s[e] !== "\r") e++;
        this.pos = e;
        return { type: "comment", value: s.slice(start + 1, e) };
      }
      case "(":
        return this.literal(start);
      case "<": {
        if (s[start + 1] === "<") {
          this.pos = start + 2;
          return { type: "<<", value: "<<" };
        }
        const e = s.indexOf(">", start + 1);
        if (e < 0 || !HEX_BODY.test(s.slice(start + 1, e))) throw new Malformed();
        this.pos = e + 1;
        return { type: "hex", value: "" };
      }
      case ">":
        if (s[start + 1] !== ">") throw new Malformed();
        this.pos = start + 2;
        return { type: ">>", value: ">>" };
      case "[":
      case "]":
        this.pos = start + 1;
        return { type: s[start] as "[" | "]", value: s[start] };
      case ")":
        throw new Malformed();
      case "{":
      case "}":
        // PostScript calculator braces: only meaningful inside function streams.
        this.pos = start + 1;
        return { type: "word", value: s[start] };
      case "/": {
        let e = start + 1;
        while (e < s.length && CLASS[s.charCodeAt(e)] === 0) e++;
        this.pos = e;
        return { type: "name", value: decodeName(s.slice(start + 1, e)) };
      }
      default: {
        let e = start;
        while (e < s.length && CLASS[s.charCodeAt(e)] === 0) e++;
        this.pos = e;
        return { type: "word", value: s.slice(start, e) };
      }
    }
  }

  /** A literal string: balanced parentheses, `\` escaping the next character. */
  private literal(start: number): Token {
    const s = this.s;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        this.pos = i + 1;
        return { type: "string", value: s.slice(start + 1, i) };
      }
    }
    throw new Malformed();
  }
}

/** One value starting at `t[i]`; returns the index after it. A reference `N G R` is one value. */
function valueEnd(t: Token[], i: number): number {
  const first = t[i];
  if (!first) throw new Malformed();
  if (first.type === "<<" || first.type === "[") {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      if (t[j].type === "<<" || t[j].type === "[") depth++;
      else if ((t[j].type === ">>" || t[j].type === "]") && --depth === 0) return j + 1;
    }
    throw new Malformed();
  }
  if (first.type === "word" && UINT.test(first.value) && t[i + 1]?.type === "word" && UINT.test(t[i + 1].value) && t[i + 2]?.type === "word" && t[i + 2].value === "R") return i + 3;
  return i + 1;
}

/** The top-level entries of a dictionary's tokens (`<<` … `>>`). A repeated key is a doubt: readers disagree on which wins. */
function entries(dict: Token[]): Map<string, Token[]> {
  const out = new Map<string, Token[]>();
  const end = dict.length - 1;
  let i = 1;
  while (i < end) {
    const key = dict[i];
    if (key.type !== "name" || out.has(key.value)) throw new Malformed();
    const j = valueEnd(dict, i + 1);
    if (j > end) throw new Malformed();
    out.set(key.value, dict.slice(i + 1, j));
    i = j;
  }
  return out;
}

interface ObjectStream {
  dict: Map<string, Token[]>;
  bodyStart: number;
  bodyEnd: number;
}

interface Scan {
  encrypted: boolean;
  active: boolean;
  hidden: boolean;
  malformed: boolean;
  objectStreams: ObjectStream[];
}

/**
 * Whether some reader may treat this stream as an object stream: `/Type
 * /ObjStm`, or any of `/N`, `/First`, `/Extends` (pdf.js reads `/N` and
 * `/First` alone; MuPDF defaults a missing `/First` to 0). ICC profiles carry
 * `/N` too and are decoded and checked as well; that only costs time.
 */
function isObjectStream(dict: Map<string, Token[]>): boolean {
  const type = dict.get("Type");
  return (type?.length === 1 && type[0].type === "name" && type[0].value === "ObjStm") || dict.has("N") || dict.has("First") || dict.has("Extends");
}

function checkSkipped(raw: string, out: Scan) {
  if (hasActiveContentName(raw)) out.active = true;
  if (HIDDEN_OBJECT.test(raw)) out.hidden = true;
}

/** One pass over the whole file. Stops at the first syntax doubt (`malformed`). */
function scan(text: string): Scan {
  const out: Scan = { encrypted: false, active: false, hidden: false, malformed: false, objectStreams: [] };
  const lx = new Lexer(text);
  const stack: ("<<" | "[")[] = [];
  /** The last two words at depth 0, for `N G obj`. */
  let gen: Token | null = null;
  let num: Token | null = null;
  /** Just after `N G obj`: the next token is the object's value. */
  let awaitingValue = false;
  /** Tokens of the object's value dictionary while it is open. */
  let collecting: Token[] | null = null;
  /** The object's value dictionary, once closed; `stream` may follow it directly. */
  let objectDict: Token[] | null = null;
  try {
    for (let t = lx.next(); t; t = lx.next()) {
      // A comment is whitespace to a reader: it changes no state.
      if (t.type === "comment") {
        checkSkipped(t.value, out);
        continue;
      }
      if (t.type === "string") checkSkipped(t.value, out);
      if (t.type === "name") {
        if (ACTIVE_CONTENT_NAMES.has(t.value)) out.active = true;
        if (t.value === "Encrypt") out.encrypted = true;
      }
      collecting?.push(t);
      const wasAwaiting = awaitingValue;
      const dictJustClosed = objectDict;
      awaitingValue = false;
      objectDict = null;

      switch (t.type) {
        case "<<":
          if (wasAwaiting && stack.length === 0) collecting = [t];
          stack.push("<<");
          break;
        case "[":
          stack.push("[");
          break;
        case ">>":
        case "]":
          if (stack.pop() !== (t.type === ">>" ? "<<" : "[")) throw new Malformed();
          if (stack.length === 0 && collecting) {
            objectDict = collecting;
            collecting = null;
          }
          break;
        case "word":
          if (t.value === "obj" && stack.length === 0 && num && gen && UINT.test(num.value) && UINT.test(gen.value)) {
            awaitingValue = true;
            collecting = null;
          } else if (t.value === "stream") {
            if (!dictJustClosed || stack.length !== 0) throw new Malformed();
            let bodyStart = lx.pos;
            if (text[bodyStart] === "\r") bodyStart++;
            if (text[bodyStart] === "\n") bodyStart++;
            const bodyEnd = text.indexOf("endstream", bodyStart);
            if (bodyEnd < 0) throw new Malformed();
            const dict = entries(dictJustClosed);
            const body = text.slice(bodyStart, bodyEnd);
            if (HIDDEN_OBJECT.test(body)) out.hidden = true;
            // An unfiltered body is plain text a reader may also parse as objects: check its names too.
            if (!dict.has("Filter") && hasActiveContentName(body)) out.active = true;
            if (isObjectStream(dict)) out.objectStreams.push({ dict, bodyStart, bodyEnd });
            lx.pos = bodyEnd + "endstream".length;
          } else if (t.value === "endobj" && stack.length !== 0) throw new Malformed();
          break;
      }
      if (t.type === "word" && stack.length === 0) {
        num = gen;
        gen = t;
      } else {
        num = gen = null;
      }
    }
    if (stack.length !== 0) throw new Malformed();
  } catch (e) {
    if (!(e instanceof Malformed)) throw e;
    out.malformed = true;
  }
  return out;
}

/** Names a stream dictionary's `/Filter` lists; null when it is not a plain name or array of names. */
function filtersOf(dict: Map<string, Token[]>): string[] | null {
  const v = dict.get("Filter");
  if (!v || (v.length === 1 && v[0].type === "word" && v[0].value === "null")) return [];
  if (v.length === 1 && v[0].type === "name") return [v[0].value];
  if (v[0].type === "[" && v.slice(1, -1).every((x) => x.type === "name")) return v.slice(1, -1).map((x) => x.value);
  return null;
}

/** Keys that change how an object stream's bytes decode, or where they come from: not supported. */
const UNSUPPORTED_STREAM_KEYS = ["DecodeParms", "DP", "F", "FFilter", "FDecodeParms"];

export function validatePdf(bytes: Uint8Array, opts: { maxBytes: number }): PdfVerdict {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  if (bytes.byteLength > opts.maxBytes) return { ok: false, reason: "too_large" };
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.subarray(0, MAGIC.length).toString("latin1") !== MAGIC) return { ok: false, reason: "bad_magic" };
  if (!buf.subarray(Math.max(0, buf.length - EOF_WINDOW)).toString("latin1").includes(EOF)) return { ok: false, reason: "no_eof" };

  // latin1 maps every byte to one code unit, so offsets in `text` are byte offsets.
  const text = buf.toString("latin1");
  const s = scan(text);
  if (s.encrypted) return { ok: false, reason: "encrypted" };
  if (s.active) return { ok: false, reason: "active_content" };
  if (s.malformed) return { ok: false, reason: "malformed" };
  if (s.hidden) return { ok: false, reason: "hidden_object" };

  let inflated = 0;
  for (const o of s.objectStreams) {
    const filters = filtersOf(o.dict);
    const extra = UNSUPPORTED_STREAM_KEYS.some((k) => {
      const v = o.dict.get(k);
      return v !== undefined && !(v.length === 1 && v[0].type === "word" && v[0].value === "null");
    });
    let decoded: string;
    if (filters === null || extra) return { ok: false, reason: "unsupported_object_stream" };
    if (filters.length === 0) decoded = text.slice(o.bodyStart, o.bodyEnd);
    else if (filters.length === 1 && filters[0] === "FlateDecode") {
      try {
        const out = inflateSync(buf.subarray(o.bodyStart, o.bodyEnd), { maxOutputLength: MAX_INFLATED_TOTAL - inflated + 1 });
        inflated += out.length;
        if (inflated > MAX_INFLATED_TOTAL) return { ok: false, reason: "inflate_limit" };
        decoded = out.toString("latin1");
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") return { ok: false, reason: "inflate_limit" };
        return { ok: false, reason: "unreadable_object_stream" };
      }
    } else return { ok: false, reason: "unsupported_object_stream" };
    // Checked whole, strings included: object streams hold dictionaries, never stream bodies.
    if (hasName(decoded, "Encrypt")) return { ok: false, reason: "encrypted" };
    if (hasActiveContentName(decoded)) return { ok: false, reason: "active_content" };
  }
  return { ok: true, sha256: sha256Of(bytes), byteSize: bytes.byteLength };
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
