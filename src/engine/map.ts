// map.json: the reversal map. It holds original values, so it is a secret on
// a par with the salt: never logged. A reloaded map reproduces every pseudonym
// it records without the salt. This module is the format only (no file
// system, so it bundles for a browser); reading and writing the file, mode
// 0600, live in src/mapfile.ts.

import { canonicalize, PSEUDO_CLASSES } from "./canonical.ts";

/**
 * Components of shaped pseudonyms are recorded too, so hosts and emails rebuild without the salt.
 * `person-given` and `person-family` record how a person was written across a first/last name column
 * pair (AGT-2787): keyed on the person's canonical form, their pseudonym is the person's own full-name
 * stand-in (the entry the person resolved to, which the map must hold), and their value is the given name or surname as written. Reveal reads them only
 * to restore such a pair of cells (pseudonym.ts splitStandIn); they are never matched in text.
 */
export const MAP_KINDS = [...PSEUDO_CLASSES, "host-label", "email-local", "person-given", "person-family"] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export const MAP_VERSION = 1;

export interface MapEntry {
  kind: MapKind;
  /** Canonical form the pseudonym is keyed on. */
  canonical: string;
  /** Smallest surface form seen (code-unit order, so call order never matters); what `reveal` restores. */
  value: string;
  pseudonym: string;
}

export interface BlindMap {
  version: typeof MAP_VERSION;
  entries: MapEntry[];
}

export class MapError extends Error {
  override name = "MapError";
}

/** Code-unit order, never locale order. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortEntries(entries: readonly MapEntry[]): MapEntry[] {
  return [...entries].sort((a, b) => compare(a.kind, b.kind) || compare(a.canonical, b.canonical));
}

/** Byte-stable serialisation: sorted entries, fixed key order, trailing newline. */
export function serializeMap(map: BlindMap): string {
  const entries = sortEntries(map.entries).map((e) => ({
    kind: e.kind,
    canonical: e.canonical,
    value: e.value,
    pseudonym: e.pseudonym,
  }));
  return `${JSON.stringify({ version: map.version, entries }, null, 2)}\n`;
}

const ENTRY_FIELDS = ["kind", "canonical", "value", "pseudonym"] as const;

/** Strict parse: unknown fields, wrong types, duplicate keys and reused pseudonyms are all errors. */
export function parseMap(text: string, source = "map.json"): BlindMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message can quote map content, which is secret; say only where.
    throw new MapError(`${source}: not valid JSON`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MapError(`${source}: expected an object at the top level`);
  }
  const top = raw as Record<string, unknown>;
  for (const k of Object.keys(top)) {
    if (k !== "version" && k !== "entries") throw new MapError(`${source}: unknown field ${JSON.stringify(k)}`);
  }
  if (top.version !== MAP_VERSION) {
    throw new MapError(`${source}: version must be ${MAP_VERSION}`);
  }
  if (!Array.isArray(top.entries)) throw new MapError(`${source}: entries must be an array`);

  const keys = new Set<string>();
  const pseudonyms = new Set<string>();
  const entries = top.entries.map((item: unknown, i): MapEntry => {
    const at = `${source}: entries[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new MapError(`${at}: expected an object`);
    }
    const rec = item as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (!(ENTRY_FIELDS as readonly string[]).includes(k)) throw new MapError(`${at}: unknown field ${JSON.stringify(k)}`);
    }
    for (const k of ENTRY_FIELDS) {
      if (typeof rec[k] !== "string") throw new MapError(`${at}.${k}: expected a string`);
    }
    const entry = rec as unknown as MapEntry;
    if (!(MAP_KINDS as readonly string[]).includes(entry.kind)) {
      throw new MapError(`${at}.kind: expected one of ${MAP_KINDS.join(", ")}`);
    }
    if (entry.pseudonym === "") throw new MapError(`${at}.pseudonym: must not be empty`);
    const key = `${entry.kind}\0${entry.canonical}`;
    if (keys.has(key)) throw new MapError(`${at}: duplicate ${entry.kind} entry`);
    keys.add(key);
    // A name part reuses its person's stand-in, checked once every entry is read.
    if (!isNamePart(entry.kind)) {
      if (pseudonyms.has(entry.pseudonym)) throw new MapError(`${at}.pseudonym: already used by another entry`);
      pseudonyms.add(entry.pseudonym);
    }
    return { kind: entry.kind, canonical: entry.canonical, value: entry.value, pseudonym: entry.pseudonym };
  });
  entries.forEach((e, i) => {
    if (isNamePart(e.kind) && !pseudonyms.has(e.pseudonym)) {
      throw new MapError(`${source}: entries[${i}].pseudonym: a ${e.kind} entry must reuse the pseudonym of the entry it is part of`);
    }
  });
  return { version: MAP_VERSION, entries };
}

/** A `person-given` or `person-family` entry: one part of a person written across a first/last name pair. */
export const isNamePart = (kind: string): boolean => kind === "person-given" || kind === "person-family";

export const foldText = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * `map` without the entries that record any of `values` (a value of a `drop`, `redact` or credential
 * column must never sit in the map, AGT-1847), by surface or canonical form, and without the host
 * label and email local-part components of the removed hosts and emails that no remaining entry uses.
 * `dropped` counts the entries removed; it says nothing of their content.
 */
export function withoutValues(map: BlindMap, values: readonly string[]): { map: BlindMap; dropped: number } {
  const wanted = new Set<string>();
  for (const v of values) {
    wanted.add(foldText(v));
    for (const cls of PSEUDO_CLASSES) wanted.add(foldText(canonicalize(cls, v)));
  }
  const isComponent = (k: string): boolean => k === "host-label" || k === "email-local";
  const hit = (e: MapEntry): boolean => !isComponent(e.kind) && (wanted.has(foldText(e.value)) || wanted.has(foldText(e.canonical)));
  const pieces = (e: MapEntry): string[] => {
    const c = e.canonical;
    if (e.kind === "email") {
      const at = c.lastIndexOf("@");
      return [c.slice(0, at), ...c.slice(at + 1).split(".")];
    }
    return e.kind === "host" ? c.split(".") : [];
  };
  const gone = map.entries.filter(hit);
  const kept = map.entries.filter((e) => !hit(e));
  const used = new Set(kept.flatMap(pieces));
  const orphaned = new Set(gone.flatMap(pieces).filter((p) => !used.has(p)));
  // A name part goes with the entry whose pseudonym it reuses.
  const whole = new Set(kept.filter((e) => !isNamePart(e.kind)).map((e) => e.pseudonym));
  const entries = kept.filter((e) => !(isComponent(e.kind) && orphaned.has(e.canonical)) && !(isNamePart(e.kind) && !whole.has(e.pseudonym)));
  return { map: { version: map.version, entries }, dropped: map.entries.length - entries.length };
}
