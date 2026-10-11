// Column decisions shared by every table-shaped format (CSV/TSV, JSON key paths,
// worksheets): what a spec rule, or its absence, does to a column's cells.

import type { ColumnRule, EntityClassName } from "../schema.ts";
import type { PseudoClass } from "./canonical.ts";
import { type ColumnStats, columnStats, isIdentifierLike, THRESHOLDS } from "./stats.ts";

export type ColumnOutcome =
  | "blinded"
  | "value"
  | "kept"
  | "unknown-pseudonymised"
  | "unknown-kept-low-cardinality"
  | "unknown-kept-not-identifier-like"
  | "unknown-kept-empty";

const SENSITIVE: ReadonlySet<EntityClassName> = new Set(["person", "org", "host", "email", "id", "location"]);

export type ColumnAction = { kind: "keep" } | { kind: "pseudo"; cls: PseudoClass } | { kind: "free" };

function ruleAction(rule: ColumnRule): ColumnAction | "heuristic" {
  if (rule.treatment === "keep") return { kind: "keep" };
  if (rule.treatment === "blind" && SENSITIVE.has(rule.class)) return { kind: "pseudo", cls: rule.class as PseudoClass };
  if (rule.treatment === "value" && rule.class === "unknown") return "heuristic";
  return { kind: "pseudo", cls: "value" };
}

/** What a column gets: its rule's action, or for no rule (or unknown/value) the fail-closed identifier-like test. */
export function decide(rule: ColumnRule | undefined, values: readonly string[]): { action: ColumnAction; stats: ColumnStats | undefined } {
  const planned = rule === undefined ? "heuristic" : ruleAction(rule);
  if (planned !== "heuristic") return { action: planned, stats: undefined };
  const stats = columnStats(values);
  return { action: isIdentifierLike(stats) ? { kind: "pseudo", cls: "value" } : { kind: "free" }, stats };
}

export function outcomeOf(action: ColumnAction, stats: ColumnStats | undefined): ColumnOutcome {
  if (stats !== undefined) {
    if (action.kind === "pseudo") return "unknown-pseudonymised";
    if (stats.count === 0) return "unknown-kept-empty";
    return stats.distinctRatio < THRESHOLDS.distinct ? "unknown-kept-low-cardinality" : "unknown-kept-not-identifier-like";
  }
  if (action.kind === "keep") return "kept";
  return action.kind === "pseudo" && action.cls !== "value" ? "blinded" : "value";
}
