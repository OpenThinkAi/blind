// The engine for CSV/TSV, JSON/JSONL, plain text, DOCX (see docx.ts) and transcripts (transcript.ts): applies a saved spec to in-memory
// files and returns the blinded bytes, a report per file, and the map. No file
// system, no clock, no model: the output depends only on the inputs, the spec,
// the salt and any earlier map.
//
// Two passes keep the result independent of discovery order. The first plans
// every edit (which cells get which pseudonym class, which spans of free text
// match a pattern or an entity) and collects the values to pseudonymise; those
// are fed to the pseudonymizer in sorted order, because its answers depend on
// call order under collision. The second pass renders.
//
// Column treatments (design decision 4, fail closed):
// - `keep` (any class, `vocabulary` included): byte-identical, apart from
//   recurring values (below).
// - `blind` with a sensitive class: every non-empty cell gets that class's pseudonym.
// - `blind` with `unknown`/`vocabulary`, or `value` with a sensitive class: a `Value_` pseudonym.
// - `scan` (any class): kept as written apart from what the free-text scanner
//   finds in it, exactly as a text file is scanned.
// - `unknown` with `value`, and any column the spec does not mention: the
//   identifier-like test decides (or, with ApplyOptions.columns = "scan", the
//   column is scanned). Identifier-like columns become `Value_`
//   pseudonyms; the rest are kept, with spec entities and patterns still
//   replaced inside their cells. A cell whose value is held whole in a `keep`
//   or `scan` cell anywhere in the corpus is never pseudonymised by this test:
//   it is scanned instead (settleFallback).
// Rows above the header and the header row itself are treated as free text.
//
// JSON and JSONL: every key path is a column (see json.ts), with the same
// treatments. Strings and numbers are values, a number as written, so the
// string "9123" and the number 9123 get the same pseudonym; true, false and
// null are left alone. Keys that are record identifiers are the values of
// their `.*~` path; other keys are free text, like a header row. Edits are
// spliced into the original text, so layout and key order never change.
//
// Values a column pass pseudonymised recur (src/engine/recur.ts): after the
// column decisions, every value one of them pseudonymised, every XLSX/DOCX
// identity metadata value replaced whole (creator, authors, company, account
// names in paths), and every value an earlier map holds, is replaced wherever else it appears: in free text, in
// cells kept as text or under `keep`, and in JSON strings and keys. A `keep`
// cell changes only for such a value; spec entities and patterns in it are
// still left as written and reported.
//
// Transcripts (src/engine/transcript.ts) are detected by content: a text file
// (or a .vtt or .srt) that reads as WebVTT, SRT or timestamped speaker turns,
// and a DOCX whose body paragraphs do. Their speaker tags are always replaced
// with Person_ pseudonyms, the speakers' names, parts and misspellings join the
// corpus-wide scanner as person forms, and timing lines stay byte-identical.
//
// People named only in prose (src/engine/prose.ts, AGT-1830) are found in the free text the scanner
// reads (never in a cell under `keep`), less anyone a column, speaker or map already names, and join
// the scanner as person forms (whole names and parts) with span source `prose`.
//
// Host matches under a keep-list domain are kept as written. Every output path
// is blinded through src/engine/names.ts (patterns, entities and the column
// values replaced above), planned with the cells and rendered after them.

import { type ColumnRule, type EntityClassName, patternOn, REDACTED_VALUE, type Spec, type Treatment } from "../schema.ts";
import { newSecretCarry } from "./secret.ts";
import { Shield, type ShieldReport } from "./shield.ts";
import type { PseudoClass } from "./canonical.ts";
// The profiler's header rule: spec rules name columns by the headers the profile reported.
import { detectHeaderRow } from "../profile/table.ts";
import { assertRowWidths, type Cell, CsvError, parseCsv, renderCell, type Row, serializeCsv, sniffDelimiter } from "./csv.ts";
import { decode, type Encoding, EncodingError, encode } from "./encoding.ts";
import { isJsonNumber, type JsonFormat, JsonError, type JsonToken, jsonCuts, quote, scanJson, scanJsonl, stringOffsets } from "./json.ts";
import { type BlindMap, foldText, withoutValues } from "./map.ts";
import { type EntityEntry, Pseudonymizer } from "./pseudonym.ts";
import { lastKey } from "./birthdate.ts";
import { type ColumnDefault, type ColumnOutcome, decide, holdsWhole, isFallback, removedForms } from "./columns.ts";
import { type ContextOptions, type ContextTriggerSpec, pairCells } from "./context.ts";
import { DocxError, type DocxPlan, docxParagraphs, docxWholes, FONT, planDocx, THUMBNAIL, thumbnailReason, refuseDocxUnrewritten, renderDocx, scanDocx } from "./docx.ts";
import { cellText } from "../formats/xlsx.ts";
import { OfficeIds } from "./officeid.ts";
import { NameRewriter, rewriteSpans } from "./names.ts";
import { canonicalize } from "./canonical.ts";
import { proseNamesWithTitles } from "./prose.ts";
import { isHonorificOrRole } from "./honorifics.ts";
import { isLabelCell, isLabelColumn } from "./labels.ts";
import { personAliases } from "./identity.ts";
import { commonNamePartCount, keepForms, keptWords, nameParts, personPartForms, personValues, proseForms, recurrenceExclusion, recurrenceForms, TextScanner, vocabularyForms } from "./recur.ts";
import { EntityMatcher, type ExtraForm, keepDomains, type Span } from "./text.ts";
import { entrySpans, keptSpeakers, planTranscript, shapeParagraphs, speakerForms, speakersOf, type TranscriptPlan, transcriptSpans } from "./transcript.ts";
import { unrewrittenSpans } from "./unrewritten.ts";
import { pseudoCell, pseudoWrite } from "./shapes.ts";
import { IMAGE, type ImageMode, imageWarning } from "./images.ts";
import { type Env, planXlsx, prepareXlsx, renderXlsx, settleXlsx, XlsxError, type XlsxPlan, XlsxSpecError, xlsxValues, ZipError } from "./xlsx.ts";

/** XLSX members that are not XML but are copied unchanged and listed as unread. */
const XLSX_COPIED = (name: string): boolean => !THUMBNAIL.test(name) && (IMAGE.test(name) || FONT.test(name) || /^xl\/printerSettings\/[^/]+\.bin$/i.test(name));

export type EngineFormat = "csv" | "tsv" | "json" | "jsonl" | "text" | "docx" | "xlsx" | "vtt" | "srt";

const EXTENSIONS: Record<string, EngineFormat> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".txt": "text",
  ".text": "text",
  ".md": "text",
  ".markdown": "text",
  ".log": "text",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".vtt": "vtt",
  ".srt": "srt",
};

/** The format this engine handles a path as, or null when it does not handle it. */
export function engineFormat(path: string): EngineFormat | null {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash + 1) return null;
  return EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

export interface InputFile {
  /** Path relative to the input root, "/"-separated; what spec rules name in `file`. */
  path: string;
  bytes: Uint8Array;
}

export type { ColumnOutcome } from "./columns.ts";

export interface ColumnReport {
  /** 0-based column index (for JSON, the key path's position in first-seen order). */
  index: number;
  /** "" for a JSON key path. */
  header: string;
  /** JSON/JSONL only: the key path. */
  jsonPath?: string;
  /** XLSX only: the worksheet. */
  sheet?: string;
  class: EntityClassName;
  /** null when the spec has no rule for the column. */
  treatment: Treatment | null;
  outcome: ColumnOutcome;
  /** Cells whose content changed. */
  changed: number;
  /** Kept (`keep`) cells that contain a spec entity or a pattern match, left unchanged as the spec says. */
  flagged: number;
  /**
   * XLSX only, when the column failed closed with no rule (`unknown-pseudonymised`): its number
   * cells, left as written because only a rule renumbers a number (AGT-1822). Absent when 0.
   */
  numbersLeft?: number;
  /**
   * When the column failed closed with no rule: cells left as text (and scanned) instead of
   * pseudonymised whole, because the same value is held whole in a `keep` or `scan` cell somewhere
   * in the corpus. Absent when 0.
   */
  heldWhole?: number;
}

export interface FileReport {
  /** The input path, as spec rules name it. */
  path: string;
  /** Where the blinded file is written: `path` with its folder and file names blinded. */
  outputPath: string;
  format: EngineFormat;
  /** Absent for XLSX, a zip whose XML members are UTF-8. */
  encoding?: Encoding;
  /** CSV/TSV only. */
  delimiter?: string;
  /** CSV/TSV only: 1-based header row (0 for an empty file). */
  headerRow?: number;
  /** CSV/TSV only: no row looked like a header, so row 1 was used, as the profiler does. */
  noHeader?: boolean;
  /** CSV/TSV only: data rows wider than the header (a stray delimiter); their extra cells continue the last column. Absent when 0. */
  overflowRows?: number;
  columns: ColumnReport[];
  /** Free-text replacements (text files, and header, preamble and kept cells of tables). */
  entityReplacements: number;
  patternReplacements: number;
  /** Values pseudonymised by a column rule, replaced whole in Office metadata, or held by an earlier map, found again and replaced elsewhere. */
  mappedReplacements: number;
  /** Values of dropped or redacted columns, found again and replaced elsewhere (AGT-1835). */
  removedReplacements?: number;
  /** Host names left as written because they are under a keep-list domain. */
  keptHosts: number;
  /** DOCX and XLSX: identity metadata (authors, initials, creator, company) and account names in paths replaced as a whole. */
  metadataReplacements?: number;
  /** Parts of the file copied without blinding (images), for the report. */
  warnings?: string[];
  /** XLSX only: each worksheet, its header row and its blinded name. */
  sheets?: { name: string; outputName: string; headerRow: number; noHeader: boolean }[];
  /** XLSX only: members that are not XML (images, binaries), copied as they are without being read. */
  unread?: string[];
  /** Set when the file was read as a transcript. */
  transcript?: TranscriptReport;
  /** Any file that is not a transcript (text, table, JSON, XLSX, DOCX): transcript speakers' names (or parts, or misspellings) replaced in it. */
  speakerMentions?: number;
  /** People named only in prose (no column, speaker, map or spec entity names them), or parts of their names, replaced. Absent when 0. */
  proseNames?: number;
  /** Names replaced as a new person because a given name stood right before a known person's surname (AGT-1854). Absent when 0. */
  joinedNames?: number;
  changed: boolean;
}

export interface TranscriptReport {
  /** How it was read: WebVTT, SRT, or timestamped speaker paragraphs in a text file or DOCX. */
  kind: "vtt" | "srt" | "text" | "docx";
  /** Distinct speakers. */
  speakers: number;
  /** Speaker tags and prefixes replaced. */
  speakerTags: number;
  /** Speaker tags left as written because the name is a keep-list term or a spec vocabulary form. */
  keptTags: number;
  /** Spoken speaker names, name parts and misspellings replaced. */
  spokenMentions: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface ApplyResult {
  /** Only files that were fully processed; skipped files have no output. */
  outputs: InputFile[];
  files: FileReport[];
  /** Files not written, and why. Never silently dropped. */
  skipped: SkippedFile[];
  map: BlindMap;
  /** Entries of the earlier map dropped because they hold a value of a `drop`/`redact`/secret column (AGT-1847). */
  mapEntriesDropped: number;
  /**
   * The pseudonyms given to name parts that two or more people share (a surname of two people
   * blinded in a column): each got its own pseudonym, never either person's. Sorted.
   */
  sharedNameParts: string[];
  /**
   * How many name parts of blinded people are not matched alone because they are common words
   * (a dictionary, field-label, honorific or role word, a keep term or a word of a kept value;
   * AGT-1852). Their whole names still recur.
   */
  commonNameParts: number;
  /** What the kept values and the built-in placeholders shielded in this run (shield.ts, AGT-1853). */
  shield: ShieldReport;
}

export interface ApplyOptions {
  salt: Uint8Array;
  /** An earlier map; its pseudonyms are reused verbatim. */
  map?: BlindMap;
  /** The policy keep list. Its domain-shaped terms keep the host names under them as written. */
  keep?: readonly string[];
  /**
   * Context-keyword redaction (context.ts): the value after "gate code", "password" and the like is
   * written as REDACTED. On unless `enabled` is false; `triggers` adds words to the built-in list.
   */
  context?: { enabled: boolean; triggers: readonly ContextTriggerSpec[] };
  /** What a column with no rule (or an unknown/value rule) gets: `fallback` (the default) or `scan`. */
  columns?: ColumnDefault;
  /** The built-in placeholder allowlist (John Doe, 123 Main St, 999-9999, user@example.com) is kept as written unless false. */
  placeholders?: boolean;
  /**
   * Embedded pictures in DOCX and XLSX (blind.toml `[images]`): `replace` (the default) writes a neutral
   * placeholder of the same format under the same part name; `keep` copies them unchanged, with a warning.
   */
  images?: ImageMode;
  /** Blinded-name shape (blind.toml `[pseudonyms] style`), passed to the Pseudonymizer, which renders it. The CLI does not forward it yet (AGT-1931). */
  pseudonymStyle?: "readable" | "compact";
}

/** The spec does not fit the inputs (a rule names a column that is not there, or a shape this engine cannot apply). */
export class ApplyError extends Error {
  override name = "ApplyError";
}

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Header and key words that say nothing about a role. */
const GENERIC_ROLES = new Set(["name", "value", "id", "field", "column", "col"]);

/**
 * The readable role label a header or JSON key gives its values (AGT-1932), or undefined for the class
 * word: ASCII letters and spaces, Title Case, at most 24 characters; `_`, `-` and camelCase split into words.
 * Generic (`name`, `value`, `id`, `field`, `column`, `col`), empty, numeric and non-ASCII headers give none.
 */
export function roleLabel(header: string | undefined): string | undefined {
  if (header === undefined || /[^\x00-\x7f]/.test(header)) return undefined;
  const words = header
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  let label = "";
  for (const w of words) {
    const next = label === "" ? w : `${label} ${w}`;
    if (next.length > 24) break;
    label = next;
  }
  if (label === "" && words.length > 0) label = (words[0] as string).slice(0, 24);
  if (label === "" || GENERIC_ROLES.has(label.toLowerCase())) return undefined;
  return label;
}

/** `fixed`: the whole value replaced by a set text (a `redact` column's REDACTED_VALUE). */
type CellEdit = { kind: "pseudo"; cls: PseudoClass } | { kind: "spans"; spans: Span[] } | { kind: "fixed"; value: string };

/** Text scanned once every column is decided: a cell kept as text or under `keep`, a header, a JSON key. */
interface Pending<K> {
  key: K;
  value: string;
  keep: boolean;
  /** The column a data cell belongs to; null for headers, preamble rows and structural keys. */
  column: ColumnReport | null;
}

interface TablePlan {
  kind: "table";
  format: "csv" | "tsv";
  input: InputFile;
  encoding: Encoding;
  text: string;
  delim: string;
  rows: Row[];
  headerRow: number;
  noHeader: boolean;
  /** Keyed by `${row}:${col}`. */
  edits: Map<string, CellEdit>;
  pending: Pending<string>[];
  /** Values the column pass pseudonymised (columns classed `vocabulary` aside): they recur elsewhere. */
  mapped: ExtraForm[];
  /** Values of dropped and redacted columns: they recur like `mapped` ones (AGT-1835). */
  removed: ExtraForm[];
  columns: ColumnReport[];
  /** 0-based indices of `drop` columns, removed from every row (preamble and header too) on render. */
  dropped: Set<number>;
  /** Data rows wider than the header; their extra cells continue the last column. */
  overflowRows: number;
  /** Cells the fail-closed fallback pseudonymised whole, settled once every plan exists (settleFallback). */
  fallback: Fallback<string>[];
}

/** A cell the fail-closed fallback pseudonymised whole: its edit, and the recurring form it added. */
interface Fallback<K> {
  key: K;
  value: string;
  column: ColumnReport;
  form: ExtraForm;
}

interface TextPlan {
  kind: "text";
  input: InputFile;
  encoding: Encoding;
  text: string;
  /** Filled once every column is decided. */
  spans: Span[];
  /** Set when the text reads as a transcript. */
  transcript?: TranscriptPlan;
}

interface JsonPlan {
  kind: "json";
  format: JsonFormat;
  input: InputFile;
  encoding: Encoding;
  text: string;
  tokens: JsonToken[];
  /** Keyed by token index. */
  edits: Map<number, CellEdit>;
  pending: Pending<number>[];
  mapped: ExtraForm[];
  /** Values of dropped and redacted columns: they recur like `mapped` ones (AGT-1835). */
  removed: ExtraForm[];
  columns: ColumnReport[];
  /** Text ranges removed for `drop` key paths (jsonCuts), and the tokens inside them. */
  cuts: { ranges: [number, number][]; tokens: Set<number> };
  fallback: Fallback<number>[];
}

interface DocxFilePlan {
  kind: "docx";
  input: InputFile;
  docx: DocxPlan;
  /** Set when the body paragraphs read as a transcript: its speakers, spoken text and speaker tags. */
  transcript?: { speakers: string[]; spoken: string[]; tags: string[] };
}

interface WorkbookPlan {
  kind: "xlsx";
  input: InputFile;
  plan: XlsxPlan;
}

type Plan = TablePlan | TextPlan | JsonPlan | DocxFilePlan | WorkbookPlan;

const isFilled = (c: Cell | undefined): c is Cell => c !== undefined && c.value.trim() !== "";

/**
 * The text read for people named only in prose (AGT-1830): what the scanner reads as free text, and
 * the values of cells under `keep`, whose names stay as written. Number cells are not read. The
 * order (plans by path, then each plan's own cell order) does not matter: proseNames sorts.
 */
function proseInputs(plans: readonly Plan[]): { free: string[]; kept: string[] } {
  const free: string[] = [];
  const kept: string[] = [];
  for (const p of plans) {
    if (p.kind === "text") free.push(p.text);
    else if (p.kind === "docx") free.push(...docxParagraphs(p.docx, "all"));
    else if (p.kind === "xlsx") {
      for (const c of p.plan.pending) {
        if (c.cell.action.kind === "keep") kept.push(c.text);
        else if (!c.number) free.push(c.text);
      }
    } else for (const q of p.pending) (q.keep ? kept : free).push(q.value);
  }
  return { free, kept };
}

/** Scan the pending text of a plan: free text gets every span, a `keep` cell only recurring values. */
function scanPending<K>(pending: readonly Pending<K>[], edits: Map<K, CellEdit>, scanner: TextScanner): void {
  for (const p of pending) {
    if (p.keep && p.column !== null && scanner.flagged(p.value)) p.column.flagged++;
    const spans = p.keep ? scanner.kept(p.value) : scanner.free(p.value);
    if (spans.length > 0) edits.set(p.key, { kind: "spans", spans });
  }
}

const contextOf = (opts: ApplyOptions): ContextOptions | undefined =>
  opts.context?.enabled === false ? undefined : { triggers: opts.context?.triggers ?? [] };

function planTable(
  input: InputFile,
  encoding: Encoding,
  text: string,
  format: "csv" | "tsv",
  rules: readonly ColumnRule[],
  context: ContextOptions | undefined,
  unruled: ColumnDefault,
): TablePlan {
  const delim = sniffDelimiter(text, format === "tsv" ? "\t" : undefined);
  const rows = parseCsv(text, delim);
  // 0-based; like the profiler, row 1 stands in when no row looks like a header.
  const detected = detectHeaderRow(rows.map((r) => r.cells.map((c) => c.value)));
  const headerRow = rows.length === 0 ? -1 : (detected ?? 1) - 1;
  const overflowRows = assertRowWidths(rows.map((r) => r.cells), headerRow);
  const headerCells = headerRow >= 0 ? (rows[headerRow] as Row).cells : [];
  // The header sets the columns. A data row's extra cells (a stray delimiter) continue the last column.
  const width = headerCells.length;
  const lastCol = width - 1;
  const maxCells = Math.max(width, ...rows.slice(headerRow + 1).map((r) => r.cells.length));
  const headers = Array.from({ length: width }, (_, i) => headerCells[i]?.value ?? "");

  for (const rule of rules) {
    if (rule.jsonPath !== undefined || rule.sheet !== undefined) {
      throw new ApplyError(`${input.path}: a spec rule uses ${rule.jsonPath !== undefined ? "jsonPath" : "sheet"}, but this is a ${format.toUpperCase()} file; name the column by its header`);
    }
    if (!headers.some((h) => h.trim() === (rule.header as string).trim())) {
      throw new ApplyError(
        `${input.path}: the spec has a rule for column ${JSON.stringify(rule.header)}, which is not in the header row (row ${headerRow + 1}); fix the rule or re-plan`,
      );
    }
  }

  const edits = new Map<string, CellEdit>();
  const pending: Pending<string>[] = [];
  const mapped: ExtraForm[] = [];
  const removed: ExtraForm[] = [];
  const columns: ColumnReport[] = [];
  const dropped = new Set<number>();
  const keptCols = new Set<number>();
  /** Header cells pseudonymised as the value of a key/value block's label header. */
  const headerPaired = new Set<number>();
  const fallback: Fallback<string>[] = [];
  const data = rows.slice(headerRow + 1);
  for (let col = 0; col < width; col++) {
    const header = headers[col] as string;
    const rule = rules.find((r) => (r.header as string).trim() === header.trim());
    // The cells of this column in a row, with their positions: the last column also owns the overflow.
    const owned = (row: Row): { cell: Cell; at: number }[] =>
      (col === lastCol ? row.cells.slice(col) : row.cells.slice(col, col + 1)).map((cell, i) => ({ cell, at: col + i }));
    const { action, outcome } = decide(rule, data.flatMap((r) => (col === lastCol ? owned(r).map((o) => o.cell.value) : [r.cells[col]?.value ?? ""])), { delimiter: delim, name: header }, unruled);
    const column: ColumnReport = {
      index: col,
      header,
      class: rule?.class ?? "unknown",
      treatment: rule?.treatment ?? null,
      outcome,
      changed: 0,
      flagged: 0,
    };
    columns.push(column);
    if (action.kind === "keep") keptCols.add(col);
    if (action.kind === "drop" || action.kind === "redact") {
      removed.push(...removedForms(rule, data.map((r) => r.cells[col]?.value ?? "")));
    }
    // A key/value block (AGT-1852): a rule pseudonymises a column of field labels ("Phone", "Card",
    // "Email") with values to its right. The labels are not values of the rule's class: they stay
    // as text. The value paired with the label column's own header ("Client" | "Dana Example") is.
    const labels = action.kind === "pseudo" && col < width - 1 && isLabelColumn(data.map((r) => r.cells[col]?.value ?? ""));
    if (labels && action.kind === "pseudo" && headerRow >= 0) {
      const paired = headerCells[col + 1];
      if (isFilled(paired) && !isLabelCell(paired.value) && rule?.class !== "vocabulary") {
        edits.set(`${headerRow}:${col + 1}`, { kind: "pseudo", cls: action.cls });
        mapped.push({ cls: action.cls, value: paired.value });
        headerPaired.add(col + 1);
        column.changed++;
      }
    }
    if (action.kind === "drop") {
      dropped.add(col);
      if (col === lastCol) for (let c = width; c < maxCells; c++) dropped.add(c);
      column.changed = data.filter((row) => owned(row).some((o) => isFilled(o.cell))).length;
      continue;
    }
    data.forEach((row, i) => {
      for (const { cell, at } of owned(row)) {
        if (!isFilled(cell)) continue;
        const key = `${headerRow + 1 + i}:${at}`;
        if (action.kind === "redact") edits.set(key, { kind: "fixed", value: REDACTED_VALUE });
        else if (labels && isLabelCell(cell.value)) pending.push({ key, value: cell.value, keep: false, column });
        else if (action.kind === "pseudo") {
          edits.set(key, { kind: "pseudo", cls: action.cls });
          if (rule?.class === "vocabulary") continue;
          const form: ExtraForm = { cls: action.cls, value: pseudoCell(action.cls, cell.value).core };
          mapped.push(form);
          if (isFallback(outcome)) fallback.push({ key, value: cell.value, column, form });
        } else pending.push({ key, value: cell.value, keep: action.kind === "keep", column });
      }
    });
  }
  // Preamble rows and the header row are free text. A dropped column leaves with its header; a
  // preamble row (a title, a note) is not part of any column and is never cut.
  for (let r = 0; r <= headerRow; r++) {
    (rows[r] as Row).cells.forEach((cell, col) => {
      if (r === headerRow && headerPaired.has(col)) return;
      if (r < headerRow || !dropped.has(col)) pending.push({ key: `${r}:${col}`, value: cell.value, keep: false, column: null });
    });
  }
  // A cell that holds the value of a label in another cell ("DOB" | "01/02/1960"), in a column
  // the column pass left as text (not one a rule keeps), is replaced whole (AGT-1841).
  if (context !== undefined) {
    const grid = rows.map((r) => r.cells.map((c) => c.value));
    const marks = pairCells(grid, context, Math.max(0, headerRow));
    const forced = new Set<string>();
    for (const m of marks) {
      // A detected header row names the columns that rules and later runs refer to: never rewritten.
      if (dropped.has(m.col) || keptCols.has(m.col) || (detected !== null && m.row === headerRow)) continue;
      const key = `${m.row}:${m.col}`;
      // A cell the column pass already pseudonymised, redacted or dropped is hidden: leave it be.
      const decided = edits.get(key);
      if (decided !== undefined && decided.kind !== "spans") continue;
      edits.set(key, { kind: "fixed", value: REDACTED_VALUE });
      forced.add(key);
    }
    for (let i = pending.length - 1; i >= 0; i--) if (forced.has((pending[i] as Pending<string>).key)) pending.splice(i, 1);
  }
  return {
    kind: "table",
    format,
    input,
    encoding,
    text,
    delim,
    rows,
    headerRow,
    noHeader: rows.length > 0 && detected === null,
    edits,
    pending,
    mapped,
    removed,
    columns,
    dropped,
    overflowRows,
    fallback,
  };
}

function planJson(
  input: InputFile,
  encoding: Encoding,
  text: string,
  format: JsonFormat,
  rules: readonly ColumnRule[],
  unruled: ColumnDefault,
): JsonPlan {
  const tokens = format === "json" ? scanJson(text) : scanJsonl(text);
  // Key paths in first-seen order, with the tokens under each (literals too, so a path holding only nulls still exists).
  const byPath = new Map<string, number[]>();
  tokens.forEach((t, i) => {
    if (t.column === null) return;
    const list = byPath.get(t.column) ?? [];
    list.push(i);
    byPath.set(t.column, list);
  });
  for (const rule of rules) {
    if (rule.jsonPath === undefined || rule.sheet !== undefined) {
      throw new ApplyError(`${input.path}: a spec rule uses ${rule.sheet !== undefined ? "sheet" : "header"}, but this is a ${format.toUpperCase()} file; name the key by its jsonPath`);
    }
    if (!byPath.has(rule.jsonPath)) {
      throw new ApplyError(`${input.path}: the spec has a rule for key path ${JSON.stringify(rule.jsonPath)}, which is not in the file; fix the rule or re-plan`);
    }
  }

  const edits = new Map<number, CellEdit>();
  const pending: Pending<number>[] = [];
  const mapped: ExtraForm[] = [];
  const removed: ExtraForm[] = [];
  const columns: ColumnReport[] = [];
  const dropped: number[] = [];
  const fallback: Fallback<number>[] = [];
  for (const [path, indices] of byPath) {
    const rule = rules.find((r) => r.jsonPath === path);
    if ((rule?.treatment === "drop" || rule?.treatment === "redact") && (path === "$" || path.endsWith("~"))) {
      throw new ApplyError(
        `${input.path}: the spec ${rule.treatment === "drop" ? "drops" : "redacts"} key path ${JSON.stringify(path)}, which is ${path === "$" ? "the document root" : "a set of record-ID keys"}; drop and redact apply to values under a key`,
      );
    }
    const valued = indices.filter((i) => (tokens[i] as JsonToken).kind !== "literal");
    const { action, outcome } = decide(rule, valued.map((i) => (tokens[i] as JsonToken).value), { name: lastKey(path) }, unruled);
    const column: ColumnReport = {
      index: columns.length,
      header: "",
      jsonPath: path,
      class: rule?.class ?? "unknown",
      treatment: rule?.treatment ?? null,
      outcome,
      changed: 0,
      flagged: 0,
    };
    columns.push(column);
    if (action.kind === "drop" || action.kind === "redact") removed.push(...removedForms(rule, valued.map((i) => (tokens[i] as JsonToken).value)));
    if (action.kind === "drop") {
      // The member goes whatever its value, null included.
      dropped.push(...indices);
      column.changed = indices.length;
      continue;
    }
    for (const i of valued) {
      const value = (tokens[i] as JsonToken).value;
      if (value.trim() === "") continue;
      if (action.kind === "redact") {
        edits.set(i, { kind: "fixed", value: REDACTED_VALUE });
        continue;
      }
      if (action.kind === "pseudo") {
        edits.set(i, { kind: "pseudo", cls: action.cls });
        if (rule?.class === "vocabulary") continue;
        const form: ExtraForm = { cls: action.cls, value: pseudoCell(action.cls, value).core };
        mapped.push(form);
        if (isFallback(outcome)) fallback.push({ key: i, value, column, form });
      } else pending.push({ key: i, value, keep: action.kind === "keep", column });
    }
  }
  const cuts = jsonCuts(text, tokens, dropped);
  // Structural keys (field names) are free text, like a table's header row; a dropped member's key goes with it.
  tokens.forEach((t, i) => {
    if (t.kind === "key" && t.column === null && !cuts.tokens.has(i)) pending.push({ key: i, value: t.value, keep: false, column: null });
  });
  return { kind: "json", format, input, encoding, text, tokens, edits, pending, mapped, removed, columns, cuts, fallback };
}

/** A string literal with the spans replaced; every untouched character keeps its original escaping. */
function spliceString(raw: string, spans: readonly Span[], pz: Pseudonymizer): string {
  const offs = stringOffsets(raw);
  const at = (i: number): number => offs[i] as number;
  let out = '"';
  let pos = 0;
  for (const s of spans) {
    out += raw.slice(at(pos), at(s.start));
    out += s.cls === null ? raw.slice(at(s.start), at(s.end)) : quote(pz.pseudonym(s.cls, s.value)).slice(1, -1);
    pos = s.end;
  }
  return `${out}${raw.slice(at(pos), raw.length - 1)}"`;
}

function renderJson(
  p: JsonPlan,
  pz: Pseudonymizer,
): { text: string; entityReplacements: number; patternReplacements: number; mappedReplacements: number; keptHosts: number } {
  const byPath = new Map(p.columns.map((c) => [c.jsonPath as string, c]));
  // Per object, each output key and the input key it came from: two input keys must never become one.
  const keys = new Map<number, Map<string, string>>();
  let entityReplacements = 0;
  let patternReplacements = 0;
  let mappedReplacements = 0;
  let keptHosts = 0;
  // Replacements and cuts, spliced into the text at the end; they never overlap.
  const patches: { start: number; end: number; text: string }[] = p.cuts.ranges.map(([start, end]) => ({ start, end, text: "" }));
  p.tokens.forEach((t, i) => {
    if (p.cuts.tokens.has(i)) return;
    const edit = p.edits.get(i);
    let value = t.value;
    if (edit !== undefined) {
      if (edit.kind === "pseudo") value = pseudoWrite(pz, edit.cls, t.value);
      else if (edit.kind === "fixed") value = edit.value;
      else {
        value = rewriteSpans(t.value, edit.spans, pz);
        entityReplacements += count(edit.spans, "entity");
        patternReplacements += count(edit.spans, "pattern");
        mappedReplacements += count(edit.spans, "map");
        keptHosts += keptHostCount(edit.spans);
      }
      if (value !== t.value) {
        const raw = p.text.slice(t.start, t.end);
        // A number stays a bare number when its replacement is one; otherwise it becomes a string.
        const written =
          t.kind === "number" ? (isJsonNumber(value) ? value : quote(value)) : edit.kind !== "spans" ? quote(value) : spliceString(raw, edit.spans, pz);
        patches.push({ start: t.start, end: t.end, text: written });
        if (t.column !== null) (byPath.get(t.column) as ColumnReport).changed++;
      }
    }
    if (t.kind === "key") {
      const seen = keys.get(t.object as number) ?? new Map<string, string>();
      const from = seen.get(value);
      if (from !== undefined && from !== t.value) {
        throw new ApplyError(
          `${p.input.path}: blinding would give two keys of one object the same name${t.column === null ? "" : ` (key path ${JSON.stringify(t.column)})`}; change the rule for those keys so they stay distinct`,
        );
      }
      seen.set(value, t.value);
      keys.set(t.object as number, seen);
    }
  });
  let out = "";
  let at = 0;
  for (const x of patches.sort((a, b) => a.start - b.start)) {
    out += p.text.slice(at, x.start) + x.text;
    at = x.end;
  }
  return { text: out + p.text.slice(at), entityReplacements, patternReplacements, mappedReplacements, keptHosts };
}

/** Tokens of a text, for the set of real values no pseudonym may equal. */
function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}._@:-]*/gu) ?? [];
}

function count(spans: readonly Span[], source: Span["source"]): number {
  return spans.filter((s) => s.cls !== null && s.source === source).length;
}

const countJoined = (spans: readonly Span[]): number => spans.filter((s) => s.cls !== null && s.joined === true).length;

function transcriptReport(
  kind: TranscriptReport["kind"],
  speakers: readonly string[],
  tags: readonly string[],
  speakerReplacements: number,
  kept: (name: string) => boolean,
): TranscriptReport {
  const keptTags = tags.filter(kept).length;
  const speakerTags = tags.length - keptTags;
  return { kind, speakers: speakers.length, speakerTags, keptTags, spokenMentions: Math.max(0, speakerReplacements - speakerTags) };
}

/** A text file's speaker counts: its transcript report, or the speaker names replaced in it. */
function textSpeakers(spans: readonly Span[], t: TranscriptPlan | undefined, kept: (name: string) => boolean): Pick<FileReport, "transcript" | "speakerMentions"> {
  const n = count(spans, "speaker");
  if (t === undefined) return n > 0 ? { speakerMentions: n } : {};
  return { transcript: transcriptReport(t.kind, speakersOf(t.entries), t.tags.map((x) => x.name), n, kept) };
}

const keptHostCount = (spans: readonly Span[]): number => spans.filter((s) => s.cls === null && s.source === "pattern").length;

/** Trimmed text of every cell under `keep`, `scan` or the `scan` default, across the corpus (`keepOnly`: under `keep` alone). */
function heldValues(plans: readonly Plan[], keepOnly = false): Set<string> {
  const out = new Set<string>();
  const held = (outcome: ColumnOutcome): boolean => (keepOnly ? outcome === "kept" : holdsWhole(outcome));
  for (const p of plans) {
    if (p.kind === "xlsx") {
      for (const c of p.plan.pending) if (held(c.column.outcome)) out.add(c.text.trim());
    } else if (p.kind === "table" || p.kind === "json") {
      for (const q of p.pending) if (q.column !== null && held(q.column.outcome)) out.add(q.value.trim());
    }
  }
  return out;
}

/**
 * Whether a cell's text holds a value of a `drop`/`redact`/secret column (or a part of a name from one)
 * inside a longer text. The fail-closed fallback must not pseudonymise such a cell whole: the map would
 * record the text, secret included (AGT-1847). It is scanned instead, so the value is redacted in place.
 */
function hidesRemoved(plans: readonly Plan[]): (text: string) => boolean {
  const removed = plans.flatMap((p) => (p.kind === "text" || p.kind === "docx" ? [] : p.kind === "xlsx" ? p.plan.removed : p.removed));
  const needles = new Set<string>();
  for (const f of removed) if (recurrenceExclusion(f.value.trim(), new Set()) === null) needles.add(foldText(f.value));
  const names = [...new Set(removed.filter((f) => f.named === true).map((f) => f.value))];
  for (const part of nameParts(names, [], new Set(), new Set())) if (part.exclusion === null) needles.add(foldText(part.form));
  const list = [...needles];
  return (text) => {
    const t = foldText(text);
    return list.some((n) => t.includes(n));
  };
}

/**
 * Settle every cell the fail-closed fallback pseudonymised whole: one whose value is held whole in a
 * `keep` or `scan` cell somewhere (heldValues) is left as text instead, scanned like free text, and
 * counted in its column's `heldWhole`; it no longer recurs. Every plan's own decisions stand.
 */
function settleFallback(plans: readonly Plan[]): void {
  const heldSet = heldValues(plans);
  const hides = hidesRemoved(plans);
  const held = { has: (t: string): boolean => heldSet.has(t) || hides(t) };
  const release = <K>(fallback: readonly Fallback<K>[], edits: Map<K, CellEdit>, pending: Pending<K>[], mapped: ExtraForm[]): void => {
    const freed = new Set<ExtraForm>();
    for (const f of fallback) {
      if (!held.has(f.value.trim())) continue;
      edits.delete(f.key);
      pending.push({ key: f.key, value: f.value, keep: false, column: f.column });
      f.column.heldWhole = (f.column.heldWhole ?? 0) + 1;
      freed.add(f.form);
    }
    if (freed.size === 0) return;
    const rest = mapped.filter((m) => !freed.has(m));
    mapped.length = 0;
    mapped.push(...rest);
  };
  for (const p of plans) {
    if (p.kind === "table") release(p.fallback, p.edits, p.pending, p.mapped);
    else if (p.kind === "json") release(p.fallback, p.edits, p.pending, p.mapped);
    else if (p.kind === "xlsx") settleXlsx(p.plan, held);
  }
}

export function applySpec(inputs: readonly InputFile[], spec: Spec, opts: ApplyOptions): ApplyResult {
  const sorted = [...inputs].sort((a, b) => cmp(a.path, b.path));
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] as InputFile).path === (sorted[i - 1] as InputFile).path) {
      throw new ApplyError(`two inputs share the path ${JSON.stringify((sorted[i] as InputFile).path)}`);
    }
  }
  const keep = keepDomains(opts.keep ?? []);
  const unruled = opts.columns ?? "fallback";
  const rulesByFile = new Map<string, ColumnRule[]>();
  for (const rule of spec.columns) {
    const list = rulesByFile.get(rule.file) ?? [];
    list.push(rule);
    rulesByFile.set(rule.file, list);
  }

  const plans: Plan[] = [];
  const skipped: SkippedFile[] = [];
  for (const input of sorted) {
    const format = engineFormat(input.path);
    if (format === null) {
      skipped.push({ path: input.path, reason: "format not supported by this engine yet; not written" });
      continue;
    }
    const rules = rulesByFile.get(input.path) ?? [];
    if (format === "docx") {
      if (rules.length > 0) {
        throw new ApplyError(`${input.path}: the spec has column rules for a DOCX file; column rules apply to tables only`);
      }
      try {
        const docx = planDocx(input.bytes, opts.images ?? "replace");
        const plan: DocxFilePlan = { kind: "docx", input, docx };
        if (shapeParagraphs(docxParagraphs(docx, docx.main === undefined ? "all" : "main")).shaped) {
          // Speakers come from every part's entries, so a speaker named only in a header is found too.
          const entries = shapeParagraphs(docxParagraphs(docx, "all")).entries;
          plan.transcript = {
            speakers: speakersOf(entries),
            spoken: entries.map((e) => e.text),
            tags: entries.flatMap((e) => (e.speaker === null ? [] : [e.speaker])),
          };
        }
        plans.push(plan);
      } catch (e) {
        if (!(e instanceof DocxError)) throw e;
        skipped.push({ path: input.path, reason: `${e.message}; not written` });
      }
      continue;
    }
    if (format === "xlsx") {
      try {
        const plan = planXlsx(input.path, input.bytes, rules, contextOf(opts), unruled);
        if (plan.refusal !== undefined) skipped.push({ path: input.path, reason: `${plan.refusal}; not written` });
        else plans.push({ kind: "xlsx", input, plan });
      } catch (e) {
        if (e instanceof XlsxSpecError) throw new ApplyError(e.message);
        if (!(e instanceof XlsxError || e instanceof ZipError)) throw e;
        skipped.push({ path: input.path, reason: `cannot read the workbook: ${e.message}; not written` });
      }
      continue;
    }
    let decoded;
    try {
      decoded = decode(input.bytes);
    } catch (e) {
      if (!(e instanceof EncodingError)) throw e;
      skipped.push({ path: input.path, reason: `${e.message}; not written` });
      continue;
    }
    if (format === "text" || format === "vtt" || format === "srt") {
      if (rules.length > 0) {
        throw new ApplyError(`${input.path}: the spec has column rules for a ${format === "text" ? "text" : "transcript"} file; column rules apply to tables only`);
      }
      const transcript = planTranscript(decoded.text) ?? undefined;
      if (format !== "text" && transcript === undefined) {
        skipped.push({ path: input.path, reason: `not ${format === "vtt" ? "a WebVTT" : "an SRT"} transcript (no cue timing found); not written` });
        continue;
      }
      plans.push({ kind: "text", input, encoding: decoded.encoding, text: decoded.text, spans: [], transcript });
      continue;
    }
    if (format === "json" || format === "jsonl") {
      try {
        plans.push(planJson(input, decoded.encoding, decoded.text, format, rules, unruled));
      } catch (e) {
        if (!(e instanceof JsonError)) throw e;
        skipped.push({ path: input.path, reason: `malformed ${format.toUpperCase()}: ${e.message}; not written` });
      }
      continue;
    }
    try {
      plans.push(planTable(input, decoded.encoding, decoded.text, format, rules, contextOf(opts), unruled));
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      skipped.push({ path: input.path, reason: `malformed ${format.toUpperCase()}: ${e.message}; not written` });
    }
  }

  // A value held whole in a `keep` or `scan` cell anywhere is the owner's to keep: the fail-closed
  // fallback does not pseudonymise it whole elsewhere (an explicit rule still does).
  settleFallback(plans);

  // File and folder names go through the patterns, the spec entities and every cell value a
  // column rule pseudonymises, so a value hidden in a cell is hidden in a name too.
  const columnValues: ExtraForm[] = [];
  for (const p of plans) {
    if (p.kind === "json") {
      for (const [i, edit] of p.edits) if (edit.kind === "pseudo") columnValues.push({ cls: edit.cls, value: (p.tokens[i] as JsonToken).value });
    } else if (p.kind === "xlsx") columnValues.push(...p.plan.columnValues);
    else if (p.kind === "table") {
      for (const [key, edit] of p.edits) {
        if (edit.kind !== "pseudo") continue;
        const [r, c] = key.split(":").map(Number) as [number, number];
        columnValues.push({ cls: edit.cls, value: ((p.rows[r] as Row).cells[c] as Cell).value });
      }
    }
  }
  // Office identity metadata (creator, authors, company, account names in paths) is replaced whole
  // whatever the spec says; those values recur like a pseudonymised column value (AGT-1812), so the
  // creator in a cell, a sheet name, another file or a file name gets the same pseudonym.
  const metadata = plans.flatMap((p) => (p.kind === "xlsx" ? p.plan.wholes : p.kind === "docx" ? docxWholes(p.docx) : []));
  columnValues.push(...metadata);
  // Transcript speakers: person forms for names, content and recurrences alike.
  const vocabulary = (spec.entities.vocabulary ?? []).flatMap((e) => [e.canonical, ...e.aliases, ...e.parts]);
  const kept = keptSpeakers(opts.keep ?? [], vocabulary);
  const speakers: string[] = [];
  const spoken: string[] = [];
  for (const p of plans) {
    if (p.kind === "text" && p.transcript !== undefined) {
      speakers.push(...speakersOf(p.transcript.entries));
      spoken.push(...p.transcript.entries.map((e) => e.text));
    } else if (p.kind === "docx" && p.transcript !== undefined) {
      speakers.push(...p.transcript.speakers);
      spoken.push(...p.transcript.spoken);
    }
  }
  // The values the column pass pseudonymised (an earlier map's are added by recurrenceForms), and
  // the people among them and in the map, whose name parts are matched alone too.
  const columnMapped = [...plans.flatMap((p) => (p.kind === "text" || p.kind === "docx" ? [] : p.kind === "xlsx" ? p.plan.mapped : p.mapped)), ...metadata];
  // Values of dropped and redacted columns recur just as a pseudonymised column's do (AGT-1835), but
  // are written as the redaction placeholder: never a pseudonym, never in the map (AGT-1847). The
  // exception is a value some column also pseudonymises: that pseudonym wins, and only that path
  // records it.
  const vocabularySet = vocabularyForms(spec.entities);
  const keepSet = keepForms(opts.keep);
  const textKey = (v: string): string => canonicalize("value", v);
  const mappedTexts = new Set(columnMapped.map((f) => textKey(f.value)));
  const removedAll = plans.flatMap((p) => (p.kind === "text" || p.kind === "docx" ? [] : p.kind === "xlsx" ? p.plan.removed : p.removed));
  const removedValues = removedAll.filter((f) => !mappedTexts.has(textKey(f.value)));
  // A removed column of people's names: its name parts are redacted where they recur too.
  const removedNames = [...new Set(removedValues.filter((f) => f.named === true).map((f) => f.value))].sort(cmp);
  // The words of values in keep columns: a column person's name part that is one of them is not
  // matched alone, so it never rewrites a kept cell (AGT-1852). The whole value still recurs.
  const read = proseInputs(plans);
  const shield = keptWords(read.kept, [...personValues(columnMapped, opts.map), ...removedNames]);
  const removedParts = (): ExtraForm[] =>
    nameParts(removedNames, [], vocabularySet, new Set([...keepSet, ...shield]))
      .filter((p) => p.exclusion === null)
      .map((p) => ({ cls: "redact" as const, value: p.form, form: p.form, source: "removed" as const }));
  // An earlier map's entries for such values go on the next write (the count is reported, never the values).
  const redactedParts = removedParts();
  const pruned = opts.map === undefined ? undefined : withoutValues(opts.map, [...removedValues.map((f) => f.value), ...redactedParts.map((f) => f.value)]);
  const priorMap = pruned?.map;
  const mapDropped = pruned?.dropped ?? 0;
  const asRemoved = (f: ExtraForm): ExtraForm => (f.cls === "redact" ? { ...f, source: "removed" } : f);
  const mapped = [...columnMapped, ...removedValues];
  columnValues.push(...removedValues);
  const voiceNames = speakers.filter((n) => !kept(n));
  const people = personValues(mapped, priorMap);
  // Redacted names are people too for who-is-who and for what prose is new, though they get no pseudonym.
  const knownPeople = [...people, ...removedNames];
  // People named only in prose (AGT-1830), in the text the scanner reads, less anyone already known.
  const known = new Set([...knownPeople, ...voiceNames].map((v) => canonicalize("person", v)));
  const found = proseNamesWithTitles(read.free, { keep: keepSet, vocabulary: vocabularySet, kept: read.kept });
  // Who is who (AGT-1842): "J. Sample" and "Dr. Sample" resolve to one known person when nothing else
  // fits (identity.ts). A lone name found after a title is considered with its title, as written.
  const titledSingles = [...found.titles].flatMap(([name, titles]) => (/\s/.test(name) ? [] : titles.map((t) => `${t} ${name}`)));
  const titled = new Set<string>();
  for (const v of [...knownPeople, ...voiceNames]) {
    const first = v.trim().split(/\s+/)[0] ?? "";
    if (isHonorificOrRole(first) && !canonicalize("person", v).startsWith(first.toLowerCase().replace(/\.$/, ""))) titled.add(canonicalize("person", v));
  }
  for (const name of found.titles.keys()) titled.add(canonicalize("person", name));
  const unknownProse = found.names.filter((v) => !known.has(canonicalize("person", v)));
  const aliases = personAliases([...knownPeople, ...voiceNames, ...unknownProse, ...titledSingles], titled);
  // A lone name seen only after titles that all resolve to one person is that person, not a second
  // person sharing the name, so it does not make that person's own name part ambiguous.
  const resolvedSingle = (name: string): boolean => {
    const targets = new Set((found.titles.get(name) ?? []).map((t) => aliases.get(canonicalize("person", `${t} ${name}`))?.key));
    return !/\s/.test(name) && targets.size === 1 && !targets.has(undefined);
  };
  const prosePeople = unknownProse.filter((v) => !resolvedSingle(v));
  const voices = speakerForms(voiceNames, spoken, vocabularySet, knownPeople, keepSet, aliases);
  // They count as other people for the known people's name parts, so a surname both share is ambiguous.
  const others = [...voiceNames, ...prosePeople];
  const recurOpts = { keep: opts.keep, speakers: others, aliases, keptWords: shield };
  const pseudoParts = personPartForms(mapped, priorMap, vocabularySet, recurOpts);
  const pseudoForms = recurrenceForms(mapped, spec.entities, priorMap, recurOpts).map(asRemoved);
  // A removed form whose text a pseudonymised form also matches is that pseudonym's, never the placeholder.
  const pseudoTexts = new Set([...pseudoForms, ...pseudoParts, ...voices].filter((f) => f.cls !== "redact").map((f) => textKey(f.form ?? f.value)));
  const redactable = (f: ExtraForm): boolean => f.cls !== "redact" || !pseudoTexts.has(textKey(f.form ?? f.value));
  const parts = [...pseudoParts, ...redactedParts].filter(redactable);
  const forms = [...pseudoForms, ...redactedParts].filter(redactable);
  // Name parts that are common words (dictionary, label, role, keep or kept-value words): reported, never matched alone.
  const commonNameParts = commonNamePartCount(mapped, priorMap, vocabularySet, recurOpts);
  // A form already matched for a known value or a speaker keeps that value's pseudonym.
  const claimed = new Set([...forms, ...voices, ...parts].map((f) => `${f.cls}\0${f.form ?? f.value}`));
  // A titled lone name ("Dr. Sample") that resolves to one person is matched with its title, which stays
  // as written, and counted with that person's other spans (a removed column's person stays `removed`).
  // One that does not resolve keeps the lone name's pseudonym, as before.
  const identity = (v: string): string => aliases.get(canonicalize("person", v))?.key ?? canonicalize("person", v);
  const sourceByPerson = new Map<string, ExtraForm["source"]>();
  for (const f of [...forms, ...parts, ...voices]) if (f.cls === "person" && !sourceByPerson.has(identity(f.value))) sourceByPerson.set(identity(f.value), f.source);
  for (const name of removedNames) if (!sourceByPerson.has(identity(name))) sourceByPerson.set(identity(name), "removed");
  const sourceOf = (key: string): ExtraForm["source"] => sourceByPerson.get(key) ?? "map";
  const titledForms: ExtraForm[] = titledSingles.map((form) => {
    const name = form.slice(form.lastIndexOf(" ") + 1);
    const alias = aliases.get(canonicalize("person", form));
    return alias !== undefined ? { cls: sourceOf(alias.key) === "removed" ? "redact" : "person", value: form, form, source: sourceOf(alias.key), lead: 1 } : { cls: "person", value: name, form, source: "prose", lead: 1 };
  });
  const prose = [...proseForms(prosePeople, [...people, ...voiceNames], vocabularySet, keepSet, aliases), ...titledForms].filter(
    (f) => !claimed.has(`${f.cls}\0${f.form ?? f.value}`),
  );
  // One rule, two halves: keptWords (above, AGT-1852) stops a word of a kept value from becoming a
  // name part; this shield stops pattern, entity and prose spans inside a kept value or placeholder.
  // Every distinct value of a `keep` column shields the same text everywhere (shield.ts), unless an
  // explicit rule also pseudonymises, drops or redacts it, or a spec entity names it.
  const explicit = [
    ...mapped.map((f) => f.value),
    ...columnValues.map((f) => f.value),
    ...Object.values(spec.entities).flatMap((list) => (list ?? []).flatMap((e) => [e.canonical, ...e.aliases])),
  ];
  const keptShield = new Shield(heldValues(plans, true), explicit, opts.placeholders !== false);
  const nameMatcher = new EntityMatcher(spec.entities, [...columnValues, ...voices, ...parts, ...prose]);
  const names = new NameRewriter(nameMatcher, spec.patterns, keep, { vocabulary: vocabularySet, keep: keepSet }, keptShield);
  for (const p of plans) names.planPath(p.input.path);

  // Every column is decided: scan the rest of the text for patterns, entities and the values the
  // column pass (or an earlier map) pseudonymised.
  // A speaker's form replaces a recurring value with the same text: it carries the speaker's pseudonym.
  const voiced = new Set(voices.map((v) => `${v.cls}\0${v.form as string}`));
  const scanForms = [...forms.filter((f) => !voiced.has(`${f.cls}\0${f.form ?? f.value}`)), ...voices, ...prose].sort(
    (a, b) => cmp(a.cls, b.cls) || cmp(a.form ?? a.value, b.form ?? b.value) || cmp(a.value, b.value),
  );
  const scanner = new TextScanner(spec.entities, spec.patterns, keep, scanForms, contextOf(opts), { keep: keepSet, vocabulary: vocabularySet }, keptShield);
  for (const p of plans) {
    // One secret-boost carry per document: its turns and paragraphs are scanned in order (secret.ts).
    const carry = newSecretCarry();
    const free = (t: string) => scanner.free(t, carry);
    if (p.kind === "text") p.spans = p.transcript !== undefined ? transcriptSpans(p.text, p.transcript, free, kept) : free(p.text);
    else if (p.kind === "docx") scanDocx(p.docx, p.transcript !== undefined ? (t) => entrySpans(t, free, kept) : free, contextOf(opts));
    else if (p.kind === "json") scanPending(p.pending, p.edits, scanner);
    else if (p.kind === "table") scanPending(p.pending, p.edits, scanner);
  }

  // Workbooks: plan their sheet and defined names, refuse one that holds a spec value where blind
  // does not rewrite, and record the pseudonyms the render will need.
  const xlsxEnv: Env = { scanner, names };
  const unhandled = new EntityMatcher(spec.entities, forms);
  // Spec values and every pattern shape, for the parts nothing rewrites.
  const unrewrittenAll = unrewrittenSpans((s) => unhandled.find(s, []), keep);
  const unrewritten = (s: string): Span[] => keptShield.filter(s, unrewrittenAll(s), false);
  for (let i = plans.length - 1; i >= 0; i--) {
    const p = plans[i] as Plan;
    if (p.kind !== "docx") continue;
    const refused = refuseDocxUnrewritten(p.docx, unrewritten);
    if (refused !== null) {
      skipped.push({ path: p.input.path, reason: refused });
      plans.splice(i, 1);
    }
  }
  for (let i = plans.length - 1; i >= 0; i--) {
    const p = plans[i] as Plan;
    if (p.kind !== "xlsx") continue;
    const refused = prepareXlsx(p.input.path, p.input.bytes, p.plan, xlsxEnv, unrewritten);
    if (refused !== null) {
      skipped.push({ path: p.input.path, reason: refused });
      plans.splice(i, 1);
    }
  }

  // Every real value in the corpus, so no pseudonym equals one.
  const avoid = new Set<string>();
  for (const p of plans) {
    for (const segment of p.input.path.split("/")) for (const t of tokens(segment)) avoid.add(t);
    if (p.kind === "text") for (const t of tokens(p.text)) avoid.add(t);
    else if (p.kind === "docx") {
      for (const v of p.docx.values) {
        avoid.add(v.trim());
        for (const t of tokens(v)) avoid.add(t);
      }
    } else if (p.kind === "xlsx") {
      for (const v of xlsxValues(p.plan)) {
        avoid.add(v.trim());
        for (const t of tokens(v)) avoid.add(t);
      }
    } else if (p.kind === "json") {
      for (const t of p.tokens) {
        if (t.kind === "literal") continue;
        avoid.add(t.value.trim());
        for (const w of tokens(t.value)) avoid.add(w);
      }
    } else {
      for (const row of p.rows) {
        for (const cell of row.cells) {
          avoid.add(cell.value.trim());
          for (const t of tokens(cell.value)) avoid.add(t);
        }
      }
    }
  }

  const entities: Partial<Record<PseudoClass, EntityEntry[]>> = {};
  for (const [cls, list] of Object.entries(spec.entities)) {
    if (cls !== "vocabulary" && list !== undefined) entities[cls as PseudoClass] = list;
  }
  const pz = new Pseudonymizer({ salt: opts.salt, map: priorMap, entities, avoid, personAliases: aliases, redactCards: patternOn(spec.patterns, "card"), style: opts.pseudonymStyle });
  const officeIds = new OfficeIds(opts.salt);

  // Pass 1 ends here: derive every pseudonym in sorted order.
  const requests = new Set<string>();
  const want = (cls: PseudoClass, value: string) => requests.add(`${cls}\0${value}`);
  for (const p of plans) {
    if (p.kind === "text") {
      for (const s of p.spans) if (s.cls !== null) want(s.cls, s.value);
      continue;
    }
    if (p.kind === "docx") {
      for (const r of p.docx.requests) want(r.cls, r.value);
      continue;
    }
    if (p.kind === "json") {
      for (const [i, edit] of p.edits) {
        if (edit.kind === "spans") {
          for (const s of edit.spans) if (s.cls !== null) want(s.cls, s.value);
        } else if (edit.kind === "pseudo") want(edit.cls, (p.tokens[i] as JsonToken).value);
      }
      continue;
    }
    if (p.kind === "xlsx") {
      for (const r of p.plan.requests) want(r.cls, r.value);
      continue;
    }
    for (const [key, edit] of p.edits) {
      if (edit.kind === "spans") {
        for (const s of edit.spans) if (s.cls !== null) want(s.cls, s.value);
      } else if (edit.kind === "pseudo") {
        const [r, c] = key.split(":").map(Number) as [number, number];
        want(edit.cls, ((p.rows[r] as Row).cells[c] as Cell).value);
      }
    }
  }
  for (const r of names.requests()) want(r.cls, r.value);
  // Role labels (AGT-1932): a value in a column or under a key is labelled from that header as written in
  // the output. The first label a value gets wins; it is only read by a readable-style Pseudonymizer.
  const labels = new Map<string, string>();
  const setLabel = (cls: PseudoClass, value: string, header: string | undefined, headerHidden: boolean) => {
    const label = headerHidden || header === undefined || pz.isPseudonym(header) || /[A-Za-z]_[0-9A-Fa-f]{4}/.test(header) ? undefined : roleLabel(header);
    if (label === undefined) return;
    const key = `${cls}\0${value}`;
    if (!labels.has(key)) labels.set(key, label);
  };
  /** Whether a header cell's output differs from its input: it was pseudonymised or holds a pseudonymised span. */
  const hidden = (e: CellEdit | undefined): boolean => e !== undefined && (e.kind !== "spans" || e.spans.some((s) => s.cls !== null));
  const requestValues = [...requests].map((r) => r.slice(r.indexOf("\0") + 1).toLowerCase()).filter((v) => v.length >= 3);
  for (const p of plans) {
    if (p.kind === "table") {
      if (p.noHeader || p.headerRow < 0) continue;
      for (const [key, edit] of p.edits) {
        if (edit.kind !== "pseudo") continue;
        const [r, c] = key.split(":").map(Number) as [number, number];
        if (r <= p.headerRow) continue;
        const header = (p.rows[p.headerRow] as Row).cells[c]?.value;
        const cell = (p.rows[r] as Row).cells[c];
        if (cell !== undefined) setLabel(edit.cls, cell.value, header, hidden(p.edits.get(`${p.headerRow}:${c}`)));
      }
    } else if (p.kind === "json") {
      const keyTokens = p.tokens.map((t, i) => ({ t, i })).filter((x) => x.t.kind === "key");
      for (const [i, edit] of p.edits) {
        if (edit.kind !== "pseudo") continue;
        const tok = p.tokens[i] as JsonToken;
        const header = tok.column === null ? undefined : lastKey(tok.column);
        if (header === undefined) continue;
        const gone = keyTokens.some((k) => k.t.value === header && hidden(p.edits.get(k.i)));
        setLabel(edit.cls, tok.value, header, gone);
      }
    } else if (p.kind === "xlsx") {
      const { wb, cells, sheets } = p.plan;
      for (const sheet of wb.sheets) {
        const info = sheets.find((s) => s.name === sheet.name);
        const plans = sheet.member === null ? undefined : cells.get(sheet.member);
        if (info === undefined || plans === undefined || info.noHeader || info.headerRow < 1) continue;
        const headers = new Map(sheet.cells.filter((c) => c.row === info.headerRow - 1).map((c) => [c.col, cellText(c, wb.sharedStrings)]));
        for (const c of sheet.cells) {
          if (c.row < info.headerRow || c.type === "n") continue;
          const plan = plans.get(c.ref);
          if (plan === undefined || plan.action.kind !== "pseudo") continue;
          const header = headers.get(c.col);
          const text = cellText(c, wb.sharedStrings);
          const lower = (header ?? "").toLowerCase();
          const gone = requestValues.some((v) => lower.includes(v));
          setLabel(plan.action.cls, text, header, gone);
          setLabel(plan.action.cls, text.trim(), header, gone);
        }
      }
    }
  }
  for (const req of [...requests].sort(cmp)) {
    const cut = req.indexOf("\0");
    pz.pseudonym(req.slice(0, cut) as PseudoClass, req.slice(cut + 1), labels.get(req));
  }
  // Office's hex linking IDs, also in sorted order, so a collision is resolved the same way every run.
  const hexIds = new Set<string>();
  for (const p of plans) {
    if (p.kind === "docx") for (const v of p.docx.hexIds) hexIds.add(v);
    else if (p.kind === "xlsx") for (const v of p.plan.hexIds) hexIds.add(v);
  }
  for (const v of [...hexIds].sort(cmp)) officeIds.hex(v);

  // Pass 2: render.
  const outputs: InputFile[] = [];
  const files: FileReport[] = [];
  for (const p of plans) {
    if (p.kind === "xlsx") {
      let r;
      try {
        r = renderXlsx(p.input.path, p.input.bytes, p.plan, xlsxEnv, pz, officeIds, opts.images ?? "replace");
      } catch (e) {
        if (e instanceof XlsxSpecError) throw new ApplyError(e.message);
        throw e;
      }
      const broken = r.members.find((m) => m.kind === "error");
      if (broken?.kind === "error") {
        // The rewriter copies a member it cannot parse unchanged: never write that as blinded.
        skipped.push({ path: p.input.path, reason: `cannot rewrite member ${broken.name} (${broken.error}); not written` });
        continue;
      }
      // As for DOCX: a member blind cannot read (an embedded workbook or OLE object, a macro, ActiveX)
      // is never copied into blinded output. Images, fonts and printer settings are copied and listed.
      const embedded = r.members.find((m) => m.kind === "other" && !m.name.endsWith("/") && !XLSX_COPIED(m.name));
      if (embedded !== undefined) {
        const why = THUMBNAIL.test(embedded.name) ? thumbnailReason(embedded.name) : `embedded file ${embedded.name} cannot be blinded inside an XLSX`;
        skipped.push({ path: p.input.path, reason: `${why}; not written` });
        continue;
      }
      const pictures = r.members.filter((m) => m.kind === "other" && !m.name.endsWith("/") && IMAGE.test(m.name)).map((m) => m.name);
      const pictureNote = imageWarning(pictures, opts.images ?? "replace");
      if (pictureNote.refusal !== null) {
        skipped.push({ path: p.input.path, reason: `${pictureNote.refusal}; not written` });
        continue;
      }
      const changed = r.members.some((m) => (m.kind === "xml" && m.changed) || (m.kind === "other" && m.replaced === true));
      const report: FileReport = {
        path: p.input.path,
        outputPath: names.renamePath(p.input.path, pz),
        format: "xlsx",
        columns: p.plan.columns,
        entityReplacements: r.entityReplacements,
        patternReplacements: r.patternReplacements,
        mappedReplacements: r.mappedReplacements,
        keptHosts: r.keptHosts,
        ...(r.speakerReplacements > 0 ? { speakerMentions: r.speakerReplacements } : {}),
        ...(r.proseReplacements > 0 ? { proseNames: r.proseReplacements } : {}),
        ...(r.joinedReplacements > 0 ? { joinedNames: r.joinedReplacements } : {}),
        ...(r.removedReplacements > 0 ? { removedReplacements: r.removedReplacements } : {}),
        ...(r.metadataReplacements > 0 ? { metadataReplacements: r.metadataReplacements } : {}),
        sheets: p.plan.sheets.map((s) => ({ ...s, outputName: r.sheetNames.find((n) => n.from === s.name)?.to ?? s.name })),
        unread: r.members.filter((m) => m.kind === "other" && m.replaced !== true && !m.name.endsWith("/")).map((m) => m.name),
        ...(pictureNote.line !== null ? { warnings: [pictureNote.line] } : {}),
        changed,
      };
      outputs.push({ path: report.outputPath, bytes: changed ? r.bytes : p.input.bytes });
      files.push(report);
      continue;
    }
    if (p.kind === "docx") {
      const r = renderDocx(p.docx, pz, officeIds);
      const outputPath = names.renamePath(p.input.path, pz);
      files.push({
        path: p.input.path,
        outputPath,
        format: "docx",
        encoding: "utf8",
        columns: [],
        entityReplacements: r.entityReplacements,
        patternReplacements: r.patternReplacements,
        mappedReplacements: r.mappedReplacements,
        keptHosts: r.keptHosts,
        metadataReplacements: r.metadataReplacements,
        warnings: p.docx.warnings,
        ...(p.transcript === undefined
          ? r.speakerReplacements > 0 ? { speakerMentions: r.speakerReplacements } : {}
          : { transcript: transcriptReport("docx", p.transcript.speakers, p.transcript.tags, r.speakerReplacements, kept) }),
        ...(r.proseReplacements > 0 ? { proseNames: r.proseReplacements } : {}),
        ...(r.joinedReplacements > 0 ? { joinedNames: r.joinedReplacements } : {}),
        ...(r.removedReplacements > 0 ? { removedReplacements: r.removedReplacements } : {}),
        changed: r.changed,
      });
      outputs.push({ path: outputPath, bytes: r.changed ? r.bytes : p.input.bytes });
      continue;
    }
    let text: string;
    let report: FileReport;
    if (p.kind === "text") {
      text = rewriteSpans(p.text, p.spans, pz);
      const t = p.transcript;
      report = {
        path: p.input.path,
        format: t === undefined || t.kind === "text" ? "text" : t.kind,
        encoding: p.encoding,
        columns: [],
        outputPath: p.input.path,
        entityReplacements: count(p.spans, "entity"),
        patternReplacements: count(p.spans, "pattern"),
        mappedReplacements: count(p.spans, "map"),
        keptHosts: keptHostCount(p.spans),
        ...textSpeakers(p.spans, t, kept),
        ...(count(p.spans, "prose") > 0 ? { proseNames: count(p.spans, "prose") } : {}),
        ...(countJoined(p.spans) > 0 ? { joinedNames: countJoined(p.spans) } : {}),
        ...(count(p.spans, "removed") > 0 ? { removedReplacements: count(p.spans, "removed") } : {}),
        changed: false,
      };
    } else if (p.kind === "json") {
      const r = renderJson(p, pz);
      text = r.text;
      report = {
        path: p.input.path,
        format: p.format,
        encoding: p.encoding,
        outputPath: p.input.path,
        columns: p.columns,
        entityReplacements: r.entityReplacements,
        patternReplacements: r.patternReplacements,
        mappedReplacements: r.mappedReplacements,
        keptHosts: r.keptHosts,
        changed: false,
      };
    } else {
      let entityReplacements = 0;
      let patternReplacements = 0;
      let mappedReplacements = 0;
      let keptHosts = 0;
      for (const [key, edit] of p.edits) {
        const [r, c] = key.split(":").map(Number) as [number, number];
        const cell = (p.rows[r] as Row).cells[c] as Cell;
        let value: string;
        if (edit.kind === "pseudo") value = pseudoWrite(pz, edit.cls, cell.value);
        else if (edit.kind === "fixed") value = edit.value;
        else {
          value = rewriteSpans(cell.value, edit.spans, pz);
          entityReplacements += count(edit.spans, "entity");
          patternReplacements += count(edit.spans, "pattern");
          mappedReplacements += count(edit.spans, "map");
          keptHosts += keptHostCount(edit.spans);
        }
        if (value === cell.value) continue;
        cell.raw = renderCell(value, cell.quoted, p.delim);
        cell.value = value;
        if (r > p.headerRow) (p.columns[Math.min(c, p.columns.length - 1)] as ColumnReport).changed++;
      }
      if (p.dropped.size > 0) {
        for (let r = Math.max(0, p.headerRow); r < p.rows.length; r++) {
          const row = p.rows[r] as Row;
          row.cells = row.cells.filter((_, c) => !p.dropped.has(c));
        }
      }
      text = serializeCsv(p.rows, p.delim);
      report = {
        path: p.input.path,
        format: p.format,
        encoding: p.encoding,
        delimiter: p.delim,
        headerRow: p.headerRow + 1,
        noHeader: p.noHeader,
        outputPath: p.input.path,
        columns: p.columns,
        ...(p.overflowRows > 0 ? { overflowRows: p.overflowRows } : {}),
        entityReplacements,
        patternReplacements,
        mappedReplacements,
        keptHosts,
        changed: false,
      };
    }
    if (p.kind !== "text") {
      const mentions = [...p.edits.values()].reduce((n, e) => n + (e.kind === "spans" ? count(e.spans, "speaker") : 0), 0);
      if (mentions > 0) report.speakerMentions = mentions;
      const prose = [...p.edits.values()].reduce((n, e) => n + (e.kind === "spans" ? count(e.spans, "prose") : 0), 0);
      if (prose > 0) report.proseNames = prose;
      const joined = [...p.edits.values()].reduce((n, e) => n + (e.kind === "spans" ? countJoined(e.spans) : 0), 0);
      if (joined > 0) report.joinedNames = joined;
      const removedHere = [...p.edits.values()].reduce((n, e) => n + (e.kind === "spans" ? count(e.spans, "removed") : 0), 0);
      if (removedHere > 0) report.removedReplacements = removedHere;
    }
    report.changed = text !== p.text;
    report.outputPath = names.renamePath(p.input.path, pz);
    outputs.push({ path: report.outputPath, bytes: report.changed ? encode(text, p.encoding) : p.input.bytes });
    files.push(report);
  }
  // Two inputs whose blinded names coincide would overwrite each other.
  const byOutput = new Map<string, string>();
  for (const f of files) {
    const other = byOutput.get(f.outputPath);
    if (other !== undefined) {
      throw new ApplyError(
        `${other} and ${f.path} would both be written as ${f.outputPath} once their names are blinded; rename one of the inputs`,
      );
    }
    byOutput.set(f.outputPath, f.path);
  }
  // Name parts two people share were replaced with a pseudonym of their own: report the ones used.
  const sharedNameParts = nameParts([...people, ...voiceNames, ...prosePeople], [], vocabularySet, new Set([...keepSet, ...shield]), aliases)
    .filter((p) => p.shared && p.exclusion === null && requests.has(`person\0${p.value}`))
    .map((p) => pz.pseudonym("person", p.value))
    .sort(cmp);
  return { outputs, files, skipped, map: pz.toMap(), mapEntriesDropped: mapDropped, sharedNameParts: [...new Set(sharedNameParts)], commonNameParts, shield: keptShield.report() };
}
