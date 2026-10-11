// The engine for CSV/TSV, JSON/JSONL and plain text: applies a saved spec to in-memory
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
//
// JSON and JSONL: every key path is a column (see json.ts), with the same
// treatments. Strings and numbers are values, a number as written, so the
// string "9123" and the number 9123 get the same pseudonym; true, false and
// null are left alone. Keys that are record identifiers are the values of
// their `.*~` path; other keys are free text, like a header row. Edits are
// spliced into the original text, so layout and key order never change.
//
// Host matches under a keep-list domain are kept as written. Every output path
// is blinded through src/engine/names.ts (patterns, entities and the column
// values replaced above), planned with the cells and rendered after them.

import type { ColumnRule, EntityClassName, Spec, Treatment } from "../schema.ts";
import type { PseudoClass } from "./canonical.ts";
// The profiler's header rule: spec rules name columns by the headers the profile reported.
import { detectHeaderRow } from "../profile/table.ts";
import { type Cell, CsvError, parseCsv, renderCell, type Row, serializeCsv, sniffDelimiter } from "./csv.ts";
import { decode, type Encoding, EncodingError, encode } from "./encoding.ts";
import { isJsonNumber, type JsonFormat, JsonError, type JsonToken, quote, scanJson, scanJsonl, stringOffsets } from "./json.ts";
import type { BlindMap } from "./map.ts";
import { type EntityEntry, Pseudonymizer } from "./pseudonym.ts";
import { type ColumnStats, columnStats, isIdentifierLike, THRESHOLDS } from "./stats.ts";
import { NameRewriter, rewriteSpans } from "./names.ts";
import { EntityMatcher, type ExtraForm, findSpans, keepDomains, type Span } from "./text.ts";

export type EngineFormat = "csv" | "tsv" | "json" | "jsonl" | "text";

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
  /** 0-based column index (for JSON, the key path's position in first-seen order). */
  index: number;
  /** "" for a JSON key path. */
  header: string;
  /** JSON/JSONL only: the key path. */
  jsonPath?: string;
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
  /** The input path, as spec rules name it. */
  path: string;
  /** Where the blinded file is written: `path` with its folder and file names blinded. */
  outputPath: string;
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
  /** Host names left as written because they are under a keep-list domain. */
  keptHosts: number;
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
  /** The policy keep list. Its domain-shaped terms keep the host names under them as written. */
  keep?: readonly string[];
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

interface JsonPlan {
  kind: "json";
  format: JsonFormat;
  input: InputFile;
  encoding: Encoding;
  text: string;
  tokens: JsonToken[];
  /** Keyed by token index. */
  edits: Map<number, CellEdit>;
  columns: ColumnReport[];
}

type Plan = TablePlan | TextPlan | JsonPlan;

type ColumnAction = { kind: "keep" } | { kind: "pseudo"; cls: PseudoClass } | { kind: "free" };

function ruleAction(rule: ColumnRule): ColumnAction | "heuristic" {
  if (rule.treatment === "keep") return { kind: "keep" };
  if (rule.treatment === "blind" && SENSITIVE.has(rule.class)) return { kind: "pseudo", cls: rule.class as PseudoClass };
  if (rule.treatment === "value" && rule.class === "unknown") return "heuristic";
  return { kind: "pseudo", cls: "value" };
}

/** What a column gets: its rule's action, or for no rule (or unknown/value) the fail-closed identifier-like test. */
function decide(rule: ColumnRule | undefined, values: readonly string[]): { action: ColumnAction; stats: ColumnStats | undefined } {
  const planned = rule === undefined ? "heuristic" : ruleAction(rule);
  if (planned !== "heuristic") return { action: planned, stats: undefined };
  const stats = columnStats(values);
  return { action: isIdentifierLike(stats) ? { kind: "pseudo", cls: "value" } : { kind: "free" }, stats };
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
    const { action, stats } = decide(rule, data.map((r) => r.cells[col]?.value ?? ""));
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

function planJson(
  input: InputFile,
  encoding: Encoding,
  text: string,
  format: JsonFormat,
  rules: readonly ColumnRule[],
  spanner: (s: string) => Span[],
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
  const columns: ColumnReport[] = [];
  for (const [path, indices] of byPath) {
    const rule = rules.find((r) => r.jsonPath === path);
    const valued = indices.filter((i) => (tokens[i] as JsonToken).kind !== "literal");
    const { action, stats } = decide(rule, valued.map((i) => (tokens[i] as JsonToken).value));
    let flagged = 0;
    for (const i of valued) {
      const value = (tokens[i] as JsonToken).value;
      if (value.trim() === "") continue;
      if (action.kind === "pseudo") edits.set(i, { kind: "pseudo", cls: action.cls });
      else {
        const spans = spanner(value);
        if (action.kind === "keep") {
          if (hasSensitive(spans)) flagged++;
        } else if (spans.length > 0) edits.set(i, { kind: "spans", spans });
      }
    }
    columns.push({
      index: columns.length,
      header: "",
      jsonPath: path,
      class: rule?.class ?? "unknown",
      treatment: rule?.treatment ?? null,
      outcome: outcomeOf(action, stats),
      changed: 0,
      flagged,
    });
  }
  // Structural keys (field names) are free text, like a table's header row.
  tokens.forEach((t, i) => {
    if (t.kind !== "key" || t.column !== null) return;
    const spans = spanner(t.value);
    if (spans.length > 0) edits.set(i, { kind: "spans", spans });
  });
  return { kind: "json", format, input, encoding, text, tokens, edits, columns };
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
): { text: string; entityReplacements: number; patternReplacements: number; keptHosts: number } {
  const byPath = new Map(p.columns.map((c) => [c.jsonPath as string, c]));
  // Per object, each output key and the input key it came from: two input keys must never become one.
  const keys = new Map<number, Map<string, string>>();
  let entityReplacements = 0;
  let patternReplacements = 0;
  let keptHosts = 0;
  let out = "";
  let at = 0;
  p.tokens.forEach((t, i) => {
    const edit = p.edits.get(i);
    let value = t.value;
    if (edit !== undefined) {
      if (edit.kind === "pseudo") value = pz.pseudonym(edit.cls, t.value);
      else {
        value = rewriteSpans(t.value, edit.spans, pz);
        entityReplacements += count(edit.spans, "entity");
        patternReplacements += count(edit.spans, "pattern");
        keptHosts += keptHostCount(edit.spans);
      }
      if (value !== t.value) {
        const raw = p.text.slice(t.start, t.end);
        // A number stays a bare number when its replacement is one; otherwise it becomes a string.
        const written =
          t.kind === "number" ? (isJsonNumber(value) ? value : quote(value)) : edit.kind === "pseudo" ? quote(value) : spliceString(raw, edit.spans, pz);
        out += p.text.slice(at, t.start) + written;
        at = t.end;
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
  return { text: out + p.text.slice(at), entityReplacements, patternReplacements, keptHosts };
}

/** Tokens of a text, for the set of real values no pseudonym may equal. */
function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}._@:-]*/gu) ?? [];
}

function count(spans: readonly Span[], source: Span["source"]): number {
  return spans.filter((s) => s.cls !== null && s.source === source).length;
}

const keptHostCount = (spans: readonly Span[]): number => spans.filter((s) => s.cls === null && s.source === "pattern").length;

export function applySpec(inputs: readonly InputFile[], spec: Spec, opts: ApplyOptions): ApplyResult {
  const sorted = [...inputs].sort((a, b) => cmp(a.path, b.path));
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] as InputFile).path === (sorted[i - 1] as InputFile).path) {
      throw new ApplyError(`two inputs share the path ${JSON.stringify((sorted[i] as InputFile).path)}`);
    }
  }
  const matcher = new EntityMatcher(spec.entities);
  const keep = keepDomains(opts.keep ?? []);
  const spanner = (s: string): Span[] => findSpans(s, matcher, spec.patterns, keep);
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
    if (format === "json" || format === "jsonl") {
      try {
        plans.push(planJson(input, decoded.encoding, decoded.text, format, rules, spanner));
      } catch (e) {
        if (!(e instanceof JsonError)) throw e;
        skipped.push({ path: input.path, reason: `malformed ${format.toUpperCase()}: ${e.message}; not written` });
      }
      continue;
    }
    try {
      plans.push(planTable(input, decoded.encoding, decoded.text, format, rules, spanner));
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
      skipped.push({ path: input.path, reason: `malformed ${format.toUpperCase()}: ${e.message}; not written` });
    }
  }

  // File and folder names go through the patterns, the spec entities and every cell value a
  // column rule pseudonymises, so a value hidden in a cell is hidden in a name too.
  const columnValues: ExtraForm[] = [];
  for (const p of plans) {
    if (p.kind === "json") {
      for (const [i, edit] of p.edits) if (edit.kind === "pseudo") columnValues.push({ cls: edit.cls, value: (p.tokens[i] as JsonToken).value });
    } else if (p.kind === "table") {
      for (const [key, edit] of p.edits) {
        if (edit.kind !== "pseudo") continue;
        const [r, c] = key.split(":").map(Number) as [number, number];
        columnValues.push({ cls: edit.cls, value: ((p.rows[r] as Row).cells[c] as Cell).value });
      }
    }
  }
  const nameMatcher = new EntityMatcher(spec.entities, columnValues);
  const names = new NameRewriter(nameMatcher, spec.patterns, keep);
  for (const p of plans) names.planPath(p.input.path);

  // Every real value in the corpus, so no pseudonym equals one.
  const avoid = new Set<string>();
  for (const p of plans) {
    for (const segment of p.input.path.split("/")) for (const t of tokens(segment)) avoid.add(t);
    if (p.kind === "text") for (const t of tokens(p.text)) avoid.add(t);
    else if (p.kind === "json") {
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
  const pz = new Pseudonymizer({ salt: opts.salt, map: opts.map, entities, avoid });

  // Pass 1 ends here: derive every pseudonym in sorted order.
  const requests = new Set<string>();
  const want = (cls: PseudoClass, value: string) => requests.add(`${cls}\0${value}`);
  for (const p of plans) {
    if (p.kind === "text") {
      for (const s of p.spans) if (s.cls !== null) want(s.cls, s.value);
      continue;
    }
    if (p.kind === "json") {
      for (const [i, edit] of p.edits) {
        if (edit.kind === "spans") {
          for (const s of edit.spans) if (s.cls !== null) want(s.cls, s.value);
        } else want(edit.cls, (p.tokens[i] as JsonToken).value);
      }
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
  for (const r of names.requests()) want(r.cls, r.value);
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
      text = rewriteSpans(p.text, p.spans, pz);
      report = {
        path: p.input.path,
        format: "text",
        encoding: p.encoding,
        columns: [],
        outputPath: p.input.path,
        entityReplacements: count(p.spans, "entity"),
        patternReplacements: count(p.spans, "pattern"),
        keptHosts: keptHostCount(p.spans),
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
        keptHosts: r.keptHosts,
        changed: false,
      };
    } else {
      let entityReplacements = 0;
      let patternReplacements = 0;
      let keptHosts = 0;
      for (const [key, edit] of p.edits) {
        const [r, c] = key.split(":").map(Number) as [number, number];
        const cell = (p.rows[r] as Row).cells[c] as Cell;
        let value: string;
        if (edit.kind === "pseudo") value = pz.pseudonym(edit.cls, cell.value);
        else {
          value = rewriteSpans(cell.value, edit.spans, pz);
          entityReplacements += count(edit.spans, "entity");
          patternReplacements += count(edit.spans, "pattern");
          keptHosts += keptHostCount(edit.spans);
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
        outputPath: p.input.path,
        columns: p.columns,
        entityReplacements,
        patternReplacements,
        keptHosts,
        changed: false,
      };
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
  return { outputs, files, skipped, map: pz.toMap() };
}
