// Column statistics and the fail-closed rule for `unknown` columns (design
// decision 4): an undecided column whose values look identifier-like is
// pseudonymised with the neutral `Value_` class; a low-cardinality one (an
// enum, a status) passes.

// The profiler's word list, so the engine and the profile agree on what a dictionary word is.
import { DICTIONARY } from "../profile/words.ts";

export interface ColumnStats {
  /** Non-empty values. */
  count: number;
  /** Distinct non-empty values ÷ count. */
  distinctRatio: number;
  /** Digit characters ÷ all characters. */
  digitRatio: number;
  /** Words (runs of two or more letters, as the profiler counts them) found in the dictionary ÷ all words; 0 when there are none. */
  dictionaryRatio: number;
  /** Values that are Title-Case multi-word phrases ÷ count. */
  titleCaseRatio: number;
}

export const THRESHOLDS = {
  distinct: 0.5,
  digit: 0.3,
  dictionary: 0.3,
  titleCase: 0.8,
} as const;

// Lowercase joining words allowed inside a Title-Case name ("Bank of Example").
const CONNECTORS = new Set(["of", "and", "the", "for", "de", "da", "del", "di", "du", "la", "le", "van", "von", "&"]);
const CAPITALISED_RE = /^\p{Lu}[\p{Ll}\p{M}'’.-]*\p{Ll}[\p{Ll}\p{Lu}\p{M}'’.-]*$|^\p{Lu}\.?$/u;

/** Two or more capitalised words, optionally joined by lowercase connectors ("Quillfeather Holdings"). */
export function isTitleCaseMultiWord(value: string): boolean {
  const words = value.trim().split(/\s+/).filter((w) => w !== "");
  if (words.length < 2) return false;
  let capitalised = 0;
  for (const w of words) {
    if (CAPITALISED_RE.test(w)) capitalised++;
    else if (!CONNECTORS.has(w)) return false;
  }
  return capitalised >= 2;
}

export function columnStats(values: readonly string[]): ColumnStats {
  const filled = values.map((v) => v.trim()).filter((v) => v !== "");
  const count = filled.length;
  if (count === 0) return { count: 0, distinctRatio: 0, digitRatio: 0, dictionaryRatio: 0, titleCaseRatio: 0 };
  let chars = 0;
  let digits = 0;
  let words = 0;
  let known = 0;
  let title = 0;
  for (const v of filled) {
    for (const ch of v) {
      chars++;
      if (ch >= "0" && ch <= "9") digits++;
    }
    for (const w of v.match(/\p{L}{2,}/gu) ?? []) {
      words++;
      if (DICTIONARY.has(w.toLowerCase())) known++;
    }
    if (isTitleCaseMultiWord(v)) title++;
  }
  return {
    count,
    distinctRatio: new Set(filled).size / count,
    digitRatio: digits / chars,
    dictionaryRatio: words === 0 ? 0 : known / words,
    titleCaseRatio: title / count,
  };
}

/**
 * The fail-closed test: distinct ratio ≥ 0.5 and (digit ratio ≥ 0.3, or
 * dictionary ratio ≤ 0.3, or ≥ 80% of values are Title-Case multi-word).
 */
export function isIdentifierLike(s: ColumnStats): boolean {
  if (s.count === 0) return false;
  return (
    s.distinctRatio >= THRESHOLDS.distinct &&
    (s.digitRatio >= THRESHOLDS.digit ||
      s.dictionaryRatio <= THRESHOLDS.dictionary ||
      s.titleCaseRatio >= THRESHOLDS.titleCase)
  );
}
