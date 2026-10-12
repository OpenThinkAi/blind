// TypeScript types for the spec and the corpus profile. Hand-kept in step with
// schema/spec.schema.json and schema/profile.schema.json, which are the source of
// truth at runtime: src/validate.ts checks documents against those files, and
// test/schema.test.ts checks the fixtures satisfy both the JSON schema and these types.

export type EntityClassName =
  | "person" | "org" | "host" | "email" | "id" | "location" | "vocabulary" | "unknown";

/**
 * `drop` removes the column (or JSON key) from the output; `redact` writes REDACTED_VALUE in every
 * non-empty cell. Neither is recorded in the map, so neither can be revealed. `scan` keeps the cell
 * as written except for what the free-text scanner finds in it (patterns, spec entities, recurring
 * values, people named only in prose, context-keyword secrets), as a free-text cell.
 */
export type Treatment = "blind" | "keep" | "value" | "drop" | "redact" | "scan";
export type Source = "analyst" | "human" | "heuristic";
/** A column rule's author: `policy` for a rule `blind plan` wrote from blind.toml (`[[columns]]` or `[keep].terms`). */
export type ColumnSource = Source | "policy";

/** What a `redact` treatment writes in place of each non-empty value. */
export const REDACTED_VALUE = "REDACTED";
export type PatternName = "ip" | "email" | "host" | "guid" | "mac" | "phone";
export type Patterns = Record<Exclude<PatternName, "phone">, boolean> & { phone?: boolean };

/** Whether a pattern is on. `phone` is absent from specs written before it existed, and absent means on (fail closed). */
export const patternOn = (patterns: Patterns, name: PatternName): boolean => patterns[name] ?? name === "phone";

/** Where a value lives: a table column (`header`, optionally on a `sheet`) or a JSON key path. */
export type Location =
  | { file: string; sheet?: string; header: string; jsonPath?: never }
  | { file: string; sheet?: string; jsonPath: string; header?: never };

export type ColumnRule = Location & {
  class: EntityClassName;
  treatment: Treatment;
  /** 0..1 */
  confidence: number;
  source: ColumnSource;
};

export interface Entity {
  canonical: string;
  aliases: string[];
  parts: string[];
  /** Who added it: `human` for a candidate accepted or rejected with `blind plan --from-audit`. Absent on analyst entities. */
  source?: Source;
}

export type Entities = Partial<Record<Exclude<EntityClassName, "unknown">, Entity[]>>;

export interface Question {
  id: string;
  text: string;
  options: string[];
  /** One of `options`, or null while unanswered. */
  answer: string | null;
  /** The column the question decides. While unanswered, that column's rule stays `unknown`. */
  about?: Location;
}

export interface Spec {
  version: 1;
  columns: ColumnRule[];
  entities: Entities;
  /** `phone` may be absent in a spec written before it existed: absent means on (patternOn). */
  patterns: Patterns;
  questions: Question[];
  /** Fingerprints of the document and transcript excerpts the analyst has read (see docs/spec.md). */
  seen?: string[];
}

export type FileFormat =
  | "csv" | "tsv" | "json" | "jsonl" | "xlsx" | "docx" | "text" | "markdown" | "log" | "vtt" | "srt";

export interface ProfileFile {
  path: string;
  format: FileFormat;
  /** Bytes. */
  size: number;
}

/** Profile detectors: the spec's shape patterns plus `numericId`, which has no free-text pattern. */
export type DetectorName = Exclude<PatternName, "phone"> | "numericId";

export interface ValueStats {
  count: number;
  distinctRatio: number;
  digitRatio: number;
  dictionaryRatio: number;
  meanLength: number;
  detectorRates: Record<DetectorName, number>;
  /** At most `Profile.sampleCount` values, each at most 120 characters. */
  samples: string[];
}

export interface ProfileTable {
  file: string;
  sheet?: string;
  /** 1-based row number of the header. */
  headerRow: number;
  /** CSV/TSV: data rows wider than the header, whose extra cells are counted in the last column. Absent when 0. */
  overflowRows?: number;
  columns: { header: string; stats: ValueStats }[];
}

export interface ProfileJsonKey {
  file: string;
  path: string;
  stats: ValueStats;
}

export interface ProfileDocument {
  file: string;
  outline: string[];
  sampleSentences: string[];
}

export interface ProfileTranscript {
  file: string;
  speakers: string[];
  sampleLines: string[];
}

export interface Cooccurrence {
  a: Location;
  b: Location;
  /** Number of distinct values present in both locations. */
  shared: number;
}

export interface Profile {
  version: 1;
  /** `k`: the most samples any one column, key, document or transcript may carry. */
  sampleCount: number;
  files: ProfileFile[];
  tables: ProfileTable[];
  jsonKeys: ProfileJsonKey[];
  documents: ProfileDocument[];
  transcripts: ProfileTranscript[];
  cooccurrence: Cooccurrence[];
}

/** The longest document-derived excerpt a profile may carry (characters, i.e. code points). */
export const MAX_EXCERPT = 120;
