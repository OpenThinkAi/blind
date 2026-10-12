// Builds the corpus profile from input files and directories.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { BLIND_DIR } from "../init.ts";
import { POLICY_FILE, type PrivacyMode } from "../policy.ts";
import { decode, EncodingError } from "../engine/encoding.ts";
import { DocxError, docxParagraphs, planDocx } from "../engine/docx.ts";
import { type Entry, planTranscript, shapeParagraphs, speakersOf } from "../engine/transcript.ts";
import { type Cooccurrence, type Location, MAX_EXCERPT, type Profile, type ProfileDocument, type ProfileFile, type ProfileJsonKey, type ProfileTable, type ProfileTranscript, type ValueStats } from "../schema.ts";
import { profileJson, scanJsonFile } from "./json.ts";
import { distinct, excerpt, pick } from "./stats.ts";
import { ParseError, parseTable, profileTable } from "./table.ts";
import { profileText } from "./text.ts";
import { tokeniseProfile } from "./tokens.ts";
import { ZipError } from "../formats/ooxml.ts";
import { isDateCell, readWorkbook, sheetRows, XlsxError } from "../formats/xlsx.ts";

/** Formats this profiler reads, by lower-cased extension. */
const PROFILED: Record<string, "csv" | "tsv" | "json" | "jsonl" | "text" | "markdown" | "log" | "vtt" | "srt" | "docx"> = {
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
  ".vtt": "vtt",
  ".srt": "srt",
  // A transcript-shaped DOCX is profiled as a transcript, any other as a document.
  ".docx": "docx",
};

/** The most speakers one transcript entry lists. */
export const MAX_SPEAKERS = 100;

/** A transcript's profile entry: its speakers (first appearance, at most MAX_SPEAKERS) and up to `k` sample lines. */
export function profileTranscript(file: string, entries: readonly Entry[], k: number): { transcript: ProfileTranscript; capped: boolean } {
  const speakers = distinct(speakersOf(entries).map(excerpt));
  const lines = distinct(entries.map((e) => (e.speaker === null ? e.text : `${e.speaker}: ${e.text}`)).filter((l) => l.trim() !== ""));
  return {
    transcript: { file, speakers: speakers.slice(0, MAX_SPEAKERS), sampleLines: pick(lines, k).map(excerpt) },
    capped: speakers.length > MAX_SPEAKERS,
  };
}

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
    t.table.columns.map((c, i) => ({
      loc: t.table.sheet === undefined ? { file: t.table.file, header: c.header } : { file: t.table.file, sheet: t.table.sheet, header: c.header },
      values: t.valueSets[i] ?? new Set<string>() })),
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
 * Profiles CSV, TSV, JSON, JSONL, plain text, Markdown and log files, VTT and SRT transcripts and
 * DOCX files (a transcript-shaped one as a transcript, any other as a document) under `inputs` (resolved against `cwd`), carrying at most `k` samples
 * per column, document or transcript. Files in formats this profiler cannot read,
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
  const transcripts: ProfileTranscript[] = [];
  const addTranscript = (path: string, entries: readonly Entry[]) => {
    const { transcript, capped } = profileTranscript(path, entries, k);
    if (capped) notes.push(`${path}: more than ${MAX_SPEAKERS} speakers; the first ${MAX_SPEAKERS} are listed`);
    transcripts.push(transcript);
  };

  for (const f of collect(inputs, cwd, skipped)) {
    // Paths are the one profile string not cut to an excerpt: the spec and engine need them exact.
    // A path that is too long to show a model is left out and reported instead of truncated.
    const pathLength = [...f.path].length;
    if (pathLength > MAX_EXCERPT) {
      skipped.push({ path: f.path, reason: `path is ${pathLength} characters, over the ${MAX_EXCERPT}-character limit` });
      continue;
    }
    const ext = extname(f.path).toLowerCase();
    if (ext === ".xlsx") {
      let bytes: Buffer;
      try {
        bytes = readFileSync(f.abs);
      } catch (e) {
        skipped.push({ path: f.path, reason: `cannot read: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
        continue;
      }
      // Each worksheet is a table, read the way `blind apply` reads it.
      let wb;
      try {
        wb = readWorkbook(bytes);
      } catch (e) {
        if (!(e instanceof XlsxError || e instanceof ZipError)) throw e;
        skipped.push({ path: f.path, reason: `cannot read the workbook: ${e.message}` });
        continue;
      }
      const broken = wb.members.find((m) => m.kind === "error");
      if (broken?.kind === "error") {
        skipped.push({ path: f.path, reason: `cannot read the workbook: member ${broken.name} (${broken.error})` });
        continue;
      }
      for (const sheet of wb.sheets) {
        if (sheet.member === null) continue;
        const dates: boolean[][] = [];
        for (const c of sheet.cells) (dates[c.row] ??= [])[c.col] = isDateCell(wb, c);
        const result = profileTable(f.path, sheetRows(sheet, wb.sharedStrings), k, false, dates);
        result.table = { file: result.table.file, sheet: excerpt(sheet.name), headerRow: result.table.headerRow, columns: result.table.columns };
        if (result.noHeader) notes.push(`${f.path} sheet ${JSON.stringify(sheet.name)}: no header row detected; row 1 used as the header`);
        tables.push(result);
      }
      files.push({ path: f.path, format: "xlsx", size: bytes.length });
      continue;
    }
    const format = PROFILED[ext];
    if (format === undefined) {
      skipped.push({ path: f.path, reason: `unsupported file type${ext === "" ? "" : ` ${ext}`}` });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(f.abs);
    } catch (e) {
      skipped.push({ path: f.path, reason: `cannot read: ${(e as NodeJS.ErrnoException).code ?? "error"}` });
      continue;
    }
    if (format === "docx") {
      let paragraphs: string[];
      let all: string[];
      try {
        const plan = planDocx(bytes);
        paragraphs = docxParagraphs(plan, plan.main === undefined ? "all" : "main");
        all = docxParagraphs(plan, "all");
      } catch (e) {
        if (!(e instanceof DocxError)) throw e;
        skipped.push({ path: f.path, reason: `cannot read: ${e.message}` });
        continue;
      }
      if (shapeParagraphs(paragraphs).shaped) {
        addTranscript(f.path, shapeParagraphs(all).entries);
      } else {
        // A prose DOCX is profiled as a document: its paragraphs read like blank-line-separated text.
        documents.push(profileText(f.path, all.filter((p) => p.trim() !== "").join("\n\n"), "text", k));
      }
      files.push({ path: f.path, format, size: bytes.length });
      continue;
    }
    let text: string;
    try {
      // The same decode() apply uses (UTF-8, BOM-marked UTF-8/16; 8-bit text that is not UTF-8 is
      // refused by both), so a file the profile lists is one the engine will handle.
      text = decode(bytes).text;
    } catch (e) {
      if (!(e instanceof EncodingError)) throw e;
      skipped.push({ path: f.path, reason: e.message });
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
      const result = profileTable(f.path, rows, k, true);
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
      // Transcripts are found by content: a WebVTT or SRT file is one whatever its name, and a
      // text file of timestamped speaker turns is also profiled as a document.
      const t = planTranscript(text);
      if ((format === "vtt" || format === "srt") && t === null) {
        skipped.push({ path: f.path, reason: `not ${format === "vtt" ? "a WebVTT" : "an SRT"} transcript (no cue timing found)` });
        continue;
      }
      if (t !== null) addTranscript(f.path, t.entries);
      if (t !== null && t.kind !== "text") {
        files.push({ path: f.path, format: t.kind, size: bytes.length });
        continue;
      }
      documents.push(profileText(f.path, text, format === "vtt" || format === "srt" ? "text" : format, k));
    }
    files.push({ path: f.path, format: format === "vtt" || format === "srt" ? "text" : format, size: bytes.length });
  }

  return {
    profile: {
      version: 1,
      sampleCount: k,
      files,
      tables: tables.map((t) => t.table),
      jsonKeys,
      documents,
      transcripts,
      cooccurrence: cooccurrence([...tableColumns(tables), ...jsonColumns]),
    },
    skipped: skipped.sort((a, b) => byCodeUnit(a.path, b.path)),
    notes,
  };
}

/**
 * Fits a profile to the privacy mode. Under profile-only a model sees no value (AGT-1832): every
 * sample value, sample sentence and sample line, every document outline (first lines and headings)
 * and every transcript speaker label is emptied, sampleCount becomes 0, and a note says what was
 * left out. blind.toml refuses `[profile] samples` above 0 under profile-only, so normally only
 * outlines and speakers are dropped here. Other modes are unchanged.
 * File paths, sheet names, headers and JSON key segments stay real here (the saved profile and
 * spec name real locations); they are tokenised for each model call (tokeniseProfile in
 * tokens.ts), and a note says so.
 */
export function forPrivacyMode(result: ProfileResult, mode: PrivacyMode): ProfileResult {
  if (mode !== "profile-only") return result;
  const { profile } = result;
  const outlines = profile.documents.filter((d) => d.outline.length > 0).length;
  const speakers = profile.transcripts.filter((t) => t.speakers.length > 0).length;
  const sampled =
    profile.tables.reduce((n, t) => n + t.columns.filter((c) => c.stats.samples.length > 0).length, 0) +
    profile.jsonKeys.filter((k) => k.stats.samples.length > 0).length +
    profile.documents.filter((d) => d.sampleSentences.length > 0).length +
    profile.transcripts.filter((t) => t.sampleLines.length > 0).length;
  const notes = [...result.notes];
  if (sampled > 0) notes.push(`privacy.mode is profile-only: the samples of ${sampled} column(s), key(s), document(s) and transcript(s) are left out`);
  if (outlines > 0) notes.push(`privacy.mode is profile-only: the outline of ${outlines} document(s) is left out`);
  if (speakers > 0) notes.push(`privacy.mode is profile-only: the speaker list of ${speakers} transcript(s) is left out`);
  const { counts } = tokeniseProfile(profile);
  if (counts.paths + counts.sheets + counts.headers + counts.keys > 0) {
    notes.push(
      `privacy.mode is profile-only: a model is sent ${counts.paths} file path(s), ${counts.sheets} sheet name(s), ${counts.headers} header(s) in ${counts.tables} table(s) ` +
        `and ${counts.keys} JSON key segment(s) as opaque tokens (file_1, sheet_1, col_1, key_1), mapped back to the real names locally`,
    );
  }
  const noSamples = <T extends { stats: ValueStats }>(x: T): T => ({ ...x, stats: { ...x.stats, samples: [] } });
  return {
    ...result,
    profile: {
      ...profile,
      sampleCount: 0,
      tables: profile.tables.map((t) => ({ ...t, columns: t.columns.map(noSamples) })),
      jsonKeys: profile.jsonKeys.map(noSamples),
      documents: profile.documents.map((d) => ({ ...d, outline: [], sampleSentences: [] })),
      transcripts: profile.transcripts.map((t) => ({ ...t, speakers: [], sampleLines: [] })),
    },
    notes,
  };
}
