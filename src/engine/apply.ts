// The engine for CSV/TSV and plain text: applies a saved spec to in-memory
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
// - `keep` (any class, `vocabulary` included): byte-identical.
// - `blind` with a sensitive class: every non-empty cell gets that class's pseudonym.
// - `blind` with `unknown`/`vocabulary`, or `value` with a sensitive class: a `Value_` pseudonym.
// - `unknown` with `value`, and any column the spec does not mention: the
//   identifier-like test decides. Identifier-like columns become `Value_`
//   pseudonyms; the rest are kept, with spec entities and patterns still
//   replaced inside their cells.
// Rows above the header and the header row itself are treated as free text.

import type { ColumnRule, EntityClassName, Spec, Treatment } from "../schema.ts";
import type { PseudoClass } from "./canonical.ts";
// The profiler's header rule: spec rules name columns by the headers the profile reported.
import { detectHeaderRow } from "../profile/table.ts";
import { type Cell, CsvError, parseCsv, renderCell, type Row, serializeCsv, sniffDelimiter } from "./csv.ts";
import { decode, type Encoding, EncodingError, encode } from "./encoding.ts";
import type { BlindMap } from "./map.ts";
import { type EntityEntry, Pseudonymizer } from "./pseudonym.ts";
import { type ColumnStats, columnStats, isIdentifierLike, THRESHOLDS } from "./stats.ts";
import { EntityMatcher, findSpans, type Span } from "./text.ts";

export type EngineFormat = "csv" | "tsv" | "text";

const EXTENSIONS: Record<string, EngineFormat> = {
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".txt": "text",
  ".text": "text",
  ".md": "text",
  ".markdown": "text",
  ".log": "text",
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

export type ColumnOutcome =
  | "blinded"
  | "value"
  | "kept"
  | "unknown-pseudonymised"
  | "unknown-kept-low-cardinality"
  | "unknown-kept-not-identifier-like"
  | "unknown-kept-empty";

export interface ColumnReport {
  /** 0-based column index. */
  index: number;
  header: string;
  class: EntityClassName;
  /** null when the spec has no rule for the column. */
  treatment: Treatment | null;
  outcome: ColumnOutcome;
  /** Cells whose content changed. */
  changed: number;
  /** Kept (`keep`) cells that contain a spec entity or a pattern match, left unchanged as the spec says. */
  flagged: number;
}

export interface FileReport {
  path: string;
  format: EngineFormat;
  encoding: Encoding;
  /** CSV/TSV only. */
  delimiter?: string;
  /** CSV/TSV only: 1-based header row (0 for an empty file). */
  headerRow?: number;
  /** CSV/TSV only: no row looked like a header, so row 1 was used, as the profiler does. */
  noHeader?: boolean;
  columns: ColumnReport[];
  /** Free-text replacements (text files, and header, preamble and kept cells of tables). */
  entityReplacements: number;
  patternReplacements: number;
  changed: boolean;
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
}

export interface ApplyOptions {
  salt: Uint8Array;
  /** An earlier map; its pseudonyms are reused verbatim. */
  map?: BlindMap;
}

/** The spec does not fit the inputs (a rule names a column that is not there, or a shape this engine cannot apply). */
export class ApplyError extends Error {
  override name = "ApplyError";
}

const SENSITIVE: ReadonlySet<EntityClassName> = new Set(["person", "org", "host", "email", "id", "location"]);

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type CellEdit = { kind: "pseudo"; cls: PseudoClass } | { kind: "spans"; spans: Span[] };

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
  columns: ColumnReport[];
}

interface TextPlan {
  kind: "text";
  input: InputFile;
  encoding: Encoding;
  text: string;
  spans: Span[];
}

type Plan = TablePlan | TextPlan;

type ColumnAction = { kind: "keep" } | { kind: "pseudo"; cls: PseudoClass } | { kind: "free" };

function ruleAction(rule: ColumnRule): ColumnAction | "heuristic" {
  if (rule.treatment === "keep") return { kind: "keep" };
  if (rule.treatment === "blind" && SENSITIVE.has(rule.class)) return { kind: "pseudo", cls: rule.class as PseudoClass };
  if (rule.treatment === "value" && rule.class === "unknown") return "heuristic";
  return { kind: "pseudo", cls: "value" };
}

function outcomeOf(action: ColumnAction, stats: ColumnStats | undefined): ColumnOutcome {
  if (stats !== undefined) {
    if (action.kind === "pseudo") return "unknown-pseudonymised";
    if (stats.count === 0) return "unknown-kept-empty";
    return stats.distinctRatio < THRESHOLDS.distinct ? "unknown-kept-low-cardinality" : "unknown-kept-not-identifier-like";
  }
  if (action.kind === "keep") return "kept";
  return action.kind === "pseudo" && action.cls !== "value" ? "blinded" : "value";
}

const isFilled = (c: Cell | undefined): c is Cell => c !== undefined && c.value.trim() !== "";
const hasSensitive = (spans: readonly Span[]): boolean => spans.some((s) => s.cls !== null);

function planTable(
  input: InputFile,
  encoding: Encoding,
  text: string,
  format: "csv" | "tsv",
  rules: readonly ColumnRule[],
  spanner: (s: string) => Span[],
): TablePlan {
  const delim = format === "tsv" ? "\t" : sniffDelimiter(text);
  const rows = parseCsv(text, delim);
  // 0-based; like the profiler, row 1 stands in when no row looks like a header.
  const detected = detectHeaderRow(rows.map((r) => r.cells.map((c) => c.value)));
  const headerRow = rows.length === 0 ? -1 : (detected ?? 1) - 1;
  const headerCells = headerRow >= 0 ? (rows[headerRow] as Row).cells : [];
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
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
  const columns: ColumnReport[] = [];
  const data = rows.slice(headerRow + 1);
  for (let col = 0; col < width; col++) {
    const header = headers[col] as string;
    const rule = rules.find((r) => (r.header as string).trim() === header.trim());
    const planned = rule === undefined ? "heuristic" : ruleAction(rule);
    const values = data.map((r) => r.cells[col]?.value ?? "");
    const heuristic = planned === "heuristic";
    const stats = heuristic ? columnStats(values) : undefined;
    const action: ColumnAction = heuristic
      ? isIdentifierLike(stats as ColumnStats)
        ? { kind: "pseudo", cls: "value" }
        : { kind: "free" }
      : planned;
    let flagged = 0;
    data.forEach((row, i) => {
      const cell = row.cells[col];
      if (!isFilled(cell)) return;
      const key = `${headerRow + 1 + i}:${col}`;
      if (action.kind === "pseudo") edits.set(key, { kind: "pseudo", cls: action.cls });
      else {
        const spans = spanner(cell.value);
        if (action.kind === "keep") {
          if (hasSensitive(spans)) flagged++;
        } else if (spans.length > 0) edits.set(key, { kind: "spans", spans });
      }
    });
    columns.push({
      index: col,
      header,
      class: rule?.class ?? "unknown",
      treatment: rule?.treatment ?? null,
      outcome: outcomeOf(action, stats),
      changed: 0,
      flagged,
    });
  }
  // Preamble rows and the header row are free text.
  for (let r = 0; r <= headerRow; r++) {
    (rows[r] as Row).cells.forEach((cell, col) => {
      const spans = spanner(cell.value);
      if (spans.length > 0) edits.set(`${r}:${col}`, { kind: "spans", spans });
    });
  }
  return { kind: "table", format, input, encoding, text, delim, rows, headerRow, noHeader: rows.length > 0 && detected === null, edits, columns };
}

/** Tokens of a text, for the set of real values no pseudonym may equal. */
function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}._@:-]*/gu) ?? [];
}

function rewrite(value: string, spans: readonly Span[], pz: Pseudonymizer): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += value.slice(at, s.start) + (s.cls === null ? value.slice(s.start, s.end) : pz.pseudonym(s.cls, s.value));
    at = s.end;
  }
  return out + value.slice(at);
}

function count(spans: readonly Span[], source: Span["source"]): number {
  return spans.filter((s) => s.cls !== null && s.source === source).length;
}

export function applySpec(inputs: readonly InputFile[], spec: Spec, opts: ApplyOptions): ApplyResult {
  const sorted = [...inputs].sort((a, b) => cmp(a.path, b.path));
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] as InputFile).path === (sorted[i - 1] as InputFile).path) {
      throw new ApplyError(`two inputs share the path ${JSON.stringify((sorted[i] as InputFile).path)}`);
    }
  }
  const matcher = new EntityMatcher(spec.entities);
  const spanner = (s: string): Span[] => findSpans(s, matcher, spec.patterns);
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
    let decoded;
    try {
      decoded = decode(input.bytes);
    } catch (e) {
      if (!(e instanceof EncodingError)) throw e;
      skipped.push({ path: input.path, reason: `cannot decode: ${e.message}; not written` });
      continue;
    }
    const rules = rulesByFile.get(input.path) ?? [];
    if (format === "text") {
      if (rules.length > 0) {
        throw new ApplyError(`${input.path}: the spec has column rules for a text file; column rules apply to tables only`);
      }
      plans.push({ kind: "text", input, encoding: decoded.encoding, text: decoded.text, spans: spanner(decoded.text) });
      continue;
    }
    try {
      plans.push(planTable(input, decoded.encoding, decoded.text, format, rules, spanner));
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      skipped.push({ path: input.path, reason: `malformed ${format.toUpperCase()}: ${e.message}; not written` });
    }
  }

  // Every real value in the corpus, so no pseudonym equals one.
  const avoid = new Set<string>();
  for (const p of plans) {
    if (p.kind === "text") for (const t of tokens(p.text)) avoid.add(t);
    else {
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
  const pz = new Pseudonymizer({ salt: opts.salt, map: opts.map, entities, avoid });

  // Pass 1 ends here: derive every pseudonym in sorted order.
  const requests = new Set<string>();
  const want = (cls: PseudoClass, value: string) => requests.add(`${cls}\0${value}`);
  for (const p of plans) {
    if (p.kind === "text") {
      for (const s of p.spans) if (s.cls !== null) want(s.cls, s.value);
      continue;
    }
    for (const [key, edit] of p.edits) {
      if (edit.kind === "spans") {
        for (const s of edit.spans) if (s.cls !== null) want(s.cls, s.value);
      } else {
        const [r, c] = key.split(":").map(Number) as [number, number];
        want(edit.cls, ((p.rows[r] as Row).cells[c] as Cell).value);
      }
    }
  }
  for (const req of [...requests].sort(cmp)) {
    const cut = req.indexOf("\0");
    pz.pseudonym(req.slice(0, cut) as PseudoClass, req.slice(cut + 1));
  }

  // Pass 2: render.
  const outputs: InputFile[] = [];
  const files: FileReport[] = [];
  for (const p of plans) {
    let text: string;
    let report: FileReport;
    if (p.kind === "text") {
      text = rewrite(p.text, p.spans, pz);
      report = {
        path: p.input.path,
        format: "text",
        encoding: p.encoding,
        columns: [],
        entityReplacements: count(p.spans, "entity"),
        patternReplacements: count(p.spans, "pattern"),
        changed: false,
      };
    } else {
      let entityReplacements = 0;
      let patternReplacements = 0;
      for (const [key, edit] of p.edits) {
        const [r, c] = key.split(":").map(Number) as [number, number];
        const cell = (p.rows[r] as Row).cells[c] as Cell;
        let value: string;
        if (edit.kind === "pseudo") value = pz.pseudonym(edit.cls, cell.value);
        else {
          value = rewrite(cell.value, edit.spans, pz);
          entityReplacements += count(edit.spans, "entity");
          patternReplacements += count(edit.spans, "pattern");
        }
        if (value === cell.value) continue;
        cell.raw = renderCell(value, cell.quoted, p.delim);
        cell.value = value;
        if (r > p.headerRow) (p.columns[c] as ColumnReport).changed++;
      }
      text = serializeCsv(p.rows, p.delim);
      report = {
        path: p.input.path,
        format: p.format,
        encoding: p.encoding,
        delimiter: p.delim,
        headerRow: p.headerRow + 1,
        noHeader: p.noHeader,
        columns: p.columns,
        entityReplacements,
        patternReplacements,
        changed: false,
      };
    }
    report.changed = text !== p.text;
    outputs.push({ path: p.input.path, bytes: report.changed ? encode(text, p.encoding) : p.input.bytes });
    files.push(report);
  }
  return { outputs, files, skipped, map: pz.toMap() };
}
