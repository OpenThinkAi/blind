// `blind apply <inputs> -o <out>`: the file-system half of the engine. Reads
// the saved spec and salt from .blind/, collects the inputs, runs the engine,
// writes the map (0600) and then the blinded files, and prints a report per
// file. Nothing is written unless the spec, the salt and every input check out.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { type ApplyResult, ApplyError, applySpec, type FileReport, type InputFile } from "./engine/apply.ts";
import { type BlindMap, MapError, readMap, writeMap } from "./engine/map.ts";
import { NameError } from "./engine/names.ts";
import { MIN_SALT_BYTES, PseudonymError } from "./engine/pseudonym.ts";
import { BLIND_DIR, SALT_FILE } from "./init.ts";
import { loadKeepTerms, POLICY_FILE, PolicyError } from "./policy.ts";
import type { Spec } from "./schema.ts";
import { parseSpec, SchemaError } from "./validate.ts";

export const SPEC_FILE = "spec.json";
export const MAP_FILE = "map.json";

export interface ApplyIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where blind.toml and .blind/ live. */
  cwd: string;
}

const APPLY_HELP = [
  "Usage: blind apply <inputs...> -o <out> [--map-out <path>]",
  "",
  "Applies the saved spec (.blind/spec.json) to the inputs and writes blinded copies under <out>.",
  "Inputs are files or directories; spec rules name files by their path relative to the input",
  "directory (or by file name for a file input). Handles CSV/TSV, JSON/JSONL (.json, .jsonl,",
  ".ndjson), XLSX workbooks (rules name a column by sheet and header), text (.txt, .md, .log)",
  "and DOCX; other files are reported and not written. File and",
  "folder names are blinded too; the report lists each renamed file. Host names under a domain",
  "in the blind.toml keep list are kept.",
  "",
  "Options:",
  "  -o, --out <dir>       Output directory (must not overlap an input)",
  "      --map-out <path>  Where to write the reversal map (default .blind/map.json, mode 0600).",
  "                        An existing map there is reused, so earlier pseudonyms stay the same.",
  "  -h, --help            Show this help",
  "",
  "Exit status: 0 every input written, 1 some inputs not written (listed), 2 refused or failed.",
  "",
].join("\n");

class Refusal extends Error {}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const toPosix = (p: string): string => p.split(sep).join("/");

/** Files and directories blind never reads as corpus input. */
const IGNORED: Record<string, string> = {
  [BLIND_DIR]: "blind's own directory (salt, spec, map); never copied",
  [POLICY_FILE]: "blind's policy file; never copied",
  ".git": "version-control metadata; never copied",
};

interface Collected {
  files: { path: string; abs: string }[];
  ignored: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
}

function collect(inputs: readonly string[], cwd: string): Collected {
  const c: Collected = { files: [], ignored: [], skipped: [] };
  const walk = (abs: string, rel: string): void => {
    const name = basename(abs);
    const why = IGNORED[name];
    if (why !== undefined) {
      c.ignored.push({ path: rel || name, reason: why });
      return;
    }
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) c.skipped.push({ path: rel, reason: "symbolic link, not followed; not written" });
    else if (st.isDirectory()) {
      const names = readdirSync(abs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const n of names) walk(join(abs, n), rel === "" ? n : `${rel}/${n}`);
    } else if (st.isFile()) c.files.push({ path: rel, abs });
    else c.skipped.push({ path: rel, reason: "not a regular file; not written" });
  };
  for (const input of inputs) {
    const abs = resolve(cwd, input);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new Refusal(`input ${input} does not exist`);
    }
    if (st.isDirectory()) walk(abs, "");
    else walk(abs, basename(abs));
  }
  return c;
}

function readSecret(path: string, what: string, hint: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal(`${path} not found; ${hint}`);
    throw new Refusal(`${path}: cannot read the ${what}`);
  }
}

function loadSpec(cwd: string): Spec {
  const path = join(cwd, BLIND_DIR, SPEC_FILE);
  const text = readSecret(path, "spec", "write a spec (see docs/spec.md) before applying").toString("utf8");
  return parseSpec(text, path);
}

const OUTCOME_TEXT: Record<FileReport["columns"][number]["outcome"], string> = {
  blinded: "blinded",
  value: "replaced with Value_ pseudonyms",
  kept: "kept",
  "unknown-pseudonymised": "pseudonymised",
  "unknown-kept-low-cardinality": "kept (low cardinality)",
  "unknown-kept-not-identifier-like": "kept (not identifier-like: mostly dictionary words)",
  "unknown-kept-empty": "kept (empty)",
};

const DELIMITER_NAMES: Record<string, string> = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };

export function renderReport(result: ApplyResult): string {
  const lines: string[] = [];
  for (const f of result.files) {
    const head: string[] = f.encoding === undefined ? [f.format] : [f.format, f.encoding];
    if (f.delimiter !== undefined) head.push(`${DELIMITER_NAMES[f.delimiter] ?? "other"}-delimited`);
    if (f.headerRow !== undefined) head.push(f.noHeader ? "no header row found, row 1 used" : `header row ${f.headerRow}`);
    lines.push(`${f.path} (${head.join(", ")})${f.changed ? "" : ": unchanged"}`);
    if (f.outputPath !== f.path) lines.push(`  written as ${f.outputPath}`);
    let sheet: string | undefined;
    for (const s of f.sheets ?? []) {
      if (s.outputName !== s.name) lines.push(`  sheet ${JSON.stringify(s.name)} renamed ${JSON.stringify(s.outputName)}`);
    }
    for (const c of f.columns) {
      if (c.sheet !== undefined && c.sheet !== sheet) {
        sheet = c.sheet;
        const s = f.sheets?.find((x) => x.name === sheet);
        lines.push(`  sheet ${JSON.stringify(sheet)}${s === undefined ? "" : s.noHeader ? " (no header row found, row 1 used)" : ` (header row ${s.headerRow})`}`);
      }
      const label = c.jsonPath !== undefined ? `key ${JSON.stringify(c.jsonPath)}` : c.header === "" ? `column ${c.index + 1} (blank header)` : JSON.stringify(c.header);
      const unit = c.jsonPath !== undefined ? "value" : "cell";
      const unknown = c.outcome.startsWith("unknown-");
      let line = `  ${label}: ${unknown ? "unknown" : `${c.class}/${c.treatment}`} → ${OUTCOME_TEXT[c.outcome]}`;
      if (c.changed > 0) line += `, ${c.changed} ${unit}${c.changed === 1 ? "" : "s"} changed`;
      if (unknown) line += c.treatment === null ? " (no spec rule)" : ` (spec: ${c.class}/${c.treatment})`;
      lines.push(line);
      if (c.flagged > 0) {
        lines.push(
          `    warning: ${c.flagged} kept ${unit}${c.flagged === 1 ? "" : "s"} contain a spec entity or a pattern match and were left unchanged as the spec says; review this rule`,
        );
      }
    }
    if (f.entityReplacements + f.patternReplacements > 0) {
      lines.push(`  free text: ${f.entityReplacements} entity and ${f.patternReplacements} pattern replacements`);
    }
    if (f.mappedReplacements > 0) {
      lines.push(`  ${f.mappedReplacements} value${f.mappedReplacements === 1 ? "" : "s"} blinded in a column replaced again where ${f.mappedReplacements === 1 ? "it recurs" : "they recur"} outside it`);
    }
    if ((f.metadataReplacements ?? 0) > 0) {
      lines.push(`  metadata: ${f.metadataReplacements} author, creator or company value${f.metadataReplacements === 1 ? "" : "s"} replaced`);
    }
    for (const w of f.warnings ?? []) lines.push(`  warning: ${w}`);
    if (f.keptHosts > 0) {
      lines.push(`  kept ${f.keptHosts} host name${f.keptHosts === 1 ? "" : "s"} under a domain in the policy keep list`);
    }
    if (f.unread !== undefined && f.unread.length > 0) {
      lines.push(`  copied without reading (not XML; the audit still reads them): ${f.unread.join(", ")}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export async function runApply(argv: string[], io: ApplyIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        "map-out": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind apply: ${(e as Error).message}\n\n${APPLY_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(APPLY_HELP);
    return 0;
  }
  if (positionals.length === 0 || values.out === undefined) {
    io.err.write(`blind apply: ${positionals.length === 0 ? "no inputs given" : "-o <out> is required"}\n\n${APPLY_HELP}`);
    return 2;
  }

  try {
    const spec = loadSpec(io.cwd);
    // The keep list's domains keep vendor host names as written. Without a policy nothing is kept.
    const keep = loadKeepTerms(io.cwd);
    const salt = readSecret(join(io.cwd, BLIND_DIR, SALT_FILE), "salt", "run `blind init` first");
    if (salt.length < MIN_SALT_BYTES) throw new Refusal(`${join(io.cwd, BLIND_DIR, SALT_FILE)} is too short; re-run \`blind init --force\``);

    const outDir = resolve(io.cwd, values.out);
    const mapPath = resolve(io.cwd, values["map-out"] ?? join(BLIND_DIR, MAP_FILE));
    const inputs = positionals.map((p) => resolve(io.cwd, p));
    for (const input of inputs) {
      if (within(outDir, input) || within(input, outDir)) {
        throw new Refusal(`output directory ${values.out} overlaps input ${relative(io.cwd, input) || "."}; choose a separate directory`);
      }
    }
    if (within(mapPath, outDir)) {
      throw new Refusal("the map must not be written inside the output directory: it holds the original values");
    }
    for (const input of inputs) {
      if (within(mapPath, input) && !mapPath.split(sep).includes(BLIND_DIR)) {
        throw new Refusal("the map must not be written inside an input; it would be read back as corpus input");
      }
    }

    const collected = collect(positionals, io.cwd);
    const files: InputFile[] = collected.files.map((f) => ({ path: f.path, bytes: readFileSync(f.abs) }));
    let map: BlindMap | undefined;
    try {
      lstatSync(mapPath);
      map = readMap(mapPath);
    } catch (e) {
      if (e instanceof MapError) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Refusal(`${mapPath}: cannot read the map`);
    }

    const result = applySpec(files, spec, { salt, map, keep });

    // The map first: if writing the outputs fails part-way, what was written can still be reversed.
    try {
      mkdirSync(dirname(mapPath), { recursive: true, mode: 0o700 });
      writeMap(mapPath, result.map);
    } catch (e) {
      throw new Refusal(`cannot write the map to ${mapPath}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    try {
      for (const o of result.outputs) {
        const dest = join(outDir, ...o.path.split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, o.bytes);
      }
    } catch (e) {
      io.err.write(`blind apply: writing ${values.out} failed part-way (${(e as Error).message}); the output is incomplete. The map was written first, so anything written can be reversed.\n`);
      return 2;
    }

    io.out.write(renderReport(result));
    for (const i of collected.ignored) io.out.write(`ignored ${i.path}: ${i.reason}\n`);
    const skipped = [...collected.skipped, ...result.skipped];
    for (const s of skipped) io.err.write(`blind apply: ${s.path}: ${s.reason}\n`);
    io.out.write(
      `wrote ${result.outputs.length} file${result.outputs.length === 1 ? "" : "s"} to ${toPosix(relative(io.cwd, outDir)) || "."}; map: ${toPosix(relative(io.cwd, mapPath))} (mode 0600; keep it secret)\n`,
    );
    if (skipped.length > 0) {
      io.err.write(`blind apply: ${skipped.length} input${skipped.length === 1 ? " was" : "s were"} not written; see above\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof Refusal || e instanceof PolicyError || e instanceof SchemaError || e instanceof ApplyError || e instanceof MapError || e instanceof PseudonymError || e instanceof NameError) {
      io.err.write(`blind apply: ${e.message}\nnothing was written\n`);
      return 2;
    }
    throw e;
  }
}

export function processApplyIO(): ApplyIO {
  return { out: process.stdout, err: process.stderr, cwd: process.cwd() };
}
