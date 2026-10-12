// Canonicalisation: the per-class normal form a pseudonym is keyed on, so
// that surface variants of one identity ("Example Widgets, Inc." and
// "EXAMPLE WIDGETS") share a pseudonym. Locale-independent by construction:
// NFKC plus String#toLowerCase, never the locale-sensitive variants.
//
// Phone-shaped values canonicalise to their digits in every class, so
// "(801) 555-0100", "801-555-0100" and "+1 801.555.0100" are one number. A
// value of bare digits is never phone-shaped: it is left as written, so a
// numeric ID keeps its length and its leading digits.
//
// A person's canonical form leaves out leading honorifics and role words
// (honorifics.ts), so "Dr. Jo Sample", "Jo Sample" and "Sample, Jo" are one
// person, and writes an initial or a title without its dot ("J. Sample" is
// "j sample"). A title with a single name after it ("Dr. Sample") keeps the
// title: it is a reference of its own, which identity.ts may resolve.

import { isHonorificOrRole } from "./honorifics.ts";

export const PSEUDO_CLASSES = ["person", "org", "host", "email", "id", "location", "value"] as const;
/**
 * `redact` is not a pseudonym class: a span of it is written as REDACTED_VALUE, recorded nowhere
 * (context-keyword redaction, context.ts). It is outside PSEUDO_CLASSES, which lists the real ones.
 */
export type PseudoClass = RealPseudoClass | "redact";
export type RealPseudoClass = (typeof PSEUDO_CLASSES)[number];

// Compared after case-folding and with dots removed, so "Inc.", "S.A." and
// "L.L.C." all match. Stripped repeatedly from the end ("Pty Ltd").
const ORG_SUFFIXES = new Set([
  "ab", "ag", "as", "bv", "co", "company", "corp", "corporation", "gmbh", "inc",
  "incorporated", "kk", "limited", "llc", "llp", "lp", "ltd", "nv", "oy", "plc",
  "pllc", "pte", "pty", "sa", "sarl", "sas", "srl",
]);

const GUID_CORE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GUID_RE = new RegExp(`^(?:\\{(${GUID_CORE})\\}|(${GUID_CORE}))$`, "i");

// North American: optional +1, a three-digit area code (optionally in parentheses), 3 + 4 digits.
// A group separator is a space, ".", "-", a Unicode dash (U+2010-2015), or "/" or "?" (a "-" that a lossy
// 8-bit conversion turned into "?", or a slash-written number, AGT-1848).
const NANP_RE = /^(?:\+?1[\s.\-/?\u2010-\u2015]?)?(?:\(\d{3}\)|\d{3})[\s.\-/?\u2010-\u2015]?\d{3}[\s.\-/?\u2010-\u2015]?\d{4}$/;
// International: a leading + and country code, then digit groups split by single separators.
const INTL_RE = /^\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,6}$/;

/**
 * The digits of a phone-shaped value, or undefined. A value of bare digits, or one without
 * the 3-3-4 North American shape or a leading +, is not phone-shaped (so dates, IPv4 addresses
 * and plain numeric IDs are never read as phones). A North American number drops its
 * country code, so "+1 801 555 0100" and "801-555-0100" agree.
 */
export function phoneDigits(value: string): string | undefined {
  const v = value.trim();
  if (/^\d+$/.test(v)) return undefined;
  if (NANP_RE.test(v)) {
    const d = v.replace(/\D/g, "");
    return d.length === 11 ? d.slice(1) : d;
  }
  if (INTL_RE.test(v)) {
    const d = v.replace(/\D/g, "");
    if (d.length < 8 || d.length > 15) return undefined;
    // "+1" with a North American number already matched above; any other +1 form is still digits.
    return d.startsWith("1") && d.length === 11 ? d.slice(1) : d;
  }
  return undefined;
}

/**
 * The digits of a payment card number written in `m`, or undefined: 13 to 19 digits that start with a
 * card IIN prefix (4; 51-55; 2221-2720; 34, 37; 6011, 65; 35) and pass the Luhn checksum. A 15-digit microchip, an order or accession number and a random digit run fail one of these.
 */
export function cardDigits(m: string): string | undefined {
  const d = m.replace(/[ -]/g, "");
  if (!/^\d{13,19}$/.test(d)) return undefined;
  const n = d.length;
  const two = Number(d.slice(0, 2));
  const four = Number(d.slice(0, 4));
  const prefixed =
    d.startsWith("4") ||
    (two >= 51 && two <= 55) ||
    (four >= 2221 && four <= 2720) ||
    two === 34 ||
    two === 37 ||
    d.startsWith("6011") ||
    two === 65 ||
    two === 35;
  if (!prefixed) return undefined;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let digit = Number(d[n - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0 ? d : undefined;
}

function base(value: string): string {
  // NUL is the HMAC field separator, so it can never appear inside a canonical value.
  return value.normalize("NFKC").replace(/\0/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function stripOrgSuffixes(name: string): string {
  let current = name;
  for (;;) {
    const trimmed = current.replace(/[\s,.&]+$/, "");
    const cut = trimmed.lastIndexOf(" ");
    if (cut < 0) return trimmed;
    const last = trimmed.slice(cut + 1).replace(/\./g, "");
    if (!ORG_SUFFIXES.has(last)) return trimmed;
    current = trimmed.slice(0, cut);
  }
}

/** "lovelace, ada" → "ada lovelace"; anything without exactly one comma is left alone. */
function unifyPersonOrder(name: string): string {
  const parts = name.split(",");
  if (parts.length !== 2) return name;
  const [last, first] = parts.map((p) => p.trim());
  if (!last || !first) return name;
  return `${first} ${last}`;
}

/**
 * "dr. jo sample" → "jo sample"; "j. sample" → "j sample"; "dr. sample" → "dr sample". Leading honorific
 * and role words go only when two or more words are left, so a title with a lone surname stays a
 * reference of its own (identity.ts may resolve it to one person) and "Front Desk" stays whole.
 */
function personIdentity(name: string): string {
  const words = name.split(" ").filter((w) => w !== "");
  let i = 0;
  while (i < words.length - 2 && isHonorificOrRole(words[i] as string)) i++;
  return words
    .slice(i)
    .map((w) => (/^\p{L}\.$/u.test(w) || isHonorificOrRole(w) ? w.replace(/\.$/, "") : w))
    .join(" ");
}

export function guidCore(value: string): string | undefined {
  const m = GUID_RE.exec(value.trim());
  return (m?.[1] ?? m?.[2])?.toLowerCase();
}

export function canonicalize(cls: PseudoClass, value: string): string {
  const v = base(value);
  const phone = phoneDigits(v);
  if (phone !== undefined) return phone;
  switch (cls) {
    case "person":
      return personIdentity(unifyPersonOrder(v));
    case "org": {
      const stripped = stripOrgSuffixes(v);
      return stripped === "" ? v : stripped;
    }
    case "host":
      return v.replace(/\.$/, "");
    case "id":
      return guidCore(v) ?? v;
    case "email":
    case "location":
    case "value":
    case "redact":
      return v;
  }
}
