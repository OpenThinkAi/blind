// The street-address finder (the `address` pattern): a house number, an optional direction, one to four
// street-name words, a street suffix, then optionally a unit and `City ST 12345`. The whole run is one
// span, so no house number or suffix is left beside a pseudonym. Pure and deterministic.
//
// Precision comes from the shape, in this order: a house number is required (so "a car on Example Rd"
// stays); the street words must be capitalised (or an already-issued pseudonym token, or an ordinal such
// as "5th"); the words are never a measure, a dose or a time word ("2 Tabs", "10 Days", "5 Units"), an
// honorific ("Dr"), and the number is never a room, suite or bed number ("Room 12 Oak Way"); "Dr" as the
// suffix is refused when a capitalised word follows it with no comma, since that reads as "Dr Sample".

const SUFFIXES = new Set([
  "st", "street", "rd", "road", "ave", "avenue", "blvd", "boulevard", "ln", "lane", "dr", "drive", "way",
  "ct", "court", "cir", "circle", "pl", "place", "pkwy", "parkway", "hwy", "highway", "ter", "terrace",
  "trl", "trail", "loop",
]);

const DIRECTIONS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]);

// Words that cannot be part of a street name: measures, doses, times, counts, honorifics.
const NOT_STREET = new Set([
  "tab", "tabs", "tablet", "tablets", "pill", "pills", "cap", "caps", "capsule", "capsules", "dose", "doses",
  "drop", "drops", "spray", "sprays", "puff", "puffs", "unit", "units", "day", "days", "week", "weeks",
  "month", "months", "year", "years", "hour", "hours", "hr", "hrs", "minute", "minutes", "min", "mins",
  "second", "seconds", "sec", "secs", "time", "times", "visit", "visits", "session", "sessions", "item", "items",
  "mg", "mcg", "ml", "cc", "kg", "lb", "lbs", "oz", "g", "iu", "meq", "mm", "cm", "ft", "feet", "inch", "inches",
  "mile", "miles", "am", "pm", "daily", "weekly", "monthly", "twice", "once", "per", "every", "each",
  "patient", "patients", "person", "people", "cat", "cats", "dog", "dogs", "pet", "pets", "kitten", "kittens", "puppy", "puppies", "room", "rooms", "bed", "beds", "page", "pages", "step", "steps",
  "dr", "mr", "mrs", "ms", "mx", "prof",
]);

// A word right before the house number that makes it a room, bed or reference number, not a house.
const NUMBER_PREFIX = new Set([
  "room", "rm", "suite", "ste", "unit", "apt", "apartment", "bldg", "building", "floor", "fl", "bed", "kennel", "cage",
  "run", "stall", "exam", "ward", "lot", "box", "po", "page", "pg", "step", "item", "no", "number", "dose", "take", "give",
  "ext", "extension", "table", "seat", "gate", "slot", "bay", "dock", "locker", "channel", "ch", "chapter", "section", "sec",
]);

const STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "GU", "VI", "AS", "MP",
]);

const SP = "[ \\t\\u00a0]";
const PSEUDONYM = "(?:Person|Org|Host|Id|Value|Loc)_[0-9A-F]{4}";
// Readable pseudonym (`[Client A #7F3A]`, spaces inside) and its name-safe twin (`Client_A_7F3A`): one street-name word.
const READABLE_PSEUDONYM = "\\[[A-Za-z0-9][A-Za-z0-9 -]*[ ][A-Z]+ #[0-9A-F]{4}\\]";
const NAME_SAFE_PSEUDONYM = "\\p{Lu}[\\p{L}\\p{N}-]*(?:_[\\p{L}\\p{N}-]+)*_[A-Z]+_[0-9A-F]{4}(?![\\p{L}\\p{N}_])";
const NAME_WORD = `(?:${READABLE_PSEUDONYM}|${NAME_SAFE_PSEUDONYM}|${PSEUDONYM}(?![\\p{L}\\p{N}_])|\\p{Lu}[\\p{L}\\p{N}'’-]*|\\d{1,3}(?:st|nd|rd|th)(?![\\p{L}\\p{N}]))`;

// The house number: 1-6 digits, optionally a letter or a half, standing alone (not in a longer number,
// a decimal, a price, a time or a range).
const HOUSE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_/#$%+:.,-])(\\d{1,6})(?:[A-Za-z](?=${SP})|${SP}1/2(?=${SP}))?(?=${SP})`,
  "gu",
);
// A word, with a dot kept only where an abbreviation reads on ("N. Sample St", "Ave. Springfield").
const WORD_RE = new RegExp(`${SP}+(${NAME_WORD})(\\.(?=${SP}+\\p{Lu}|,))?`, "uy");
const UNIT_RE = new RegExp(`(?:,?${SP}+(?:Apt|Apartment|Unit|Suite|Ste|Bldg|Building|Fl|Floor|Rm|Room)\\.?${SP}*#?${SP}*|,?${SP}*#${SP}*)(?:\\d[A-Za-z0-9-]{0,5}|[A-Za-z](?![\\p{L}\\p{N}]))(?![\\p{L}\\p{N}])`, "iuy");
const CITY_WORD = `\\p{Lu}[\\p{L}'’.-]*`;
const ZIP = "\\d{5}(?:-\\d{4})?";
const LOCALITY_COMMA_RE = new RegExp(`,${SP}*(${CITY_WORD}(?:${SP}+${CITY_WORD}){0,2}),?${SP}+([A-Z]{2})(?![\\p{L}\\p{N}])(?:,?${SP}+(${ZIP}))?(?![\\p{L}\\p{N}]|-\\d)`, "uy");
const LOCALITY_PLAIN_RE = new RegExp(`${SP}+(${CITY_WORD}(?:${SP}+${CITY_WORD}){0,2}),?${SP}+([A-Z]{2})(?![\\p{L}\\p{N}]),?${SP}+(${ZIP})(?![\\p{L}\\p{N}]|-\\d)`, "uy");

const fold = (w: string): string => w.toLowerCase().replace(/\.$/, "");
const wordRe = (): RegExp => new RegExp(WORD_RE.source, "uy");

export interface AddressSpan {
  start: number;
  end: number;
}

/** The word before `pos` on the same line, lowercased, without a trailing "." or ":" ("" when there is none). */
function wordBefore(text: string, pos: number): string {
  const m = /([\p{L}]+)[.:]?[ \t ]*$/u.exec(text.slice(Math.max(0, pos - 24), pos));
  return m === null ? "" : (m[1] as string).toLowerCase();
}

/** One address at `start` (the house number), or null. `end` is the exclusive end offset. */
function addressAt(text: string, start: number, afterNumber: number): AddressSpan | null {
  if (NUMBER_PREFIX.has(wordBefore(text, start))) return null;
  const re = wordRe();
  // `end` includes an abbreviation dot; `bare` does not.
  const words: { word: string; end: number; bare: number }[] = [];
  let pos = afterNumber;
  for (let i = 0; i < 6; i++) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (m === null) break;
    const end = re.lastIndex;
    words.push({ word: m[1] as string, end, bare: m[2] === undefined ? end : end - 1 });
    pos = end;
    if (m[2] !== undefined && i > 0 && SUFFIXES.has(fold(m[1] as string))) break;
    if (i > 0 && SUFFIXES.has(fold(m[1] as string))) break;
  }
  // The street: [direction] name{1,4} suffix. The suffix is the first suffix word after at least one name word.
  const lead = words.length > 2 && DIRECTIONS.has(fold((words[0] as { word: string }).word)) ? [1, 0] : [0];
  for (const from of lead) {
    for (let k = from + 1; k < words.length; k++) {
      const suffix = words[k] as { word: string; end: number; bare: number };
      if (!SUFFIXES.has(fold(suffix.word)) || isPseudonymWord(suffix.word) || !capitalised(suffix.word)) continue;
      const name = words.slice(from, k);
      if (name.length > 4) continue;
      if (name.some((w) => NOT_STREET.has(fold(w.word)) && !isPseudonymWord(w.word))) continue;
      if (words.slice(0, from).some((w) => !DIRECTIONS.has(fold(w.word)))) continue;
      const end = extend(text, suffix.bare);
      // "Dr Sample" is an honorific, not a street: a bare "Dr" then a capitalised word, with no unit or locality after it.
      if (fold(suffix.word) === "dr" && end === suffix.bare && /^\.?[ \t\u00a0]+\p{Lu}/u.test(text.slice(end, end + 8))) continue;
      return { start, end };
    }
  }
  return null;
}

const capitalised = (w: string): boolean => /^\p{Lu}/u.test(w);
// Name-safe twins are not exempt here: without the map a shape is no proof, and a real `Host_A_1234` must not be.
const isPseudonymWord = (w: string): boolean => new RegExp(`^(?:${PSEUDONYM}|${READABLE_PSEUDONYM})$`, "u").test(w);

/** The street's end extended over an optional unit and `City ST ZIP`. */
function extend(text: string, end: number): number {
  let out = end;
  UNIT_RE.lastIndex = out;
  if (UNIT_RE.exec(text) !== null) out = UNIT_RE.lastIndex;
  // An abbreviation dot after the suffix is taken in only together with a locality ("Ave., Springfield UT").
  const at = text[out] === "." ? out + 1 : out;
  for (const re of [LOCALITY_COMMA_RE, LOCALITY_PLAIN_RE]) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m !== null && STATES.has(m[2] as string)) return re.lastIndex;
  }
  return out;
}

/** Street addresses in `text`, left to right, without overlaps. */
export function findAddresses(text: string): AddressSpan[] {
  const out: AddressSpan[] = [];
  let taken = 0;
  for (const m of text.matchAll(HOUSE_RE)) {
    const start = m.index;
    if (start < taken) continue;
    const found = addressAt(text, start, start + m[0].length);
    if (found === null) continue;
    out.push(found);
    taken = found.end;
  }
  return out;
}
