// TypeScript types for the spec and the corpus profile. Hand-kept in step with
// schema/spec.schema.json and schema/profile.schema.json, which are the source of
// truth at runtime: src/validate.ts checks documents against those files, and
// test/schema.test.ts checks the fixtures satisfy both the JSON schema and these types.

export type EntityClassName =
  | "person" | "org" | "host" | "email" | "id" | "location" | "vocabulary" | "unknown";

export type Treatment = "blind" | "keep" | "value";
export type Source = "analyst" | "human" | "heuristic";
export type PatternName = "ip" | "email" | "host" | "guid" | "mac";

/** Where a value lives: a table column (`header`, optionally on a `sheet`) or a JSON key path. */
export type Location =
  | { file: string; sheet?: string; header: string; jsonPath?: never }
  | { file: string; sheet?: string; jsonPath: string; header?: never };

export type ColumnRule = Location & {
  class: EntityClassName;
  treatment: Treatment;
  /** 0..1 */
  confidence: number;
  source: Source;
};

export interface Entity {
  canonical: string;
  aliases: string[];
  parts: string[];
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
  patterns: Record<PatternName, boolean>;
  questions: Question[];
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
export type DetectorName = PatternName | "numericId";

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
