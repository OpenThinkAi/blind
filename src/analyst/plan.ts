// `blind plan <inputs>`: profile the corpus, ask the analyst for a spec, save it as
// .blind/spec.json (mode 0600) and print it for review, questions first. With a saved spec,
// only what it does not cover goes to the analyst, and the reply is merged in (merge.ts).
// `blind plan --answer q1=blind` answers a question in the saved spec and prints it again.
// Nothing here changes a document: `blind apply` does that, and only from a saved spec.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SPEC_FILE } from "../apply.ts";
import { BLIND_DIR } from "../init.ts";
import { type AskOptions, ModelError, modelsEnabled } from "../model.ts";
import { loadPolicy, PolicyError } from "../policy.ts";
import { writeProfile } from "../profile/command.ts";
import { buildProfile, forPrivacyMode, InputError } from "../profile/profile.ts";
import type { ColumnRule, EntityClassName, Location, Spec } from "../schema.ts";
import { parseSpec, SchemaError, validateProfile, validateSpec } from "../validate.ts";
import { AnalystError, answerQuestion, proposeSpec, runAnalyst } from "./analyst.ts";
import { heuristicSpec } from "./heuristic.ts";
import { type Dropped, freshDiff, isEmptyPart, mergeProposal, type PlanDiff, seenAfter, unseenPart } from "./merge.ts";

export interface PlanIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where blind.toml and .blind/ live. */
  cwd: string;
  /** Test seams, passed through to the model call. */
  model?: Pick<AskOptions, "fetch" | "spawn" | "env" | "timeoutMs">;
}

const PLAN_HELP = [
  "Usage: blind plan <inputs...> [--no-model] [--quiet] [--force] [--json]",
  "       blind plan --answer <id>=<option> [--answer ...]",
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
  "Options:",
  "  --answer <id>=<option>  Answer a question in the saved spec and print it again (repeatable)",
  "  --no-model              Heuristic analyst only: classify a column only when an email, ip, host,",
  "                          guid or numeric-id detector matches 80% of its values; the rest stay",
  "                          unknown. Also used when privacy.mode is \"none\".",
  "  --quiet                 Do not print the per-call model line (role, backend, model, mode, bytes)",
  "  --force                 Ignore the saved .blind/spec.json and plan from scratch (its edits and",
  "                          answers are lost)",
  "  --json                  Print what changed (added, classified, dropped) as JSON instead of the spec",
  "  -h, --help              Show this help",
  "",
  "Exit status: 0 spec saved; 1 spec saved but some inputs were not profiled (listed); 2 refused or failed.",
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
  if (diff.dropped.length > 0) out.push(`  dropped (${diff.dropped.length}), because the analyst may not change a saved entry:`);
  for (const d of diff.dropped) out.push(`    ${dropLabel(d)}: ${d.reason}`);
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
    if (saved === undefined) {
      if (useModel) {
        const result = await runAnalyst(profile, policy, modelOpts);
        const seen = seenAfter([], profile);
        spec = seen.length > 0 ? { ...result.spec, seen } : result.spec;
        filled = result.filled;
      } else spec = heuristicSpec(profile, policy);
      diff = freshDiff(spec);
    } else {
      const part = unseenPart(profile, saved);
      let proposal: Spec | null = null;
      if (useModel && isEmptyPart(part)) remarks.push(`${join(BLIND_DIR, SPEC_FILE)} already covers every column, key and document excerpt here, so no model was called`);
      else if (useModel) proposal = await proposeSpec(part, profile, policy, modelOpts);
      const merged = mergeProposal(saved, proposal, part, policy);
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
      if (diff.reused) io.out.write(`\n${renderDiff(diff)}`);
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

export function processPlanIO(): PlanIO {
  return { out: process.stdout, err: process.stderr, cwd: process.cwd() };
}
