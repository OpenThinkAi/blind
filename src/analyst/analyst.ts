// The model analyst: profile and policy in, a spec proposal out. The reply has already
// passed schema/spec.schema.json inside ask(); here it must also be a spec that only talks
// about the profile's own columns, written by the analyst, with every question unanswered.
// Anything else is rejected whole, never repaired. Columns the analyst left out get the
// heuristic rule, and a column with an open question stays `unknown` until it is answered.

import { type AskOptions, ask } from "../model.ts";
import type { Policy } from "../policy.ts";
import type { ColumnRule, EntityClassName, Location, Profile, Question, Spec } from "../schema.ts";
import { type SchemaIssue, validateSpec } from "../validate.ts";
import specSchema from "../../schema/spec.schema.json" with { type: "json" };
import { heuristicRule, profileLocations } from "./heuristic.ts";
import { analystPrompt, systemPrompt } from "./prompt.ts";

export class AnalystError extends Error {
  override name = "AnalystError";
}

/** Options a question about a column may offer: a treatment, or a class to give the column. */
export const COLUMN_ANSWERS: readonly string[] = ["blind", "keep", "value", "person", "org", "host", "email", "id", "location", "vocabulary"];

/**
 * What the analyst may reply: the spec schema without `seen`, which only blind writes (it
 * records what the analyst has read, so a reply that set it could hide excerpts from later runs).
 */
const { seen: _seen, ...proposalProperties } = specSchema.properties;
const proposalSchema = { ...specSchema, properties: proposalProperties };

export const locationKey = (l: Location): string => JSON.stringify([l.file, l.sheet ?? null, l.header ?? null, l.jsonPath ?? null]);

const where = (l: Location): string => `${l.file} ${JSON.stringify(l.header ?? l.jsonPath ?? "")}`;

/** The rules a model reply must meet beyond the schema. Returns every problem found. */
export function checkProposal(spec: Spec, profile: Profile): SchemaIssue[] {
  const result = validateSpec(spec);
  const issues = result.ok ? [] : [...result.issues];
  const known = new Set(profileLocations(profile).map(({ loc }) => locationKey(loc)));
  spec.columns.forEach((c, i) => {
    if (!known.has(locationKey(c))) issues.push({ path: `$.columns[${i}]`, message: `${where(c)} is not a column or key in the profile` });
    if (c.source !== "analyst") issues.push({ path: `$.columns[${i}].source`, message: `must be "analyst", got ${JSON.stringify(c.source)}` });
  });
  const asked = new Map<string, number>();
  spec.questions.forEach((q, i) => {
    if (q.id.includes("=")) issues.push({ path: `$.questions[${i}].id`, message: `must not contain "="` });
    if (q.answer !== null) issues.push({ path: `$.questions[${i}].answer`, message: "must be null: only the human answers" });
    if (q.about === undefined) return;
    // One question per column: answering one would decide the column while the other stayed open.
    const first = asked.get(locationKey(q.about));
    if (first !== undefined) issues.push({ path: `$.questions[${i}].about`, message: `same column as $.questions[${first}].about; ask once per column` });
    else asked.set(locationKey(q.about), i);
    if (!known.has(locationKey(q.about))) {
      issues.push({ path: `$.questions[${i}].about`, message: `${where(q.about)} is not a column or key in the profile` });
    }
    const bad = q.options.filter((o) => !COLUMN_ANSWERS.includes(o));
    if (bad.length > 0) {
      issues.push({ path: `$.questions[${i}].options`, message: `a question about a column may offer only ${COLUMN_ANSWERS.join(", ")}` });
    }
  });
  return issues;
}

/**
 * Completes a checked proposal: every profile column the analyst skipped gets the heuristic
 * rule (reported in `filled`), and every column an open question is about is set to
 * `unknown`/`value`, so nothing the analyst asked about is decided until the human answers.
 */
export function completeProposal(spec: Spec, profile: Profile, policy: Pick<Policy, "sensitive">): { spec: Spec; filled: Location[] } {
  const byKey = new Map(spec.columns.map((c) => [locationKey(c), c]));
  const open = new Set(spec.questions.filter((q) => q.about !== undefined && q.answer === null).map((q) => locationKey(q.about as Location)));
  const filled: Location[] = [];
  const columns = profileLocations(profile).map(({ loc, stats }): ColumnRule => {
    const key = locationKey(loc);
    let rule = byKey.get(key);
    if (rule === undefined) {
      filled.push(loc);
      rule = heuristicRule(loc, stats, policy);
    }
    return open.has(key) ? { ...rule, class: "unknown", treatment: "value", confidence: 0 } : rule;
  });
  return { spec: { ...spec, columns }, filled };
}

/**
 * Sends the analyst `sent` (the whole profile, or on a re-plan only what the saved spec lacks)
 * and returns its checked proposal. Column names are checked against `known`, the whole profile,
 * so a reply about a saved column reaches the merge and is reported there, not lost.
 * Throws ModelError (transport, privacy) or AnalystError (bad proposal).
 */
export async function proposeSpec(sent: Profile, known: Profile, policy: Policy, opts: Omit<AskOptions, "policy">): Promise<Spec> {
  const proposal = await ask<Spec>("analyst", systemPrompt(policy), analystPrompt(sent, policy), proposalSchema, { ...opts, policy });
  const issues = checkProposal(proposal, known);
  if (issues.length > 0) {
    throw new AnalystError(`the analyst's spec was rejected:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  }
  return proposal;
}

/** Asks the configured analyst for a spec of the whole profile, completed with heuristic rules. */
export async function runAnalyst(
  profile: Profile,
  policy: Policy,
  opts: Omit<AskOptions, "policy">,
): Promise<{ spec: Spec; filled: Location[] }> {
  return completeProposal(await proposeSpec(profile, profile, policy, opts), profile, policy);
}

/**
 * Records `option` as the answer to question `id` and, for a question about a column, applies
 * it to that column's rule as a human decision. Throws AnalystError naming what is wrong.
 */
export function answerQuestion(spec: Spec, id: string, option: string, policy: Pick<Policy, "sensitive">): Spec {
  const question = spec.questions.find((q) => q.id === id);
  if (question === undefined) {
    const ids = spec.questions.map((q) => q.id);
    throw new AnalystError(`no question ${JSON.stringify(id)} in the spec${ids.length > 0 ? ` (questions: ${ids.join(", ")})` : ""}`);
  }
  if (!question.options.includes(option)) {
    throw new AnalystError(`question ${id} takes one of ${question.options.join(", ")}, not ${JSON.stringify(option)}`);
  }
  const questions: Question[] = spec.questions.map((q) => (q === question ? { ...q, answer: option } : q));
  if (question.about === undefined) return { ...spec, questions };

  const key = locationKey(question.about);
  const other = spec.questions.find((q) => q !== question && q.about !== undefined && locationKey(q.about) === key);
  if (other !== undefined) {
    throw new AnalystError(
      `questions ${id} and ${other.id} are both about ${where(question.about)}, so answering one would decide the column while the other stays; delete one of them from the spec, then answer the other`,
    );
  }
  const index = spec.columns.findIndex((c) => locationKey(c) === key);
  const rule = spec.columns[index];
  if (rule === undefined) throw new AnalystError(`question ${id} is about ${where(question.about)}, which has no column rule in the spec`);
  if (!COLUMN_ANSWERS.includes(option)) {
    throw new AnalystError(`question ${id} is about a column, so its answer must be one of ${COLUMN_ANSWERS.join(", ")}`);
  }
  const columns = [...spec.columns];
  columns[index] = { ...rule, ...decide(rule, option, policy), confidence: 1, source: "human" };
  return { ...spec, columns, questions };
}

function decide(rule: ColumnRule, option: string, policy: Pick<Policy, "sensitive">): Pick<ColumnRule, "class" | "treatment"> {
  const undecided = rule.class === "unknown";
  switch (option) {
    case "keep":
      return { class: undecided ? "vocabulary" : rule.class, treatment: "keep" };
    case "blind":
      return { class: rule.class, treatment: "blind" };
    case "value":
      // `unknown` with `value` would hand the column back to the apply-time heuristic; the
      // human asked for it hidden, and `unknown` with `blind` always gives Value_ pseudonyms.
      return { class: rule.class, treatment: undecided ? "blind" : "value" };
    default: {
      const sensitive = policy.sensitive.classes.some((c) => c === option);
      return { class: option as EntityClassName, treatment: sensitive ? "blind" : "keep" };
    }
  }
}
