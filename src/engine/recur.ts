// Recurrences: a value that a column rule pseudonymised (or that an earlier map
// already holds) is replaced wherever else it turns up, in free text, kept
// cells and JSON strings, not only in its own column. Format handlers (CSV/TSV,
// JSON and text here; XLSX and DOCX alongside) collect the values their column
// pass pseudonymised, build one TextScanner for the whole corpus, and scan
// every other piece of text with it.
//
// Which values recur (recurrenceForms), fail closed but without rewriting
// ordinary prose:
// - each value as written, and its canonical form when that differs by more
//   than case (an org without "Inc.", a person as "first last");
// - every person/org/host/email/id/location/value entry of an earlier map, the
//   same way. Host labels and email local parts are pieces of a blinded value,
//   not values, and never recur on their own;
// - not a value with fewer than MIN_RECUR_LENGTH letters and digits: the audit
//   only ever calls a survivor that short a candidate, and "42" or "N/A"
//   would otherwise be rewritten in every sentence;
// - not a value whose every word is in the built-in dictionary (src/engine/words.ts),
//   such as "open" or "Main Office": ordinary words are left to the spec, which
//   can still list them as entities. The audit still reports them;
// - not a spec vocabulary form, and (the caller's part) not a value from a
//   column classed `vocabulary`.
// The name parts of each person among them (and among the map's person
// entries) recur on their own too (AGT-1803), so a lone "Quill" in a note gets
// the pseudonym of "Avery Quill" from the Owner column, as the audit requires:
// each word of 3+ letters, capitalised so it matches only where the text is
// capitalised, not a dictionary word, keep term or vocabulary form
// (partExclusion). A part two different people share is never given either's
// pseudonym: it is pseudonymised as itself (nameParts), and apply reports it.
// Matching uses the entity case rules (text.ts): a short acronym only exactly,
// a single capitalised word only where the text is capitalised too, anything
// else in any case; whole tokens only; longest form first at each position,
// and a mapped value ranks after the spec entities when lengths tie.

import type { Entities, PatternName, Patterns } from "../schema.ts";
import { DICTIONARY } from "./words.ts";
import { canonicalize, PSEUDO_CLASSES, type PseudoClass } from "./canonical.ts";
import { isHonorificOrRole } from "./honorifics.ts";
import { isDateWord } from "./datecontext.ts";
import { identityOf, type PersonAliases } from "./identity.ts";
import { looksLikePersonName } from "./prose.ts";
import type { BlindMap } from "./map.ts";
import type { ContextOptions } from "./context.ts";
import { EntityMatcher, type ExtraForm, findPatternSpans, findSpans, type Span } from "./text.ts";

/** A recurring value needs at least this many letters and digits; the audit's MIN_LEAK_LENGTH agrees. */
export const MIN_RECUR_LENGTH = 3;

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string): string[] => fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Why a form is not matched as a recurrence, or null when it is. */
export function recurrenceExclusion(form: string, vocabulary: ReadonlySet<string>): string | null {
  const w = words(form);
  if ([...w.join("")].length < MIN_RECUR_LENGTH) return `fewer than ${MIN_RECUR_LENGTH} letters and digits`;
  if (w.every((x) => DICTIONARY.has(x))) return "only dictionary words";
  if (vocabulary.has(fold(form))) return "a spec vocabulary form";
  return null;
}

/** Why a name part is not matched alone, or null when it is: the audit's rule for a lone name word (AGT-1801). */
export function partExclusion(part: string, vocabulary: ReadonlySet<string>, keep: ReadonlySet<string>): string | null {
  if ([...words(part).join("")].length < MIN_RECUR_LENGTH) return `fewer than ${MIN_RECUR_LENGTH} letters and digits`;
  // The whole word, as the audit checks it: "Rose-May" is a name even though "rose" and "may" are words.
  if (DICTIONARY.has(fold(part))) return "a dictionary word";
  if (isHonorificOrRole(part)) return "an honorific or role word";
  if (vocabulary.has(fold(part))) return "a spec vocabulary form";
  if (keep.has(fold(part))) return "a keep term";
  return null;
}

// A word of a name, as the audit reads one: letters and marks, joined by an apostrophe or a hyphen.
const NAME_WORD_RE = /[\p{L}\p{M}]+(?:['\u2019-][\p{L}\p{M}]+)*/gu;

/** Capitalised as a name part is written: "quill" and "QUILL" become "Quill"; "McDonald" stays. */
function capitalise(w: string): string {
  const lower = /\p{Ll}/u.test(w) ? w : w.toLowerCase();
  const first = String.fromCodePoint(lower.codePointAt(0) as number);
  return first.toUpperCase() + lower.slice(first.length);
}

/**
 * The parts of a person's name: each word of the value as written and of its canonical form, and
 * each piece of a hyphenated word, capitalised (so the single-word case rule applies: matched only
 * where the text is capitalised). A one-word name is not a part of itself.
 */
function personWords(value: string, canonical: string): string[] {
  const out = new Map<string, string>();
  for (const w of [...(value.match(NAME_WORD_RE) ?? []), ...(canonical.match(NAME_WORD_RE) ?? [])]) {
    for (const p of [w, ...(w.includes("-") ? w.split("-") : [])]) if (!out.has(fold(p))) out.set(fold(p), capitalise(p));
  }
  out.delete(fold(value));
  out.delete(fold(canonical));
  return [...out.values()];
}

export interface NamePart {
  /** The part, capitalised. */
  form: string;
  /** The person value it stands for, or the part itself when it is shared. */
  value: string;
  /** The part belongs to two or more different people, or is one person's whole name. */
  shared: boolean;
  /** Why it is not matched alone (partExclusion), or null. */
  exclusion: string | null;
}

/**
 * The name parts of the people in `own`: each part of three letters or more (given name, surname)
 * with its person as the value, so a lone "Quill" gets the pseudonym of "Avery Quill". People are
 * told apart by canonical form, across `own` and `others` together. A part shared by two different
 * people (or equal to someone's whole one-word name) is never given either person's pseudonym: its
 * value is the part itself, so it gets its own, as an ambiguous spec entity part does. Excluded
 * parts are returned too, with the reason, for callers that still need them. Sorted by form.
 * `aliases` (identity.ts) tells people apart by who they are, not how they are written: "J. Quill"
 * resolved to "Avery Quill" is not a second Quill.
 */
export function nameParts(
  own: Iterable<string>,
  others: Iterable<string>,
  vocabulary: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  aliases?: PersonAliases,
): NamePart[] {
  const smallest = new Map<string, string>();
  const canonicals = new Map<string, string>();
  const parts = new Map<string, { form: string; owners: Set<string>; own: boolean }>();
  const visit = (value: string, isOwn: boolean) => {
    const written = canonicalize("person", value);
    const c = identityOf(aliases, written);
    canonicals.set(written, c);
    if (isOwn) {
      const prior = smallest.get(c);
      if (prior === undefined || value < prior) smallest.set(c, value);
    }
    for (const w of personWords(value, written)) {
      const k = fold(w);
      const e = parts.get(k) ?? { form: w, owners: new Set<string>(), own: false };
      if (w < e.form) e.form = w;
      e.owners.add(c);
      e.own ||= isOwn;
      parts.set(k, e);
    }
  };
  for (const v of own) visit(v, true);
  for (const v of others) visit(v, false);
  const out: NamePart[] = [];
  for (const [k, e] of parts) {
    if (!e.own) continue;
    const whole = canonicals.get(k);
    if (whole !== undefined) e.owners.add(whole);
    const shared = e.owners.size > 1;
    const value = shared ? e.form : (smallest.get([...e.owners][0] as string) as string);
    out.push({ form: e.form, value, shared, exclusion: partExclusion(e.form, vocabulary, keep) });
  }
  return out.sort((a, b) => cmp(a.form, b.form) || cmp(a.value, b.value));
}

/** A lowercase canonical form, cased so the case rules treat it like the value it came from. */
function caseCanonical(canonical: string): string {
  // A single word of letters (the "acme" of "Acme Inc") is capitalised, so it gets the capitalised-word
  // rule and "acme" in running text is left alone. Multi-word forms match in any case anyway.
  const first = canonical.charAt(0);
  const upper = first.toUpperCase();
  if (/^\p{L}+$/u.test(canonical) && upper.length === 1) return upper + canonical.slice(1);
  return canonical;
}

const isPseudoClass = (k: string): k is PseudoClass => (PSEUDO_CLASSES as readonly string[]).includes(k);

/**
 * The forms to find again: `values` (what the column pass pseudonymised, leaving out columns classed
 * `vocabulary`) and the non-component entries of `map`. Sorted and deduplicated, so the result does
 * not depend on the order values were given in; each form's `value` was or will be given to the
 * pseudonymizer anyway, so matching it never derives a pseudonym out of order.
 */
export function recurrenceForms(values: Iterable<ExtraForm>, entities: Entities, map?: BlindMap, opts: RecurrenceOptions = {}): ExtraForm[] {
  const vocabulary = vocabularyForms(entities);
  const list = [...values];
  const out = new Map<string, ExtraForm>();
  const consider = (cls: PseudoClass, value: string, raw: string): void => {
    const form = raw.trim().replace(/\s+/g, " ");
    if (recurrenceExclusion(form, vocabulary) !== null) return;
    const key = `${cls}\0${form}`;
    const prior = out.get(key);
    // The smallest value, so two values sharing a form always resolve the same way.
    if (prior === undefined || value < prior.value) out.set(key, { cls, value, form });
  };
  const add = (cls: PseudoClass, value: string, canonical: string): void => {
    consider(cls, value, value);
    if (fold(canonical) !== fold(value)) consider(cls, value, caseCanonical(canonical));
  };
  for (const v of list) add(v.cls, v.value, canonicalize(v.cls, v.value));
  for (const e of map?.entries ?? []) if (isPseudoClass(e.kind)) add(e.kind, e.value, e.canonical);
  // Name parts come after whole values: a part that is also a whole value keeps that value's form.
  for (const p of personPartForms(list, map, vocabulary, opts)) if (!out.has(`${p.cls}\0${p.form as string}`)) out.set(`${p.cls}\0${p.form as string}`, p);
  return [...out.values()].sort((a, b) => cmp(a.cls, b.cls) || cmp(a.form as string, b.form as string) || cmp(a.value, b.value));
}

export interface RecurrenceOptions {
  /** The policy keep list: a name part equal to a keep term is not matched alone. */
  keep?: readonly string[];
  /** Transcript speakers: their parts are speakerForms', but a part a speaker shares with someone here is ambiguous. */
  speakers?: readonly string[];
  /** Person forms that stand for another person (identity.ts). */
  aliases?: PersonAliases;
}

/** Every spec vocabulary form, folded. */
export function vocabularyForms(entities: Entities): Set<string> {
  return new Set((entities.vocabulary ?? []).flatMap((e) => [e.canonical, ...e.aliases, ...e.parts]).map(fold));
}

/** The keep list, folded, as nameParts compares it. */
export const keepForms = (keep: readonly string[] = []): Set<string> => new Set(keep.map(fold));

/** A `value`-class value that reads as a person's full name (two or more words): it has name parts too (AGT-1842). */
export const isNamedValue = (v: ExtraForm): boolean => v.cls === "value" && /\S\s+\S/.test(v.value.trim()) && looksLikePersonName(v.value);

/** The person values of `values` (with the named `value`-class ones, isNamedValue) and of the map's person and named value entries. */
export function personValues(values: Iterable<ExtraForm>, map?: BlindMap): string[] {
  const out = new Set<string>();
  for (const v of values) if (v.cls === "person" || isNamedValue(v)) out.add(v.value);
  for (const e of map?.entries ?? []) if (e.kind === "person" || (e.kind === "value" && isNamedValue({ cls: "value", value: e.value }))) out.add(e.value);
  return [...out].sort(cmp);
}

/**
 * Forms for the name parts of the people in `values` (a column rule pseudonymised them) and in the
 * map, as nameParts gives them, leaving out the parts partExclusion excludes. A part whose person is
 * known only as a named `value` cell keeps class `value`, so it carries that cell's `Value_`
 * pseudonym rather than a new `Person_` one.
 */
export function personPartForms(values: Iterable<ExtraForm>, map: BlindMap | undefined, vocabulary: ReadonlySet<string>, opts: RecurrenceOptions = {}): ExtraForm[] {
  const list = [...values];
  const persons = new Set<string>();
  for (const v of list) if (v.cls === "person") persons.add(identityOf(opts.aliases, canonicalize("person", v.value)));
  for (const e of map?.entries ?? []) if (e.kind === "person") persons.add(identityOf(opts.aliases, canonicalize("person", e.value)));
  const clsOf = (value: string): PseudoClass => (persons.has(identityOf(opts.aliases, canonicalize("person", value))) ? "person" : "value");
  return nameParts(personValues(list, map), opts.speakers ?? [], vocabulary, keepForms(opts.keep), opts.aliases)
    .filter((p) => p.exclusion === null)
    .map((p) => ({ cls: p.shared ? "person" : clsOf(p.value), value: p.value, form: p.form, ...(isDateWord(p.form) ? { datePart: true } : {}) }));
}

/**
 * Person forms for people found only in prose (prose.ts, AGT-1830): each name whole, unless
 * recurrenceExclusion leaves it out, and its parts as nameParts gives them (a part shared with one of
 * `others`, the people known from columns, speakers or the map, gets a pseudonym of its own). Every
 * form has source `prose`, so a cell under `keep` is never changed for one.
 */
export function proseForms(names: readonly string[], others: Iterable<string>, vocabulary: ReadonlySet<string>, keep: ReadonlySet<string>, aliases?: PersonAliases): ExtraForm[] {
  const out: ExtraForm[] = [];
  for (const v of names) if (recurrenceExclusion(v, vocabulary) === null) out.push({ cls: "person", value: v, form: v, source: "prose" });
  for (const p of nameParts(names, others, vocabulary, keep, aliases)) {
    if (p.exclusion === null) out.push({ cls: "person", value: p.value, form: p.form, source: "prose", ...(isDateWord(p.form) ? { datePart: true } : {}) });
  }
  return out;
}

/** One scanner for the corpus: the spec's patterns and entities plus the recurring values. */
export class TextScanner {
  private readonly spec: EntityMatcher;
  private readonly all: EntityMatcher;

  /** `keep` is the keep-list domains (keepDomains in text.ts); `forms` come from recurrenceForms. */
  constructor(
    entities: Entities,
    private readonly patterns: Patterns,
    private readonly keep: readonly string[],
    forms: readonly ExtraForm[],
    /** Context-keyword redaction (context.ts); absent = off. */
    private readonly context?: ContextOptions,
  ) {
    this.spec = new EntityMatcher(entities);
    this.all = new EntityMatcher(entities, forms);
  }

  /** Free text (and cells kept as text): patterns first, then spec entities and recurring values in the gaps, longest first. */
  free(text: string): Span[] {
    return findSpans(text, this.all, this.patterns, this.keep, this.context);
  }

  /**
   * A cell under `keep`: only recurring values (and transcript speakers' names) are replaced. Spec entities still shield their text
   * (and stay as written, reported by `flagged`), as do hosts under a keep-list domain; other pattern
   * matches do not, so a blinded email kept in a notes column is still replaced.
   */
  kept(text: string): Span[] {
    const shields = findPatternSpans(text, this.patterns, this.keep).filter((s) => s.cls === null);
    return this.all.find(text, shields).filter((s) => s.source === "map" || s.source === "removed" || s.source === "speaker");
  }

  /** Whether a kept cell holds a spec entity or a pattern match, which `keep` leaves as written. */
  flagged(text: string): boolean {
    return findSpans(text, this.spec, this.patterns, this.keep).some((s) => s.cls !== null);
  }
}
