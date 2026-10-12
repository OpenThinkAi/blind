// Canonicalisation: the per-class normal form a pseudonym is keyed on, so
// that surface variants of one identity ("Example Widgets, Inc." and
// "EXAMPLE WIDGETS") share a pseudonym. Locale-independent by construction:
// NFKC plus String#toLowerCase, never the locale-sensitive variants.
//
// Phone-shaped values canonicalise to their digits in every class, so
// "(801) 555-0100", "801-555-0100" and "+1 801.555.0100" are one number. A
// value of bare digits is never phone-shaped: it is left as written, so a
// numeric ID keeps its length and its leading digits.

export const PSEUDO_CLASSES = ["person", "org", "host", "email", "id", "location", "value"] as const;
export type PseudoClass = (typeof PSEUDO_CLASSES)[number];

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
const NANP_RE = /^(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}$/;
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
      return unifyPersonOrder(v);
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
      return v;
  }
}
