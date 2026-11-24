import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { hasActiveContentName, validatePdf } from "../pdf";

/**
 * Supplier PDF validation (F13, TKT-3). Every document here is synthetic and
 * built in the test; none is a real supplier ticket.
 */

const MAX = 64 * 1024;

/** A minimal one-page PDF with `extra` added to the catalogue dictionary and `objects` appended. */
function pdf(opts: { catalog?: string; objects?: string[]; head?: string; tail?: string } = {}): Buffer {
  const parts = [
    opts.head ?? "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${opts.catalog ?? ""}>>\nendobj\n`,
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 21 >>\nstream\nBT /F1 12 Tf (x) Tj ET\nendstream\nendobj\n",
    ...(opts.objects ?? []),
    "trailer\n<< /Root 1 0 R >>\n",
    opts.tail ?? "%%EOF\n",
  ];
  return Buffer.from(parts.join(""), "latin1");
}

/** An object stream holding `inner`, compressed with FlateDecode (or as given). */
function objStm(n: number, inner: string, filter: string | null = "/FlateDecode"): Buffer {
  const body = filter === "/FlateDecode" ? deflateSync(Buffer.from(inner, "latin1")) : Buffer.from(inner, "latin1");
  return Buffer.concat([
    Buffer.from(`${n} 0 obj\n<< /Type /ObjStm /N 1 /First 4 ${filter ? `/Filter ${filter} ` : ""}/Length ${body.length} >>\nstream\n`, "latin1"),
    body,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);
}

function withObjects(...objects: Buffer[]): Buffer {
  const base = pdf();
  const at = base.indexOf("trailer");
  return Buffer.concat([base.subarray(0, at), ...objects, base.subarray(at)]);
}

describe("validatePdf", () => {
  it("accepts a plain PDF and returns its sha256 and size", () => {
    const b = pdf();
    const v = validatePdf(b, { maxBytes: MAX });
    expect(v).toEqual({ ok: true, sha256: createHash("sha256").update(b).digest("hex"), byteSize: b.length });
  });

  it("accepts a clean object stream and binary image streams", () => {
    const image = Buffer.concat([Buffer.from("9 0 obj\n<< /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 8 >>\nstream\n", "latin1"), Buffer.from([0xff, 0xd8, 0x2f, 0x41, 0x41, 0x20, 0xff, 0xd9]), Buffer.from("\nendstream\nendobj\n", "latin1")]);
    expect(validatePdf(withObjects(objStm(8, "5 0 << /Type /Font /Subtype /Type1 >>"), image), { maxBytes: MAX }).ok).toBe(true);
  });

  it("refuses empty, oversized, wrong magic and truncated files", () => {
    expect(validatePdf(new Uint8Array(), { maxBytes: MAX })).toEqual({ ok: false, reason: "empty" });
    expect(validatePdf(pdf(), { maxBytes: 100 })).toEqual({ ok: false, reason: "too_large" });
    expect(validatePdf(pdf({ head: " %PDF-1.7\n" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "bad_magic" });
    expect(validatePdf(Buffer.from("<html><body>Error</body></html>\n%%EOF"), { maxBytes: MAX })).toEqual({ ok: false, reason: "bad_magic" });
    expect(validatePdf(Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), pdf()]), { maxBytes: MAX })).toEqual({ ok: false, reason: "bad_magic" });
    expect(validatePdf(pdf({ tail: "" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "no_eof" });
    // %%EOF only far from the end: a truncated or padded download.
    expect(validatePdf(pdf({ tail: `%%EOF\n${" ".repeat(2000)}x` }), { maxBytes: MAX })).toEqual({ ok: false, reason: "no_eof" });
  });

  it.each([
    "/OpenAction 5 0 R",
    "/AA << /O 5 0 R >>",
    "/Names << /JavaScript 5 0 R >>",
    "/Names << /EmbeddedFiles 5 0 R >>",
    "/AcroForm << /XFA 5 0 R >>",
    "/OpenAction << /S /Launch /F (calc.exe) >>",
    "/OpenAction << /S /JS /JS (app.alert(1)) >>",
    "/X << /S /SubmitForm >>",
    "/X << /S /ImportData >>",
    "/X << /Type /RichMedia >>",
    "/X << /Type /EmbeddedFile >>",
  ])("refuses active content in the catalogue: %s", (catalog) => {
    expect(validatePdf(pdf({ catalog }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
  });

  it("refuses #xx-escaped active names", () => {
    expect(validatePdf(pdf({ catalog: "/Names << /J#61vaScript 5 0 R >>" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(pdf({ catalog: "/#4FpenAction 5 0 R" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(pdf({ catalog: "/#41#41 << >>" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
  });

  it("refuses active content hidden in a compressed or plain object stream", () => {
    expect(validatePdf(withObjects(objStm(8, "5 0 << /S /JavaScript /JS (app.alert(1)) >>")), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(withObjects(objStm(8, "5 0 << /S /J#61vaScript >>")), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(withObjects(objStm(8, "5 0 << /OpenAction 6 0 R >>", null)), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
  });

  it("refuses object streams it cannot inspect, and encrypted files", () => {
    expect(validatePdf(withObjects(objStm(8, "5 0 << >>", "/ASCIIHexDecode")), { maxBytes: MAX })).toEqual({ ok: false, reason: "unsupported_object_stream" });
    expect(validatePdf(withObjects(objStm(8, "5 0 << >>", "[/ASCII85Decode /FlateDecode]")), { maxBytes: MAX })).toEqual({ ok: false, reason: "unsupported_object_stream" });
    const broken = Buffer.from("8 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 6 >>\nstream\nnot-zl\nendstream\nendobj\n", "latin1");
    expect(validatePdf(withObjects(broken), { maxBytes: MAX })).toEqual({ ok: false, reason: "unreadable_object_stream" });
    expect(validatePdf(pdf({ objects: ["trailer\n<< /Encrypt 9 0 R >>\n"] }), { maxBytes: MAX })).toEqual({ ok: false, reason: "encrypted" });
  });

  it("refuses an object stream that inflates past the limit (zip bomb)", () => {
    const bomb = deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
    const obj = Buffer.concat([Buffer.from(`8 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n`, "latin1"), bomb, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    expect(validatePdf(withObjects(obj), { maxBytes: 1024 * 1024 })).toEqual({ ok: false, reason: "inflate_limit" });
  });

  /** An object whose value is `dict` followed by a stream holding `body` (FlateDecode when `flate`). */
  function streamObj(n: number, dict: string, body: string, flate = false): Buffer {
    const data = flate ? deflateSync(Buffer.from(body, "latin1")) : Buffer.from(body, "latin1");
    return Buffer.concat([Buffer.from(`${n} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  }

  it("sees active names after a string that looks like a stream start (R-B4-1)", () => {
    // Before: `>>stream` inside the string was taken for a stream start and
    // everything up to the next `endstream` (object 4) was skipped.
    expect(validatePdf(pdf({ catalog: "/X (>>stream\n) /OpenAction 3 0 R" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(pdf({ catalog: "/X (>>stream\r\n) /AA << /O 5 0 R >>" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    // A name ended by NUL (PDF whitespace) is still the name.
    expect(validatePdf(pdf({ catalog: "/OpenAction\0 3 0 R" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
  });

  it("checks an object stream whose dictionary has `obj` in a key or is longer than 4 KiB (R-B4-1)", () => {
    const js = "5 0 << /S /JavaScript /JS (app.alert(1)) >>";
    expect(validatePdf(withObjects(streamObj(8, "/Type /ObjStm /Xobj 1 /N 1 /First 4 /Filter /FlateDecode", js, true)), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    const padding = `/Pad [${" 0".repeat(3000)} ]`;
    expect(validatePdf(withObjects(streamObj(8, `/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode ${padding}`, js, true)), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    // Escaped keys and values are decoded.
    expect(validatePdf(withObjects(streamObj(8, "/#54ype /Obj#53tm /N 1 /First 4 /Filter /Flate#44ecode", js, true)), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    // No /Type at all: /N and /First are all a reader needs to use it as an object stream.
    expect(validatePdf(withObjects(streamObj(8, "/N 1 /First 4 /Filter /FlateDecode", js, true)), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
  });

  it("refuses object streams whose decoding it cannot follow", () => {
    const clean = "5 0 << /Type /Font >>";
    const unsupported = { ok: false, reason: "unsupported_object_stream" };
    expect(validatePdf(withObjects(streamObj(8, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 12 >>", clean, true)), { maxBytes: MAX })).toEqual(unsupported);
    expect(validatePdf(withObjects(streamObj(8, "/Type /ObjStm /N 1 /First 4 /Filter 9 0 R", clean, true)), { maxBytes: MAX })).toEqual(unsupported);
    expect(validatePdf(withObjects(streamObj(8, "/Type /ObjStm /N 1 /First 4 /F (other.bin)", clean)), { maxBytes: MAX })).toEqual(unsupported);
    // A filter array of one FlateDecode, and an explicit null DecodeParms, are fine.
    expect(validatePdf(withObjects(streamObj(8, "/Type /ObjStm /N 1 /First 4 /Filter [/FlateDecode] /DecodeParms null", clean, true)), { maxBytes: MAX }).ok).toBe(true);
  });

  it.each([
    ["an unterminated string", "/Title (abc"],
    ["a stray closing parenthesis", "/Title abc)"],
    ["an unclosed dictionary", "/X << /Y 1"],
    ["a dictionary closed by a bracket", "/X << /Y 1 ]"],
    ["a single >", "/X 1 > /Y 2"],
    ["a hex string with non-hex content", "/ID <12 zz>"],
    ["an unterminated hex string", "/ID <0a0b"],
  ])("refuses %s as malformed", (_what, catalog) => {
    expect(validatePdf(pdf({ catalog }), { maxBytes: MAX })).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses streams it cannot place as malformed", () => {
    const malformed = { ok: false, reason: "malformed" };
    // No endstream.
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /Length 4 >>\nstream\nabcd\nendobj\n"] }), { maxBytes: MAX })).toEqual(malformed);
    // `stream` after a dictionary that is not an object's value.
    expect(validatePdf(pdf({ objects: ["<< /Length 4 >>\nstream\nabcd\nendstream\n"] }), { maxBytes: MAX })).toEqual(malformed);
    expect(validatePdf(pdf({ objects: ["9 0 obj\n[ << /Length 4 >> ]\nstream\nabcd\nendstream\nendobj\n"] }), { maxBytes: MAX })).toEqual(malformed);
    // A repeated key in a stream dictionary: readers disagree on which one wins.
    expect(validatePdf(withObjects(streamObj(8, "/Type /ObjStm /N 1 /First 4 /Type /XObject", "5 0 << >>")), { maxBytes: MAX })).toEqual(malformed);
    // A dictionary left open at endobj.
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /A 1\nendobj\n"] }), { maxBytes: MAX })).toEqual(malformed);
  });

  it("refuses object syntax inside a string, a comment or a raw stream body (hidden_object)", () => {
    const hidden = { ok: false, reason: "hidden_object" };
    // A cross-reference offset can point into any of these; a reader would parse the object there.
    expect(validatePdf(pdf({ catalog: "/X (7 0 obj << /Type /Action >> endobj)" }), { maxBytes: MAX })).toEqual(hidden);
    expect(validatePdf(pdf({ objects: ["% 7 0 obj << /Type /Action >> endobj\n"] }), { maxBytes: MAX })).toEqual(hidden);
    expect(validatePdf(withObjects(streamObj(9, "/Subtype /Image", "7 0 obj << /Type /Action >> endobj")), { maxBytes: MAX })).toEqual(hidden);
    expect(validatePdf(withObjects(streamObj(9, "/Subtype /Image", "xref\n0 1\n0000000000 65535 f \n")), { maxBytes: MAX })).toEqual(hidden);
    // A stream whose /Length ends early: what follows up to `endstream` is still body to the scanner, and checked.
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /Length 1 >>\nstream\nA\nendobj 10 0 obj << /S /GoTo >>\nendstream\nendobj\n"] }), { maxBytes: MAX })).toEqual(hidden);
  });

  it("refuses a trailer hidden in a filtered stream body (R-B4-13)", () => {
    const body = "endobj\ntrailer\n<< /Root << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> >>";
    const file = withObjects(Buffer.from(`9 0 obj\n<< /Length ${body.length} /Filter /FlateDecode >>\nstream\n${body}\nendstream\nendobj\n`, "latin1"));
    expect(validatePdf(file, { maxBytes: MAX })).toEqual({ ok: false, reason: "hidden_object" });
    // An unfiltered body with only the word, no object syntax, is refused the same way.
    const plain = "trailer << /Root 1 0 R >>";
    expect(validatePdf(withObjects(Buffer.from(`9 0 obj\n<< /Length ${plain.length} >>\nstream\n${plain}\nendstream\nendobj\n`, "latin1")), { maxBytes: MAX }).ok).toBe(false);
  });

  it("refuses the recheck bypasses: digit-glued obj in a stream body, /N-only object streams, file attachments and remote go-to", () => {
    // A content stream whose body hides "1 0obj<<...>>": readers end the number at "o" and read an object there.
    const glued = "1 0obj<</Type/Catalog/Pages 2 0 R/OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj";
    const hiddenBody = Buffer.from(`9 0 obj\n<< /Length ${glued.length} >>\nstream\n${glued}\nendstream\nendobj\n`, "latin1");
    expect(validatePdf(withObjects(hiddenBody), { maxBytes: MAX }).ok).toBe(false);
    const glued2 = "0.obj << >> endobj";
    expect(validatePdf(withObjects(Buffer.from(`9 0 obj\n<< /Length ${glued2.length} /Filter /FlateDecode >>\nstream\n${glued2}\nendstream\nendobj\n`, "latin1")), { maxBytes: MAX })).toEqual({ ok: false, reason: "hidden_object" });
    // An object stream with /N only (MuPDF defaults /First to 0), compressed.
    const inner = deflateSync(Buffer.from("1 4 <</Type/Catalog/OpenAction<</S/Launch/F(calc.exe)>>>>", "latin1"));
    const nOnly = Buffer.concat([Buffer.from(`8 0 obj\n<< /N 1 /Filter /FlateDecode /Length ${inner.length} >>\nstream\n`, "latin1"), inner, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    expect(validatePdf(withObjects(nOnly), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    // A FileAttachment annotation whose /EF points at a plain stream (no /Type /EmbeddedFile).
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /Type /Annot /Subtype /FileAttachment /FS << /F (invoice.exe) /EF << /F 10 0 R >> >> >>\nendobj\n"] }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /S /GoToR /F (\\\\host\\share\\x.pdf) >>\nendobj\n"] }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
  });

  it("parses strings, comments and nesting the way a reader does", () => {
    // Escaped and nested parentheses, a % inside a string, a ( inside a comment, empty and hex strings.
    const catalog = "/Title (a \\) b (nested (deep)) c \\\\) /Subject (50% off) /Keywords () /ID [<0a1B> <>] % note (unbalanced\n";
    expect(validatePdf(pdf({ catalog }), { maxBytes: MAX }).ok).toBe(true);
    // A comment between the dictionary and `stream` is whitespace.
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /Length 4 >> % c\nstream\nabcd\nendstream\nendobj\n"] }), { maxBytes: MAX }).ok).toBe(true);
    // A body containing a false `endstream` before the real one: what follows is scanned as top-level syntax.
    expect(validatePdf(pdf({ objects: ["9 0 obj\n<< /Length 30 >>\nstream\nab endstream /OpenAction 3 0 R\nendstream\nendobj\n"] }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    // A name inside a string is still refused (fail closed); words merely containing a listed name are not.
    expect(validatePdf(pdf({ catalog: "/Title (see /JavaScript)" }), { maxBytes: MAX })).toEqual({ ok: false, reason: "active_content" });
    expect(validatePdf(pdf({ catalog: "/Title (JavaScript object notation) /JSON 1" }), { maxBytes: MAX }).ok).toBe(true);
  });
});

describe("hasActiveContentName", () => {
  it("matches whole names only, after decoding escapes", () => {
    expect(hasActiveContentName("/JS")).toBe(true);
    expect(hasActiveContentName("/JSON /AAB /Launcher /XFAx")).toBe(false);
    expect(hasActiveContentName("/J#53")).toBe(true);
    expect(hasActiveContentName("(text /JavaScript in a string)")).toBe(true); // fail closed: raw text, strings included
    expect(hasActiveContentName("/JS\0")).toBe(true); // NUL is PDF whitespace
  });
});
