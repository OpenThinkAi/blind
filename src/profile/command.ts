// `blind profile <inputs>`: build the corpus profile, write .blind/profile.json, print it.

import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BLIND_DIR } from "../init.ts";
import { defaultPolicy, loadPolicy, POLICY_FILE, PolicyError } from "../policy.ts";
import type { Location, Profile, ValueStats } from "../schema.ts";
import { validateProfile } from "../validate.ts";
import { buildProfile, forPrivacyMode, InputError, type Skipped } from "./profile.ts";

export const PROFILE_FILE = "profile.json";

export interface ProfileIO {
  output: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

const PROFILE_HELP = [
  "Usage: blind profile <inputs...> [--samples N] [--json]",
  "",
  "Profiles CSV, TSV, JSON, JSONL, XLSX, plain text, Markdown and log files, VTT and SRT transcripts",
  "and DOCX files (directories are walked) and writes .blind/profile.json (mode",
  "0600). Every JSON key path is profiled like a table column, every worksheet as a table, and",
  "transcripts list their speakers.",
  "The profile is the only thing a model ever sees; this command prints it so you can check exactly",
  "what would leave the machine. Samples are cut to 120 characters.",
  "Run it in the directory that holds blind.toml.",
  "",
  "Options:",
  "  --samples N  Sample values per column or document (default: [profile] samples in blind.toml; 0 = none)",
  "  --json       Print the profile JSON instead of the table",
  "  -h, --help   Show this help",
  "",
  "Exit status: 0 every file was profiled; 1 an error, or some files were not profiled (listed); 2 usage.",
  "",
].join("\n");

/** Writes the profile through a 0600 temp file and a rename, so a reader never sees a partial file. */
export function writeProfile(cwd: string, profile: Profile): string {
  const dir = join(cwd, BLIND_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, PROFILE_FILE);
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(profile, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  return join(BLIND_DIR, PROFILE_FILE);
}

const q = (s: string): string => JSON.stringify(s);
const fixed = (x: number): string => x.toFixed(2);

function detectors(s: ValueStats): string {
  const hits = Object.entries(s.detectorRates)
    .filter(([, r]) => r > 0)
    .map(([name, r]) => `${name} ${fixed(r)}`);
  return hits.length === 0 ? "-" : hits.join(" ");
}

function table(rows: string[][]): string[] {
  const widths = (rows[0] ?? []).map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => `  ${r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] ?? 0))).join("  ")}`.trimEnd());
}

const statCells = (s: ValueStats): string[] => [
  String(s.count),
  fixed(s.distinctRatio),
  fixed(s.digitRatio),
  fixed(s.dictionaryRatio),
  s.meanLength.toFixed(1),
  detectors(s),
  s.samples.map(q).join(", "),
];

const where = (l: Location): string => `${l.file}${l.sheet === undefined ? "" : ` sheet ${q(l.sheet)}`} ${q(l.header ?? l.jsonPath ?? "")}`;

/** The human-readable profile. Every document-derived string is printed JSON-quoted, as data. */
export function renderProfile(p: Profile, skipped: readonly Skipped[], notes: readonly string[]): string {
  const out: string[] = [`profile: ${p.files.length} file(s), up to ${p.sampleCount} sample(s) each`, ""];
  const formats = new Map(p.files.map((f) => [f.path, f]));
  const head = (file: string) => {
    const f = formats.get(file);
    return `${q(file)}  ${f?.format ?? "?"}  ${f?.size ?? 0} bytes`;
  };
  for (const t of p.tables) {
    out.push(`${head(t.file)}${t.sheet === undefined ? "" : `  sheet ${q(t.sheet)}`}  header row ${t.headerRow}${t.overflowRows === undefined ? "" : `  ${t.overflowRows} row(s) wider than the header (extra cells counted in the last column)`}`);
    out.push(
      ...table([
        ["column", "count", "distinct", "digits", "words", "length", "detectors", "samples"],
        ...t.columns.map((c) => [q(c.header), ...statCells(c.stats)]),
      ]),
      "",
    );
  }
  // JSON and JSONL files, each with its key paths.
  for (const f of p.files) {
    if (f.format !== "json" && f.format !== "jsonl") continue;
    const group = p.jsonKeys.filter((j) => j.file === f.path);
    out.push(head(f.path));
    if (group.length === 0) {
      out.push("  no key paths", "");
      continue;
    }
    out.push(
      ...table([
        ["key path", "count", "distinct", "digits", "words", "length", "detectors", "samples"],
        ...group.map((j) => [q(j.path), ...statCells(j.stats)]),
      ]),
      "",
    );
  }
  for (const d of p.documents) {
    out.push(head(d.file));
    out.push(`  outline: ${d.outline.length === 0 ? "-" : d.outline.map(q).join(", ")}`);
    out.push(`  samples: ${d.sampleSentences.length === 0 ? "-" : ""}`.trimEnd());
    for (const s of d.sampleSentences) out.push(`    ${q(s)}`);
    out.push("");
  }
  for (const t of p.transcripts) {
    out.push(`${head(t.file)}  transcript`);
    out.push(`  speakers: ${t.speakers.length === 0 ? "-" : t.speakers.map(q).join(", ")}`);
    out.push(`  samples: ${t.sampleLines.length === 0 ? "-" : ""}`.trimEnd());
    for (const s of t.sampleLines) out.push(`    ${q(s)}`);
    out.push("");
  }
  if (p.cooccurrence.length > 0) {
    out.push("co-occurrence (columns sharing over half their distinct values):");
    for (const c of p.cooccurrence) out.push(`  ${where(c.a)}  <->  ${where(c.b)}  ${c.shared} shared`);
    out.push("");
  }
  for (const n of notes) out.push(`note: ${n}`);
  if (skipped.length > 0) {
    out.push(`not profiled (${skipped.length}); a model would see nothing about these:`);
    for (const s of skipped) out.push(`  ${q(s.path)}: ${s.reason}`);
  }
  return `${out.join("\n").trimEnd()}\n`;
}

export async function runProfile(argv: string[], io: ProfileIO, cwd = process.cwd()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        samples: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind profile: ${(e as Error).message}\n\n${PROFILE_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.output.write(PROFILE_HELP);
    return 0;
  }
  if (positionals.length === 0) {
    io.err.write(`blind profile: name at least one input file or directory\n\n${PROFILE_HELP}`);
    return 2;
  }
  if (values.samples !== undefined && !/^\d+$/.test(values.samples)) {
    io.err.write(`blind profile: --samples must be a whole number (0 or more), got ${q(values.samples)}\n`);
    return 2;
  }

  try {
    // --samples works without blind.toml; then the mode is the default (local-only).
    const policy = values.samples !== undefined && !existsSync(join(cwd, POLICY_FILE)) ? defaultPolicy() : loadPolicy(cwd);
    const k = values.samples !== undefined ? Number(values.samples) : policy.profile.samples;
    const { profile, skipped, notes } = forPrivacyMode(buildProfile(positionals, k, cwd), policy.privacy.mode);
    const check = validateProfile(profile);
    if (!check.ok) {
      // A bug, not a user error: refuse to write a profile that breaks the schema.
      const issues = check.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n");
      io.err.write(`blind profile: internal error, the profile failed validation; nothing written\n${issues}\n`);
      return 1;
    }
    const written = writeProfile(cwd, profile);
    if (values.json) {
      io.output.write(`${JSON.stringify(profile, null, 2)}\n`);
      for (const n of notes) io.err.write(`blind profile: note: ${n}\n`);
      for (const s of skipped) io.err.write(`blind profile: not profiled: ${q(s.path)}: ${s.reason}\n`);
      io.err.write(`blind profile: wrote ${written} (mode 0600)\n`);
    } else {
      io.output.write(renderProfile(profile, skipped, notes));
      const seen = policy.privacy.mode === "profile-only" ? "A model would see these statistics, with every name above sent as a token, and no value." : "This is everything a model would see.";
      io.output.write(`\nwrote ${written} (mode 0600). ${seen}\n`);
    }
    if (skipped.length > 0) {
      io.err.write(`blind profile: ${skipped.length} file(s) not profiled; see the list above\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof PolicyError || e instanceof InputError) {
      io.err.write(`blind profile: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
