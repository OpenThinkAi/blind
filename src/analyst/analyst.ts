// The model analyst: profile and policy in, a spec proposal out. The reply has already
// passed schema/spec.schema.json inside ask(); here it must also be a spec that only talks
// about the profile's own columns, written by the analyst, with every question unanswered.
// Anything else is rejected whole, never repaired, except a column rule with a treatment only
// blind.toml or a human may set (drop, redact, scan), or that keeps an identifying column in clear
// (keep/vocabulary), is dropped and reported; so is a pattern it turns off (restored). Columns the analyst left out get the
// heuristic rule, and a column with an open question stays `unknown` until it is answered.

import { fold } from "../audit/views.ts";
import { isPersonColumn } from "../engine/prose.ts";
import { type AskOptions, ask } from "../model.ts";
import type { Policy } from "../policy.ts";
import { restoreSpec, tokeniseProfile } from "../profile/tokens.ts";
import { type ColumnRule, type Entities, type EntityClassName, type Location, type PatternName, patternOn, type Profile, type Question, type Spec, type ValueStats } from "../schema.ts";
import { type SchemaIssue, validateSpec } from "../validate.ts";
import specSchema from "../../schema/spec.schema.json" with { type: "json" };
import { heuristicPatterns, heuristicRule, profileLocations } from "./heuristic.ts";
import { analystPrompt, systemPrompt } from "./prompt.ts";

export class AnalystError extends Error {
  override name = "AnalystError";
}

/** Options a question about a column may offer: a treatment, or a class to give the column. */
export const COLUMN_ANSWERS: readonly string[] = ["blind", "keep", "value", "person", "org", "host", "email", "id", "location", "vocabulary", "secret"];

/**
 * What the analyst may reply: the spec schema without `seen`, which only blind writes (it
 * records what the analyst has read, so a reply that set it could hide excerpts from later runs),
 * and without an entity's `source`, which only `blind plan --from-audit` writes (a reply could
 * otherwise pass its entities off as human decisions).
 */
const { seen: _seen, ...proposalProperties } = specSchema.properties;
const { source: _source, ...entityProperties } = specSchema.$defs.entity.properties;
export const proposalSchema = {
  ...specSchema,
  properties: proposalProperties,
  $defs: { ...specSchema.$defs, entity: { ...specSchema.$defs.entity, properties: entityProperties } },
};

export const locationKey = (l: Location): string => JSON.stringify([l.file, l.sheet ?? null, l.header ?? null, l.jsonPath ?? null]);

const where = (l: Location): string => `${l.file} ${JSON.stringify(l.header ?? l.jsonPath ?? "")}`;

/** Treatments the analyst may not set. A rule with one is dropped from its reply (dropForbidden). */
export const FORBIDDEN_TREATMENTS: readonly string[] = ["drop", "redact", "scan"];

/** A column rule dropped from the analyst's reply, with the treatment it asked for. */
export interface DroppedRule {
  at: Location;
  treatment: string;
  /** `forbidden`: a treatment only blind.toml or a human may set. `identifying`: keep/vocabulary on a column the profile shows to be identifying. */
  why: "forbidden" | "identifying";
}

const locationOf = (c: Location): Location => {
  const at = { file: c.file, sheet: c.sheet, header: c.header, jsonPath: c.jsonPath };
  return Object.fromEntries(Object.entries(at).filter(([, v]) => v !== undefined)) as unknown as Location;
};

/**
 * Removes the column rules whose treatment the analyst may not set, so those columns fall back as
 * if it had not ruled them (heuristic, then the blind.toml `[[columns]]` overlay, which may set them).
 * The model is shown the policy and tends to echo its drop/redact/scan rules; that is not a reason
 * to throw out the rest of its spec. Every other problem still rejects the whole reply.
 */
export function dropForbidden(spec: Spec): { spec: Spec; dropped: DroppedRule[] } {
  const dropped: DroppedRule[] = [];
  const columns = spec.columns.filter((c) => {
    if (!FORBIDDEN_TREATMENTS.includes(c.treatment)) return true;
    dropped.push({ at: locationOf(c), treatment: c.treatment, why: "forbidden" });
    return false;
  });
  return { spec: dropped.length === 0 ? spec : { ...spec, columns }, dropped };
}

/**
 * Whether the profile shows a column to hold identifying values: a shape the heuristic analyst
 * classifies (email, host, id, address, phone, ...), a column of people's names (read from the
 * samples), or, with no samples to read (profile-only), words that are not dictionary words and
 * mostly distinct. A measure or a small category is not identifying.
 */
export function isIdentifying(loc: Location, stats: ValueStats): boolean {
  if (heuristicRule(loc, stats, { sensitive: { classes: [], description: "", examples: [] } }).class !== "unknown") return true;
  if (stats.count === 0) return false;
  if (stats.samples.length > 0) return isPersonColumn(stats.samples);
  return stats.distinctRatio >= 0.5 && stats.dictionaryRatio <= 0.3 && stats.digitRatio < 0.3;
}

/**
 * Removes the analyst's keep (or vocabulary) rules for columns that `sent` shows to be identifying,
 * so they fall back as if it had not ruled them (heuristic, then the blind.toml `[[columns]]` overlay;
 * a human can still keep them in blind.toml or by editing the spec). A model reading a document
 * that says "this column is harmless" must not be able to publish it in clear. Rules for locations
 * `sent` does not describe are left alone.
 */
export function dropRelaxed(spec: Spec, sent: Profile): { spec: Spec; dropped: DroppedRule[] } {
  const stats = new Map(profileLocations(sent).map(({ loc, stats: s }) => [locationKey(loc), { loc, s }]));
  const dropped: DroppedRule[] = [];
  const columns = spec.columns.filter((c) => {
    if (c.treatment !== "keep" && c.class !== "vocabulary") return true;
    const at = stats.get(locationKey(c));
    if (at === undefined || !isIdentifying(at.loc, at.s)) return true;
    dropped.push({ at: locationOf(c), treatment: c.treatment === "keep" ? "keep" : c.class, why: "identifying" });
    return false;
  });
  return { spec: dropped.length === 0 ? spec : { ...spec, columns }, dropped };
}

/**
 * Turns back on every pattern the analyst set to false or left out where absent means off although the policy would have it on (the
 * pattern's class is sensitive), unless blind.toml `[patterns]` pins it: only blind.toml or a
 * human may switch a pattern off. Returns the names restored (an optional pattern the analyst omitted counts as off).
 */
export function keepPatterns(spec: Spec, policy: Pick<Policy, "sensitive"> & Partial<Pick<Policy, "patterns">>): { spec: Spec; restored: PatternName[] } {
  const baseline = heuristicPatterns(policy);
  const restored = (Object.keys(baseline) as PatternName[]).filter((name) => policy.patterns?.[name] === undefined && baseline[name] === true && !patternOn(spec.patterns, name));
  if (restored.length === 0) return { spec, restored };
  return { spec: { ...spec, patterns: { ...spec.patterns, ...Object.fromEntries(restored.map((n) => [n, true])) } }, restored };
}

/**
 * Removes `[keep] terms` from the analyst's sensitive entities: an entity whose canonical form is a
 * keep term is dropped, and an alias or part that is one is taken out (compared with the audit's
 * fold, as the auditor's withoutExplained compares its candidates). Vocabulary entities are left
 * alone (they keep a term already). Under profile-only the analyst is never sent the keep list (keepSent in model.ts,
 * AGT-1996), so this is where "do not list keep terms" is applied; elsewhere it backs up the instruction.
 */
export function dropKeptEntities(spec: Spec, keep: readonly string[]): Spec {
  const kept = new Set(keep.map(fold).filter((t) => t !== ""));
  if (kept.size === 0) return spec;
  const entities: Entities = {};
  for (const [cls, list] of Object.entries(spec.entities) as [keyof Entities, Entities[keyof Entities]][]) {
    if (list === undefined) continue;
    entities[cls] =
      cls === "vocabulary"
        ? list
        : list
            .filter((e) => !kept.has(fold(e.canonical)))
            .map((e) => ({ ...e, aliases: e.aliases.filter((a) => !kept.has(fold(a))), parts: e.parts.filter((p) => !kept.has(fold(p))) }));
  }
  return { ...spec, entities };
}

/** The rules a model reply must meet beyond the schema. Returns every problem found. */
export function checkProposal(spec: Spec, profile: Profile): SchemaIssue[] {
  const result = validateSpec(spec);
  const issues = result.ok ? [] : [...result.issues];
  const known = new Set(profileLocations(profile).map(({ loc }) => locationKey(loc)));
  spec.columns.forEach((c, i) => {
    if (!known.has(locationKey(c))) issues.push({ path: `$.columns[${i}]`, message: `${where(c)} is not a column or key in the profile` });
    if (c.source !== "analyst") issues.push({ path: `$.columns[${i}].source`, message: `must be "analyst", got ${JSON.stringify(c.source)}` });
    // Removing or overwriting data outright, or leaving a column to the scanner instead of
    // pseudonymising it, is the policy's or the human's call, never the analyst's.
    if (c.treatment === "drop" || c.treatment === "redact" || c.treatment === "scan") {
      issues.push({ path: `$.columns[${i}].treatment`, message: `must be "blind", "keep" or "value"; only blind.toml or a human may drop, redact or scan a column` });
    }
    // Class `secret` under `blind` redacts the column (columns.ts), which is the same call.
    if (c.class === "secret" && c.treatment === "blind") {
      issues.push({ path: `$.columns[${i}].class`, message: `a "secret" column under "blind" is redacted; only blind.toml or a human may redact a column (ask a question instead)` });
    }
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
export function completeProposal(spec: Spec, profile: Profile, policy: Pick<Policy, "sensitive"> & Partial<Pick<Policy, "patterns">>): { spec: Spec; filled: Location[] } {
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
export async function proposeSpec(
  sent: Profile,
  known: Profile,
  policy: Policy,
  opts: Omit<AskOptions, "policy">,
): Promise<{ spec: Spec; dropped: DroppedRule[] }> {
  // Under profile-only the analyst sees every path, sheet name, header and key as a token and no
  // values; its column rules are mapped back to the real locations here, before any check.
  const tokens = policy.privacy.mode === "profile-only" ? tokeniseProfile(sent) : undefined;
  const reply = await ask<Spec>("analyst", systemPrompt(policy), analystPrompt(tokens?.profile ?? sent, policy), proposalSchema, { ...opts, policy });
  // Forbidden treatments are dropped before the locations are restored, so a note names the
  // header as the analyst saw it (a token under profile-only), never a value.
  const forbidden = dropForbidden(reply);
  const relaxed = dropRelaxed(forbidden.spec, tokens?.profile ?? sent);
  const dropped = [...forbidden.dropped, ...relaxed.dropped];
  const trimmed = relaxed.spec;
  let proposal = trimmed;
  if (tokens !== undefined) {
    const restored = restoreSpec(trimmed, tokens);
    if (restored.issues.length > 0) {
      throw new AnalystError(`the analyst's spec was rejected:\n${restored.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
    }
    proposal = restored.spec;
  }
  // Keep terms are applied here, on the mapped-back reply, not by trusting the model with them.
  proposal = dropKeptEntities(proposal, policy.keep.terms);
  const issues = checkProposal(proposal, known);
  if (issues.length > 0) {
    throw new AnalystError(`the analyst's spec was rejected:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")}`);
  }
  return { spec: proposal, dropped };
}

/** Asks the configured analyst for a spec of the whole profile, completed with heuristic rules. */
export async function runAnalyst(
  profile: Profile,
  policy: Policy,
  opts: Omit<AskOptions, "policy">,
): Promise<{ spec: Spec; filled: Location[]; dropped: DroppedRule[]; patternsRestored: PatternName[] }> {
  const proposed = await proposeSpec(profile, profile, policy, opts);
  // A fresh plan takes the analyst's patterns whole, so it may not have switched one off. (A re-plan
  // keeps the saved spec's patterns, mergeProposal.)
  const kept = keepPatterns(proposed.spec, policy);
  return { ...completeProposal(kept.spec, profile, policy), dropped: proposed.dropped, patternsRestored: kept.restored };
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
