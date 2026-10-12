// Date context (AGT-1813): a month or weekday word standing next to a day number or a year is part
// of a date, not a person's name. Model-free and shared by the engine's matcher and the audit, so the
// two agree. Used only for name parts (a given name such as "Jan" or "May"), never for whole values
// or spec entities, which the spec decides.

const DATE_WORDS = new Set(
  (
    "jan feb mar apr may jun jul aug sep sept oct nov dec " +
    "january february march april june july august september october november december " +
    "mon tue tues wed thu thur thurs fri sat sun " +
    "monday tuesday wednesday thursday friday saturday sunday"
  ).split(" "),
);

/** Whether `word` (any case, without a trailing dot) is an English month or weekday name or abbreviation. */
export function isDateWord(word: string): boolean {
  return DATE_WORDS.has(word.toLowerCase());
}

// A day number (1-31, optional ordinal suffix) or a four-digit year, standing alone as a number.
const AFTER_RE = /^[.,]?[ \t ]+(?:(?:[12]\d{3})|(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?)(?![\p{L}\p{N}])(?![.,]\d)/u;
const BEFORE_RE = /(?<![\p{L}\p{N}.,])(?:(?:[12]\d{3})|(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?)[.,]?[ \t ]+$/u;

/**
 * Whether the word at text[s, e) sits in a date context: a day number (1-31) or a four-digit year
 * right after it ("Jan. 9", "Jan 2026", "May 3rd", "Jan, 2026") or right before it ("9 Jan.",
 * "2026 Jan"), with one optional dot or comma and spaces between. Anywhere else it is a name.
 */
export function inDateContext(text: string, s: number, e: number): boolean {
  return AFTER_RE.test(text.slice(e, e + 16)) || BEFORE_RE.test(text.slice(Math.max(0, s - 16), s));
}
