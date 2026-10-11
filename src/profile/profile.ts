// Builds the corpus profile from input files and directories.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { BLIND_DIR } from "../init.ts";
import { POLICY_FILE } from "../policy.ts";
import { type Cooccurrence, type FileFormat, type Location, MAX_EXCERPT, type Profile, type ProfileDocument, type ProfileFile, type ProfileJsonKey, type ProfileTable } from "../schema.ts";
import { profileJson, scanJsonFile } from "./json.ts";
import { ParseError, parseTable, profileTable } from "./table.ts";
import { profileText } from "./text.ts";

/** Formats this profiler reads, by lower-cased extension. */
const PROFILED: Record<string, "csv" | "tsv" | "json" | "jsonl" | "text" | "markdown" | "log"> = {
  ".json": "json",
  ".jsonl": "jsonl",
  ".ndjson": "jsonl",
  ".csv": "csv",
  ".tsv": "tsv",
  ".tab": "tsv",
  ".txt": "text",
  ".text": "text",
  ".md": "markdown",
  ".markdown": "markdown",
  ".log": "log",
};

/** Formats blind knows but this profiler cannot read yet. */
const NOT_YET: Record<string, FileFormat> = {
  ".xlsx": "xlsx",
  ".docx": "docx",
  ".vtt": "vtt",
  ".srt": "srt",
};

/** Co-occurrence threshold: shared distinct values over the smaller column's distinct values. */
export const COOCCURRENCE_OVERLAP = 0.5;

/** A file or directory entry that was not profiled, and why. */
export interface Skipped {
  path: string;
  reason: string;
}

export interface ProfileResult {
  profile: Profile;
  skipped: Skipped[];
  /** Notes about profiled files, such as a table with no detectable header row. */
  notes: string[];
}

export class InputError extends Error {
  override name = "InputError";
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = (p: string): string => p.split(sep).join("/");

interface Found {
  /** Absolute path on disk. */
  abs: string;
  /** Path in the profile: relative to the input directory, or the file name for a file input. */
  path: string;
}

/**
 * Lists every file under the inputs, sorted by profile path. Directories are walked recursively in
 * sorted order. Inside a directory, hidden entries, symbolic links and special files are skipped and
 * reported; blind's own state (`.blind/` and `blind.toml` at the top of a walked directory) is skipped
 * silently. A file named directly is always included.
 */
function collect(inputs: readonly string[], cwd: string, skipped: Skipped[]): Found[] {
  const found: Found[] = [];
  const walk = (root: string, dir: string) => {
    const names = readdirSync(dir).sort(byCodeUnit);
    for (const name of names) {
      const abs = join(dir, name);
      const path = toPosix(relative(root, abs));
      if (name === BLIND_DIR || (dir === root && name === POLICY_FILE)) continue;
      const st = lstatSync(abs);
      if (name.startsWith(".")) skipped.push({ path, reason: "hidden" });
      else if (st.isSymbolicLink()) skipped.push({ path, reason: "symbolic link (not followed)" });
      else if (st.isDirectory()) walk(root, abs);
      else if (st.isFile()) found.push({ abs, path });
      else skipped.push({ path, reason: "not a regular file" });
    }
  };
  for (const input of inputs) {
    const abs = resolve(cwd, input);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new InputError(`${input}: no such file or directory`);
    }
    if (st.isDirectory()) walk(abs, abs);
    else if (st.isFile()) found.push({ abs, path: basename(abs) });
    else throw new InputError(`${input}: not a regular file or directory`);
  }
  const seen = new Map<string, string>();
  for (const f of found) {
    const first = seen.get(f.path);
    if (first !== undefined && first !== f.abs) {
      throw new InputError(`two inputs map to the same profile path ${JSON.stringify(f.path)}; profile them separately`);
    }
    seen.set(f.path, f.abs);
  }
  const unique = [...new Map(found.map((f) => [f.path, f])).values()];
  return unique.sort((a, b) => byCodeUnit(a.path, b.path));
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

interface TableColumns {
  table: ProfileTable;
  valueSets: Set<string>[];
}

/** A table column or JSON key path and its folded distinct values. */
interface ValueColumn {
  loc: Location;
  values: Set<string>;
}

function tableColumns(tables: readonly TableColumns[]): ValueColumn[] {
  return tables.flatMap((t) =>
    t.table.columns.map((c, i) => ({ loc: { file: t.table.file, header: c.header }, values: t.valueSets[i] ?? new Set<string>() })),
  );
}

/** Every pair of locations, table columns first and then JSON key paths, each in profile order. */
function cooccurrence(cols: readonly ValueColumn[]): Cooccurrence[] {
  const out: Cooccurrence[] = [];
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const a = cols[i];
      const b = cols[j];
      if (a === undefined || b === undefined) continue;
      const [small, large] = a.values.size <= b.values.size ? [a.values, b.values] : [b.values, a.values];
      if (small.size === 0) continue;
      let shared = 0;
      for (const v of small) if (large.has(v)) shared++;
      if (shared / small.size > COOCCURRENCE_OVERLAP) out.push({ a: { ...a.loc }, b: { ...b.loc }, shared });
    }
  }
  return out;
}

/**
 * Profiles CSV, TSV, JSON, JSONL, plain text, Markdown and log files under `inputs` (resolved against `cwd`),
 * carrying at most `k` samples per column or document. Files in formats this profiler cannot read,
 * and files that fail to decode or parse, are left out of the profile and listed in `skipped`.
 */
export function buildProfile(inputs: readonly string[], k: number, cwd: string): ProfileResult {
  const skipped: Skipped[] = [];
  const notes: string[] = [];
  const files: ProfileFile[] = [];
  const tables: TableColumns[] = [];
  const documents: ProfileDocument[] = [];
  const jsonKeys: ProfileJsonKey[] = [];
  const jsonColumns: ValueColumn[] = [];

  for (const f of collect(inputs, cwd, skipped)) {
    // Paths are the one profile string not cut to an excerpt: the spec and engine need them exact.
    // A path that is too long to show a model is left out and reported instead of truncated.
    const pathLength = [...f.path].length;
    if (pathLength > MAX_EXCERPT) {
      skipped.push({ path: f.path, reason: `path is ${pathLength} characters, over the ${MAX_EXCERPT}-character limit` });
      continue;
    }
    const ext = extname(f.path).toLowerCase();
    const format = PROFILED[ext];
    if (format === undefined) {
      const known = NOT_YET[ext];
      skipped.push({
        path: f.path,
        reason: known !== undefined ? `${known} is not profiled yet` : `unsupported file type${ext === "" ? "" : ` ${ext}`}`,
      });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(f.abs);
    } catch (e) {
      skipped.push({ path: f.path, reason: `cannot read: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
      continue;
    }
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      skipped.push({ path: f.path, reason: "not valid UTF-8" });
      continue;
    }
    if (format === "csv" || format === "tsv") {
      let rows: string[][];
      try {
        rows = parseTable(text, format);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        skipped.push({ path: f.path, reason: `cannot parse: ${e.message}` });
        continue;
      }
      const result = profileTable(f.path, rows, k);
      if (result.noHeader) notes.push(`${f.path}: no header row detected; row 1 used as the header`);
      tables.push(result);
    } else if (format === "json" || format === "jsonl") {
      let result;
      try {
        result = profileJson(f.path, scanJsonFile(text, format), k);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        skipped.push({ path: f.path, reason: `cannot parse: ${e.message}` });
        continue;
      }
      // Key paths, like file paths, are never cut: the spec names them exactly.
      const long = result.keys.find((j) => [...j.path].length > MAX_EXCERPT);
      if (long !== undefined) {
        skipped.push({ path: f.path, reason: `a key path is ${[...long.path].length} characters, over the ${MAX_EXCERPT}-character limit` });
        continue;
      }
      jsonKeys.push(...result.keys);
      result.keys.forEach((j, i) => jsonColumns.push({ loc: { file: j.file, jsonPath: j.path }, values: result.valueSets[i] ?? new Set<string>() }));
    } else {
      documents.push(profileText(f.path, text, format, k));
    }
    files.push({ path: f.path, format, size: bytes.length });
  }

  return {
    profile: {
      version: 1,
      sampleCount: k,
      files,
      tables: tables.map((t) => t.table),
      jsonKeys,
      documents,
      transcripts: [],
      cooccurrence: cooccurrence([...tableColumns(tables), ...jsonColumns]),
    },
    skipped: skipped.sort((a, b) => byCodeUnit(a.path, b.path)),
    notes,
  };
}
