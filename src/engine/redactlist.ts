// The spec's `redact` list (AGT-2438): values written as REDACTED wherever they occur, never a
// pseudonym and never recorded in the map. A secret or card number the audit finds surviving is
// accepted into it by `blind plan --from-audit`, not as an entity, so the credential is stored in
// neither spec.json nor map.json.
//
// Each entry is `<length>:<fingerprint>`: the value's length in UTF-16 code units and the first 32
// hex digits of HMAC-SHA256 over it, keyed by .blind/salt. apply finds the values again by
// fingerprinting every stretch of the corpus text of a listed length that starts and ends at a word
// edge (the same edges `plan --from-audit` reads a candidate to), and redacts the ones that match.

import { createHmac } from "node:crypto";

const DOMAIN = "blind-redact\u0000";
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** The spec `redact` entry for `value` under `salt`. */
export function redactEntry(salt: Uint8Array, value: string): string {
  const mac = createHmac("sha256", salt).update(DOMAIN + value, "utf8").digest("hex").slice(0, 32);
  return `${value.length}:${mac}`;
}

/** Whether the code point ending just before `i` (or starting at `i`) is a letter or digit. */
function wordBefore(text: string, i: number): boolean {
  if (i <= 0) return false;
  const lo = text.charCodeAt(i - 1);
  const at = lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? i - 2 : i - 1;
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(at) as number));
}
function wordAt(text: string, i: number): boolean {
  if (i >= text.length) return false;
  return WORD_CHAR.test(String.fromCodePoint(text.codePointAt(i) as number));
}

/**
 * The distinct values in `texts` whose `redact` entry is in `entries`, sorted. Only stretches with
 * no letter or digit right before or after them are tried, so a listed value inside a longer word
 * is not found (as `plan --from-audit` would have read the longer word).
 */
export function findRedactValues(texts: Iterable<string>, entries: readonly string[], salt: Uint8Array): string[] {
  if (entries.length === 0) return [];
  const wanted = new Set(entries);
  const lengths = [...new Set(entries.map((e) => Number(e.slice(0, e.indexOf(":")))))];
  const found = new Set<string>();
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) {
      if (wordBefore(text, i)) continue;
      for (const n of lengths) {
        const end = i + n;
        if (end > text.length || wordAt(text, end)) continue;
        const v = text.slice(i, end);
        if (v.trim() !== v || found.has(v)) continue;
        if (wanted.has(redactEntry(salt, v))) found.add(v);
      }
    }
  }
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
