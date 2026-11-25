/**
 * The TravelDesk text clean-up rules (doc 30 §3.7, owner decision D13): a
 * reviewed, tested rule file the N1 importer applies to supplier text before
 * it becomes a draft listing. A person reviews every draft afterwards; these
 * rules only remove the noise that would otherwise be fixed by hand on every
 * page.
 *
 *  - Title tags such as "(Russian-Speaking Guide)" move out of the title into
 *    a language fact, which the option name then carries.
 *  - Listed typos are fixed ("Ballon" → "Balloon").
 *  - Internal codes are dropped ("(Code: SIC-12)", "TD-1234", "#123").
 *  - Option names are built from facts ("Shared · 4 hours · hotel pickup"),
 *    never from TravelDesk's internal offer names.
 *  - Sales description and terms (plain text from `traveldesk.content.ts`)
 *    are split into the activity document's fields: the first sentence is
 *    the subtitle, an "Inclusions" or "Exclusions" section becomes those
 *    lists, every other paragraph is an "important info" item. The activity
 *    document has no free description field.
 *  - Category: a pre-fill from a reviewed keyword table. Always confirmed by
 *    the editor at review (it is a pending field).
 *
 * Adding a rule: add it here with a test in
 * `src/server/suppliers/__tests__/traveldesk.text-rules.test.ts`.
 *
 * Pure: no env, db, clock or logger.
 */

export const TEXT_RULES_VERSION = 1;

/** "(Russian-Speaking Guide)", "[Arabic speaking]", "- English Guide" at the end. */
const LANGUAGE_TAG = /\s*[([]\s*([A-Za-z]{3,20})(?:[\s-]*speaking)?(?:\s+guide)?\s*[)\]]|\s+[-–]\s+([A-Za-z]{3,20})[\s-]*speaking(?:\s+guide)?\s*$/gi;

/** Languages a tag may name; anything else stays in the title for the editor. */
export const KNOWN_LANGUAGES = Object.freeze([
  "Arabic", "Chinese", "English", "French", "German", "Hindi", "Italian", "Japanese", "Korean", "Mandarin", "Persian", "Portuguese", "Russian", "Spanish", "Turkish", "Urdu",
]);

/** [wrong, right]; whole words, case of the first letter kept. */
export const TYPO_FIXES: readonly (readonly [string, string])[] = Object.freeze([
  ["Ballon", "Balloon"],
  ["Ballooon", "Balloon"],
  ["Safary", "Safari"],
  ["Crusie", "Cruise"],
  ["Dinnner", "Dinner"],
  ["Abudhabi", "Abu Dhabi"],
  ["Burj Khalifah", "Burj Khalifa"],
]);

/** Internal reference codes. Each match is removed with the space before it. */
export const INTERNAL_CODE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\s*[([]\s*(?:code|ref|id|sku)\s*[:#]?\s*[\w-]+\s*[)\]]/gi,
  /\s*\b(?:TD|TDK|TRV)[-_ ]?\d{2,}\b/g,
  /\s+#\d{1,8}\b/g,
]);

/** Category pre-fill: the first rule whose pattern matches the tour name or a TravelDesk category name wins. */
export const CATEGORY_RULES: readonly { pattern: RegExp; categorySlug: string }[] = Object.freeze([
  { pattern: /\b(desert|safari|dune|quad bik|buggy|camel)/i, categorySlug: "desert-safari" },
  { pattern: /\b(dhow|cruise|yacht|boat|marina sail|catamaran)/i, categorySlug: "cruises-yachts" },
  { pattern: /\b(theme park|ferrari world|warner|legoland|img worlds|motiongate|water ?park|aquaventure|wild wadi)/i, categorySlug: "theme-parks" },
  { pattern: /\b(jet ?ski|kayak|parasail|diving|snorkel|flyboard|fishing|paddle)/i, categorySlug: "water-activities" },
  { pattern: /\b(balloon|helicopter|seaplane|sky ?dive|limousine)/i, categorySlug: "luxury-experiences" },
  { pattern: /\b(city tour|sightseeing|abu dhabi|sharjah|ajman|fujairah|ras al khaimah|mosque|old dubai|heritage)/i, categorySlug: "dubai-city-tours" },
  { pattern: /\b(burj|frame|aquarium|museum|observation|sky ?view|garden|zoo|ticket)/i, categorySlug: "dubai-attractions" },
]);

/** Used when no rule matches; the editor confirms the category at review either way. */
export const FALLBACK_CATEGORY = "dubai-attractions";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fixTypos(s: string): string {
  let out = s;
  for (const [wrong, right] of TYPO_FIXES) {
    out = out.replace(new RegExp(`\\b${escapeRe(wrong)}\\b`, "gi"), (m) => (m[0] === m[0].toLowerCase() ? right.toLowerCase() : right));
  }
  return out;
}

function dropCodes(s: string): string {
  let out = s;
  for (const p of INTERNAL_CODE_PATTERNS) out = out.replace(new RegExp(p.source, p.flags), "");
  return out;
}

function titleCaseLanguage(word: string): string | null {
  const w = word.toLowerCase();
  return KNOWN_LANGUAGES.find((l) => l.toLowerCase() === w) ?? null;
}

/** A supplier tour or offer name → a clean title and the languages its tags named. */
export function cleanTitle(raw: string | null | undefined, maxChars = 120): { title: string; languages: string[] } {
  const languages: string[] = [];
  let s = collapse(dropCodes(raw ?? ""));
  s = s.replace(new RegExp(LANGUAGE_TAG.source, LANGUAGE_TAG.flags), (m, a?: string, b?: string) => {
    const lang = titleCaseLanguage(a ?? b ?? "");
    if (!lang) return m;
    if (!languages.includes(lang)) languages.push(lang);
    return "";
  });
  s = collapse(fixTypos(s)).replace(/[\s,;:–-]+$/, "");
  if (s.length > maxChars) s = `${s.slice(0, maxChars - 1).trimEnd()}…`;
  return { title: s, languages };
}

/** Clean free text (descriptions, terms, FAQ answers): typos and internal codes, per line. */
export function cleanText(raw: string | null | undefined): string {
  return (raw ?? "")
    .split("\n")
    .map((line) => fixTypos(dropCodes(line)).replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The facts an option name is built from. */
export interface OptionFacts {
  isPrivate: boolean;
  durationHours: number | null;
  pickup: boolean;
  ticket: boolean;
  languages: string[];
  startTimes: string[];
}

/**
 * "Shared · 4 hours · hotel pickup". Names within one listing are made
 * distinct: the start time is added where two names agree, then a number.
 */
export function optionNames(facts: OptionFacts[]): string[] {
  const base = facts.map((f) => {
    const parts = [f.isPrivate ? "Private" : "Shared"];
    if (f.durationHours && f.durationHours > 0) parts.push(`${f.durationHours} hour${f.durationHours === 1 ? "" : "s"}`);
    if (f.ticket) parts.push("ticket");
    else parts.push(f.pickup ? "hotel pickup" : "meet at the venue");
    for (const l of f.languages) parts.push(`${l}-speaking guide`);
    return parts.join(" · ");
  });
  const withTimes = base.map((n, i) => (base.filter((x) => x === n).length > 1 && facts[i].startTimes.length ? `${n} · from ${facts[i].startTimes[0]}` : n));
  const seen = new Map<string, number>();
  return withTimes.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    const named = k === 1 ? n : `${n} · option ${k}`;
    return named.length > 80 ? `${named.slice(0, 79).trimEnd()}…` : named;
  });
}

const INCLUDE_HEAD = /^(?:inclusions?|what'?s included|includes?|included|tour inclusions?)\s*:?\s*$/i;
const EXCLUDE_HEAD = /^(?:exclusions?|what'?s not included|not included|excludes?|tour exclusions?)\s*:?\s*$/i;
const OTHER_HEAD = /^[A-Z][A-Za-z'’ &/-]{2,40}:\s*$/;

function cap(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function firstSentence(text: string): string {
  const flat = collapse(text);
  const m = /^(.{20,200}?[.!?])(\s|$)/.exec(flat);
  return cap(m ? m[1] : flat, 200);
}

/** Sales description and terms (plain text) → the activity document's text fields. */
export function describe(salesDescription: string, terms: string): { subtitle: string; inclusions: string[]; exclusions: string[]; importantInfo: string[] } {
  const inclusions: string[] = [];
  const exclusions: string[] = [];
  const paragraphs: string[] = [];
  const walk = (text: string) => {
    let mode: "body" | "inc" | "exc" = "body";
    let para: string[] = [];
    const flush = () => {
      if (para.length) paragraphs.push(collapse(para.join(" ")));
      para = [];
    };
    for (const raw of cleanText(text).split("\n")) {
      const line = raw.trim();
      if (!line) {
        flush();
        if (mode !== "body") mode = "body";
        continue;
      }
      if (INCLUDE_HEAD.test(line)) {
        flush();
        mode = "inc";
        continue;
      }
      if (EXCLUDE_HEAD.test(line)) {
        flush();
        mode = "exc";
        continue;
      }
      if (mode !== "body" && OTHER_HEAD.test(line)) mode = "body";
      const item = line.replace(/^[•*·-]\s*/, "");
      if (mode === "inc") inclusions.push(cap(item, 300));
      else if (mode === "exc") exclusions.push(cap(item, 300));
      else if (/^[•*·-]\s/.test(line)) {
        flush();
        paragraphs.push(item);
      } else para.push(line);
    }
    flush();
  };
  walk(salesDescription);
  const descriptionParas = paragraphs.length;
  walk(terms);
  const subtitle = paragraphs.length ? firstSentence(paragraphs[0]) : "";
  // The subtitle's own sentence is not repeated as an info item when it was the whole first paragraph.
  const info = paragraphs.filter((p, i) => !(i === 0 && descriptionParas > 0 && collapse(p) === subtitle)).map((p) => cap(p, 600));
  return { subtitle, inclusions: inclusions.slice(0, 30), exclusions: exclusions.slice(0, 30), importantInfo: info.slice(0, 26) };
}

/** Category pre-fill from the tour name and TravelDesk's category names. */
export function categoryFor(tourName: string, supplierCategories: readonly string[], known: ReadonlySet<string>): string {
  const hay = [tourName, ...supplierCategories].join(" | ");
  for (const r of CATEGORY_RULES) if (r.pattern.test(hay) && known.has(r.categorySlug)) return r.categorySlug;
  return known.has(FALLBACK_CATEGORY) ? FALLBACK_CATEGORY : ([...known][0] ?? FALLBACK_CATEGORY);
}

/** Bit order of TravelDesk DaysOfWeek (`isOfferedOn`): Monday 1 … Sunday 64. */
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * TravelDesk `daysOffered` bit mask (Monday 1 … Sunday 64, as `isOfferedOn` reads it; 0 or
 * all bits = every day) → the "important info" line, or null for every day.
 * The activity document has no day field; the date picker relies on live
 * availability (doc 30 §3.4).
 */
export function daysLine(masks: readonly number[]): string | null {
  const every = (m: number) => m === 0 || (m & 127) === 127;
  if (masks.length === 0 || masks.every(every)) return null;
  const union = masks.reduce((a, m) => a | (every(m) ? 127 : m), 0);
  if ((union & 127) === 127) return "Some options run on selected days only; the calendar shows the days each option runs.";
  const days = DAY_NAMES.filter((_, i) => union & (1 << i));
  return `Runs on ${days.join(", ")} only.`;
}
