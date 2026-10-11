// Scoring for `blind bench`: what one run of apply and audit did, measured against the kit's
// oracle (the sensitive values a person found by reading the inputs). Pure: inputs in, items out,
// in a stable order. Values are masked in every item; nothing here prints or writes.
//
//   leaks    an oracle value that survives anywhere in the output: any byte (in every decoding
//            the audit reads), XML text joined across runs, zip members, file and folder names.
//   damage   a change the oracle does not explain: a CSV/TSV cell changed outside the blinded
//            and declared-unknown columns that holds no oracle value, a file or folder renamed
//            whose name holds no oracle value, a decoy that did not survive, a table whose shape
//            changed.
//   honesty  a file the audit called `clean` that has a leak.
//
// What cannot be scored is listed (`unscored`), never assumed clean.

import { maskValue, type AuditReport, type TreeEntry } from "../audit/mechanical.ts";
import { xmlViews } from "../audit/semantic.ts";
import { stringView, type View, viewsOf } from "../audit/views.ts";
import { looksLikeZip, readZip, ZipError } from "../audit/zip.ts";
import type { FileReport } from "../engine/apply.ts";
import { CsvError, parseCsv } from "../engine/csv.ts";
import { decode, EncodingError } from "../engine/encoding.ts";

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
  const scanBytes = (file: string, part: string, name: string, bytes: Uint8Array, depth: number): void => {
    const raw = (b: Uint8Array) => push(file, part, "content", matcher.find(contentViews(b, name)));
    if (!looksLikeZip(bytes)) return raw(bytes);
    if (depth >= MAX_DEPTH) {
      unscored.push({ file, part, reason: `archive nested more than ${MAX_DEPTH} deep; its members were not read` });
      return raw(bytes);
    }
    let members;
    try {
      members = readZip(bytes);
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
      else scanBytes(file, memberPart, m.name, m.bytes, depth + 1);
    }
  };
  for (const e of entries) {
    const name = e.path.slice(e.path.lastIndexOf("/") + 1);
    // Each entry's own name; a folder's name is scored once, on the folder.
    push(e.path, "", "name", matcher.find(stringView(name).map((v) => v.text)));
    if (e.kind === "file") scanBytes(e.path, "", name, e.bytes, 0);
    else if (e.kind !== "dir") unscored.push({ file: e.path, part: "", reason: e.kind === "unreadable" ? `cannot be read (${e.reason})` : `${e.kind === "symlink" ? "a symbolic link" : "not a regular file"}; not read` });
  }
  return { leaks, unscored };
}

export interface DamageItem {
  kind: "cell" | "rename" | "decoy" | "structure";
  /** The input path. */
  file: string;
  /** Where in the file: a cell, a path segment, a decoy. Never the value itself. */
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

const ALLOWED: ReadonlySet<string> = new Set(["blind", "value"]);

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
  const allowed = new Set(report.columns.filter((c) => c.treatment !== null && ALLOWED.has(c.treatment)).map((c) => c.index));
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
    if (report.format !== "csv" && report.format !== "tsv" && report.format !== "text") {
      unscored.push({ file: report.path, part: "", reason: `damage is not scored for ${report.format} files yet` });
      continue;
    }
    let before: string;
    let after: string;
    try {
      before = decode(f.input).text;
      after = decode(f.output).text;
    } catch (e) {
      if (!(e instanceof EncodingError)) throw e;
      unscored.push({ file: report.path, part: "", reason: `cannot be decoded (${e.message}); damage was not scored` });
      continue;
    }
    if (report.format !== "text") cellDamage(f, before, after, matcher, damage, unscored);
    for (const d of oracle.decoys) {
      const n = countWord(before, d.text);
      const left = countWord(after, d.text);
      if (left < n) damage.push({ kind: "decoy", file: report.path, where: "decoy", masked: maskValue(d.text), detail: `${n - left} of ${n} occurrences did not survive` });
    }
  }
  return { damage, unscored };
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
