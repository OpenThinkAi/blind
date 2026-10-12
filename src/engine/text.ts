// Free-text finders: the spec's shape patterns and its entity lists, turned
// into non-overlapping spans. Pure and deterministic; the caller decides what
// each span becomes.
//
// Order: pattern matches (email, IP, MAC, GUID, phone, host, secret) and spoken values (spelled
// digits, spoken emails; spelled.ts) are found first and are atomic, so
// "avery@example.com" is one email, not a name plus a host. Entity
// forms are then matched in the gaps, longest form first at each position,
// whole-token only.
//
// Case rules, per entity form (by its shape, as written in the spec):
// - an acronym (no lowercase letters, at most 6 letters, e.g. "EXW") matches
//   only exactly, so "EXW" never matches "exw";
// - a single capitalised word (a given name or surname part, e.g. "Avery" or
//   "May") matches case-insensitively but only where the text starts with a
//   capital, so "May" matches "May" and "MAY" but not "may";
// - anything else (multi-word names, lowercase handles) matches
//   case-insensitively.
// A vocabulary form wins any length tie with another form, so a listed acronym ("SAM") is kept
// even though a person part ("Sam") would also match its all-caps text.
// Whitespace between the words of a multi-word form matches any run of
// whitespace, so a name wrapped across lines is still found.
//
// One person, one span (AGT-1842): adjacent matches that stand for the same
// person (the same class and value, `person` or a named `value`) and share no
// word are joined into one span when only a joiner separates them: spaces, a
// comma, `+`, `.`, `_`, `-` or a URL-encoded space or comma (`%20`, `%2C`). So
// "q=Dana+Marwick", "Marwick, Dana" and "Marwick.Dana" each become the
// person's pseudonym once. A dotted initial right before or after such a span
// that is the initial of another word of that person's name is taken in too
// ("Marwick D."). A match may start right after a URL escape ("%20Marwick").

import { PSEUDO_CLASSES, phoneDigits, type PseudoClass, type RealPseudoClass, cardDigits } from "./canonical.ts";
export { cardDigits };
import { type Entities, type PatternName, type Patterns, patternOn } from "../schema.ts";
import { inDateContext, isDateWord } from "./datecontext.ts";
import { type CellRule, cellValueSpan, type ContextOptions, findContextSpans } from "./context.ts";
import { findSecretSpans, type SecretCarry, type SecretOptions, type SecretSpan } from "./secret.ts";
import { findAddresses } from "./address.ts";
import { findSpelledDigits, findSpokenEmails } from "./spelled.ts";
import { DICTIONARY } from "./words.ts";
import { isHonorificOrRole } from "./honorifics.ts";

export interface Span {
  start: number;
  end: number;
  /**
   * null: kept as written. For an entity, a vocabulary form that shields its text from other
   * entity forms; for a pattern, a host under a keep-list domain.
   */
  cls: PseudoClass | null;
  /**
   * The value the pseudonym is derived from: the matched text for a pattern, the spec form for an
   * entity, the value already given to the pseudonymizer for an extra form.
   */
  value: string;
  /**
   * `map`: an extra form, a value pseudonymised elsewhere (a column rule, an earlier map) found again here.
   * `speaker`: a transcript speaker's tag, or their name, a part of it or a misspelling (transcript.ts).
   * `prose`: a person found only in free text (prose.ts), or a part of their name.
   * `removed`: a value of a dropped or redacted column, found again here (AGT-1835).
   */
  source: "pattern" | "entity" | "map" | "speaker" | "prose" | "removed";
  /**
   * A known person's surname that a capitalised given name stood right before: the span covers both
   * and is a new person (joinGivenNames, AGT-1854). Counted in the report.
   */
  joined?: true;
  /** Internal to find(): the span is a lone surname part of a known person. Never present in its result. */
  surname?: true;
  /** For a shape-pattern match (findPatternSpans): which pattern found it, so the audit names it even when only the context made it one. */
  pattern?: PatternName;
}

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const DASHES = "\\u2010-\\u2015";
const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PATTERN_RES: Record<Exclude<PatternName, "secret" | "address">, RegExp> = {
  email: /(?<![\p{L}\p{N}._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?![\p{L}\p{N}-]|\.[A-Za-z0-9])/gu,
  ip: new RegExp(
    `(?<![\\d.])${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?!\\d|\\.\\d)|(?<![\\p{L}\\p{N}:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\\p{L}\\p{N}:]|\\.\\d)`,
    "gu",
  ),
  mac: /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])/g,
  guid: /(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])/g,
  // A phone: North American (optional +1, a three-digit area code, 3 + 4 digits, with separators or
  // parentheses) or international (a leading + and country code). A separator is a space, ".", "-", a
  // Unicode dash, "/" or "?" (a dash mangled by a lossy 8-bit conversion). Bare digit runs are phones
  // only with context (barePhoneSpans), so ids, amounts and dates that merely contain digits are left
  // alone (accept() checks phoneDigits).
  phone: new RegExp(
    `(?<![\\p{L}\\p{N}_+/]|\\p{N}[.\\-/?${DASHES}])(?:` +
      `(?:\\+?1[ .\\-/?${DASHES}]?)?(?:\\(\\d{3}\\)[ .\\-/?${DASHES}]?|\\d{3}[ .\\-/?${DASHES}])\\d{3}[ .\\-/?${DASHES}]\\d{4}` +
      "|\\+\\d{1,3}(?:[ \\t.-]?\\(?\\d{1,4}\\)?){2,6}" +
      `)(?![\\p{L}\\p{N}_]|[.\\-/${DASHES}]\\d)`,
    "gu",
  ),
  // A card number: 13 to 19 digits, unseparated or grouped 4-4-4-4(-3), 4-6-5 or 4-6-4 by spaces or dashes.
  // accept() keeps only those with a card IIN prefix and a valid Luhn checksum (cardDigits).
  card: /(?<![\p{L}\p{N}_]|\d-)(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{4}(?:\1\d{3})?|\d{4}([ -])\d{6}\2\d{5}|\d{4}([ -])\d{6}\3\d{4})(?![\p{L}\p{N}_]|-\d)/gu,
  host: /(?<![\p{L}\p{N}._-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![\p{L}\p{N}_-]|\.[A-Za-z0-9])/gu,
};

/** What each pattern's matches are pseudonymised as. */
export const PATTERN_CLASS: Record<PatternName, PseudoClass> = {
  email: "email",
  ip: "host",
  mac: "id",
  guid: "id",
  host: "host",
  phone: "id",
  address: "location",
  // Not a pseudonym: a card number is written as the fixed placeholder, like a secret (card.ts).
  card: "redact",
  // Not a pseudonym: a secret is written as the fixed placeholder (secret.ts).
  secret: "redact",
};

// Fixed order: when two patterns match the same span, the earlier one wins.
// `secret` is last: a token another pattern matches is never a secret.
const PATTERN_ORDER: readonly PatternName[] = ["email", "ip", "mac", "guid", "card", "phone", "address", "host", "secret"];

/** Every shape but `secret`: what secret.ts asks about a token ("is this whole token an email, a phone ...?"). */
const OTHER_SHAPES: Patterns = { email: true, ip: true, mac: true, guid: true, phone: true, card: true, host: true, address: false, secret: false };

// Two-label names count as hosts only under these suffixes, so "notes.txt" or
// "report.md" is not a host; three or more labels ("db01.example.com") always count.
const HOST_TLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "io", "co", "ai", "dev", "app", "cloud", "biz", "info",
  "local", "lan", "internal", "intranet", "corp", "home", "example", "test", "invalid", "localhost", "uk", "us",
  "de", "fr", "nl", "eu", "ca", "au", "jp", "ch", "se", "no", "es", "it",
]);

export function validIpv6(s: string): boolean {
  if (!s.includes(":")) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  if (groups.length === 0 || groups.some((g) => g === "" || g.length > 4)) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

// A bare run of NANP digits: 10, or 1 and 10; the area code and the exchange start 2-9.
const BARE_PHONE_RE = /(?<![\p{L}\p{N}_+$.,/\\?-])1?[2-9]\d{2}[2-9]\d{6}(?![\p{L}\p{N}_]|[.,\-/?]\d)/gu;
// Words that say a number nearby is a phone number: "phone", "tel=", "cell:", "call", "contact", "#".
const PHONE_WORDS = new Set(["phone", "phones", "tel", "telephone", "cell", "cellphone", "mobile", "mob", "call", "calls", "text", "sms", "contact", "ph", "fax", "whatsapp", "#"]);
// Words that make a "#" or a nearby number something else: "order #", "accession 2023..".
const NOT_PHONE_WORDS = new Set(["order", "accession", "invoice", "account", "acct", "case", "ticket", "serial", "sku", "ref", "reference", "id", "chip", "microchip", "tracking", "confirmation", "po", "claim", "policy", "member", "receipt", "tag", "lot", "batch", "isbn", "barcode", "upc"]);
// A parenthetical relation or role next to a number: "Sam Sample (sister) 5555550100".
const RELATIONS = new Set([
  "sister", "brother", "sibling", "mother", "father", "mom", "mum", "dad", "parent", "wife", "husband", "spouse", "partner", "son", "daughter",
  "aunt", "uncle", "cousin", "grandmother", "grandfather", "grandma", "grandpa", "friend", "neighbor", "neighbour", "roommate", "boyfriend",
  "girlfriend", "fiance", "fiancee", "guardian", "owner", "emergency", "colleague", "coworker", "landlord", "cell", "mobile", "home", "work", "office",
]);

/** Whether the words just before a bare number, or a relation in parentheses beside it, say it is a phone number. */
function phoneContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 80), start);
  const after = text.slice(end, end + 40);
  const rel = (w: string): boolean => RELATIONS.has(w.trim().toLowerCase());
  const lead = /\(([\p{L} ]{2,20})\)[ \t]*[:\-\u2013\u2014]?[ \t]*$/u.exec(before);
  if (lead?.[1] !== undefined && rel(lead[1])) return true;
  const trail = /^[ \t]*\(([\p{L} ]{2,20})\)/u.exec(after);
  if (trail?.[1] !== undefined && rel(trail[1])) return true;
  const tokens = (before.toLowerCase().match(/#|\p{L}+/gu) ?? []).slice(-4);
  const last = tokens[tokens.length - 1];
  if (last !== undefined && NOT_PHONE_WORDS.has(last)) return false;
  if (tokens.slice(-2).includes("#") && tokens.length >= 2 && NOT_PHONE_WORDS.has(tokens[tokens.length - 2] as string)) return false;
  return tokens.some((t) => PHONE_WORDS.has(t));
}

/** Bare 10-digit (or 1 and 10) runs that are NANP-valid and read as a phone from the words around them (AGT-1848). */
function barePhoneSpans(text: string): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  for (const m of text.matchAll(BARE_PHONE_RE)) {
    if (!phoneContext(text, m.index, m.index + m[0].length)) continue;
    // Written with separators for the pseudonymizer, so a bare number gets the same Id_ pseudonym as
    // "555-555-0100" (a bare digit run would get a number-shaped one) and drops a leading 1 as they do.
    const d = m[0].slice(-10);
    out.push({ start: m.index, end: m.index + m[0].length, value: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` });
  }
  return out;
}

function accept(name: PatternName, m: string): boolean {
  if (name === "card") return cardDigits(m) !== undefined;
  if (name === "ip" && m.includes(":")) return validIpv6(m);
  if (name === "phone") return phoneDigits(m) !== undefined;
  if (name === "host") {
    const labels = m.split(".");
    return labels.length >= 3 || HOST_TLDS.has((labels[labels.length - 1] as string).toLowerCase());
  }
  return true;
}

/**
 * The domain-shaped terms of the policy keep list ("vendor.example.net", or "*.vendor.example.net"),
 * lowercased. Terms without a dot are not domains, so a keep term such as "com" never keeps a host.
 */
export function keepDomains(terms: readonly string[]): string[] {
  const out = new Set<string>();
  for (const term of terms) {
    const d = term.trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "");
    if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(d)) out.add(d);
  }
  return [...out].sort(cmp);
}

/** A host equal to a kept domain or under it, by whole labels ("api.vendor.example.net" is under "vendor.example.net"; "badvendor.example.net" is not). */
export function underKeptDomain(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Pattern matches in `text`. A host match under one of `keep` (from keepDomains) is returned with
 * `cls: null`: kept as written, and still shielding its text from entity forms.
 */
export function findPatternSpans(text: string, patterns: Patterns, keep: readonly string[] = [], carry?: SecretCarry): Span[] {
  const found: (Span & { rank: number })[] = [];
  PATTERN_ORDER.forEach((name, rank) => {
    if (!patternOn(patterns, name)) return;
    if (name === "secret") {
      for (const s of findSecretSpans(text, wholeOtherShape, carry === undefined ? {} : { carry })) {
        found.push({ start: s.start, end: s.end, cls: "redact", value: text.slice(s.start, s.end), source: "pattern", pattern: name, rank });
      }
      return;
    }
    if (name === "address") {
      for (const a of findAddresses(text)) found.push({ start: a.start, end: a.end, cls: "location", value: text.slice(a.start, a.end), source: "pattern", pattern: name, rank });
      return;
    }
    for (const m of text.matchAll(PATTERN_RES[name])) {
      if (!accept(name, m[0])) continue;
      const start = m.index;
      const cls = name === "host" && underKeptDomain(m[0], keep) ? null : PATTERN_CLASS[name];
      found.push({ start, end: start + m[0].length, cls, value: m[0], source: "pattern", pattern: name, rank });
    }
    if (name === "phone") {
      for (const b of barePhoneSpans(text)) found.push({ ...b, cls: PATTERN_CLASS.phone, source: "pattern", pattern: name, rank });
    }
  });
  // Leftmost first; at the same start the longest; then the fixed pattern order.
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  const out: Span[] = [];
  let taken = 0;
  for (const { rank: _rank, ...s } of found) {
    if (s.start < taken) continue;
    out.push(s);
    taken = s.end;
  }
  return out;
}

/** Whether another shape (email, IP, MAC, GUID, phone, host) matches all of `token`. */
function wholeOtherShape(token: string): boolean {
  return findPatternSpans(token, OTHER_SHAPES).some((s) => s.start === 0 && s.end === token.length);
}

/** The secret pattern's matches in `text`, read exactly as the engine reads them (for the audit). */
export function secretSpans(text: string, opts: SecretOptions = {}): SecretSpan[] {
  return findSecretSpans(text, wholeOtherShape, opts);
}

type CaseRule = "exact" | "capital" | "fold";

interface Form {
  words: string[];
  folded: string[];
  rule: CaseRule;
  cls: PseudoClass | null;
  value: string;
  /** Characters excluding the flexible whitespace, for longest-first ordering. */
  length: number;
  /** Position of the entity class in ENTITY_CLASSES, the tie-breaker between equal lengths. */
  rank: number;
  /** A vocabulary form: wins every length tie, so it shields its span from other forms. */
  shield: boolean;
  source: "entity" | "map" | "speaker" | "prose" | "removed";
  /** A name part that is also a month or weekday word: not matched in a date context (datecontext.ts). */
  datePart: boolean;
  /** Leading words matched but not replaced (ExtraForm.lead). */
  lead: number;
  /** A surname part of a known person (ExtraForm.surname). */
  surname: boolean;
}

const WORDCHAR_RE = /[\p{L}\p{N}]/u;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORDCHAR_RE.test(ch);
const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

function caseRule(form: string, words: readonly string[]): CaseRule {
  const letters = form.match(/\p{L}/gu) ?? [];
  if (letters.length > 0 && letters.length <= 6 && !/\p{Ll}/u.test(form)) return "exact";
  if (words.length === 1 && /^\p{Lu}/u.test(form)) return "capital";
  return "fold";
}

const ENTITY_CLASSES = ["person", "org", "host", "email", "id", "location", "vocabulary"] as const;

/** A literal value to match like an entity form, such as a cell value pseudonymised by a column rule. */
export interface ExtraForm {
  cls: PseudoClass;
  /** What the pseudonym is derived from: a value the pseudonymizer is given anyway. */
  value: string;
  /** The text to match, under the case rule of its own shape; `value` when omitted. */
  form?: string;
  /** The span source for matches; `map` when omitted. */
  source?: "map" | "speaker" | "prose" | "removed";
  /** A value of a removed (`drop`/`redact`) column that is a person's name: its name parts are redacted too (AGT-1847). */
  named?: boolean;
  /** A name part (recur.ts nameParts): a month or weekday word among them is left alone in a date context (AGT-1813). */
  datePart?: boolean;
  /**
   * Leading words that must be there but stay as written: the title of "Dr. Thornby" when only the
   * titled form resolves to one person (identity.ts). The span covers the words after them.
   */
  lead?: number;
  /**
   * A surname part of a known person (recur.ts personPartForms): a capitalised given name right
   * before it makes a different person's full name, not the known person's lone surname (AGT-1854).
   */
  surname?: boolean;
}

/** What a joined given name may not be: the policy's keep terms and the spec's vocabulary forms, folded. */
export interface JoinOptions {
  keep?: ReadonlySet<string>;
  vocabulary?: ReadonlySet<string>;
}

/** An index of every entity form in the spec, ready to scan text with. */
export class EntityMatcher {
  private readonly byFirst = new Map<string, Form[]>();
  readonly empty: boolean;

  /**
   * `extra` forms (cell values pseudonymised by column rules, for names and recurrences) follow the
   * same case rules, give spans with source `map`, and rank after every spec entity class when
   * lengths tie. Of two extras with the same class and form, the first is kept: pass them sorted.
   */
  constructor(entities: Entities, extra: readonly ExtraForm[] = [], private readonly joinOpts: JoinOptions = {}) {
    const seen = new Set<string>();
    const add = (key: string, cls: PseudoClass | null, raw: string, value: string, rank: number, source: Form["source"], datePart = false, lead = 0, surname = false): void => {
      const words = raw.trim().split(/\s+/).filter((w) => w !== "");
      if (words.length === 0 || lead >= words.length) return;
      const dedupe = `${key}\0${lead}\0${words.join(" ")}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const form: Form = {
        words,
        folded: words.map((w) => w.toLowerCase()),
        rule: caseRule(raw, words),
        cls,
        value,
        length: words.join("").length,
        rank,
        shield: key === "vocabulary",
        source,
        datePart: datePart && words.length === 1 && isDateWord(raw.trim()),
        lead,
        surname: surname && words.length === 1 && lead === 0,
      };
      const first = (words[0] as string)[0]?.toLowerCase() as string;
      const list = this.byFirst.get(first) ?? [];
      list.push(form);
      this.byFirst.set(first, list);
    };
    for (const [rank, key] of ENTITY_CLASSES.entries()) {
      const cls: PseudoClass | null = key === "vocabulary" ? null : key;
      for (const e of entities[key] ?? []) {
        for (const raw of [e.canonical, ...e.aliases, ...e.parts]) add(key, cls, raw, raw, rank, "entity");
      }
    }
    for (const x of extra) add(`extra:${x.cls}`, x.cls, x.form ?? x.value, x.value, ENTITY_CLASSES.length + PSEUDO_CLASSES.indexOf(x.cls as RealPseudoClass), x.source ?? "map", x.datePart === true, x.lead ?? 0, x.surname === true);
    // Longest first; at equal length a vocabulary form wins (so "SAM" listed as vocabulary is not
    // taken for the person part "Sam"); then class order, then text, so the scan is order-independent.
    for (const list of this.byFirst.values()) {
      list.sort(
        (a, b) =>
          b.length - a.length || Number(b.shield) - Number(a.shield) || a.rank - b.rank || cmp(a.value, b.value),
      );
    }
    this.empty = this.byFirst.size === 0;
  }

  /** End offset of `form` matched at `pos`, or -1. `starts`, when given, receives each word's offset. */
  private matchAt(text: string, pos: number, form: Form, caseless = false, starts?: number[]): number {
    let i = pos;
    for (let w = 0; w < form.words.length; w++) {
      if (w > 0) {
        if (!isSpace(text[i])) return -1;
        while (isSpace(text[i])) i++;
      }
      starts?.push(i);
      const word = form.words[w] as string;
      const got = text.slice(i, i + word.length);
      if (got.length !== word.length) return -1;
      if (form.rule === "exact") {
        if (got !== word) return -1;
      } else if (got.toLowerCase() !== form.folded[w]) return -1;
      if (form.rule === "capital" && !caseless && !/^\p{Lu}/u.test(got)) return -1;
      i += word.length;
    }
    const lastWord = form.words[form.words.length - 1] as string;
    if (isWordChar(lastWord[lastWord.length - 1]) && isWordChar(text[i])) return -1;
    return i;
  }

  /**
   * Entity spans in `text` that do not overlap any of `taken` (sorted, non-overlapping). `caseless`
   * drops the capitalised-word rule, so a single name word matches in any case ("sample" for
   * "Sample"): for names written as identifiers (names.ts); short acronyms still match exactly.
   */
  find(text: string, taken: readonly Span[] = [], caseless = false): Span[] {
    if (this.empty) return [];
    const out: Span[] = [];
    let t = 0;
    let pos = 0;
    while (pos < text.length) {
      while (t < taken.length && (taken[t] as Span).end <= pos) t++;
      const block = taken[t];
      if (block !== undefined && block.start <= pos) {
        pos = block.end;
        continue;
      }
      const ch = text[pos] as string;
      const inWord = isWordChar(text[pos - 1]) && isWordChar(ch) && !URL_ESCAPE_BEFORE_RE.test(text.slice(Math.max(0, pos - 3), pos));
      const candidates = inWord ? undefined : this.byFirst.get(ch.toLowerCase());
      let matched = false;
      for (const form of candidates ?? []) {
        const starts: number[] = [];
        const end = this.matchAt(text, pos, form, caseless, starts);
        if (end < 0 || (block !== undefined && end > block.start)) continue;
        if (form.datePart && inDateContext(text, pos, end)) continue;
        out.push({ start: starts[form.lead] as number, end, cls: form.cls, value: form.value, source: form.source, ...(form.surname ? { surname: true as const } : {}) });
        pos = end;
        matched = true;
        break;
      }
      if (!matched) pos++;
    }
    const joined = joinPersonSpans(text, out, taken);
    return caseless ? joined.map(({ surname: _s, ...rest }) => rest) : joinGivenNames(text, joined, taken, this.joinOpts);
  }
}

const URL_ESCAPE_BEFORE_RE = /%[0-9A-Fa-f]{2}$/;
// What may stand between two parts of one person's name for them to be read as one name.
const JOINER_RE = /^(?:[ \t\u00a0]+|[ \t\u00a0]*,[ \t\u00a0]*|,?\+|[._-]|%20|%2[Cc](?:%20|\+)?)$/;
const nameWords = (s: string): string[] => s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether two spans may stand for one person: the same person-like class and value. */
const samePerson = (a: Span, b: Span): boolean => a.cls === b.cls && (a.cls === "person" || a.cls === "value") && a.value === b.value;

// Name particles that sit inside a surname: Irish and Scottish ("O'", "Ó", "Ní", "Mac", "Mc"), Romance and
// Germanic ("de", "del", "van", "von") and Arabic ("bin", "al-"). A lone particle is never a given name.
const PARTICLE = "(?:O['\u2019]|Ó|Ní|Mac|Mc|de|del|van|von|bin|al-)";
const GIVEN_BEFORE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}'\u2019-])(\\p{Lu}[\\p{L}\\p{M}]*(?:['\u2019-][\\p{L}\\p{M}]+)*)(?:[ \\t\u00a0]+${PARTICLE}[ \\t\u00a0]*|[ \\t\u00a0]+)$`,
  "u",
);

/**
 * A lone surname part of a known person with a capitalised given name right before it (optionally a
 * name particle between) is another person's full name, not the known person's surname alone
 * (AGT-1854): "Sam Quillfeather" next to "Dana Quillfeather". The span grows to cover both and is a new
 * person, so the known person's pseudonym is not reused and the given name does not survive. The word
 * must be capitalised and not a dictionary word, honorific or role, month or weekday, keep term or
 * vocabulary form, nor already part of a span. Marked `joined`; the internal `surname` mark is dropped.
 */
function joinGivenNames(text: string, spans: Span[], taken: readonly Span[], opts: JoinOptions): Span[] {
  let lowerTaken = 0;
  let prevEnd = 0;
  const out: Span[] = [];
  for (const span of spans) {
    const { surname, ...s } = span;
    const lowest = (): number => {
      lowerTaken = 0;
      for (const t of taken) if (t.end <= s.start && t.end > lowerTaken) lowerTaken = t.end;
      return Math.max(prevEnd, lowerTaken);
    };
    if (surname === true && s.cls === "person" && nameWords(text.slice(s.start, s.end)).length === 1) {
      const lo = lowest();
      const m = GIVEN_BEFORE_RE.exec(text.slice(lo, s.start));
      if (m !== null) {
        const given = m[1] as string;
        const folded = given.normalize("NFKC").toLowerCase();
        const eligible =
          (given.match(/\p{L}/gu) ?? []).length >= 2 &&
          !DICTIONARY.has(folded) &&
          !isHonorificOrRole(given) &&
          !isDateWord(folded) &&
          !(opts.keep?.has(folded) ?? false) &&
          !(opts.vocabulary?.has(folded) ?? false);
        if (eligible) {
          const start = lo + m.index;
          const full = text.slice(start, s.end).replace(/[ \t\u00a0]+/g, " ");
          out.push({ ...s, start, value: full, joined: true });
          prevEnd = s.end;
          continue;
        }
      }
    }
    out.push(s);
    prevEnd = s.end;
  }
  return out;
}

/**
 * Adjacent spans of one person joined (see the header), and a dotted initial of that person taken in.
 * `spans` are sorted and do not overlap; nor does the result, nor does it reach into `taken`.
 */
function joinPersonSpans(text: string, spans: Span[], taken: readonly Span[]): Span[] {
  if (spans.length === 0) return spans;
  const free = (start: number, end: number): boolean => !taken.some((t) => t.start < end && start < t.end);
  const out: Span[] = [];
  let words = new Set<string>();
  for (const s of spans) {
    const prev = out[out.length - 1];
    const own = nameWords(text.slice(s.start, s.end));
    if (
      prev !== undefined &&
      samePerson(prev, s) &&
      JOINER_RE.test(text.slice(prev.end, s.start)) &&
      own.every((w) => !words.has(w))
    ) {
      prev.end = s.end;
      for (const w of own) words.add(w);
      continue;
    }
    out.push({ ...s });
    words = new Set(own);
  }
  for (let i = 0; i < out.length; i++) {
    const s = out[i] as Span;
    if (s.cls !== "person" && s.cls !== "value") continue;
    const have = new Set(nameWords(text.slice(s.start, s.end)));
    const valueWords = nameWords(s.value);
    if (!valueWords.some((w) => have.has(w))) continue;
    const initials = new Set(valueWords.filter((w) => !have.has(w) && [...w].length > 1).map((w) => String.fromCodePoint(w.codePointAt(0) as number)));
    if (initials.size === 0) continue;
    const lower = i > 0 ? (out[i - 1] as Span).end : 0;
    const upper = i + 1 < out.length ? (out[i + 1] as Span).start : text.length;
    const after = /^,?[ \t\u00a0]+(\p{Lu})\.(?![\p{L}\p{N}])/u.exec(text.slice(s.end, upper));
    if (after !== null && initials.has((after[1] as string).toLowerCase()) && free(s.end, s.end + after[0].length)) {
      s.end += after[0].length;
      continue;
    }
    const before = /(?<![\p{L}\p{N}.])(\p{Lu})\.[ \t\u00a0]+$/u.exec(text.slice(lower, s.start));
    if (before !== null && initials.has((before[1] as string).toLowerCase()) && free(s.start - before[0].length, s.start)) s.start -= before[0].length;
  }
  return out;
}

/**
 * Spoken values (spelled.ts), each normalised and then classed by the normal patterns: a run of four
 * or more spelled digits ("eight oh one five") becomes its digit string, classed by the first enabled
 * pattern that matches it whole and `id` otherwise; a spoken email ("avery dot quill at example dot
 * com") becomes the written address and is kept only when the `email` pattern is on and matches it.
 * Spans have source `pattern`, and `value` is the normalised form, so a spoken value and the same
 * value written out share one pseudonym.
 */
export function findSpelledSpans(text: string, patterns: Patterns): Span[] {
  const whole = (v: string): PseudoClass | null => {
    const [s] = findPatternSpans(v, patterns);
    return s !== undefined && s.start === 0 && s.end === v.length ? s.cls : null;
  };
  const out: Span[] = [];
  for (const d of findSpelledDigits(text)) {
    out.push({ start: d.start, end: d.end, cls: whole(d.normalised) ?? "id", value: d.normalised, source: "pattern" });
  }
  if (patterns.email) {
    for (const e of findSpokenEmails(text, (label) => HOST_TLDS.has(label.toLowerCase()))) {
      if (whole(e.normalised) === "email") out.push({ start: e.start, end: e.end, cls: "email", value: e.normalised, source: "pattern" });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * The value after each context keyword (context.ts), as `redact` spans: written as a fixed placeholder,
 * the keyword left alone. A value spoken in digits ("gate code four four seven one") is taken whole.
 */
function findRedactSpans(text: string, context: ContextOptions, spelled: readonly Span[]): Span[] {
  return findContextSpans(text, context).map((c) => {
    const spoken = spelled.find((s) => s.start === c.start && s.end > c.end);
    const end = spoken === undefined ? c.end : spoken.end;
    return { start: c.start, end, cls: "redact", value: text.slice(c.start, end), source: "pattern" };
  });
}

/**
 * Pattern matches and spoken values together, leftmost first and longest at the same start, without
 * overlaps: "jane at example.com" is one spoken email, not a lone host.
 */
function shapeSpans(text: string, patterns: Patterns, keep: readonly string[], context?: ContextOptions, carry?: SecretCarry): Span[] {
  const spelled = findSpelledSpans(text, patterns);
  const p = findPatternSpans(text, patterns, keep, carry);
  const secrets = context === undefined ? [] : findRedactSpans(text, context, spelled);
  if (spelled.length === 0 && secrets.length === 0) return p;
  // At the same start and length a redaction comes first: the placeholder says more than a pseudonym.
  const all = [...secrets, ...p, ...spelled].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  let taken = 0;
  for (const s of all) {
    if (s.start < taken) continue;
    out.push(s);
    taken = s.end;
  }
  return out;
}

/**
 * Every span to act on: pattern matches, spoken values and, when `context` is given, redactions after
 * context keywords, then entity forms in the gaps, sorted by position. `carry` is the secret
 * pattern's trigger boost across calls over one document (secret.ts).
 */
export function findSpans(
  text: string,
  matcher: EntityMatcher,
  patterns: Patterns,
  keep: readonly string[] = [],
  context?: ContextOptions,
  carry?: SecretCarry,
): Span[] {
  const p = shapeSpans(text, patterns, keep, context, carry);
  const e = matcher.find(text, p);
  return [...p, ...e].sort((a, b) => a.start - b.start);
}

/**
 * `spans` (found in `text`) with the value of a table cell redacted: `rule` is the label in the
 * neighbouring cell that names it (context.ts, pairCells). Whatever else was found inside the value
 * is replaced by the placeholder; spans elsewhere in the text stay.
 */
export function withCellRedaction(spans: readonly Span[], text: string, rule: CellRule): Span[] {
  const v = cellValueSpan(text, rule);
  if (v === null) return [...spans];
  const redact: Span = { start: v[0], end: v[1], cls: "redact", value: text.slice(v[0], v[1]), source: "pattern" };
  return [...spans.filter((s) => s.end <= v[0] || s.start >= v[1]), redact].sort((a, b) => a.start - b.start);
}
