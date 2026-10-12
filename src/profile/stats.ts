// Value statistics, shape detectors, excerpts and deterministic sampling for the profile.
// Everything here is a pure function of its input: no clock, no randomness, no locale.

import { type DetectorName, type DetectorRates, MAX_EXCERPT, type ValueStats } from "../schema.ts";
import { findAddresses } from "../engine/address.ts";
import { isEpochColumn, isEpochTimestamp } from "../engine/epoch.ts";
import { DICTIONARY } from "../engine/words.ts";

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

/** Shape detectors. All but `numericId` look for the shape anywhere in the value. */
/** A detector is anything with a RegExp-style `test`. */
export const DETECTORS: Record<DetectorName, { test(value: string): boolean }> = {
  ip: new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?![\\d.]*\\d)`),
  // Starts only where a run of local-part characters starts: the same matches, in linear time on a long run with no "@".
  email: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  // A dotted name ending in a letters-only label; the domain of an email does not count as a host.
  host: /(?<![@\w.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![\w-]|\.\w)/,
  guid: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f])/,
  mac: /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}(?![0-9A-Fa-f:-])/,
  // A street address anywhere in the value, a bare street line ("12 Sample Lane") included (the `address` pattern's finder).
  address: { test: (v: string) => findAddresses(v).length > 0 },
  // The whole value: an optional short letter prefix and separator, then 4 or more digits.
  numericId: /^[A-Za-z]{0,6}[-_#]?\d{4,}$/,
};

const DETECTOR_NAMES = Object.keys(DETECTORS).sort() as DetectorName[];

/** Collapses whitespace and cuts to MAX_EXCERPT code points, ending a cut excerpt with "…". */
export function excerpt(text: string): string {
  const cps = [...text.replace(/\s+/g, " ").trim()];
  return cps.length <= MAX_EXCERPT ? cps.join("") : `${cps.slice(0, MAX_EXCERPT - 1).join("")}…`;
}

/** Picks up to `k` items spread evenly across `items`, in order. Deterministic. */
export function pick<T>(items: readonly T[], k: number): T[] {
  const n = items.length;
  if (n <= k) return [...items];
  return Array.from({ length: k }, (_, i) => items[Math.floor((i * n) / k)] as T);
}

/** Distinct items in first-seen order. */
export function distinct(items: readonly string[]): string[] {
  return [...new Set(items)];
}

const round = (x: number): number => Math.round(x * 10_000) / 10_000;
const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : round(part / whole));

/** Words for the dictionary ratio: runs of two or more letters, lower-cased. */
function words(value: string): string[] {
  return (value.match(/\p{L}{2,}/gu) ?? []).map((w) => w.toLowerCase());
}

/** Statistics over one column's (or key's) values. Empty and whitespace-only values are not counted. */
export function valueStats(raw: readonly string[], k: number, dates: readonly boolean[] = []): ValueStats {
  const values = raw.map((v) => v.trim()).filter((v) => v !== "");
  // Dates and Unix times are measurements, not IDs: numericId skips XLSX date-formatted cells and,
  // in a column that is mostly Unix times, those times.
  const dated = new Set(raw.flatMap((v, i) => (dates[i] === true && v.trim() !== "" ? [v.trim()] : [])));
  const epochs = isEpochColumn(values);
  const skips = (name: DetectorName, v: string): boolean => name === "numericId" && (dated.has(v) || (epochs && isEpochTimestamp(v)));
  const uniques = distinct(values);
  let chars = 0;
  let digits = 0;
  let wordCount = 0;
  let known = 0;
  for (const v of values) {
    const cps = [...v];
    chars += cps.length;
    digits += cps.filter((c) => c >= "0" && c <= "9").length;
    for (const w of words(v)) {
      wordCount++;
      if (DICTIONARY.has(w)) known++;
    }
  }
  const detectorRates = {} as DetectorRates;
  for (const name of DETECTOR_NAMES) {
    const re = DETECTORS[name];
    detectorRates[name] = ratio(values.filter((v) => !skips(name, v) && re.test(v)).length, values.length);
  }
  return {
    count: values.length,
    distinctRatio: ratio(uniques.length, values.length),
    digitRatio: ratio(digits, chars),
    dictionaryRatio: ratio(known, wordCount),
    meanLength: values.length === 0 ? 0 : round(chars / values.length),
    detectorRates,
    samples: pick(uniques, k).map(excerpt),
  };
}
