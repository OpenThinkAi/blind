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

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";
import type { PlanDiff } from "./analyst/merge.ts";
import { decideFromReport, type PlanIO, renderDiff, renderSpec, runPlan } from "./analyst/plan.ts";
import { MAP_FILE, runApply, SPEC_FILE } from "./apply.ts";
import { EXIT_NOT_RUN, renderTable, runAudit } from "./audit/command.ts";
import type { AuditReport } from "./audit/mechanical.ts";
import { BLIND_DIR } from "./init.ts";
import { loadPolicyIfAny } from "./policy.ts";
import { parseSpec } from "./validate.ts";
import { terminalStream } from "./terminal.ts";

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
  "At most 3 rounds in all; it stops early when the audit finds no leak, or when accepting changed",
  "nothing. Candidates that are not leaks are never decided here: review them with",
  "`blind audit <out> --json` and `blind plan --from-audit`. No model is called for the decisions.",
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
  const report = JSON.parse(planOut.text()) as PlanDiff & { notes: string[] };
  const specPath = join(io.cwd, BLIND_DIR, SPEC_FILE);
  const spec = parseSpec(readFileSync(specPath, "utf8"), specPath);
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

  // 2. Apply.
  const mapOut = values["map-out"] ?? join(BLIND_DIR, MAP_FILE);
  const applyCode = await runApply([...positionals, "-o", values.out, "--map-out", mapOut], { out: io.out, err: io.err, cwd: io.cwd });
  if (applyCode === 2) {
    io.err.write("blind run: apply refused or failed; nothing was audited\n");
    return EXIT_NOT_RUN;
  }

  // 3. Audit, over what apply wrote.
  const mapAbs = resolve(io.cwd, mapOut);
  const auditArgs = [values.out, "--map", mapAbs, ...(values["no-model"] ? ["--no-model"] : [])];
  let auditCode: number;
  let worst = Math.max(planCode, applyCode);
  if (!values["accept-leaks"]) auditCode = await runAudit(auditArgs, io);
  else {
    // The audit's own JSON report feeds the next round; the table printed is rendered from it.
    let report = await auditRound(auditArgs, io);
    auditCode = report.code;
    for (let round = 1; auditCode === EXIT_LEAK && round < MAX_ROUNDS; round++) {
      io.out.write(`\n--accept-leaks: round ${round} left leaks; accepting each at its suggested class\n`);
      let changed: boolean;
      try {
        const reportText = report.text;
        const decided = await decideFromReport(() => reportText, `the round ${round} audit`, values.out, { acceptLeaks: true, map: mapOut, json: false }, { out: io.out, err: io.err, cwd: io.cwd });
        changed = decided.changed;
        worst = Math.max(worst, decided.code);
      } catch (e) {
        io.err.write(`blind run: --accept-leaks: ${(e as Error).message}; the round ${round} audit stands\n`);
        break;
      }
      if (!changed) {
        io.out.write(`--accept-leaks: the spec did not change, so another round would find the same leaks; stopping after round ${round}\n`);
        break;
      }
      io.out.write(`\n--accept-leaks: round ${round + 1}: apply and audit again\n`);
      const again = await runApply([...positionals, "-o", values.out, "--map-out", mapOut], { out: io.out, err: io.err, cwd: io.cwd });
      if (again === 2) {
        io.err.write("blind run: apply refused or failed; nothing more was audited\n");
        return EXIT_NOT_RUN;
      }
      worst = Math.max(worst, again);
      report = await auditRound(auditArgs, io);
      auditCode = report.code;
    }
  }
  if (auditCode === 0 && worst !== 0) {
    io.err.write("blind run: the audit is clean, but some inputs were not profiled or not written (listed above), so the run is not clean\n");
    return 1;
  }
  return auditCode;
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
