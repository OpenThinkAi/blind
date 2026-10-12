// Free-text finders: the spec's shape patterns and its entity lists, turned
// into non-overlapping spans. Pure and deterministic; the caller decides what
// each span becomes.
//
// Order: pattern matches (email, IP, MAC, GUID, host) are found first and are
// atomic, so "avery@example.com" is one email, not a name plus a host. Entity
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

import { PSEUDO_CLASSES, type PseudoClass } from "./canonical.ts";
import type { Entities, PatternName } from "../schema.ts";
import { inDateContext, isDateWord } from "./datecontext.ts";

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
   */
  source: "pattern" | "entity" | "map" | "speaker";
}

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const PATTERN_RES: Record<PatternName, RegExp> = {
  email: /(?<![\p{L}\p{N}._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?![\p{L}\p{N}-]|\.[A-Za-z0-9])/gu,
  ip: new RegExp(
    `(?<![\\d.])${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}(?!\\d|\\.\\d)|(?<![\\p{L}\\p{N}:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\\p{L}\\p{N}:]|\\.\\d)`,
    "gu",
  ),
  mac: /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])/g,
  guid: /(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])/g,
  host: /(?<![\p{L}\p{N}._-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![\p{L}\p{N}_-]|\.[A-Za-z0-9])/gu,
};

/** What each pattern's matches are pseudonymised as. */
export const PATTERN_CLASS: Record<PatternName, PseudoClass> = {
  email: "email",
  ip: "host",
  mac: "id",
  guid: "id",
  host: "host",
};

// Fixed order: when two patterns match the same span, the earlier one wins.
const PATTERN_ORDER: readonly PatternName[] = ["email", "ip", "mac", "guid", "host"];

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

function accept(name: PatternName, m: string): boolean {
  if (name === "ip" && m.includes(":")) return validIpv6(m);
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
export function findPatternSpans(text: string, patterns: Record<PatternName, boolean>, keep: readonly string[] = []): Span[] {
  const found: (Span & { rank: number })[] = [];
  PATTERN_ORDER.forEach((name, rank) => {
    if (!patterns[name]) return;
    for (const m of text.matchAll(PATTERN_RES[name])) {
      if (!accept(name, m[0])) continue;
      const start = m.index;
      const cls = name === "host" && underKeptDomain(m[0], keep) ? null : PATTERN_CLASS[name];
      found.push({ start, end: start + m[0].length, cls, value: m[0], source: "pattern", rank });
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
  source: "entity" | "map" | "speaker";
  /** A name part that is also a month or weekday word: not matched in a date context (datecontext.ts). */
  datePart: boolean;
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
  source?: "map" | "speaker";
  /** A name part (recur.ts nameParts): a month or weekday word among them is left alone in a date context (AGT-1813). */
  datePart?: boolean;
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
  constructor(entities: Entities, extra: readonly ExtraForm[] = []) {
    const seen = new Set<string>();
    const add = (key: string, cls: PseudoClass | null, raw: string, value: string, rank: number, source: Form["source"], datePart = false): void => {
      const words = raw.trim().split(/\s+/).filter((w) => w !== "");
      if (words.length === 0) return;
      const dedupe = `${key}\0${words.join(" ")}`;
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
    for (const x of extra) add(`extra:${x.cls}`, x.cls, x.form ?? x.value, x.value, ENTITY_CLASSES.length + PSEUDO_CLASSES.indexOf(x.cls), x.source ?? "map", x.datePart === true);
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

  /** End offset of `form` matched at `pos`, or -1. */
  private matchAt(text: string, pos: number, form: Form): number {
    let i = pos;
    for (let w = 0; w < form.words.length; w++) {
      if (w > 0) {
        if (!isSpace(text[i])) return -1;
        while (isSpace(text[i])) i++;
      }
      const word = form.words[w] as string;
      const got = text.slice(i, i + word.length);
      if (got.length !== word.length) return -1;
      if (form.rule === "exact") {
        if (got !== word) return -1;
      } else if (got.toLowerCase() !== form.folded[w]) return -1;
      if (form.rule === "capital" && !/^\p{Lu}/u.test(got)) return -1;
      i += word.length;
    }
    const lastWord = form.words[form.words.length - 1] as string;
    if (isWordChar(lastWord[lastWord.length - 1]) && isWordChar(text[i])) return -1;
    return i;
  }

  /** Entity spans in `text` that do not overlap any of `taken` (sorted, non-overlapping). */
  find(text: string, taken: readonly Span[] = []): Span[] {
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
      const candidates = isWordChar(text[pos - 1]) && isWordChar(ch) ? undefined : this.byFirst.get(ch.toLowerCase());
      let matched = false;
      for (const form of candidates ?? []) {
        const end = this.matchAt(text, pos, form);
        if (end < 0 || (block !== undefined && end > block.start)) continue;
        if (form.datePart && inDateContext(text, pos, end)) continue;
        out.push({ start: pos, end, cls: form.cls, value: form.value, source: form.source });
        pos = end;
        matched = true;
        break;
      }
      if (!matched) pos++;
    }
    return out;
  }
}

/** Every span to act on: pattern matches, then entity forms in the gaps, sorted by position. */
export function findSpans(
  text: string,
  matcher: EntityMatcher,
  patterns: Record<PatternName, boolean>,
  keep: readonly string[] = [],
): Span[] {
  const p = findPatternSpans(text, patterns, keep);
  const e = matcher.find(text, p);
  return [...p, ...e].sort((a, b) => a.start - b.start);
}
