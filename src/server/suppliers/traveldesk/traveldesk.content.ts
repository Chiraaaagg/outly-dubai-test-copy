import { createHash } from "node:crypto";

/**
 * TravelDesk tour content (doc 30 §3.2, build N0): the descriptive part of a
 * `GET /tours/{Id}` answer — sales description, terms, FAQ, itinerary, photo
 * list and video link — read into a sanitised shape for
 * `supplier_tour_content`.
 *
 * Owner decision D3 (25 Nov 2026) allows storing and using TravelDesk text
 * and photos. This module only reads and cleans; it never renders anything.
 *
 * Rules:
 *  - Supplier HTML becomes plain text (`htmlToPlainText`). It is never kept as
 *    HTML and must never be rendered as HTML.
 *  - Photos are references (https addresses with their sizes), never fetched
 *    here. N1 copies them through the checked fetch (doc 30 §3.8).
 *  - FAQ and itinerary shapes are undocumented and were empty in every
 *    sandbox answer seen (`z.unknown()` in the codec). They are read
 *    tolerantly: a known pair of fields is taken, anything else is skipped
 *    with a warning naming only the keys seen. The sanitised raw lists are
 *    kept beside the parsed ones (`raw`) with `TOUR_CONTENT_SCHEMA_VERSION`,
 *    so a later parser can re-read them without a new sync.
 *  - Content is held apart from the catalogue payload: the approved offer
 *    terms hash (`traveldesk.offer-terms.ts`) reads the tour payload, and the
 *    catalogue sync strips `content` from it, so storing content cannot mark
 *    an approved mapping as changed.
 *  - No prices and no personal data are read here.
 *
 * Pure: no env, db or logger.
 */

/** Bump when the parsed shape or a parsing rule changes; stored with every row. */
export const TOUR_CONTENT_SCHEMA_VERSION = 1;

/** Caps, so one odd answer cannot fill a row. */
export const CONTENT_LIMITS = Object.freeze({
  textChars: 20_000,
  shortTextChars: 500,
  listItems: 100,
  photos: 60,
  photoVariants: 20,
  urlChars: 2_048,
  rawDepth: 6,
  rawKeys: 50,
  /** Input characters one tour's text fields may read in total (`TextBudget`, N0-01). */
  tourInputChars: 200_000,
});

export interface TourContentFaq {
  question: string;
  answer: string;
}

export interface TourContentItineraryStep {
  /** The supplier's order when it gives one, else the list position (1-based). */
  position: number;
  title: string;
  description: string;
}

export interface TourContentPhotoVariant {
  /** Declared media type, e.g. "image/webp"; null when absent. Never trusted for the copy (N1 sniffs the bytes). */
  type: string | null;
  url: string;
  width: number | null;
  height: number | null;
}

export interface TourContentPhoto {
  supplierPhotoId: number | null;
  caption: string;
  description: string;
  variants: TourContentPhotoVariant[];
}

export interface TourContent {
  schemaVersion: number;
  name: string;
  salesDescription: string;
  terms: string;
  videoUrl: string | null;
  faq: TourContentFaq[];
  itinerary: TourContentItineraryStep[];
  photos: TourContentPhoto[];
  /** The undocumented lists as received, sanitised (`sanitiseRaw`), for re-parsing later. */
  raw: { faqList: unknown; itineraries: unknown; photos: unknown };
  /** What could not be read, by part and position. Key names only, never values. */
  warnings: string[];
  /** sha256 over everything above except the hash itself. */
  contentHash: string;
}

/** The tour detail fields this module reads (codec `tourDetailsWire`). */
export interface TourContentWire {
  name?: string | null;
  salesDescription?: string | null;
  termsAndConditions?: string | null;
  videoUrl?: string | null;
  faqList?: unknown[] | null;
  itineraries?: unknown[] | null;
  photos?: unknown[] | null;
}

/* ---------------------------------------------------------------------------
 * Text
 * ------------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Surrogates, control characters and out-of-range code points are dropped, not decoded.
      if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code < 0x20) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Control characters other than newline and tab, the Unicode bidi overrides
 * and isolates, the directional marks (U+200E, U+200F, U+061C), zero-width
 * space and the byte-order mark. Line and paragraph separators become "\n"
 * (`LINE_SEPARATORS`).
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/** Replace lone UTF-16 surrogates (Postgres `jsonb` and `text` refuse them) with U+FFFD. Applied after every cut. */
export function wellFormed(s: string): string {
  return s.toWellFormed();
}

/**
 * Cut to at most `max` UTF-16 units without splitting a surrogate pair,
 * marking the cut with "…". The result is always well formed.
 */
function capText(s: string, max: number): string {
  if (s.length <= max) return wellFormed(s);
  let cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return wellFormed(`${s.slice(0, cut).trimEnd()}…`);
}

/**
 * How many input characters one tour's content may still read (N0-01). Each
 * text field takes from it before it is parsed; once it is spent, further
 * fields read as empty and `exhausted` is set, so one tour's parse is bounded
 * whatever TravelDesk sends.
 */
export interface TextBudget {
  left: number;
  exhausted: boolean;
}

export function newTextBudget(chars: number = CONTENT_LIMITS.tourInputChars): TextBudget {
  return { left: chars, exhausted: false };
}

/** Elements dropped with everything inside them. */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "textarea", "title", "head"]);
/** Elements whose start and end become a line break. */
const BLOCK = new Set(["p", "div", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section", "article", "blockquote"]);
const TAG_START = /[A-Za-z/!?]/;
const TAG_NAME = /^(\/?)([A-Za-z][A-Za-z0-9]*)/;

/**
 * Remove tags in one left-to-right pass (N0-01): every `indexOf` starts after
 * the previous match, and an unclosed tag, comment or dropped element ends the
 * text there (N0-09), so the work is linear in the input whatever the markup.
 * A "<" not followed by a tag start is kept as text.
 */
function stripTags(s: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, lt));
    const next = s[lt + 1];
    if (next === undefined || !TAG_START.test(next)) {
      parts.push("<");
      i = lt + 1;
      continue;
    }
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end === -1) break;
      parts.push(" ");
      i = end + 3;
      continue;
    }
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) break;
    i = gt + 1;
    const m = TAG_NAME.exec(s.slice(lt + 1, Math.min(gt, lt + 40)));
    if (!m) {
      parts.push(" ");
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (!closing && DROP_WITH_CONTENT.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, "gi");
      close.lastIndex = i;
      const found = close.exec(s);
      if (!found) break;
      parts.push(" ");
      i = found.index + found[0].length;
      continue;
    }
    if (name === "br") parts.push("\n");
    else if (name === "li") parts.push(closing ? "" : "\n• ");
    else if (BLOCK.has(name)) parts.push("\n");
    else parts.push(" ");
  }
  return parts.join("");
}

/**
 * Supplier HTML (or plain text) → plain text. Script, style and comment
 * content is dropped; block ends become line breaks and list items "• ";
 * every other tag is removed; entities are decoded once (the result is text,
 * so a decoded "<" stays a character and is never parsed again); control
 * characters are removed and whitespace collapsed. Linear in the input
 * (`stripTags`); the input read is capped at `maxChars × 4` and by `budget`;
 * the result at `maxChars`, always well formed.
 */
export function htmlToPlainText(value: unknown, maxChars: number = CONTENT_LIMITS.textChars, budget?: TextBudget): string {
  if (typeof value !== "string" || value.length === 0) return "";
  let take = Math.min(value.length, maxChars * 4);
  if (budget) {
    if (budget.left < take) {
      budget.exhausted = true;
      take = budget.left;
    }
    budget.left -= take;
    if (take <= 0) return "";
  }
  let s = stripTags(take < value.length ? value.slice(0, take) : value);
  s = wellFormed(decodeEntities(s).replace(/\r\n?/g, "\n").replace(LINE_SEPARATORS, "\n").replace(CONTROL, ""));
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return capText(s, maxChars);
}

/** Hosts that are never a public media host (N0-05). Suffix match on whole labels. */
const PRIVATE_HOST_SUFFIXES = ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "arpa"];

/**
 * An https address of at most `CONTENT_LIMITS.urlChars`, on the default port,
 * without credentials, whose host is a public-looking DNS name (N0-05): IP
 * literals (v4 in any spelling the URL parser normalises, v6), single-label
 * hosts, `localhost` and private suffixes are refused. Null otherwise.
 *
 * This is capture hygiene only. N1's checked fetch must still allow-list the
 * TravelDesk media hosts, check the resolved address and refuse or re-check
 * redirects (doc 30 §3.8; N1 acceptance item).
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > CONTENT_LIMITS.urlChars) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) return null;
  if (PRIVATE_HOST_SUFFIXES.includes(labels[labels.length - 1]) || labels.includes("localhost")) return null;
  return u.toString();
}

/* ---------------------------------------------------------------------------
 * Raw lists
 * ------------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A JSON-safe copy of an unknown value for storage: strings lose control
 * characters, are capped and made well formed; numbers must be finite; depth,
 * list length and key count are capped; anything else becomes null. HTML and
 * any address stay as received: `raw` is for re-parsing only, never rendered,
 * copied into a listing or selected by any other reader (review 103 N0-06).
 */
export function sanitiseRaw(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return wellFormed(value.replace(CONTROL, "").slice(0, CONTENT_LIMITS.textChars));
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= CONTENT_LIMITS.rawDepth) return null;
  if (Array.isArray(value)) return value.slice(0, CONTENT_LIMITS.listItems).map((v) => sanitiseRaw(v, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, CONTENT_LIMITS.rawKeys)) {
      const key = wellFormed(k.replace(CONTROL, "").slice(0, 64));
      if (key && key !== "__proto__" && key !== "constructor" && key !== "prototype") out[key] = sanitiseRaw(v, depth + 1);
    }
    return out;
  }
  return null;
}

/** Key names of an unknown item, for a warning; never its values. */
function keysOf(item: unknown): string {
  if (!isRecord(item)) return Array.isArray(item) ? "array" : typeof item;
  const keys = Object.keys(item).slice(0, 8).map((k) => k.replace(/[^A-Za-z0-9_]/g, "").slice(0, 32));
  return keys.length ? keys.join(",") : "no keys";
}

function firstText(item: Record<string, unknown>, keys: readonly string[], maxChars: number, budget?: TextBudget): string {
  for (const k of keys) {
    const t = htmlToPlainText(item[k], maxChars, budget);
    if (t) return t;
  }
  return "";
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

/* ---------------------------------------------------------------------------
 * Parts
 * ------------------------------------------------------------------------ */

const FAQ_QUESTION_KEYS = ["question", "title", "q", "name", "header"] as const;
const FAQ_ANSWER_KEYS = ["answer", "description", "text", "a", "content", "body"] as const;

/** FAQ items with a question and an answer; anything else is skipped with a warning. */
export function parseFaq(list: unknown[] | null | undefined, warnings: string[], budget?: TextBudget): TourContentFaq[] {
  const out: TourContentFaq[] = [];
  (list ?? []).slice(0, CONTENT_LIMITS.listItems).forEach((item, i) => {
    if (!isRecord(item)) {
      warnings.push(`faq ${i + 1}: unreadable (${keysOf(item)})`);
      return;
    }
    const question = firstText(item, FAQ_QUESTION_KEYS, CONTENT_LIMITS.shortTextChars, budget);
    const answer = firstText(item, FAQ_ANSWER_KEYS, CONTENT_LIMITS.textChars, budget);
    if (!question || !answer) {
      warnings.push(`faq ${i + 1}: unknown shape (${keysOf(item)})`);
      return;
    }
    out.push({ question, answer });
  });
  if ((list?.length ?? 0) > CONTENT_LIMITS.listItems) warnings.push(`faq: ${list!.length - CONTENT_LIMITS.listItems} items over the cap dropped`);
  return out;
}

const STEP_TITLE_KEYS = ["title", "name", "heading", "header", "place"] as const;
const STEP_TEXT_KEYS = ["description", "text", "details", "content", "body"] as const;
const STEP_ORDER_KEYS = ["order", "sortOrder", "position", "sequence", "day", "dayNumber"] as const;

/** Itinerary steps with a title or a description; ordered by the supplier's order field when every step has one. */
export function parseItinerary(list: unknown[] | null | undefined, warnings: string[], budget?: TextBudget): TourContentItineraryStep[] {
  const steps: (TourContentItineraryStep & { order: number | null })[] = [];
  (list ?? []).slice(0, CONTENT_LIMITS.listItems).forEach((item, i) => {
    if (typeof item === "string") {
      const text = htmlToPlainText(item, CONTENT_LIMITS.textChars, budget);
      if (text) steps.push({ position: i + 1, order: null, title: "", description: text });
      else warnings.push(`itinerary ${i + 1}: empty`);
      return;
    }
    if (!isRecord(item)) {
      warnings.push(`itinerary ${i + 1}: unreadable (${keysOf(item)})`);
      return;
    }
    const title = firstText(item, STEP_TITLE_KEYS, CONTENT_LIMITS.shortTextChars, budget);
    const description = firstText(item, STEP_TEXT_KEYS, CONTENT_LIMITS.textChars, budget);
    if (!title && !description) {
      warnings.push(`itinerary ${i + 1}: unknown shape (${keysOf(item)})`);
      return;
    }
    const order = STEP_ORDER_KEYS.map((k) => intOrNull(item[k])).find((v) => v !== null) ?? null;
    steps.push({ position: i + 1, order, title, description });
  });
  if ((list?.length ?? 0) > CONTENT_LIMITS.listItems) warnings.push(`itinerary: ${list!.length - CONTENT_LIMITS.listItems} items over the cap dropped`);
  const ordered = steps.every((s) => s.order !== null) ? [...steps].sort((a, b) => a.order! - b.order! || a.position - b.position) : steps;
  return ordered.map((s, i) => ({ position: s.order ?? i + 1, title: s.title, description: s.description }));
}

/**
 * Photos as TravelDesk sends them (sandbox, tour 5, 27 Oct 2026):
 * `{ id, caption, description, srcSet: [{ type, sizes: [{ src, width, height }] }] }`.
 * Only https sources are kept; a photo without one is skipped with a warning.
 * A plain https string is accepted as a one-variant photo.
 */
export function parsePhotos(list: unknown[] | null | undefined, warnings: string[], budget?: TextBudget): TourContentPhoto[] {
  const out: TourContentPhoto[] = [];
  (list ?? []).slice(0, CONTENT_LIMITS.photos).forEach((item, i) => {
    if (typeof item === "string") {
      const url = safeHttpsUrl(item);
      if (url) out.push({ supplierPhotoId: null, caption: "", description: "", variants: [{ type: null, url, width: null, height: null }] });
      else warnings.push(`photo ${i + 1}: not an allowed https address`);
      return;
    }
    if (!isRecord(item)) {
      warnings.push(`photo ${i + 1}: unreadable (${keysOf(item)})`);
      return;
    }
    const variants: TourContentPhotoVariant[] = [];
    let dropped = 0;
    const sets = Array.isArray(item.srcSet) ? item.srcSet : [];
    for (const set of sets) {
      if (!isRecord(set)) continue;
      const type = typeof set.type === "string" && /^image\/[a-z0-9.+-]{1,40}$/i.test(set.type) ? set.type.toLowerCase() : null;
      for (const size of Array.isArray(set.sizes) ? set.sizes : []) {
        if (!isRecord(size)) continue;
        const url = safeHttpsUrl(size.src);
        if (!url) {
          dropped += 1;
          continue;
        }
        if (variants.length < CONTENT_LIMITS.photoVariants) variants.push({ type, url, width: intOrNull(size.width), height: intOrNull(size.height) });
      }
    }
    // A flat `src`/`url` field, if a later answer sends one.
    if (variants.length === 0) {
      const url = safeHttpsUrl(item.src) ?? safeHttpsUrl(item.url);
      if (url) variants.push({ type: null, url, width: intOrNull(item.width), height: intOrNull(item.height) });
    }
    if (dropped) warnings.push(`photo ${i + 1}: ${dropped} source(s) not an allowed https address, dropped`);
    if (variants.length === 0) {
      warnings.push(`photo ${i + 1}: no usable source (${keysOf(item)})`);
      return;
    }
    out.push({
      supplierPhotoId: intOrNull(item.id),
      caption: htmlToPlainText(item.caption, CONTENT_LIMITS.shortTextChars, budget),
      description: htmlToPlainText(item.description, CONTENT_LIMITS.shortTextChars, budget),
      variants,
    });
  });
  if ((list?.length ?? 0) > CONTENT_LIMITS.photos) warnings.push(`photos: ${list!.length - CONTENT_LIMITS.photos} over the cap dropped`);
  return out;
}

/* ---------------------------------------------------------------------------
 * Whole tour
 * ------------------------------------------------------------------------ */

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

/** Read the content part of a tour detail answer. Never throws: what cannot be read is empty, with a warning. */
export function tourContentFrom(wire: TourContentWire): TourContent {
  const warnings: string[] = [];
  const budget = newTextBudget();
  const videoRaw = typeof wire.videoUrl === "string" ? wire.videoUrl.trim() : "";
  const videoUrl = videoRaw ? safeHttpsUrl(videoRaw) : null;
  if (videoRaw && !videoUrl) warnings.push("video: not an allowed https address");
  const name = htmlToPlainText(wire.name, CONTENT_LIMITS.shortTextChars, budget);
  const salesDescription = htmlToPlainText(wire.salesDescription, CONTENT_LIMITS.textChars, budget);
  const terms = htmlToPlainText(wire.termsAndConditions, CONTENT_LIMITS.textChars, budget);
  const faq = parseFaq(wire.faqList, warnings, budget);
  const itinerary = parseItinerary(wire.itineraries, warnings, budget);
  const photos = parsePhotos(wire.photos, warnings, budget);
  if (budget.exhausted) warnings.push(`content: input over ${CONTENT_LIMITS.tourInputChars} characters, the rest read as empty`);
  const body = {
    schemaVersion: TOUR_CONTENT_SCHEMA_VERSION,
    name,
    salesDescription,
    terms,
    videoUrl,
    faq,
    itinerary,
    photos,
    raw: {
      faqList: sanitiseRaw(wire.faqList ?? []),
      itineraries: sanitiseRaw(wire.itineraries ?? []),
      photos: sanitiseRaw(wire.photos ?? []),
    },
    warnings,
  };
  const contentHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, contentHash };
}

/**
 * `tourContentFrom` for the tour read (N0-01): content can never fail the
 * read of a tour's structure and offers. On any error it returns undefined
 * and adds a warning to `warnings` (the tour detail's own, never stored in
 * the payload); the sync then stores no content for that tour this run.
 */
export function safeTourContentFrom(wire: TourContentWire, warnings: string[]): TourContent | undefined {
  try {
    return tourContentFrom(wire);
  } catch (error) {
    warnings.push(`content: unreadable (${error instanceof Error ? error.name : "unknown"})`);
    return undefined;
  }
}
