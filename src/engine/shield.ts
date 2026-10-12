// Shields (AGT-1853): text the owner keeps, wherever it appears.
//
// A `keep` column keeps its own cells. Its distinct values also become corpus-wide shield forms,
// like a `[keep]` term: a pattern, name or recurrence span that falls inside an occurrence of one is
// dropped, so a public phone number kept in a `clinic_phone` column is not turned into an id in a
// handbook, a transcript or a letter. A phone is compared by its canonical digits.
//
// Built-in placeholders are shielded the same way, unless `[keep] placeholders = false`: the
// textbook identities of forms and documentation (John Doe, 123 Main St, 999-9999, user@example.com)
// are nobody's data, so a template reads as written. A real-looking number (555-01xx) is not one.
//
// A value that an explicit rule also pseudonymises (or drops, or redacts) somewhere is not shielded:
// the explicit rule wins, and the conflict is counted.
//
// Pure and deterministic; the engine and the audit share it.

import { phoneDigits } from "./canonical.ts";
import { isMeasure } from "./stats.ts";
import { EntityMatcher, findPatternSpans, type Span } from "./text.ts";

/** The canonical form a value is compared by: a phone by its digits, else folded text. */
export const shieldKey = (value: string): string => phoneDigits(value) ?? value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether a kept value can shield: at least 4 characters, and not a number, date or measure. A phone
 * can (it compares by digits); anything else needs a letter.
 */
export function shieldable(value: string): boolean {
  const v = value.trim();
  if (v.length < 4) return false;
  if (phoneDigits(v) !== undefined) return true;
  return /\p{L}/u.test(v) && !isMeasure(v);
}

const PHONE_ONLY = { email: false, ip: false, mac: false, guid: false, host: false, phone: true, secret: false };

// Textbook identities. Each matches a whole token run, never part of a longer word.
const TEMPLATE_DOMAIN = String.raw`(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|[A-Za-z0-9-]+\.(?:example|test|invalid)|example|test|invalid)`;
const PLACEHOLDER_RES: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])J(?:ohn|ane)[ \t]+Doe(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])J(?:ohn|ane)[ \t]+Q\.?[ \t]+Public(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])123[ \t]+Main[ \t]+(?:St(?:reet)?)(?![\p{L}\p{N}])\.?/giu,
  // An email whose local part is a template word on a reserved example domain.
  new RegExp(String.raw`(?<![\p{L}\p{N}._%+-])(?:user|username|name|yourname|you|your\.name|email|someone|first\.last|firstname\.lastname)@${TEMPLATE_DOMAIN}(?![\p{L}\p{N}-]|\.[A-Za-z0-9])`, "giu"),
];

/** A phone whose last seven digits are one repeated digit ("999-9999", "000-000-0000"). */
const repeated = (digits: string): boolean => digits.length >= 7 && /^(\d)\1{6}$/.test(digits.slice(-7));

interface Occurrence {
  start: number;
  end: number;
  /** The shield value's key, or null for a placeholder. */
  key: string | null;
}

export interface ShieldReport {
  /** Distinct kept values that shield (after the conflicts are left out). */
  values: number;
  /** Of those, how many shielded at least one span. */
  shielding: number;
  /** Spans dropped because they fall inside an occurrence of a kept value. */
  spans: number;
  /** Spans dropped because they fall inside a built-in placeholder. */
  placeholderSpans: number;
  /** Kept values left unshielded because an explicit rule also pseudonymises them. */
  conflicts: number;
}

export class Shield {
  private readonly matcher: EntityMatcher;
  private readonly phones = new Set<string>();
  private readonly used = new Set<string>();
  private spans = 0;
  private placeholderSpans = 0;
  readonly values: number;
  readonly conflicts: number;

  /**
   * `kept` is every value held whole in a `keep` column; `explicit` the values an explicit rule
   * pseudonymises, drops or redacts (a kept value among them is not shielded).
   */
  constructor(kept: Iterable<string>, explicit: Iterable<string>, private readonly placeholders: boolean) {
    const against = new Set<string>();
    for (const v of explicit) against.add(shieldKey(v));
    const forms = new Map<string, string>();
    let conflicts = 0;
    const seen = new Set<string>();
    for (const raw of kept) {
      const v = raw.trim();
      if (!shieldable(v)) continue;
      const key = shieldKey(v);
      if (seen.has(key)) continue;
      seen.add(key);
      if (against.has(key)) {
        conflicts++;
        continue;
      }
      forms.set(v, key);
    }
    this.conflicts = conflicts;
    this.values = forms.size;
    for (const [v, key] of forms) if (phoneDigits(v) !== undefined) this.phones.add(key);
    this.matcher = new EntityMatcher({}, [...forms.keys()].sort().map((value) => ({ cls: "value" as const, value })));
  }

  /** Nothing to shield: no kept value and the placeholders are off. */
  get idle(): boolean {
    return this.values === 0 && !this.placeholders;
  }

  /** Where kept values and placeholders stand in `text`, sorted by start. */
  occurrences(text: string): Occurrence[] {
    if (this.idle) return [];
    const out: Occurrence[] = [];
    if (this.values > 0) {
      for (const s of this.matcher.find(text)) out.push({ start: s.start, end: s.end, key: shieldKey(s.value) });
    }
    const needPhones = this.phones.size > 0 || this.placeholders;
    if (needPhones && /\d/.test(text)) {
      for (const s of findPatternSpans(text, PHONE_ONLY)) {
        const digits = phoneDigits(s.value);
        if (digits === undefined) continue;
        if (this.phones.has(digits)) out.push({ start: s.start, end: s.end, key: digits });
        else if (this.placeholders && repeated(digits)) out.push({ start: s.start, end: s.end, key: null });
      }
    }
    if (this.placeholders) {
      for (const re of PLACEHOLDER_RES) for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, key: null });
    }
    // Kept values first at a tie, so they are the ones credited.
    return out.sort((a, b) => a.start - b.start || b.end - a.end || Number(a.key === null) - Number(b.key === null));
  }

  /**
   * `spans` less those inside a shielded occurrence: pattern, entity and prose-name spans. A
   * redaction (a secret, a value after a keyword), a span already kept as written, a transcript
   * speaker and a value an explicit column rule blinded (`map`, `removed`) are never dropped: the
   * explicit rule wins, even inside a kept cell. `count`
   * false leaves the report alone (file names, parts nothing rewrites).
   */
  filter(text: string, spans: Span[], count = true): Span[] {
    if (this.idle || spans.length === 0) return spans;
    const occ = this.occurrences(text);
    if (occ.length === 0) return spans;
    return spans.filter((s) => {
      if (s.cls === null || s.cls === "redact" || s.source === "speaker" || s.source === "map" || s.source === "removed") return true;
      const o = occ.find((x) => x.start <= s.start && s.end <= x.end);
      if (o === undefined) return true;
      if (count) {
        if (o.key === null) this.placeholderSpans++;
        else {
          this.spans++;
          this.used.add(o.key);
        }
      }
      return false;
    });
  }

  report(): ShieldReport {
    return { values: this.values, shielding: this.used.size, spans: this.spans, placeholderSpans: this.placeholderSpans, conflicts: this.conflicts };
  }
}
