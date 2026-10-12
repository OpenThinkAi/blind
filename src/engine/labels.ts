// Field labels (AGT-1852): the words a form, a record or a key/value worksheet writes next to a
// value ("Phone", "Card", "Email", "Address", "Agency"). They are not names. A column rule that
// claims a label column (a vertical `Client | Dana Example` sheet whose labels sit under the
// header the rule matched) must not make them person values, and no such word is ever a name
// part matched alone, or a value recurring on its own, corpus-wide.
//
// Kept apart from the dictionary (words.ts), which feeds the profile's dictionary ratio: adding
// these there would change how columns are classified. Lowercase, without a trailing dot.

import { DICTIONARY } from "./words.ts";
import { isHonorificOrRole } from "./honorifics.ts";

const WORDS = `
phone phones telephone tel tele mobile cell cellphone fax pager email emails e-mail mail
card cards visa mastercard amex cvv cvc passcode password pwd username login
address addresses addr street st apt suite unit city town state province county country zip zipcode
postcode postal
agency agencies acct account accounts routing iban swift bic
dob birthdate birthday ssn sin nhs nino ein tin vat id ids ref dl licence license plate vin
website url web ip host domain
client clients owner owners contact contacts employer company insurer insurance policy member
patient gender sex age notes memo ext extension emergency relation relationship spouse guardian
referral referred signature initials
`
  .split(/\s+/)
  .filter((w) => w !== "");

const SET: ReadonlySet<string> = new Set(WORDS);

const strip = (w: string): string => w.normalize("NFKC").toLowerCase().replace(/[.:]+$/u, "");

/** A field-label word ("Phone", "card", "E-mail", "DOB:"), not a name. */
export function isLabelWord(word: string): boolean {
  return SET.has(strip(word));
}

/** A word no name part is ever made of: a dictionary word or a field-label word. */
export function isCommonWord(word: string): boolean {
  const w = strip(word);
  return DICTIONARY.has(w) || SET.has(w);
}

/** A label cell holds at most this many words. */
const MAX_LABEL_WORDS = 3;

/**
 * Whether a cell reads as a field label: one to three words of letters (an optional ":" or "#" at
 * the end), every one a dictionary, field-label, honorific or role word ("Phone", "Card",
 * "Email:", "Home address", "Emergency contact"). No digits.
 */
export function isLabelCell(value: string): boolean {
  const v = value.trim().replace(/\s*[:#]$/u, "");
  if (v === "" || /\p{N}/u.test(v)) return false;
  const words = v.split(/[\s/]+/u).filter((w) => w !== "");
  if (words.length > MAX_LABEL_WORDS) return false;
  return words.every((w) => /^[\p{L}\p{M}]+(?:[-'.][\p{L}\p{M}]+)*\.?$/u.test(w) && (isCommonWord(w) || isHonorificOrRole(w)));
}

/** A label column: at least this share of its filled cells are label cells. */
export const LABEL_COLUMN_RATIO = 0.6;

/**
 * Whether a column's values are the labels of a key/value block: at least two filled cells, every
 * one short (at most three words), and most (LABEL_COLUMN_RATIO) label cells (isLabelCell). The
 * caller checks that a value column sits to its right.
 */
export function isLabelColumn(values: readonly string[]): boolean {
  const filled = values.map((v) => v.trim()).filter((v) => v !== "");
  if (filled.length < 2) return false;
  if (filled.some((v) => v.split(/\s+/).length > MAX_LABEL_WORDS)) return false;
  return filled.filter(isLabelCell).length / filled.length >= LABEL_COLUMN_RATIO;
}
