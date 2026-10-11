// The pseudonymizer: HMAC-SHA256(salt, class || canonical value), rendered in
// the class's shape. Deterministic: the only inputs are the salt, the values
// asked for (in the order asked), the entity lists, the set of real values to
// avoid and any reloaded map. No clock, no randomness.
//
// Collision handling: a candidate that equals a real value, the value itself,
// or a pseudonym already issued to a different value is rejected and the next
// candidate is derived with a counter appended to the HMAC input
// (class || canonical || counter). Bounded by MAX_ATTEMPTS; exhaustion throws
// rather than emitting a duplicate. Because "already issued" depends on what
// came before, callers must ask for values in a stable order (the engine walks
// a sorted file list); a reloaded map pins every earlier answer.

import { createHmac } from "node:crypto";
import { canonicalize, guidCore, type PseudoClass } from "./canonical.ts";
import { type BlindMap, MAP_VERSION, type MapEntry, type MapKind, sortEntries } from "./map.ts";

export { PSEUDO_CLASSES, type PseudoClass } from "./canonical.ts";

export const MAX_ATTEMPTS = 10_000;
export const MIN_SALT_BYTES = 16;

/** RFC 5737 documentation ranges: pseudonymous IPv4 addresses come only from here. */
export const IPV4_DOC_PREFIXES = ["192.0.2", "198.51.100", "203.0.113"] as const;

const PREFIX: Record<PseudoClass, string> = {
  person: "Person",
  org: "Org",
  host: "Host",
  id: "Id",
  value: "Value",
  location: "Loc",
  // An email-class value that is not email-shaped falls back to the neutral class.
  email: "Value",
};

export interface EntityEntry {
  canonical: string;
  aliases?: readonly string[];
  parts?: readonly string[];
}

export interface PseudonymizerOptions {
  /** The corpus salt (`.blind/salt`). Optional only when every value is already in `map`. */
  salt?: Uint8Array;
  /** A previously written map; its pseudonyms are reused verbatim. */
  map?: BlindMap;
  /** Spec entity lists: aliases and parts resolve to the entity's canonical name. */
  entities?: Partial<Record<PseudoClass, readonly EntityEntry[]>>;
  /** Real values from the corpus that no pseudonym may equal. */
  avoid?: Iterable<string>;
}

export class PseudonymError extends Error {
  override name = "PseudonymError";
}

const PREFIXED_RE = /^(?:Person|Org|Host|Id|Value|Loc)_[0-9A-F]{4}$/;
const LABEL = "host-[0-9a-f]{4}";
const HOST_RE_SRC = `${LABEL}(?:\\.${LABEL})*(?:\\.[a-z]{2,63})?`;
const HOST_RE = new RegExp(`^${HOST_RE_SRC}$`);
const EMAIL_RE = new RegExp(`^user_[0-9a-f]{4}@${HOST_RE_SRC}$`);
const DOC_IPV4_RE = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.(\d{1,3})$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const EMAIL_SHAPE_RE = /^([^@\s]+)@([^@\s]+)$/;
const HOST_LABEL_RE = /^[a-z0-9_-]+$/;
const TLD_RE = /^[a-z]{2,63}$/;

/** True for the forms recognisable by shape alone (everything except GUIDs and numeric IDs). */
function isShapedPseudonym(s: string): boolean {
  if (PREFIXED_RE.test(s) || HOST_RE.test(s) || EMAIL_RE.test(s)) return true;
  const ip = DOC_IPV4_RE.exec(s);
  if (!ip) return false;
  const last = Number(ip[1]);
  return String(last) === ip[1] && last >= 1 && last <= 254;
}

/**
 * Recognises every emitted form. GUID and numeric pseudonyms are
 * indistinguishable from real ones by shape, so they are recognised only via
 * the map that issued them.
 */
export function isPseudonym(s: string, map?: BlindMap): boolean {
  if (isShapedPseudonym(s)) return true;
  if (!map) return false;
  const norm = guidCore(s) ?? s;
  return map.entries.some((e) => e.pseudonym === norm);
}

function isHostname(c: string): boolean {
  const labels = c.split(".");
  return labels.length >= 2 && labels.every((l) => HOST_LABEL_RE.test(l));
}

/** Deterministic byte stream: HMAC blocks over the same message, extended by block index. */
class ByteStream {
  private block = 0;
  private buf: Buffer;
  private pos = 0;
  constructor(
    private readonly salt: Uint8Array,
    private readonly msg: string,
  ) {
    this.buf = createHmac("sha256", salt).update(msg, "utf8").digest();
  }
  next(): number {
    if (this.pos >= this.buf.length) {
      this.block += 1;
      this.buf = createHmac("sha256", this.salt).update(`${this.msg}\0#${this.block}`, "utf8").digest();
      this.pos = 0;
    }
    return this.buf[this.pos++] as number;
  }
  take(n: number): Buffer {
    return Buffer.from(Array.from({ length: n }, () => this.next()));
  }
}

function hex4(bytes: ByteStream): string {
  return bytes.take(2).toString("hex");
}

function renderIpv4(bytes: ByteStream): string {
  const [a, b] = bytes.take(2);
  return `${IPV4_DOC_PREFIXES[(a as number) % 3]}.${1 + ((b as number) % 254)}`;
}

function renderGuid(bytes: ByteStream): string {
  const b = bytes.take(16);
  b[6] = ((b[6] as number) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Same length; a leading non-zero digit stays non-zero. Rejection sampling keeps digits unbiased. */
function renderNumeric(bytes: ByteStream, like: string): string {
  let out = "";
  while (out.length < like.length) {
    const byte = bytes.next();
    if (byte >= 250) continue;
    const d = byte % 10;
    if (out === "" && like[0] !== "0" && d === 0) continue;
    out += String(d);
  }
  return out;
}

/** Re-apply a surface GUID's case and braces to a canonical (lowercase, bare) pseudonym. */
function formatGuidLike(surface: string, guid: string): string {
  const s = surface.trim();
  const upper = /[A-F]/.test(s) && !/[a-f]/.test(s);
  const g = upper ? guid.toUpperCase() : guid;
  return s.startsWith("{") ? `{${g}}` : g;
}

interface Resolved {
  key: string;
  display?: string;
}

export class Pseudonymizer {
  private readonly salt: Uint8Array | undefined;
  private readonly entries = new Map<string, MapEntry>();
  private readonly issued = new Set<string>();
  private readonly avoid = new Set<string>();
  private readonly index = new Map<PseudoClass, Map<string, Resolved>>();
  private readonly ambiguousKeys: { cls: PseudoClass; key: string }[] = [];

  constructor(opts: PseudonymizerOptions) {
    if (opts.salt !== undefined && opts.salt.length < MIN_SALT_BYTES) {
      throw new PseudonymError(`salt must be at least ${MIN_SALT_BYTES} bytes`);
    }
    if (opts.salt === undefined && opts.map === undefined) {
      throw new PseudonymError("a salt or a map is required");
    }
    this.salt = opts.salt;
    for (const v of opts.avoid ?? []) {
      this.avoid.add(v);
      const g = guidCore(v);
      if (g) this.avoid.add(g);
    }
    for (const e of opts.map?.entries ?? []) {
      this.entries.set(`${e.kind}\0${e.canonical}`, { ...e });
      this.issued.add(e.pseudonym);
    }
    for (const [cls, list] of Object.entries(opts.entities ?? {}) as [PseudoClass, EntityEntry[]][]) {
      this.indexEntities(cls, list);
    }
  }

  /** Alias or part keys claimed by more than one entity; they are not resolved, only pseudonymized as themselves. */
  get ambiguous(): readonly { cls: PseudoClass; key: string }[] {
    return [...this.ambiguousKeys].sort((a, b) =>
      a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    );
  }

  private indexEntities(cls: PseudoClass, list: readonly EntityEntry[]): void {
    const idx = new Map<string, Resolved>();
    const dead = new Set<string>();
    for (const entity of list) {
      const target: Resolved = { key: canonicalize(cls, entity.canonical), display: entity.canonical };
      for (const form of [entity.canonical, ...(entity.aliases ?? []), ...(entity.parts ?? [])]) {
        const k = canonicalize(cls, form);
        if (dead.has(k)) continue;
        const prior = idx.get(k);
        if (prior && prior.key !== target.key) {
          idx.delete(k);
          dead.add(k);
          this.ambiguousKeys.push({ cls, key: k });
        } else if (!prior) {
          idx.set(k, target);
        }
      }
    }
    this.index.set(cls, idx);
  }

  private resolve(cls: PseudoClass, value: string): Resolved {
    const c = canonicalize(cls, value);
    return this.index.get(cls)?.get(c) ?? { key: c };
  }

  /**
   * The recorded pseudonym, if any. The surface form kept for reveal is the
   * code-unit-smallest one seen, so the map does not depend on call order.
   */
  private lookup(kind: MapKind, canonical: string, surface: string): string | undefined {
    const known = this.entries.get(`${kind}\0${canonical}`);
    if (known && surface < known.value) known.value = surface;
    return known?.pseudonym;
  }

  /**
   * Look up or derive the pseudonym for (kind, canonical). `render` turns the
   * HMAC byte stream into a candidate; `surface` is recorded for reveal.
   */
  private derive(kind: MapKind, canonical: string, surface: string, render: (b: ByteStream) => string): string {
    const known = this.lookup(kind, canonical, surface);
    if (known !== undefined) return known;
    if (this.salt === undefined) {
      throw new PseudonymError(`a ${kind} value is not in the map and no salt was given to derive it`);
    }
    for (let counter = 0; counter < MAX_ATTEMPTS; counter++) {
      const msg = counter === 0 ? `${kind}\0${canonical}` : `${kind}\0${canonical}\0${counter}`;
      const candidate = render(new ByteStream(this.salt, msg));
      if (candidate === canonical || candidate === surface) continue;
      if (this.avoid.has(candidate) || this.issued.has(candidate)) continue;
      this.issued.add(candidate);
      this.entries.set(`${kind}\0${canonical}`, { kind, canonical, value: surface, pseudonym: candidate });
      return candidate;
    }
    throw new PseudonymError(`no free ${kind} pseudonym after ${MAX_ATTEMPTS} attempts`);
  }

  /** Record a pseudonym built from already-unique components (hostnames, emails). */
  private compose(kind: MapKind, canonical: string, surface: string, build: () => string): string {
    const known = this.lookup(kind, canonical, surface);
    if (known !== undefined) return known;
    const pseudo = build();
    if (this.issued.has(pseudo)) {
      throw new PseudonymError(`composed ${kind} pseudonym collides with an issued one`);
    }
    this.issued.add(pseudo);
    this.entries.set(`${kind}\0${canonical}`, { kind, canonical, value: surface, pseudonym: pseudo });
    return pseudo;
  }

  private label(label: string): string {
    return this.derive("host-label", label, label, (b) => `host-${hex4(b)}`);
  }

  /** Every label pseudonymized independently; an alphabetic TLD is kept so the result stays host-shaped. */
  private hostLabels(canonical: string): string {
    const labels = canonical.split(".");
    const last = labels[labels.length - 1] as string;
    const keepTld = labels.length >= 2 && TLD_RE.test(last);
    const body = keepTld ? labels.slice(0, -1) : labels;
    const out = body.map((l) => this.label(l));
    return keepTld ? `${out.join(".")}.${last}` : out.join(".");
  }

  private prefixed(cls: PseudoClass, canonical: string, surface: string): string {
    return this.derive(cls, canonical, surface, (b) => `${PREFIX[cls]}_${hex4(b).toUpperCase()}`);
  }

  pseudonym(cls: PseudoClass, value: string): string {
    const { key: c, display } = this.resolve(cls, value);
    const surface = display ?? value;
    switch (cls) {
      case "host":
        if (IPV4_RE.test(c)) return this.derive("host", c, surface, renderIpv4);
        if (isHostname(c)) return this.compose("host", c, surface, () => this.hostLabels(c));
        return this.prefixed(cls, c, surface);
      case "email": {
        const m = EMAIL_SHAPE_RE.exec(c);
        const [local, domain] = [m?.[1], m?.[2]];
        if (local === undefined || domain === undefined || !domain.split(".").every((l) => HOST_LABEL_RE.test(l))) {
          return this.prefixed(cls, c, surface);
        }
        return this.compose("email", c, surface, () => {
          const user = this.derive("email-local", local, local, (b) => `user_${hex4(b)}`);
          return `${user}@${this.hostLabels(domain)}`;
        });
      }
      case "id": {
        if (guidCore(c) !== undefined) return formatGuidLike(value, this.derive("id", c, surface, renderGuid));
        if (/^\d+$/.test(c)) return this.derive("id", c, surface, (b) => renderNumeric(b, c));
        return this.prefixed(cls, c, surface);
      }
      case "person":
      case "org":
      case "location":
      case "value":
        return this.prefixed(cls, c, surface);
    }
  }

  isPseudonym(s: string): boolean {
    return isShapedPseudonym(s) || this.issued.has(guidCore(s) ?? s);
  }

  toMap(): BlindMap {
    return { version: MAP_VERSION, entries: sortEntries([...this.entries.values()]) };
  }
}
