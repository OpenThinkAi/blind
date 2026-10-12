// `blind bench <kit>`: the evaluation harness. A kit is `<kit>/input/` (the documents),
// `<kit>/oracle.json` (every sensitive value a person found by reading the inputs) and
// `<kit>/spec.json` (the reviewed spec), plus an optional `<kit>/blind.toml`. The bench runs
// `blind apply` and `blind audit` once, in a private temporary workspace with a fresh salt, scores
// the output against the oracle (src/bench/score.ts), prints a masked table, writes
// bench-report.json and deletes the workspace. No model is called: the audit runs its mechanical
// and semantic layers, and `--plan` uses the heuristic analyst.
//
// Everything in the report except `timing` depends only on the kit: the order is fixed and no
// value in it depends on the salt.

import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { runPlan } from "../analyst/plan.ts";
import { runApply, SPEC_FILE } from "../apply.ts";
import { collectTree, EXIT_NOT_RUN, runAudit } from "../audit/command.ts";
import type { AuditReport } from "../audit/mechanical.ts";
import type { ApplyResult, SkippedFile } from "../engine/apply.ts";
import { BLIND_DIR, writeSalt } from "../init.ts";
import { defaultPolicy, POLICY_FILE, renderPolicy } from "../policy.ts";
import {
  type BenchOracle,
  type DamageItem,
  type HonestyItem,
  type LeakItem,
  OracleError,
  OracleMatcher,
  parseOracle,
  type ScoredFile,
  scanLeaks,
  scoreDamage,
  scoreHonesty,
  type UnscoredItem,
} from "./score.ts";

export const KIT_INPUT = "input";
export const KIT_ORACLE = "oracle.json";
export const KIT_SPEC = "spec.json";
export const REPORT_FILE = "bench-report.json";

export interface BenchIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  cwd: string;
  /** Wall clock in milliseconds; only ever written to `timing`. A test seam. */
  now?: () => number;
  /** Where the private workspace is created; the system tmpdir by default. A test seam. */
  tmpRoot?: string;
}

const BENCH_HELP = [
  "Usage: blind bench <kit> [--report <path>] [--plan]",
  "",
  "Scores one blinding run against a kit's oracle. A kit is a directory holding input/ (the documents),",
  "oracle.json (every sensitive value in them, found by reading the inputs) and spec.json (the reviewed",
  "spec), and optionally blind.toml (the policy; the default policy otherwise). `bun src/bench/synth.ts",
  "<kit>` writes a synthetic one; docs/bench.md says how to build one from your own data.",
  "",
  "The bench runs `blind apply` and `blind audit` once in a private temporary workspace with a fresh",
  "salt, then deletes it (the blinded copies and the map with it). No model is called. It scores:",
  "  leaks    oracle values left anywhere in the output (any case, whole words; names and archives too)",
  "  damage   CSV/TSV and worksheet cells and JSON keys and values changed outside the blinded and",
  "           declared-unknown columns, DOCX paragraphs, and file, folder, worksheet and defined names",
  "           changed, that hold no oracle value; decoys that did not survive; changed shapes",
  "  honesty  files the audit called clean that have a leak",
  "  speed    wall time of apply and audit",
  "Values are masked in the table and the report: first characters, ***, length.",
  "",
  "Options:",
  "      --report <path>  Where to write the JSON report (default <kit>/bench-report.json)",
  "      --plan           Ignore spec.json: plan the spec with the heuristic analyst (`blind plan",
  "                       --no-model`) and score that first try",
  "  -h, --help           Show this help",
  "",
  "Exit status: 0 leaks, damage and honesty all 0 and everything scored; 1 anything else (listed);",
  "2 the bench could not run (usage error, bad kit, or apply or audit refused).",
  "",
].join("\n");

class Refusal extends Error {}

export interface BenchReport {
  version: 1;
  result: "pass" | "fail";
  kit: { version?: number; seed?: number; rows?: number; files: number; inputBytes: number; oracleValues: number; decoys: number };
  /** "kit": the kit's spec.json; "heuristic": planned with `--plan`. */
  spec: "kit" | "heuristic";
  apply: { exit: number; written: number; notWritten: SkippedFile[] };
  audit: { exit: number; status: AuditReport["status"]; leaks: number; candidates: number; layers: string[] };
  leaks: { count: number; items: LeakItem[] };
  damage: { count: number; items: DamageItem[] };
  honesty: { count: number; items: HonestyItem[] };
  unscored: UnscoredItem[];
  /** The only fields that vary between runs of the same kit. */
  timing: { applyMs: number; auditMs: number; totalMs: number };
}

/** A stream that keeps what is written, for the in-process commands. */
class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString();
    cb();
  }
}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function readKitFile(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal(`${path} not found; a kit needs ${what} (see docs/bench.md)`);
    throw new Refusal(`${path}: cannot read ${what}`);
  }
}

/** Writes `text` to a new file created 0600 in the same open call. */
function writePrivate(path: string, text: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

const indent = (s: string): string => s.trimEnd().split("\n").map((l) => `  ${l}`).join("\n");

function table(i: { kind: string; where: string; class: string; masked: string; detail: string }[]): string[] {
  if (i.length === 0) return [];
  const head = ["KIND", "WHERE", "CLASS", "VALUE", "DETAIL"];
  const cells = i.map((x) => [x.kind, x.where, x.class, x.masked === "" ? "-" : x.masked, x.detail]);
  const width = head.map((h, k) => Math.max(h.length, ...cells.map((c) => (c[k] as string).length)));
  const fmt = (c: string[]) => c.map((x, k) => (k === c.length - 1 ? x : x.padEnd(width[k] as number))).join("  ");
  return [fmt(head), ...cells.map(fmt), ""];
}

const partOf = (file: string, part: string): string => (part === "" ? file : `${file}!${part}`);

/** The masked table: one row per finding, then the scores. Timing is the last line, on its own. */
export function renderBench(r: BenchReport): string {
  const rows = [
    ...r.leaks.items.map((l) => ({ kind: "leak", where: `${partOf(l.file, l.part)}${l.in === "name" ? " [name]" : ""}`, class: l.class, masked: l.masked, detail: "oracle value left in the output" })),
    ...r.damage.items.map((d) => ({ kind: `damage:${d.kind}`, where: `${d.file} ${d.where}`, class: "-", masked: d.masked, detail: d.detail })),
    ...r.honesty.items.map((h) => ({ kind: "honesty", where: h.file, class: "-", masked: "", detail: `the audit called it clean; ${h.leaks} leak${h.leaks === 1 ? "" : "s"}` })),
    ...r.apply.notWritten.map((n) => ({ kind: "not-written", where: n.path, class: "-", masked: "", detail: n.reason })),
    ...r.unscored.map((u) => ({ kind: "unscored", where: partOf(u.file, u.part), class: "-", masked: "", detail: u.reason })),
  ];
  const k = r.kit;
  const kit = [k.version === undefined ? null : `kit v${k.version}`, k.seed === undefined ? null : `seed ${k.seed}`, k.rows === undefined ? null : `${k.rows} rows`]
    .filter((x) => x !== null)
    .join(", ");
  const lines = [
    ...table(rows),
    `${kit === "" ? "kit" : kit}: ${k.files} input file${k.files === 1 ? "" : "s"}, ${k.inputBytes} bytes, ${k.oracleValues} oracle values, ${k.decoys} decoys; spec: ${r.spec === "kit" ? "the kit's spec.json" : "planned by the heuristic analyst"}`,
    `leaks:   ${r.leaks.count}`,
    `damage:  ${r.damage.count}`,
    `honesty: ${r.honesty.count} (audit: ${r.audit.status}, ${r.audit.leaks} leak${r.audit.leaks === 1 ? "" : "s"}, ${r.audit.candidates} candidate${r.audit.candidates === 1 ? "" : "s"})`,
    `not written: ${r.apply.notWritten.length}; not scored: ${r.unscored.length}`,
    `result: ${r.result}${r.result === "pass" ? " (scores only the values the oracle lists; it says nothing about anything the oracle misses)" : ""}`,
    `speed: apply ${(r.timing.applyMs / 1000).toFixed(2)} s, audit ${(r.timing.auditMs / 1000).toFixed(2)} s, total ${(r.timing.totalMs / 1000).toFixed(2)} s`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runBench(argv: string[], io: BenchIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        report: { type: "string" },
        plan: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind bench: ${(e as Error).message}\n\n${BENCH_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(BENCH_HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    io.err.write(`blind bench: ${positionals.length === 0 ? "no kit given" : "give exactly one kit"}\n\n${BENCH_HELP}`);
    return 2;
  }
  const now = io.now ?? (() => performance.now());
  const kitDir = resolve(io.cwd, positionals[0] as string);
  const inputDir = join(kitDir, KIT_INPUT);
  const reportPath = resolve(io.cwd, values.report ?? join(kitDir, REPORT_FILE));
  let ws: string | undefined;
  try {
    let st;
    try {
      st = lstatSync(inputDir);
    } catch {
      throw new Refusal(`${inputDir} not found; a kit keeps its documents in input/ (see docs/bench.md)`);
    }
    if (!st.isDirectory()) throw new Refusal(`${inputDir} is not a directory`);
    // The report would be read back as a document on the next run.
    if (within(reportPath, inputDir)) throw new Refusal("the report must not be written inside the kit's input/");
    const oraclePath = join(kitDir, KIT_ORACLE);
    const oracle: BenchOracle = parseOracle(readKitFile(oraclePath, "an oracle"), oraclePath);
    const spec = values.plan ? undefined : readKitFile(join(kitDir, KIT_SPEC), "a reviewed spec (or pass --plan)");
    let policy: string | undefined;
    try {
      policy = readFileSync(join(kitDir, POLICY_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Refusal(`${join(kitDir, POLICY_FILE)}: cannot read the policy`);
    }

    // The workspace: blind.toml, a fresh salt, the spec (0600), and the output. mkdtemp makes it 0700.
    ws = mkdtempSync(join(io.tmpRoot ?? tmpdir(), "blind-bench-"));
    writeFileSync(join(ws, POLICY_FILE), policy ?? renderPolicy(defaultPolicy()), { flag: "wx" });
    writeSalt(ws, false);
    if (spec !== undefined) writePrivate(join(ws, BLIND_DIR, SPEC_FILE), spec);
    else {
      const plan = { out: new Capture(), err: new Capture(), cwd: ws };
      const code = await runPlan([inputDir, "--no-model", "--quiet"], plan);
      if (code === 2) throw new Refusal(`blind plan refused:\n${indent(plan.err.text)}`);
    }

    const outDir = join(ws, "out");
    let result: { engine: ApplyResult; notWritten: readonly SkippedFile[] } | undefined;
    const applyIO = { out: new Capture(), err: new Capture(), cwd: ws, onResult: (engine: ApplyResult, notWritten: readonly SkippedFile[]) => (result = { engine, notWritten }) };
    const t0 = now();
    const applyExit = await runApply([inputDir, "-o", outDir], applyIO);
    const t1 = now();
    if (applyExit === 2 || result === undefined) throw new Refusal(`blind apply refused, so nothing was scored:\n${indent(applyIO.err.text)}`);
    const auditIO = { out: new Capture(), err: new Capture(), cwd: ws };
    const auditExit = await runAudit([outDir, "--json", "--no-model"], auditIO);
    const t2 = now();
    if (auditExit === EXIT_NOT_RUN) throw new Refusal(`blind audit could not run, so honesty was not scored:\n${indent(auditIO.err.text)}`);
    const audit = JSON.parse(auditIO.out.text) as AuditReport;

    const { engine, notWritten } = result;
    const matcher = new OracleMatcher(oracle);
    const entries = collectTree(outDir);
    const leakScan = scanLeaks(entries, matcher);
    const byOutput = new Map(engine.outputs.map((o) => [o.path, o.bytes]));
    const scored: ScoredFile[] = engine.files.map((report) => {
      const output = byOutput.get(report.outputPath);
      if (output === undefined) throw new Error(`internal error: apply reported ${report.path} but wrote no ${report.outputPath}`);
      return { report, input: readFileSync(join(inputDir, ...report.path.split("/"))), output };
    });
    const damage = scoreDamage(scored, oracle, matcher);
    const honesty = scoreHonesty(audit, leakScan.leaks);
    const unscored = [...leakScan.unscored, ...damage.unscored];

    const inputBytes = scored.reduce((n, f) => n + f.input.byteLength, 0);
    const fail = leakScan.leaks.length + damage.damage.length + honesty.length + notWritten.length + unscored.length > 0;
    const report: BenchReport = {
      version: 1,
      result: fail ? "fail" : "pass",
      kit: { version: oracle.version, seed: oracle.seed, rows: oracle.rows, files: scored.length + notWritten.length, inputBytes, oracleValues: oracle.values.length, decoys: oracle.decoys.length },
      spec: spec === undefined ? "heuristic" : "kit",
      apply: { exit: applyExit, written: engine.outputs.length, notWritten: [...notWritten] },
      audit: { exit: auditExit, status: audit.status, leaks: audit.summary.leaks, candidates: audit.summary.candidates, layers: audit.layers },
      leaks: { count: leakScan.leaks.length, items: leakScan.leaks },
      damage: { count: damage.damage.length, items: damage.damage },
      honesty: { count: honesty.length, items: honesty },
      unscored,
      timing: { applyMs: Math.round(t1 - t0), auditMs: Math.round(t2 - t1), totalMs: Math.round(t2 - t0) },
    };
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (e) {
      throw new Refusal(`cannot write the report to ${reportPath}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    io.out.write(renderBench(report));
    io.out.write(`wrote ${within(reportPath, io.cwd) ? relative(io.cwd, reportPath) : reportPath}\n`);
    return fail ? 1 : 0;
  } catch (e) {
    if (e instanceof Refusal || e instanceof OracleError) {
      io.err.write(`blind bench: ${e.message}\nnothing was scored\n`);
      return 2;
    }
    // Anything else is a bug; exit 2 rather than let the runtime's exit 1 read as a scored failure.
    io.err.write(`blind bench: unexpected error: ${(e as Error).message}; nothing was scored\n`);
    return 2;
  } finally {
    if (ws !== undefined) rmSync(ws, { recursive: true, force: true });
  }
}

export function processBenchIO(): BenchIO {
  return { out: process.stdout, err: process.stderr, cwd: process.cwd() };
}
