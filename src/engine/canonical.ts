// Canonicalisation: the per-class normal form a pseudonym is keyed on, so
// that surface variants of one identity ("Example Widgets, Inc." and
// "EXAMPLE WIDGETS") share a pseudonym. Locale-independent by construction:
// NFKC plus String#toLowerCase, never the locale-sensitive variants.

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
