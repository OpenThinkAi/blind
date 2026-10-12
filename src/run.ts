// `blind run <inputs> -o <out>`: plan, apply and audit in one pass, through the
// commands themselves. Plan reuses the saved spec, so a corpus it already covers
// makes no analyst call (the audit's model layer still runs unless --no-model). When the plan added anything to the spec (or there was no
// saved spec), run stops for review with exit 3 and prints what changed, unless
// --yes. Otherwise apply, then audit; the audit's status and exit code are run's,
// raised to at least 1 when plan or apply left inputs out. A step that refuses
// gives exit 3, never 2, which is the audit's "leak".
//
// --accept-leaks closes the loop without a human or a model: while the audit finds a leak, its
// report goes to `blind plan --from-audit --accept-leaks` (each leak accepted at its suggested
// class), and apply and audit run again, at most MAX_ROUNDS rounds in all. It stops early when
// accepting changed nothing, since another round would find the same leaks.

import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { PlanDiff } from "./analyst/merge.ts";
import { decideFromReport, type PlanIO, renderDiff, renderSpec, runPlan } from "./analyst/plan.ts";
import { MAP_FILE, runApply, SPEC_FILE } from "./apply.ts";
import type { ApplyResult, SkippedFile } from "./engine/apply.ts";
import { type FileAuditStatus, type ManifestInput, readPreviousOutputs, type RunManifest, staleOutputs, writeRunManifest } from "./runmanifest.ts";
import { EXIT_NOT_RUN, renderTable, runAudit } from "./audit/command.ts";
import type { AuditReport } from "./audit/mechanical.ts";
import { BLIND_DIR } from "./init.ts";
import { loadPolicyIfAny } from "./policy.ts";
import { parseSpec } from "./validate.ts";
import { oneLine, terminalStream } from "./terminal.ts";

export interface RunIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where blind.toml and .blind/ live. */
  cwd: string;
  /** Test seams, passed through to plan's and audit's model calls. */
  model?: PlanIO["model"];
}

const RUN_HELP = [
  "Usage: blind run <inputs...> -o <out> [--yes] [--accept-leaks] [--no-model] [--quiet] [--map-out <path>]",
  "",
  "Runs `blind plan` (reusing the saved .blind/spec.json: only columns, keys and excerpts it does",
  "not cover go to the analyst, and nothing does when it covers everything), then `blind apply`,",
  "then `blind audit` on <out>.",
  "",
  "When the plan adds anything to the spec (columns, entities or questions, or classifies a rule),",
  "or there was no saved spec, run stops before applying: it prints the spec or what changed and",
  "exits 3. Review .blind/spec.json (edit it, or `blind plan --answer`), then run again. --yes",
  "applies without stopping.",
  "",
  "With --accept-leaks, a leak in the audit does not end the run: every leak (a spec entity, map value",
  "or enabled pattern that survives) is accepted into the spec at its suggested class, as",
  "`blind plan --from-audit <report> --accept-leaks` does, and apply and audit run again into <out>.",
  "A leak that is not sensitive (dictionary words only, a value kept by a keep column or [keep].terms,",
  "a measure, a number under 5 digits) is listed with why and left out.",
  "At most 3 rounds in all; it stops early when the audit finds no leak, or when accepting changed",
  "nothing. Candidates that are not leaks are never decided here: review them with",
  "`blind audit <out> --json` and `blind plan --from-audit`. No model is called for the decisions.",
  "",
  "Each round is written to a private staging directory beside <out> and audited there; only the final",
  "round's tree is moved into <out>, so no earlier round's file survives under an old name. Files",
  "already in <out> are left alone (as `blind apply` does); run warns when one looks like a stale copy",
  "of an input. .blind/run.json (mode 0600) records each input's output path, why any input was not",
  "written, and the final audit status per output file.",
  "",
  "Options:",
  "  -o, --out <dir>       Output directory (must not overlap an input)",
  "      --yes             Apply even when the plan changed the spec",
  "      --accept-leaks    Accept every audit leak into the spec and run apply and audit again (see above)",
  "      --no-model        Heuristic analyst only, and no model audit layer (see `blind plan --help`, `blind audit --help`)",
  "      --quiet           Do not print the per-call model line",
  "      --map-out <path>  Where apply writes the map, and audit reads it (default .blind/map.json)",
  "  -h, --help            Show this help",
  "",
  "Exit status is the audit's: 0 clean, 1 candidates, 2 leak; at least 1 when some inputs were not",
  "profiled or written (listed). 3: stopped for review, or a step refused or failed (nothing audited).",
  "",
].join("\n");

/** Collects what a step writes, for run to read back its own --json output. */
function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (d) => (text += d));
  return { stream, text: () => text };
}

/** True when the plan put something in the spec the user has not reviewed. */
export function needsReview(diff: PlanDiff): boolean {
  const { columns, entities, questions } = diff.added;
  return !diff.reused || columns.length + entities.length + questions.length + diff.classified.length > 0;
}

export async function runRun(argv: string[], io: RunIO): Promise<number> {
  try {
    return await chain(argv, io);
  } catch (e) {
    // A bug, not a verdict: exit 3 rather than let the runtime's exit 1 read as "candidates".
    io.err.write(`blind run: unexpected error: ${(e as Error).message}; the run did not finish and nothing more was audited\n`);
    return EXIT_NOT_RUN;
  }
}

async function chain(argv: string[], io: RunIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        yes: { type: "boolean", default: false },
        "accept-leaks": { type: "boolean", default: false },
        "no-model": { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        "map-out": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind run: ${(e as Error).message}\n\n${RUN_HELP}`);
    return EXIT_NOT_RUN;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(RUN_HELP);
    return 0;
  }
  if (positionals.length === 0 || values.out === undefined) {
    io.err.write(`blind run: ${positionals.length === 0 ? "no inputs given" : "-o <out> is required"}\n\n${RUN_HELP}`);
    return EXIT_NOT_RUN;
  }

  // 1. Plan. Its --json report is what changed; its stderr (model lines, skipped files) passes through.
  const planOut = capture();
  const planArgs = [...positionals, "--json", ...(values["no-model"] ? ["--no-model"] : []), ...(values.quiet ? ["--quiet"] : [])];
  const planCode = await runPlan(planArgs, { out: planOut.stream, err: io.err, cwd: io.cwd, model: io.model });
  if (planCode === 2) {
    io.err.write("blind run: plan refused; nothing was applied or audited\n");
    return EXIT_NOT_RUN;
  }
  const report = JSON.parse(planOut.text()) as PlanDiff & { notes: string[]; warnings: string[] };
  const specPath = join(io.cwd, BLIND_DIR, SPEC_FILE);
  const spec = parseSpec(readFileSync(specPath, "utf8"), specPath);
  for (const w of report.warnings) io.out.write(`${w}\n`);
  for (const n of report.notes) io.out.write(`note: ${n}\n`);

  if (needsReview(report)) {
    io.out.write(renderSpec(spec, loadPolicyIfAny(io.cwd)?.patterns ?? {}));
    if (report.reused || report.dropped.length > 0) io.out.write(`\n${renderDiff(report)}`);
    if (!values.yes) {
      io.out.write(
        `\nstopped for review: ${report.reused ? "the plan changed" : "this is a new"} ${join(BLIND_DIR, SPEC_FILE)}. Nothing was applied.\n` +
          "Check it (edit the file, or answer questions with `blind plan --answer <id>=<option>`), then run again; --yes applies without stopping.\n",
      );
      return EXIT_NOT_RUN;
    }
    io.out.write("\n--yes: applying the changed spec without stopping for review\n");
  } else {
    io.out.write(`spec: ${join(BLIND_DIR, SPEC_FILE)} reused unchanged\n`);
    if (report.dropped.length > 0) io.out.write(renderDiff(report));
  }

  // 2. Apply, into a staging directory beside <out>; only the final round's tree reaches <out>.
  const mapOut = values["map-out"] ?? join(BLIND_DIR, MAP_FILE);
  const mapAbs = resolve(io.cwd, mapOut);
  const outAbs = resolve(io.cwd, values.out);
  const outRel = toPosix(relative(io.cwd, outAbs)) || ".";
  if (within(mapAbs, outAbs)) {
    io.err.write("blind run: the map must not be written inside the output directory: it holds the original values\n");
    return EXIT_NOT_RUN;
  }
  const previous = readPreviousOutputs(io.cwd, outRel);
  let stage: string | undefined;
  const dropStage = (): void => {
    if (stage !== undefined) rmSync(stage, { recursive: true, force: true });
    stage = undefined;
  };
  try {
    let last: Applied | undefined;
    const round = async (): Promise<Applied> => {
      const fresh = newStage(outAbs);
      const a = await applyInto(fresh, outAbs, outRel, positionals, mapOut, io);
      if (a.code === 2) {
        rmSync(fresh, { recursive: true, force: true });
        dropStage();
        return a;
      }
      dropStage(); // the previous round's tree: nothing of it reaches <out>
      stage = fresh;
      last = a;
      return a;
    };
    const refused = (what: string): number => {
      io.err.write(`blind run: apply refused or failed; ${what}; nothing was written to ${outRel}\n`);
      return EXIT_NOT_RUN;
    };

    const first = await round();
    if (first.code === 2) return refused("nothing was audited");

    // 3. Audit, over what apply staged.
    const auditArgs = (): string[] => [stage as string, "--map", mapAbs, ...(values["no-model"] ? ["--no-model"] : [])];
    const audit = async (): Promise<{ code: number; text: string }> => auditRound(auditArgs(), rewriteIO(io, stage as string, outAbs, outRel));
    let worst = Math.max(planCode, first.code);
    let rounds = 1;
    let final = await audit();
    if (values["accept-leaks"]) {
      for (let r = 1; final.code === EXIT_LEAK && r < MAX_ROUNDS; r++) {
        io.out.write(`\n--accept-leaks: round ${r} left leaks; accepting each at its suggested class\n`);
        let changed: boolean;
        try {
          const reportText = final.text;
          const decided = await decideFromReport(() => reportText, `the round ${r} audit`, stage as string, { acceptLeaks: true, map: mapOut, json: false }, { out: io.out, err: io.err, cwd: io.cwd });
          changed = decided.changed;
          worst = Math.max(worst, decided.code);
        } catch (e) {
          io.err.write(`blind run: --accept-leaks: ${(e as Error).message}; the round ${r} audit stands\n`);
          break;
        }
        if (!changed) {
          io.out.write(`--accept-leaks: the spec did not change, so another round would find the same leaks; stopping after round ${r}\n`);
          break;
        }
        io.out.write(`\n--accept-leaks: round ${r + 1}: apply and audit again\n`);
        const again = await round();
        if (again.code === 2) return refused("nothing more was audited");
        worst = Math.max(worst, again.code);
        rounds = r + 1;
        final = await audit();
      }
    }
    let code = final.code;
    if (code === 0 && worst !== 0) {
      io.err.write("blind run: the audit is clean, but some inputs were not profiled or not written (listed above), so the run is not clean\n");
      code = 1;
    }

    // 4. Promote the final round's tree into <out>, and record the run.
    try {
      promote(stage as string, outAbs);
      stage = undefined;
    } catch (e) {
      io.err.write(`blind run: cannot move the output into ${outRel} (${(e as Error).message}); nothing was written there\n`);
      return EXIT_NOT_RUN;
    }
    const applied = last as Applied;
    const files = applied.result?.files ?? [];
    for (const s of staleOutputs(outAbs, files, previous)) {
      io.err.write(
        `blind run: warning: ${oneLine(s.stale)} in ${oneLine(outRel)} was not written by this run, but it is where ${oneLine(s.input)} was written before; it may be an earlier copy still holding values. blind never removes files it did not write; delete it if it is stale\n`,
      );
    }
    const report = final.code === EXIT_NOT_RUN ? undefined : (JSON.parse(final.text) as AuditReport);
    const statusOf = new Map((report?.files ?? []).map((f) => [f.path, f.status] as const));
    const manifest: RunManifest = {
      version: 1,
      out: outRel,
      rounds,
      exit: code,
      audit: report === undefined ? null : { status: report.status, leaks: report.summary.leaks, candidates: report.summary.candidates },
      inputs: [
        ...files.map((f): ManifestInput => ({ input: f.path, output: f.outputPath, audit: fileStatus(report, statusOf.get(f.outputPath)) })),
        ...applied.notWritten.map((n): ManifestInput => ({ input: n.path, output: null, reason: n.reason, audit: null })),
      ],
    };
    writeRunManifest(io.cwd, manifest);
    return code;
  } finally {
    dropStage();
  }
}

const toPosix = (p: string): string => p.split(sep).join("/");
const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The audit's word for one file: clean when the audit ran and listed nothing for it. */
function fileStatus(report: AuditReport | undefined, s: string | undefined): FileAuditStatus | null {
  if (report === undefined) return null;
  return s === "leak" || s === "candidates" ? s : "clean";
}

interface Applied {
  code: number;
  result: ApplyResult | undefined;
  notWritten: readonly SkippedFile[];
}

/** A fresh private directory beside <out>, so the final move into it stays on one file system. */
function newStage(outAbs: string): string {
  mkdirSync(dirname(outAbs), { recursive: true });
  return mkdtempSync(join(dirname(outAbs), `.${basename(outAbs)}.blind-stage-`));
}

/** Streams that name the staging directory as <out>: the user never chose, or needs to know, its name. */
function rewriting(target: NodeJS.WritableStream, stageAbs: string, outAbs: string, outRel: string, cwd: string): NodeJS.WritableStream {
  const stageRel = toPosix(relative(cwd, stageAbs));
  return new Writable({
    write(chunk, _enc, cb) {
      target.write(String(chunk).split(stageAbs).join(outAbs).split(stageRel).join(outRel));
      cb();
    },
  });
}

function rewriteIO(io: RunIO, stageAbs: string, outAbs: string, outRel: string): RunIO {
  return { ...io, out: rewriting(io.out, stageAbs, outAbs, outRel, io.cwd), err: rewriting(io.err, stageAbs, outAbs, outRel, io.cwd) };
}

async function applyInto(stageAbs: string, outAbs: string, outRel: string, inputs: string[], mapOut: string, io: RunIO): Promise<Applied> {
  const r = rewriteIO(io, stageAbs, outAbs, outRel);
  const applied: Applied = { code: 0, result: undefined, notWritten: [] };
  applied.code = await runApply([...inputs, "-o", stageAbs, "--map-out", mapOut], {
    out: r.out,
    err: r.err,
    cwd: io.cwd,
    onResult: (result, notWritten) => {
      applied.result = result;
      applied.notWritten = notWritten;
    },
  });
  return applied;
}

/**
 * Moves the staged tree into <out>. Into a missing or empty <out> it is one rename. Into a
 * directory that already holds files, each staged file replaces the same path there and the rest
 * are left alone, which is what `blind apply` does into a non-empty directory.
 */
export function promote(stage: string, out: string): void {
  let st;
  try {
    st = lstatSync(out);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const mode = 0o777 & ~process.umask();
  if (st === undefined || (st.isDirectory() && readdirSync(out).length === 0)) {
    if (st !== undefined) rmdirSync(out);
    renameSync(stage, out);
    chmodSync(out, mode);
    return;
  }
  if (!st.isDirectory() && !st.isSymbolicLink()) throw new Error("it exists and is not a directory");
  const walk = (dir: string, rel: string[]): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const segs = [...rel, name];
      if (lstatSync(abs).isDirectory()) {
        walk(abs, segs);
        continue;
      }
      // Never write through a symbolic link already inside <out>.
      for (let k = 1; k < segs.length + 1; k++) {
        try {
          if (lstatSync(join(out, ...segs.slice(0, k))).isSymbolicLink()) throw new Error(`${segs.slice(0, k).join("/")} is a symbolic link; blind never writes through one`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
          throw e;
        }
      }
      const dest = join(out, ...segs);
      mkdirSync(dirname(dest), { recursive: true });
      try {
        renameSync(abs, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        copyFileSync(abs, dest);
        unlinkSync(abs);
      }
    }
  };
  walk(stage, []);
  rmSync(stage, { recursive: true, force: true });
}

/** At most this many apply-and-audit rounds under --accept-leaks: the first, and two more. */
export const MAX_ROUNDS = 3;
const EXIT_LEAK = 2;

/** One audit, as JSON for the next round, printed as the usual table. */
async function auditRound(args: string[], io: RunIO): Promise<{ code: number; text: string }> {
  const out = capture();
  const code = await runAudit([...args, "--json"], { ...io, out: out.stream });
  const text = out.text();
  if (code !== EXIT_NOT_RUN) io.out.write(renderTable(JSON.parse(text) as AuditReport));
  return { code, text };
}

export function processRunIO(): RunIO {
  return { out: terminalStream(process.stdout), err: terminalStream(process.stderr), cwd: process.cwd() };
}
