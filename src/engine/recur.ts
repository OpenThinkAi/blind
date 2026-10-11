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
// - not a value whose every word is in the built-in dictionary (src/profile/words.ts),
//   such as "open" or "Main Office": ordinary words are left to the spec, which
//   can still list them as entities. The audit still reports them;
// - not a spec vocabulary form, and (the caller's part) not a value from a
//   column classed `vocabulary`.
// Matching uses the entity case rules (text.ts): a short acronym only exactly,
// a single capitalised word only where the text is capitalised too, anything
// else in any case; whole tokens only; longest form first at each position,
// and a mapped value ranks after the spec entities when lengths tie.

import type { Entities, PatternName } from "../schema.ts";
import { DICTIONARY } from "../profile/words.ts";
import { canonicalize, PSEUDO_CLASSES, type PseudoClass } from "./canonical.ts";
import type { BlindMap } from "./map.ts";
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
export function recurrenceForms(values: Iterable<ExtraForm>, entities: Entities, map?: BlindMap): ExtraForm[] {
  const vocabulary = new Set((entities.vocabulary ?? []).flatMap((e) => [e.canonical, ...e.aliases, ...e.parts]).map(fold));
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
  for (const v of values) add(v.cls, v.value, canonicalize(v.cls, v.value));
  for (const e of map?.entries ?? []) if (isPseudoClass(e.kind)) add(e.kind, e.value, e.canonical);
  return [...out.values()].sort((a, b) => cmp(a.cls, b.cls) || cmp(a.form as string, b.form as string) || cmp(a.value, b.value));
}

/** One scanner for the corpus: the spec's patterns and entities plus the recurring values. */
export class TextScanner {
  private readonly spec: EntityMatcher;
  private readonly all: EntityMatcher;

  /** `keep` is the keep-list domains (keepDomains in text.ts); `forms` come from recurrenceForms. */
  constructor(
    entities: Entities,
    private readonly patterns: Record<PatternName, boolean>,
    private readonly keep: readonly string[],
    forms: readonly ExtraForm[],
  ) {
    this.spec = new EntityMatcher(entities);
    this.all = new EntityMatcher(entities, forms);
  }

  /** Free text (and cells kept as text): patterns first, then spec entities and recurring values in the gaps, longest first. */
  free(text: string): Span[] {
    return findSpans(text, this.all, this.patterns, this.keep);
  }

  /**
   * A cell under `keep`: only recurring values are replaced. Spec entities still shield their text
   * (and stay as written, reported by `flagged`), as do hosts under a keep-list domain; other pattern
   * matches do not, so a blinded email kept in a notes column is still replaced.
   */
  kept(text: string): Span[] {
    const shields = findPatternSpans(text, this.patterns, this.keep).filter((s) => s.cls === null);
    return this.all.find(text, shields).filter((s) => s.source === "map");
  }

  /** Whether a kept cell holds a spec entity or a pattern match, which `keep` leaves as written. */
  flagged(text: string): boolean {
    return findSpans(text, this.spec, this.patterns, this.keep).some((s) => s.cls !== null);
  }
}
