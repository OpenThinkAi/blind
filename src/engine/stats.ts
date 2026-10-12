// Column statistics and the fail-closed rule for `unknown` columns (design
// decision 4): an undecided column whose values look identifier-like is
// pseudonymised with the neutral `Value_` class; a low-cardinality one (an
// enum, a status) passes. So does a column of measures (dates, decimals, amounts, quantities
// with a unit) and a small repeating categorical (species, sex, status) (AGT-1822): those are
// the data a reader needs, and pseudonymising them corrupts it without protecting anyone.

// The profiler's word list, so the engine and the profile agree on what a dictionary word is.
import { DICTIONARY } from "../profile/words.ts";
import { isDateWord } from "./datecontext.ts";

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
  /** Values that are a date, time, decimal, currency amount or quantity with a unit ÷ count. */
  measureRatio: number;
  /** Distinct non-empty values. */
  distinctCount: number;
  /** Values that occur more than once in the column ÷ count. */
  repeatedRatio: number;
  /** Values with at least one letter ÷ count. */
  letterRatio: number;
}

export const THRESHOLDS = {
  distinct: 0.5,
  digit: 0.3,
  dictionary: 0.3,
  titleCase: 0.8,
  /** At least this share of values are measures: the column is data, not identifiers. */
  measure: 0.8,
  /** A categorical has at most this many distinct values, ... */
  categoricalDistinct: 10,
  /** ... at least this many values, ... */
  categoricalCount: 4,
  /** ... and at least this share of its values repeat within the column. */
  categoricalRepeated: 0.75,
} as const;

// Measures. Each regex matches a whole (trimmed) value. Plain integers are not measures: a run of
// digits may be an ID, and the numericId detector and the rules decide those.
const NUM = String.raw`[-+−]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+|\.\d+)`;
const TIME = String.raw`\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp]\.?[Mm]\.?)?(?:Z|[+-]\d{2}:?\d{2})?`;
const MEASURE_RES: readonly RegExp[] = [
  // A decimal or a grouped number: 38.6, -0.25, 1,250, 1,250.75.
  /^[-+−]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.\d+)$/,
  // ISO dates and date-times: 2026-03-14, 2026-03-14T09:30:00Z, 2026/03/14.
  new RegExp(String.raw`^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]${TIME})?$`),
  // Day-month-year in either order: 03/14/2026, 14.03.26, 14-03-2026 09:30.
  new RegExp(String.raw`^\d{1,2}[-/.]\d{1,2}[-/.](?:\d{2}|\d{4})(?:,?\s${TIME})?$`),
  // A time of day: 09:30, 9:30 pm.
  new RegExp(String.raw`^${TIME}$`),
  // A currency amount: $1,250.00, -€12.50, (£3.20), USD 40, 40.00 EUR.
  new RegExp(String.raw`^\(?[-+−]?(?:[$€£¥₹]|(?:USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY)\s?)\s?${NUM}\)?$|^\(?${NUM}\s?(?:[$€£¥₹]|USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY)\)?$`),
  // A quantity with a unit: 38.6 lb, 12%, 5 mg, 101.2 °F, 3 days.
  new RegExp(
    String.raw`^${NUM}\s?(?:%|‰|°\s?[CF]?|(?:lbs?|oz|kg|g|mg|mcg|µg|μg|ml|mL|l|L|dl|dL|cc|cm|mm|m|km|in|ft|yd|mi|mph|kph|km/h|bpm|rpm|mmHg|kcal|cal|Hz|kHz|MHz|GHz|[kKMGT]?B|[kMG]b|hrs?|h|mins?|s|secs?|ms|days?|d|wks?|weeks?|mos?|months?|yrs?|years?)\.?)$`,
  ),
];

/** A date written with a month or weekday name: "Mar 14, 2026", "14 March 2026", "Tue 3 Mar". */
function isWordDate(v: string): boolean {
  const tokens = v.split(/[\s,]+/).filter((t) => t !== "");
  if (tokens.length < 2 || tokens.length > 5) return false;
  let word = false;
  let number = false;
  for (const t of tokens) {
    const bare = t.replace(/\.$/, "");
    if (isDateWord(bare)) word = true;
    else if (/^(?:[12]\d{3}|(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?)$/.test(bare) || new RegExp(`^${TIME}$`).test(t)) number = true;
    else return false;
  }
  return word && number;
}

/** Whether a (trimmed) value is a date, time, decimal, currency amount or quantity with a unit. */
export function isMeasure(value: string): boolean {
  return MEASURE_RES.some((re) => re.test(value)) || isWordDate(value);
}

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
  if (count === 0) return { count: 0, distinctRatio: 0, digitRatio: 0, dictionaryRatio: 0, titleCaseRatio: 0, measureRatio: 0, distinctCount: 0, repeatedRatio: 0, letterRatio: 0 };
  let chars = 0;
  let digits = 0;
  let words = 0;
  let known = 0;
  let title = 0;
  let measures = 0;
  let lettered = 0;
  const seen = new Map<string, number>();
  for (const v of filled) {
    seen.set(v, (seen.get(v) ?? 0) + 1);
    if (isMeasure(v)) measures++;
    if (/\p{L}/u.test(v)) lettered++;
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
  let repeated = 0;
  for (const n of seen.values()) if (n > 1) repeated += n;
  return {
    count,
    distinctRatio: seen.size / count,
    digitRatio: digits / chars,
    dictionaryRatio: words === 0 ? 0 : known / words,
    titleCaseRatio: title / count,
    measureRatio: measures / count,
    distinctCount: seen.size,
    repeatedRatio: repeated / count,
    letterRatio: lettered / count,
  };
}

/** Mostly dates, times, decimals, amounts or quantities with a unit. */
export function isMeasureColumn(s: ColumnStats): boolean {
  return s.count > 0 && s.measureRatio >= THRESHOLDS.measure;
}

/**
 * A small set of words that repeat (species, sex, status): at most 10 distinct values over at
 * least 4, three quarters of the values occurring more than once, words not codes (digit ratio
 * under 0.3, every value has a letter) and not a column of Title-Case names.
 */
export function isCategoricalColumn(s: ColumnStats): boolean {
  return (
    s.count >= THRESHOLDS.categoricalCount &&
    s.distinctCount <= THRESHOLDS.categoricalDistinct &&
    s.repeatedRatio >= THRESHOLDS.categoricalRepeated &&
    s.digitRatio < THRESHOLDS.digit &&
    s.letterRatio === 1 &&
    s.titleCaseRatio < THRESHOLDS.titleCase
  );
}

/**
 * The fail-closed test: distinct ratio ≥ 0.5 and (digit ratio ≥ 0.3, or
 * dictionary ratio ≤ 0.3, or ≥ 80% of values are Title-Case multi-word), unless the column is
 * measures (≥ 80% dates, times, decimals, amounts or quantities with a unit) or a small
 * repeating categorical. Rules in the spec come first: this decides only unruled columns.
 */
export function isIdentifierLike(s: ColumnStats): boolean {
  if (s.count === 0) return false;
  if (isMeasureColumn(s) || isCategoricalColumn(s)) return false;
  return (
    s.distinctRatio >= THRESHOLDS.distinct &&
    (s.digitRatio >= THRESHOLDS.digit ||
      s.dictionaryRatio <= THRESHOLDS.dictionary ||
      s.titleCaseRatio >= THRESHOLDS.titleCase)
  );
}
