// Scoring for `blind bench`: what one run of apply and audit did, measured against the kit's
// oracle (the sensitive values a person found by reading the inputs). Pure: inputs in, items out,
// in a stable order. Values are masked in every item; nothing here prints or writes.
//
//   leaks    an oracle value that survives anywhere in the output: any byte (in every decoding
//            the audit reads), XML text joined across runs, zip members, file and folder names.
//   damage   a change the oracle does not explain: a CSV/TSV or worksheet cell, or a JSON value
//            or key, changed outside the blinded and declared-unknown columns that holds no
//            oracle value; a DOCX paragraph changed that holds none; a file, folder, worksheet
//            or defined name renamed that holds none; a decoy that did not survive; a table,
//            workbook, JSON document or DOCX whose shape changed.
//   honesty  a file the audit called `clean` that has a leak.
//
// What cannot be scored is listed (`unscored`), never assumed clean.

import { maskValue, type AuditReport, type TreeEntry } from "../audit/mechanical.ts";
import { xmlViews } from "../audit/semantic.ts";
import { stringView, type View, viewsOf } from "../audit/views.ts";
import { looksLikeZip, readZip, type ZipBudget, ZipError, zipBudget } from "../audit/zip.ts";
import type { FileReport } from "../engine/apply.ts";
import { CsvError, parseCsv } from "../engine/csv.ts";
import { DocxError, docxParagraphs, planDocx } from "../engine/docx.ts";
import { decode, EncodingError } from "../engine/encoding.ts";
import { JsonError, type JsonToken, jsonCuts, scanJson, scanJsonl } from "../engine/json.ts";
import { ZipError as OoxmlZipError } from "../formats/ooxml.ts";
import { readWorkbook, sheetRows, XlsxError, type XlsxWorkbook } from "../formats/xlsx.ts";

/** One sensitive value of the oracle. Kits may carry more fields; these are the ones scored. */
export interface OracleEntry {
  value: string;
  class: string;
  /** Input files it occurs in, for the reader; a leak counts wherever it is found. */
  files?: string[];
}

export interface OracleDecoy {
  /** Text that looks like a name part but is not one; it must come through unchanged (exact case). */
  text: string;
}

export interface BenchOracle {
  version?: number;
  seed?: number;
  rows?: number;
  /** Sorted by class, then value (code-unit order), whatever order the file has. */
  values: OracleEntry[];
  decoys: OracleDecoy[];
}

export class OracleError extends Error {
  override name = "OracleError";
}

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Reads `oracle.json`: `values[]` with a non-empty `value` and a `class`, optional `decoys[]` with a `text`. */
export function parseOracle(text: string, source = "oracle.json"): BenchOracle {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new OracleError(`${source}: not valid JSON (${(e as Error).message})`);
  }
  if (!isObject(doc)) throw new OracleError(`${source}: expected a JSON object`);
  if (!Array.isArray(doc.values)) throw new OracleError(`${source}: "values" must be an array of {value, class}`);
  const values: OracleEntry[] = doc.values.map((v, i) => {
    if (!isObject(v) || typeof v.value !== "string" || v.value === "" || typeof v.class !== "string" || v.class === "") {
      throw new OracleError(`${source}: values[${i}] needs a non-empty string "value" and "class"`);
    }
    if (v.files !== undefined && !(Array.isArray(v.files) && v.files.every((f) => typeof f === "string"))) {
      throw new OracleError(`${source}: values[${i}].files must be an array of strings`);
    }
    return v.files === undefined ? { value: v.value, class: v.class } : { value: v.value, class: v.class, files: [...(v.files as string[])] };
  });
  if (values.length === 0) throw new OracleError(`${source}: "values" is empty; a kit needs at least one sensitive value to score`);
  const rawDecoys = doc.decoys ?? [];
  if (!Array.isArray(rawDecoys)) throw new OracleError(`${source}: "decoys" must be an array of {text}`);
  const decoys: OracleDecoy[] = rawDecoys.map((d, i) => {
    if (!isObject(d) || typeof d.text !== "string" || d.text === "") throw new OracleError(`${source}: decoys[${i}] needs a non-empty string "text"`);
    return { text: d.text };
  });
  const out: BenchOracle = {
    values: values.sort((a, b) => cmp(a.class, b.class) || cmp(a.value, b.value)),
    decoys: [...new Map(decoys.map((d) => [d.text, d])).values()].sort((a, b) => cmp(a.text, b.text)),
  };
  for (const k of ["version", "seed", "rows"] as const) {
    if (typeof doc[k] === "number") out[k] = doc[k];
  }
  return out;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` as a whole word: no letter or digit right before or after it. */
const wordRe = (text: string, flags: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${escape(text)}(?![\\p{L}\\p{N}])`, flags);

/**
 * Finds oracle values in text: as a whole word, in any case, after the decoy texts (exact case)
 * are blanked out. This is the rule docs/bench.md states for the oracle.
 */
export class OracleMatcher {
  private readonly values: { entry: OracleEntry; re: RegExp }[];
  private readonly decoys: string[];

  constructor(oracle: BenchOracle) {
    const seen = new Set<string>();
    this.values = [];
    for (const entry of oracle.values) {
      if (seen.has(entry.value)) continue;
      seen.add(entry.value);
      this.values.push({ entry, re: wordRe(entry.value, "iu") });
    }
    // Longest first, so a decoy inside a longer decoy is blanked with it.
    this.decoys = oracle.decoys.map((d) => d.text).sort((a, b) => b.length - a.length || cmp(a, b));
  }

  private mask(text: string): string {
    let t = text;
    for (const d of this.decoys) if (t.includes(d)) t = t.replaceAll(d, " ".repeat(d.length));
    return t;
  }

  /** The oracle values present in any of `texts`, in oracle order. */
  find(texts: readonly string[]): OracleEntry[] {
    const masked = texts.map((t) => this.mask(t));
    return this.values.filter(({ re }) => masked.some((t) => re.test(t))).map(({ entry }) => entry);
  }

  contains(text: string): boolean {
    return this.find([text]).length > 0;
  }
}

export interface LeakItem {
  /** Path in the output tree. */
  file: string;
  /** Zip member ("a.docx!word/document.xml" style, without the file), or "". */
  part: string;
  in: "content" | "name";
  class: string;
  masked: string;
}

export interface UnscoredItem {
  file: string;
  part: string;
  reason: string;
}

const XML_NAME = /\.(?:xml|rels|vml)$/i;
/** Archives nested deeper than this are not opened (the audit's limit). */
const MAX_DEPTH = 8;

function contentViews(bytes: Uint8Array, name: string): string[] {
  const views: View[] = viewsOf(bytes);
  const texts = views.map((v) => v.text);
  if (XML_NAME.test(name)) for (const v of views) for (const x of xmlViews(v)) texts.push(x.text);
  return texts;
}

/** Every oracle value left in the output tree, and every part that could not be read for them. */
export function scanLeaks(entries: readonly TreeEntry[], matcher: OracleMatcher): { leaks: LeakItem[]; unscored: UnscoredItem[] } {
  const leaks: LeakItem[] = [];
  const unscored: UnscoredItem[] = [];
  const push = (file: string, part: string, where: LeakItem["in"], found: OracleEntry[]) => {
    for (const e of found) leaks.push({ file, part, in: where, class: e.class, masked: maskValue(e.value) });
  };
  const scanBytes = (file: string, part: string, name: string, bytes: Uint8Array, depth: number, budget: ZipBudget): void => {
    const raw = (b: Uint8Array) => push(file, part, "content", matcher.find(contentViews(b, name)));
    if (!looksLikeZip(bytes)) return raw(bytes);
    if (depth >= MAX_DEPTH) {
      unscored.push({ file, part, reason: `archive nested more than ${MAX_DEPTH} deep; its members were not read` });
      return raw(bytes);
    }
    let members;
    try {
      members = readZip(bytes, budget);
    } catch (e) {
      if (!(e instanceof ZipError)) throw e;
      unscored.push({ file, part, reason: `looks like a zip archive but cannot be read (${e.message})` });
      return raw(bytes);
    }
    // The archive's own bytes less what is read below in decoded form (member names and data), as
    // the audit does: headers, comments, members that could not be decoded.
    const residual = Uint8Array.from(bytes);
    for (const m of members) {
      for (const [a, b] of m.nameRanges) residual.fill(0, a, b);
      if (m.bytes !== undefined) residual.fill(0, m.dataRange[0], m.dataRange[1]);
    }
    raw(residual);
    for (const m of [...members].sort((a, b) => cmp(a.name, b.name))) {
      const memberPart = part === "" ? m.name : `${part}!${m.name}`;
      push(file, memberPart, "name", matcher.find(stringView(m.name).map((v) => v.text)));
      if (m.bytes === undefined) unscored.push({ file, part: memberPart, reason: `${m.error ?? "not decoded"}; its content was not read` });
      else scanBytes(file, memberPart, m.name, m.bytes, depth + 1, budget);
    }
  };
  for (const e of entries) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1);
    // Each entry's own name; a folder's name is scored once, on the folder.
    push(e.path, "", "name", matcher.find(stringView(name).map((v) => v.text)));
    if (e.kind === "file") scanBytes(e.path, "", name, e.bytes, 0, zipBudget());
    else if (e.kind !== "dir") unscored.push({ file: e.path, part: "", reason: e.kind === "unreadable" ? `cannot be read (${e.reason})` : `${e.kind === "symlink" ? "a symbolic link" : "not a regular file"}; not read` });
  }
  return { leaks, unscored };
}

export interface DamageItem {
  kind: "cell" | "paragraph" | "rename" | "decoy" | "structure";
  /** The input path. */
  file: string;
  /** Where in the file: a cell, a key path, a paragraph, a path segment, a sheet by position, a decoy. Never the value itself. */
  where: string;
  /** The original value, masked; "" when not about a value. */
  masked: string;
  detail: string;
}

/** One input file, paired with its blinded output by apply's report. */
export interface ScoredFile {
  report: FileReport;
  input: Uint8Array;
  output: Uint8Array;
}

// `drop` and `redact` columns change by design; a dropped CSV/TSV column or JSON key is taken out
// of the input before the shapes are compared.
const ALLOWED: ReadonlySet<string> = new Set(["blind", "value", "drop", "redact"]);

function cellDamage(f: ScoredFile, before: string, after: string, matcher: OracleMatcher, items: DamageItem[], unscored: UnscoredItem[]): void {
  const { report } = f;
  let a;
  let b;
  try {
    const delim = report.delimiter ?? (report.format === "tsv" ? "\t" : ",");
    b = parseCsv(before, delim).map((r) => r.cells.map((c) => c.value));
    a = parseCsv(after, delim).map((r) => r.cells.map((c) => c.value));
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    unscored.push({ file: report.path, part: "", reason: `cannot be parsed as ${report.format} (${e.message}); its cells were not compared` });
    return;
  }
  if (a.length !== b.length) {
    items.push({ kind: "structure", file: report.path, where: "rows", masked: "", detail: `${b.length} rows in, ${a.length} out` });
    return;
  }
  const headerRow = report.headerRow ?? 1;
  const dropped = new Set(report.columns.filter((c) => c.outcome === "dropped").map((c) => c.index));
  // The engine removes a dropped column from the header row down; compare against the input without it.
  if (dropped.size > 0) b = b.map((row, r) => (r >= headerRow - 1 ? row.filter((_, c) => !dropped.has(c)) : row));
  const kept = (c: { index: number }) => [...dropped].filter((d) => d < c.index).length;
  const allowed = new Set(report.columns.filter((c) => c.treatment !== null && ALLOWED.has(c.treatment) && !dropped.has(c.index)).map((c) => c.index - kept(c)));
  b.forEach((row, r) => {
    const out = a[r] as string[];
    if (out.length !== row.length) {
      items.push({ kind: "structure", file: report.path, where: `row ${r + 1}`, masked: "", detail: `${row.length} cells in, ${out.length} out` });
      return;
    }
    row.forEach((cell, c) => {
      if (out[c] === cell) return;
      // Data rows of blinded and declared-unknown columns may change; header and preamble rows may not.
      if (r >= headerRow && allowed.has(c)) return;
      if (matcher.contains(cell)) return;
      items.push({ kind: "cell", file: report.path, where: `row ${r + 1}, column ${c + 1}`, masked: maskValue(cell), detail: "changed, and holds no oracle value" });
    });
  });
}

function countWord(text: string, word: string): number {
  return (text.match(wordRe(word, "gu")) ?? []).length;
}

/** Changes the oracle does not explain, file by file in input-path order. */
export function scoreDamage(files: readonly ScoredFile[], oracle: BenchOracle, matcher: OracleMatcher): { damage: DamageItem[]; unscored: UnscoredItem[] } {
  const damage: DamageItem[] = [];
  const unscored: UnscoredItem[] = [];
  for (const f of [...files].sort((x, y) => cmp(x.report.path, y.report.path))) {
    const { report } = f;
    const inSegs = report.path.split("/");
    const outSegs = report.outputPath.split("/");
    if (inSegs.length !== outSegs.length) {
      damage.push({ kind: "structure", file: report.path, where: "path", masked: "", detail: `${inSegs.length} path segments in, ${outSegs.length} out` });
    } else {
      inSegs.forEach((seg, i) => {
        if (seg === outSegs[i] || matcher.contains(seg)) return;
        const what = i === inSegs.length - 1 ? "file name" : "folder name";
        damage.push({ kind: "rename", file: report.path, where: `${what} (segment ${i + 1})`, masked: maskValue(seg), detail: `${what} changed, and holds no oracle value` });
      });
    }
    let texts: { before: string; after: string } | null;
    switch (report.format) {
      case "csv":
      case "tsv":
      case "text":
      case "vtt":
      case "srt":
      case "json":
      case "jsonl":
        texts = decoded(f, unscored);
        if (texts === null) continue;
        if (report.format === "csv" || report.format === "tsv") cellDamage(f, texts.before, texts.after, matcher, damage, unscored);
        else if (report.format === "json" || report.format === "jsonl") jsonDamage(f, texts.before, texts.after, matcher, damage, unscored);
        break;
      case "xlsx":
        texts = xlsxDamage(f, matcher, damage, unscored);
        break;
      case "docx":
        texts = docxDamage(f, matcher, damage, unscored);
        break;
      default: {
        const never: never = report.format;
        unscored.push({ file: report.path, part: "", reason: `damage is not scored for ${String(never)} files yet` });
        continue;
      }
    }
    if (texts === null) continue;
    for (const d of oracle.decoys) {
      const n = countWord(texts.before, d.text);
      const left = countWord(texts.after, d.text);
      if (left < n) damage.push({ kind: "decoy", file: report.path, where: "decoy", masked: maskValue(d.text), detail: `${n - left} of ${n} occurrences did not survive` });
    }
  }
  return { damage, unscored };
}

/** Both sides of a text file, decoded; null (and an unscored item) when either cannot be. */
function decoded(f: ScoredFile, unscored: UnscoredItem[]): { before: string; after: string } | null {
  try {
    return { before: decode(f.input).text, after: decode(f.output).text };
  } catch (e) {
    if (!(e instanceof EncodingError)) throw e;
    unscored.push({ file: f.report.path, part: "", reason: `cannot be decoded (${e.message}); damage was not scored` });
    return null;
  }
}

/** The key paths a column rule lets change: the blinded and declared-unknown ones. */
function allowedPaths(report: FileReport): Set<string> {
  return new Set(report.columns.filter((c) => c.jsonPath !== undefined && c.treatment !== null && ALLOWED.has(c.treatment)).map((c) => c.jsonPath as string));
}

/**
 * JSON and JSONL, token by token (the engine splices edits into the text, so the token list keeps
 * its length): a key or value that changed is damage unless it is a value (or record-ID key) of a
 * blinded or declared-unknown key path, or the original holds an oracle value.
 */
function jsonDamage(f: ScoredFile, before: string, after: string, matcher: OracleMatcher, items: DamageItem[], unscored: UnscoredItem[]): void {
  const { report } = f;
  const scan = report.format === "jsonl" ? scanJsonl : scanJson;
  let b: JsonToken[];
  let a: JsonToken[];
  try {
    b = scan(before);
    a = scan(after);
  } catch (e) {
    if (!(e instanceof JsonError)) throw e;
    unscored.push({ file: report.path, part: "", reason: `cannot be parsed as ${report.format} (${e.message}); its keys and values were not compared` });
    return;
  }
  const allowed = allowedPaths(report);
  const dropped = new Set(report.columns.filter((c) => c.outcome === "dropped" && c.jsonPath !== undefined).map((c) => c.jsonPath as string));
  if (dropped.size > 0) {
    // The engine cuts a dropped key path's members; compare against the input without them.
    const cut = jsonCuts(before, b, b.flatMap((t, i) => (t.column !== null && dropped.has(t.column) ? [i] : []))).tokens;
    b = b.filter((_, i) => !cut.has(i));
  }
  if (a.length !== b.length) {
    items.push({ kind: "structure", file: report.path, where: "tokens", masked: "", detail: `${b.length} keys and values in, ${a.length} out` });
    return;
  }
  const nth = new Map<string, number>();
  b.forEach((t, i) => {
    const o = a[i] as JsonToken;
    const at = t.column ?? `object ${t.object ?? 0}`;
    const n = (nth.get(`${t.kind}\0${at}`) ?? 0) + 1;
    nth.set(`${t.kind}\0${at}`, n);
    if (o.kind === t.kind && o.value === t.value) return;
    if (t.column !== null && allowed.has(t.column)) return;
    if (matcher.contains(t.value)) return;
    const what = t.kind === "key" ? "key" : "value";
    items.push({ kind: "cell", file: report.path, where: `${what} ${n} of ${at}`, masked: maskValue(t.value), detail: `${what} changed, and holds no oracle value` });
  });
}

/** Every cell's text and every worksheet name, joined, for counting decoys. */
const workbookText = (wb: XlsxWorkbook): string => [...wb.sheets.map((s) => s.name), ...wb.sheets.flatMap((s) => sheetRows(s, wb.sharedStrings).map((r) => r.join("\t")))].join("\n");

/**
 * XLSX, worksheet by worksheet in workbook order (sheets are named by position, since a name may
 * hold a value): cells as for CSV, with each sheet's header row and column rules from the report;
 * worksheet and defined names that changed and hold no oracle value; the sheet and row counts.
 */
function xlsxDamage(f: ScoredFile, matcher: OracleMatcher, items: DamageItem[], unscored: UnscoredItem[]): { before: string; after: string } | null {
  const { report } = f;
  let wb: XlsxWorkbook;
  let wa: XlsxWorkbook;
  try {
    wb = readWorkbook(f.input);
    wa = readWorkbook(f.output);
  } catch (e) {
    if (!(e instanceof XlsxError || e instanceof OoxmlZipError)) throw e;
    unscored.push({ file: report.path, part: "", reason: `cannot be read as a workbook (${e.message}); damage was not scored` });
    return null;
  }
  for (const m of [...wb.members, ...wa.members]) {
    if (m.kind === "error") unscored.push({ file: report.path, part: m.name, reason: `cannot be read (${m.error}); its damage was not scored` });
  }
  // Sheets are paired by position; with a different count nothing below can be paired, so stop here.
  if (wa.sheets.length !== wb.sheets.length) {
    items.push({ kind: "structure", file: report.path, where: "sheets", masked: "", detail: `${wb.sheets.length} worksheets in, ${wa.sheets.length} out` });
    return null;
  }
  const names = (x: XlsxWorkbook) => x.definedNames;
  if (names(wa).length !== names(wb).length) items.push({ kind: "structure", file: report.path, where: "defined names", masked: "", detail: `${names(wb).length} defined names in, ${names(wa).length} out` });
  else {
    names(wb).forEach((n, i) => {
      if (names(wa)[i] !== n && !matcher.contains(n)) items.push({ kind: "rename", file: report.path, where: `defined name ${i + 1}`, masked: maskValue(n), detail: "defined name changed, and holds no oracle value" });
    });
  }
  wb.sheets.forEach((sheet, i) => {
    const out = wa.sheets[i] as XlsxWorkbook["sheets"][number];
    const label = `sheet ${i + 1}`;
    if (out.name !== sheet.name && !matcher.contains(sheet.name)) items.push({ kind: "rename", file: report.path, where: `${label} name`, masked: maskValue(sheet.name), detail: "worksheet name changed, and holds no oracle value" });
    const b = sheetRows(sheet, wb.sharedStrings);
    const a = sheetRows(out, wa.sharedStrings);
    if (a.length !== b.length) {
      items.push({ kind: "structure", file: report.path, where: `${label} rows`, masked: "", detail: `${b.length} rows in, ${a.length} out` });
      return;
    }
    // `sheet.name` is the input's (pre-blinding) name, which is what the report's sheets and column rules carry.
    const headerRow = report.sheets?.find((s) => s.name === sheet.name)?.headerRow ?? 1;
    const allowed = new Set(report.columns.filter((c) => c.sheet === sheet.name && c.treatment !== null && ALLOWED.has(c.treatment)).map((c) => c.index));
    b.forEach((row, r) => {
      const after = a[r] as string[];
      if (after.length !== row.length) {
        items.push({ kind: "structure", file: report.path, where: `${label}, row ${r + 1}`, masked: "", detail: `${row.length} cells in, ${after.length} out` });
        return;
      }
      row.forEach((cell, c) => {
        if (after[c] === cell) return;
        if (r >= headerRow && allowed.has(c)) return;
        if (matcher.contains(cell)) return;
        items.push({ kind: "cell", file: report.path, where: `${label}, row ${r + 1}, column ${c + 1}`, masked: maskValue(cell), detail: "changed, and holds no oracle value" });
      });
    });
  });
  return { before: workbookText(wb), after: workbookText(wa) };
}

/**
 * DOCX, paragraph by paragraph across every part (body, headers, footers, comments, notes): a
 * paragraph that changed and holds no oracle value, and the paragraph count.
 */
function docxDamage(f: ScoredFile, matcher: OracleMatcher, items: DamageItem[], unscored: UnscoredItem[]): { before: string; after: string } | null {
  const { report } = f;
  let b: string[];
  let a: string[];
  try {
    b = docxParagraphs(planDocx(f.input, "keep"), "all");
    a = docxParagraphs(planDocx(f.output, "keep"), "all");
  } catch (e) {
    if (!(e instanceof DocxError)) throw e;
    unscored.push({ file: report.path, part: "", reason: `cannot be read as a DOCX (${e.message}); damage was not scored` });
    return null;
  }
  if (a.length !== b.length) {
    items.push({ kind: "structure", file: report.path, where: "paragraphs", masked: "", detail: `${b.length} paragraphs in, ${a.length} out` });
    return null;
  }
  b.forEach((p, i) => {
    if (a[i] === p || matcher.contains(p)) return;
    items.push({ kind: "paragraph", file: report.path, where: `paragraph ${i + 1}`, masked: maskValue(p), detail: "changed, and holds no oracle value" });
  });
  return { before: b.join("\n"), after: a.join("\n") };
}

export interface HonestyItem {
  /** Path in the output tree. */
  file: string;
  /** What the audit said. */
  audit: "clean";
  leaks: number;
}

/** Files and folders the audit called `clean` that have a leak. */
export function scoreHonesty(audit: AuditReport, leaks: readonly LeakItem[]): HonestyItem[] {
  const count = new Map<string, number>();
  for (const l of leaks) count.set(l.file, (count.get(l.file) ?? 0) + 1);
  return audit.files
    .filter((f) => f.status === "clean" && (count.get(f.path) ?? 0) > 0)
    .map((f) => ({ file: f.path, audit: "clean" as const, leaks: count.get(f.path) as number }))
    .sort((a, b) => cmp(a.file, b.file));
}
