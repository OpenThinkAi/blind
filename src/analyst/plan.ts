// `blind plan <inputs>`: profile the corpus, ask the analyst for a spec, save it as
// .blind/spec.json (mode 0600) and print it for review, questions first. With a saved spec,
// only what it does not cover goes to the analyst, and the reply is merged in (merge.ts).
// `blind plan --answer q1=blind` answers a question in the saved spec and prints it again.
// Nothing here changes a document: `blind apply` does that, and only from a saved spec.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAP_FILE, SPEC_FILE } from "../apply.ts";
import { MapError, readMap } from "../engine/map.ts";
import { BLIND_DIR } from "../init.ts";
import { type AskOptions, ModelError, modelsEnabled } from "../model.ts";
import { loadPolicy, PolicyError } from "../policy.ts";
import { writeProfile } from "../profile/command.ts";
import { buildProfile, forPrivacyMode, InputError } from "../profile/profile.ts";
import type { ColumnRule, EntityClassName, Location, Spec } from "../schema.ts";
import { parseSpec, SchemaError, validateProfile, validateSpec } from "../validate.ts";
import { AnalystError, answerQuestion, proposeSpec, runAnalyst } from "./analyst.ts";
import { heuristicSpec } from "./heuristic.ts";
import {
  ACCEPT_CLASSES,
  type AcceptClass,
  applyDecisions,
  type Candidate,
  type Change,
  type Collected,
  collectCandidates,
  type Decision,
  FromAuditError,
  leakDecisions,
  parseAuditReport,
  parseDecisions,
  type ReportFinding,
} from "./fromaudit.ts";
import { type Dropped, freshDiff, guardFresh, isEmptyPart, mergeProposal, type PlanDiff, seenAfter, unseenPart } from "./merge.ts";
import { terminalStream, terminalText } from "../terminal.ts";

export interface PlanIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where blind.toml and .blind/ live. */
  cwd: string;
  /** Test seams, passed through to the model call. */
  model?: Pick<AskOptions, "fetch" | "spawn" | "env" | "timeoutMs">;
  /** Asks the human one line on a terminal (`--from-audit` without decisions); null at end of input. Absent when stdin is not a TTY. */
  prompt?: (question: string) => Promise<string | null>;
}

const PLAN_HELP = [
  "Usage: blind plan <inputs...> [--no-model] [--quiet] [--force] [--json]",
  "       blind plan --answer <id>=<option> [--answer ...]",
  "       blind plan --from-audit <report.json> -o <out> [--accept <ids>] [--reject <ids>] [--accept-leaks] [--map <path>] [--json]",
  "",
  "Profiles the inputs, asks the analyst model (models.analyst in blind.toml) for a spec, saves it as",
  ".blind/spec.json (mode 0600) and prints it for review: questions first, then columns by class,",
  "then entities and patterns. The model sees only the profile (`blind profile` shows it). Nothing",
  "is changed until you run `blind apply`. Edit the spec file, or answer questions with --answer.",
  "A column with an unanswered question stays unknown.",
  "",
  "When .blind/spec.json exists it is reused: the analyst is sent only the columns, keys and",
  "document excerpts the spec does not cover yet (nothing at all when there are none), and its reply",
  "is merged in. It may add rules, entities and questions, and classify its own unknown rules that no",
  "question is about. Human rules, answered questions, entities and patterns are never changed;",
  "any attempt is dropped and listed with what was added and classified.",
  "",
  "With --from-audit, the report of `blind audit <out> --json` is turned into spec changes you decide.",
  "Each value the audit raised is read back from the blinded output <out> (the report shows masked",
  "values only) and listed once as a candidate c1, c2, ... with what raised it and where. On a",
  "terminal you are asked about each; otherwise decide with --accept and --reject. Accepted, a value",
  "is added to the spec as an entity (source human) of the class you give, or the suggested one; or",
  "with <id>=pattern, its shape pattern is turned on. Rejected, it is added to the spec's vocabulary",
  "so the audit does not raise it again. Undecided candidates change nothing and stay in the audit.",
  "Saved entries are never changed. Findings that are not one value (columns, unanswered questions,",
  "parts the audit could not read) are listed, not turned into changes. No model is called.",
  "",
  "--accept-leaks accepts every candidate the audit raised as a leak (a spec entity, map value or",
  "enabled pattern that survives) at its suggested class, or id when it suggests none, without",
  "asking. Candidates that are not leaks stay undecided unless --accept or --reject decides them;",
  "an --accept or --reject of a leak wins over --accept-leaks. A leak that cannot be accepted (a",
  "vocabulary form) is listed and left undecided.",
  "",
  "Options:",
  "  --answer <id>=<option>  Answer a question in the saved spec and print it again (repeatable)",
  "  --no-model              Heuristic analyst only: classify a column only when an email, ip, host,",
  "                          guid or numeric-id detector matches 80% of its values; the rest stay",
  "                          unknown. Also used when privacy.mode is \"none\".",
  "  --quiet                 Do not print the per-call model line (role, backend, model, mode, bytes)",
  "  --force                 Ignore the saved .blind/spec.json and plan from scratch (its edits and",
  "                          answers are lost)",
  "  --json                  Print what changed (added, classified, dropped) as JSON instead of the spec",
  "  --from-audit <report>   Turn a `blind audit --json` report into spec changes (see above)",
  "  -o, --out <out>         With --from-audit: the blinded output tree the report audited",
  "  --accept <ids>          With --from-audit: accept candidates, e.g. c1,c2=org,c3=pattern (repeatable)",
  "  --reject <ids>          With --from-audit: reject candidates into the vocabulary, e.g. c4,c5 (repeatable)",
  "  --accept-leaks          With --from-audit: accept every leak at its suggested class (see above)",
  "  --map <path>            With --from-audit: the map apply wrote (default .blind/map.json)",
  "  -h, --help              Show this help",
  "",
  "Exit status: 0 spec saved; 1 spec saved but some inputs were not profiled, or (--from-audit) some findings",
  "could not be read back from the output (listed); 2 refused or failed, nothing written.",
  "",
].join("\n");

const q = (s: string): string => JSON.stringify(s);
const where = (l: Location): string => `${q(l.file)}${l.sheet === undefined ? "" : ` [${q(l.sheet)}]`} ${q(l.header ?? l.jsonPath ?? "")}`;

const CLASS_ORDER: EntityClassName[] = ["unknown", "person", "org", "host", "email", "id", "location", "vocabulary"];

/** The spec as a review table: questions first, then columns grouped by class, entities, patterns. */
export function renderSpec(spec: Spec): string {
  const out: string[] = [];
  const open = spec.questions.filter((x) => x.answer === null).length;
  out.push(spec.questions.length === 0 ? "questions: none" : `questions (${open} unanswered of ${spec.questions.length}):`);
  for (const x of spec.questions) {
    out.push(`  ${x.id}  ${q(x.text)}`);
    out.push(`      options: ${x.options.join(" | ")}   answer: ${x.answer === null ? "(unanswered)" : x.answer}`);
    if (x.about !== undefined) out.push(`      about: ${where(x.about)}${x.answer === null ? " (unknown until answered)" : ""}`);
  }
  if (open > 0) out.push("  answer with: blind plan --answer <id>=<option>");
  out.push("");

  out.push(`columns (${spec.columns.length}):`);
  for (const cls of CLASS_ORDER) {
    const rules = spec.columns.filter((c) => c.class === cls);
    if (rules.length === 0) continue;
    out.push(`  ${cls}${cls === "unknown" ? " (value: decided at apply time, identifier-like columns get Value_ pseudonyms; blind: always Value_)" : ""}`);
    const rows = rules.map((c: ColumnRule) => [where(c), c.treatment, c.confidence.toFixed(2), c.source]);
    const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
    for (const r of rows) out.push(`    ${r.map((cell, i) => (i < 3 ? cell.padEnd(widths[i] ?? 0) : cell)).join("  ")}`);
  }
  out.push("");

  const groups = Object.entries(spec.entities).filter(([, list]) => list !== undefined && list.length > 0);
  out.push(groups.length === 0 ? "entities: none" : "entities:");
  for (const [cls, list] of groups) {
    out.push(`  ${cls}`);
    for (const e of list ?? []) {
      const extra = [e.aliases.length > 0 ? `aliases ${e.aliases.map(q).join(", ")}` : "", e.parts.length > 0 ? `parts ${e.parts.map(q).join(", ")}` : ""];
      out.push(`    ${q(e.canonical)}${extra.filter((x) => x !== "").map((x) => `; ${x}`).join("")}`);
    }
  }
  out.push("");
  out.push(`patterns: ${Object.entries(spec.patterns).map(([name, on]) => `${name} ${on ? "on" : "off"}`).join(", ")}`);
  return `${out.join("\n")}\n`;
}

/** Writes the spec through a 0600 temp file and a rename. The spec names real entities: it is private. */
function writeSpec(cwd: string, spec: Spec): string {
  const dir = join(cwd, BLIND_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, SPEC_FILE);
  const tmp = `${target}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(spec, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  return join(BLIND_DIR, SPEC_FILE);
}

class Refusal extends Error {}

/** The saved spec, validated, or undefined when there is none. */
function readSaved(cwd: string): Spec | undefined {
  const path = join(cwd, BLIND_DIR, SPEC_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Refusal(`${path}: cannot read the spec`);
  }
  return parseSpec(text, path);
}

/** The map `blind apply` wrote, if there is one: its values are blinded, so no analyst vocabulary may keep them. An unreadable map stops the plan. */
function readMapIfAny(cwd: string): ReturnType<typeof readMap> | undefined {
  const path = join(cwd, BLIND_DIR, MAP_FILE);
  try {
    return readMap(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (e instanceof MapError) throw new Refusal(`${path}: ${e.message}`);
    throw new Refusal(`${path}: cannot read the map`);
  }
}

const dropLabel = (d: Dropped): string => {
  switch (d.kind) {
    case "column":
      return `column ${where(d.location)}`;
    case "question":
      return `question ${d.id}`;
    case "entity":
      return `${d.class} entity ${q(d.canonical)}`;
    case "pattern":
      return `pattern ${d.name}`;
    case "vocabulary":
      return `analyst vocabulary ${q(d.canonical)}`;
  }
};

/** What a re-plan changed in the saved spec. */
export function renderDiff(diff: PlanDiff): string {
  const out: string[] = ["changes to the saved spec:"];
  const { columns, entities, questions } = diff.added;
  if (columns.length + entities.length + questions.length + diff.classified.length + diff.dropped.length === 0) out.push("  none");
  for (const c of columns) out.push(`  added column ${where(c)}  ${c.class} ${c.treatment} ${c.source}`);
  for (const e of entities) out.push(`  added ${e.class} entity ${q(e.canonical)}`);
  for (const id of questions) out.push(`  added question ${id}`);
  for (const c of diff.classified) out.push(`  classified ${where(c.location)}  ${c.from} -> ${c.to}`);
  const saved = diff.dropped.filter((d) => d.kind !== "vocabulary");
  const shielding = diff.dropped.filter((d) => d.kind === "vocabulary");
  if (saved.length > 0) out.push(`  dropped (${saved.length}), because the analyst may not change a saved entry:`);
  for (const d of saved) out.push(`    ${dropLabel(d)}: ${d.reason}`);
  if (shielding.length > 0) out.push(`  dropped (${shielding.length}), because the analyst's vocabulary may not keep a blinded value in clear:`);
  for (const d of shielding) out.push(`    ${dropLabel(d)}: ${d.reason}`);
  return `${out.join("\n")}\n`;
}

/** Guards our own output: a spec that fails validation is a bug and is never saved. */
function checked(spec: Spec): Spec {
  const result = validateSpec(spec);
  if (!result.ok) throw new Refusal(`internal error, the spec failed validation:\n${result.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  return spec;
}

function answer(raw: string[], io: PlanIO): number {
  const policy = loadPolicy(io.cwd);
  let spec = readSaved(io.cwd);
  if (spec === undefined) throw new Refusal(`${join(io.cwd, BLIND_DIR, SPEC_FILE)} not found; run \`blind plan <inputs>\` first`);
  for (const a of raw) {
    const eq = a.indexOf("=");
    if (eq <= 0 || eq === a.length - 1) throw new Refusal(`--answer takes <id>=<option>, got ${q(a)}`);
    spec = answerQuestion(spec, a.slice(0, eq), a.slice(eq + 1), policy);
  }
  const written = writeSpec(io.cwd, checked(spec));
  io.out.write(renderSpec(spec));
  io.out.write(`\nwrote ${written} (mode 0600). Nothing is changed until you run \`blind apply\`.\n`);
  return 0;
}

export async function runPlan(argv: string[], io: PlanIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        answer: { type: "string", multiple: true },
        "no-model": { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        "from-audit": { type: "string" },
        out: { type: "string", short: "o" },
        accept: { type: "string", multiple: true },
        reject: { type: "string", multiple: true },
        "accept-leaks": { type: "boolean", default: false },
        map: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind plan: ${(e as Error).message}\n\n${PLAN_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(PLAN_HELP);
    return 0;
  }
  const answers = values.answer ?? [];
  const fromAuditOnly =
    values.out !== undefined || values.accept !== undefined || values.reject !== undefined || values["accept-leaks"] || values.map !== undefined;
  if (values["from-audit"] !== undefined) {
    if (answers.length > 0 || positionals.length > 0 || values["no-model"] || values.force) {
      io.err.write("blind plan: --from-audit changes the saved spec only; give it no inputs, --answer, --no-model or --force\n");
      return 2;
    }
    if (values.out === undefined) {
      io.err.write("blind plan: --from-audit needs -o <out>, the blinded output tree the report audited\n");
      return 2;
    }
    try {
      return await fromAudit(values["from-audit"], values.out, { ...values, acceptLeaks: values["accept-leaks"] }, io);
    } catch (e) {
      if (e instanceof Refusal || e instanceof FromAuditError || e instanceof SchemaError || e instanceof MapError || e instanceof AnalystError) {
        io.err.write(`blind plan: ${e.message}\nno spec was written\n`);
        return 2;
      }
      throw e;
    }
  }
  if (fromAuditOnly) {
    io.err.write("blind plan: -o, --accept, --reject, --accept-leaks and --map go with --from-audit\n");
    return 2;
  }
  if (answers.length > 0 && (positionals.length > 0 || values["no-model"] || values.force || values.json)) {
    io.err.write("blind plan: --answer changes the saved spec only; give it no inputs, --no-model, --force or --json\n");
    return 2;
  }
  if (answers.length === 0 && positionals.length === 0) {
    io.err.write(`blind plan: name at least one input file or directory\n\n${PLAN_HELP}`);
    return 2;
  }

  try {
    if (answers.length > 0) return answer(answers, io);

    const policy = loadPolicy(io.cwd);
    // Read (and validate) before profiling or any model call: an invalid saved spec stops here.
    const saved = values.force ? undefined : readSaved(io.cwd);

    const { profile, skipped, notes } = forPrivacyMode(buildProfile(positionals, policy.profile.samples, io.cwd), policy.privacy.mode);
    const check = validateProfile(profile);
    if (!check.ok) throw new Refusal(`internal error, the profile failed validation:\n${check.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
    writeProfile(io.cwd, profile);

    let spec: Spec;
    let diff: PlanDiff;
    const remarks: string[] = [];
    const useModel = !values["no-model"] && modelsEnabled(policy);
    if (!values["no-model"] && !useModel) remarks.push('privacy.mode is "none", so no model was called: heuristic analyst only');
    const modelOpts = { ...io.model, quiet: values.quiet, stderr: (line: string) => io.err.write(`blind plan: ${line}\n`) };
    let filled: Location[] = [];
    let vocabDropped: Dropped[] = [];
    if (saved === undefined) {
      if (useModel) {
        const result = await runAnalyst(profile, policy, modelOpts);
        const guarded = guardFresh(result.spec, { profile, map: readMapIfAny(io.cwd) });
        const seen = seenAfter([], profile);
        spec = seen.length > 0 ? { ...guarded.spec, seen } : guarded.spec;
        filled = result.filled;
        vocabDropped = guarded.dropped;
      } else spec = heuristicSpec(profile, policy);
      diff = freshDiff(spec, vocabDropped);
    } else {
      const part = unseenPart(profile, saved);
      let proposal: Spec | null = null;
      if (useModel && isEmptyPart(part)) remarks.push(`${join(BLIND_DIR, SPEC_FILE)} already covers every column, key and document excerpt here, so no model was called`);
      else if (useModel) proposal = await proposeSpec(part, profile, policy, modelOpts, saved.entities);
      const merged = mergeProposal(saved, proposal, part, policy, { profile, map: readMapIfAny(io.cwd) });
      spec = merged.spec;
      diff = merged.diff;
      filled = merged.filled;
    }
    for (const l of filled) remarks.push(`the analyst left out ${where(l)}; the heuristic rule was used`);

    const written = writeSpec(io.cwd, checked(spec));
    if (values.json) {
      io.out.write(`${JSON.stringify({ spec: written, ...diff, notes: [...notes, ...remarks] }, null, 2)}\n`);
    } else {
      io.out.write(renderSpec(spec));
      if (diff.reused || diff.dropped.length > 0) io.out.write(`\n${renderDiff(diff)}`);
      for (const n of [...notes, ...remarks]) io.out.write(`note: ${n}\n`);
      io.out.write(`\nwrote ${written} (mode 0600). Nothing is changed until you run \`blind apply\`.\n`);
    }
    for (const s of skipped) io.err.write(`blind plan: not profiled: ${q(s.path)}: ${s.reason}\n`);
    if (skipped.length > 0) {
      io.err.write(`blind plan: ${skipped.length} file(s) not profiled, so the spec says nothing about them\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    // ModelError covers ModelRefusal: a call the privacy mode, endpoint or key setting refused before sending.
    if (e instanceof Refusal || e instanceof PolicyError || e instanceof InputError || e instanceof SchemaError || e instanceof ModelError || e instanceof AnalystError) {
      io.err.write(`blind plan: ${e.message}\nno spec was written\n`);
      return 2;
    }
    throw e;
  }
}

// --- --from-audit ------------------------------------------------------------

const placeLabel = (p: { file: string; part: string; in: string; line: number | null }): string =>
  `${p.part === "" ? p.file : `${p.file}!${p.part}`}${p.in === "content" ? "" : ` [${p.in}]`}${p.line === null ? "" : ` line ${p.line}`}`;

function renderCandidate(c: Candidate): string[] {
  const shown = c.places.slice(0, 3).map(placeLabel).join("; ");
  const more = c.places.length > 3 ? `; and ${c.places.length - 3} more` : "";
  const traits = [
    c.severity,
    c.kinds.join(", "),
    `accept as: ${c.suggested ?? `(name one: ${ACCEPT_CLASSES.join("|")})`}`,
    ...(c.pattern === null ? [] : [`shape: ${c.pattern}`]),
    ...(c.known ? ["cannot be rejected (the spec or map already treats it as sensitive)"] : []),
  ];
  return [`  ${c.id}  ${q(c.value)}  ${traits.join("  ")}`, `      at ${shown}${more}`];
}

function renderChange(x: Change): string {
  switch (x.result) {
    case "entity":
      return `  ${x.id}  accepted ${q(x.value)}: added ${x.class} entity (source human)`;
    case "pattern":
      return `  ${x.id}  accepted ${q(x.value)}: turned pattern ${x.pattern} on`;
    case "vocabulary":
      return `  ${x.id}  rejected ${q(x.value)}: added to the vocabulary (source human)`;
    case "unchanged":
      return `  ${x.id}  ${q(x.value)}: no change, ${x.note}`;
  }
}

/** Asks about each candidate on the terminal. Returns the decisions made; skipped ones are left out. */
async function promptDecisions(collected: Collected, saved: Spec, map: ReturnType<typeof readMap>, io: PlanIO & { prompt: NonNullable<PlanIO["prompt"]> }): Promise<Decision[]> {
  const decisions: Decision[] = [];
  for (const c of collected.candidates) {
    io.out.write(`\n${renderCandidate(c).join("\n")}\n`);
    const opts = [`a = accept as ${c.suggested ?? "(name a class)"}`, `<class> = accept as ${ACCEPT_CLASSES.join("|")}`];
    if (c.pattern !== null) opts.push(`pattern = turn pattern ${c.pattern} on`);
    if (!c.known) opts.push("r = reject (vocabulary)");
    opts.push("s or empty = skip", "q = stop");
    for (;;) {
      const raw = await io.prompt(`  ${c.id}? ${opts.join(", ")}: `);
      const a = raw?.trim() ?? "q";
      if (a === "q") return decisions;
      if (a === "" || a === "s") break;
      let d: Decision;
      if (a === "a") d = { id: c.id, action: "accept", as: null };
      else if (a === "r") d = { id: c.id, action: "reject" };
      else if (a === "pattern" || ACCEPT_CLASSES.includes(a as AcceptClass)) d = { id: c.id, action: "accept", as: a as AcceptClass | "pattern" };
      else {
        io.out.write(`  not an option: ${q(a)}\n`);
        continue;
      }
      try {
        applyDecisions(saved, collected.candidates, [...decisions, d], map);
      } catch (e) {
        if (!(e instanceof FromAuditError)) throw e;
        io.out.write(`  ${e.message}\n`);
        continue;
      }
      decisions.push(d);
      break;
    }
  }
  return decisions;
}

export interface FromAuditOptions {
  accept?: string[];
  reject?: string[];
  /** --accept-leaks: accept every leak at its suggested class (leakDecisions). */
  acceptLeaks?: boolean;
  map?: string;
  json: boolean;
}

async function fromAudit(reportPath: string, out: string, values: FromAuditOptions, io: PlanIO): Promise<number> {
  const report = (): string => {
    const reportFile = resolve(io.cwd, reportPath);
    try {
      return readFileSync(reportFile, "utf8");
    } catch {
      throw new Refusal(`${reportFile}: cannot read the audit report`);
    }
  };
  return (await decideFromReport(report, reportPath, out, values, io)).code;
}

/**
 * `--from-audit` on a report already in hand (`blind run --accept-leaks` passes the audit's own):
 * the exit code plan gives, and whether the saved spec changed. Throws what fromAudit's caller
 * catches (Refusal, FromAuditError, SchemaError, MapError) when it refuses; then nothing is written.
 */
export async function decideFromReport(
  readReport: () => string,
  label: string,
  out: string,
  values: FromAuditOptions,
  io: PlanIO,
): Promise<{ code: number; changed: boolean }> {
  const saved = readSaved(io.cwd);
  if (saved === undefined) throw new Refusal(`${join(io.cwd, BLIND_DIR, SPEC_FILE)} not found; run \`blind plan <inputs>\` first`);
  const mapPath = resolve(io.cwd, values.map ?? join(BLIND_DIR, MAP_FILE));
  let map;
  try {
    map = readMap(mapPath);
  } catch (e) {
    if (e instanceof MapError) throw e;
    throw new Refusal(`${mapPath}: cannot read the map; pass --map with the map \`blind apply\` wrote`);
  }
  const findings = parseAuditReport(readReport(), label);
  const collected = collectCandidates(findings, resolve(io.cwd, out), map);

  const flagged = values.accept !== undefined || values.reject !== undefined || values.acceptLeaks === true;
  // Checked before anything is printed or asked: a bad id or a refused decision writes nothing.
  let decisions = parseDecisions(values.accept ?? [], values.reject ?? []);
  applyDecisions(saved, collected.candidates, decisions, map);
  let leaksSkipped: ReturnType<typeof leakDecisions>["skipped"] = [];
  if (values.acceptLeaks) ({ decisions, skipped: leaksSkipped } = leakDecisions(saved, collected.candidates, decisions, map));
  let applied = applyDecisions(saved, collected.candidates, decisions, map);
  const interactive = !flagged && !values.json && io.prompt !== undefined && collected.candidates.length > 0;

  if (!values.json) {
    io.out.write(collected.candidates.length === 0 ? "audit candidates: none to decide\n" : `audit candidates (${collected.candidates.length}):\n`);
    if (!interactive) for (const c of collected.candidates) io.out.write(`${renderCandidate(c).join("\n")}\n`);
    if (collected.other.length > 0) {
      io.out.write(`\nnot one value, so not turned into spec changes (${collected.other.length}); \`blind plan <inputs>\` and --answer decide columns and questions:\n`);
      for (const f of collected.other) io.out.write(`  ${placeLabel(f)}  ${f.class}  ${f.reason}\n`);
    }
  }
  if (interactive) {
    decisions = await promptDecisions(collected, saved, map, { ...io, prompt: io.prompt as NonNullable<PlanIO["prompt"]> });
    applied = applyDecisions(saved, collected.candidates, decisions, map);
  }

  const decided = new Set(decisions.map((d) => d.id));
  const undecided = collected.candidates.filter((c) => !decided.has(c.id)).map((c) => c.id);
  const changed = applied.spec !== saved;
  const written = changed ? writeSpec(io.cwd, checked(applied.spec)) : null;

  if (values.json) {
    const unmapped = collected.unmapped.map(({ finding: f, why }) => ({ file: f.file, part: f.part, in: f.in, offset: f.offset, class: f.class, masked: f.masked, why }));
    const other = collected.other.map((f: ReportFinding) => ({ file: f.file, part: f.part, in: f.in, class: f.class, reason: f.reason }));
    io.out.write(`${JSON.stringify({ spec: written, candidates: collected.candidates, changes: applied.changes, undecided, leaksSkipped, other, unmapped }, null, 2)}\n`);
  } else {
    if (applied.changes.length > 0) io.out.write(`\nchanges to the saved spec:\n${applied.changes.map(renderChange).join("\n")}\n`);
    if (leaksSkipped.length > 0) io.out.write(`\nleaks --accept-leaks could not accept (${leaksSkipped.length}):\n${leaksSkipped.map((x) => `  ${x.id}  ${q(x.value)}: ${x.why}`).join("\n")}\n`);
    if (undecided.length > 0) {
      io.out.write(`\nundecided (${undecided.length}): ${undecided.join(", ")}. Nothing was added for them; the audit will raise them again.\n`);
      if (!flagged && !interactive) io.out.write("decide with: blind plan --from-audit <report> -o <out> --accept <ids> --reject <ids>\n");
    }
    io.out.write(
      written === null
        ? "\nthe spec was not changed.\n"
        : `\nwrote ${written} (mode 0600). Run \`blind apply\` and \`blind audit\` again to see the effect.\n`,
    );
  }
  for (const { finding: f, why } of collected.unmapped) io.err.write(`blind plan: not read back: ${placeLabel(f)}  ${f.class} ${f.masked}: ${why}\n`);
  if (collected.unmapped.length > 0) {
    io.err.write(`blind plan: ${collected.unmapped.length} finding(s) could not be read back from ${out}, so they are not candidates here\n`);
    return { code: 1, changed };
  }
  return { code: 0, changed };
}

export function processPlanIO(): PlanIO {
  const io: PlanIO = { out: terminalStream(process.stdout), err: terminalStream(process.stderr), cwd: process.cwd() };
  if (process.stdin.isTTY) {
    io.prompt = async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(terminalText(question));
      } catch {
        return null;
      } finally {
        rl.close();
      }
    };
  }
  return io;
}
