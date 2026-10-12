// Column decisions shared by every table-shaped format (CSV/TSV, JSON key paths,
// worksheets): what a spec rule, or its absence, does to a column's cells.

import type { ColumnRule, EntityClassName } from "../schema.ts";
import type { PseudoClass } from "./canonical.ts";
import { isPersonColumn } from "./prose.ts";
import { type ColumnStats, columnStats, isIdentifierLike, THRESHOLDS } from "./stats.ts";

export type ColumnOutcome =
  | "blinded"
  | "value"
  | "kept"
  | "dropped"
  | "redacted"
  | "unknown-pseudonymised"
  | "unknown-person"
  | "unknown-kept-low-cardinality"
  | "unknown-kept-not-identifier-like"
  | "unknown-kept-empty";

const SENSITIVE: ReadonlySet<EntityClassName> = new Set(["person", "org", "host", "email", "id", "location"]);

/** `drop` removes the column (or key); `redact` writes REDACTED_VALUE in each non-empty cell. */
export type ColumnAction = { kind: "keep" } | { kind: "pseudo"; cls: PseudoClass } | { kind: "free" } | { kind: "drop" } | { kind: "redact" };

function ruleAction(rule: ColumnRule): ColumnAction | "heuristic" {
  if (rule.treatment === "keep") return { kind: "keep" };
  if (rule.treatment === "drop") return { kind: "drop" };
  if (rule.treatment === "redact") return { kind: "redact" };
  if (rule.treatment === "blind" && SENSITIVE.has(rule.class)) return { kind: "pseudo", cls: rule.class as PseudoClass };
  if (rule.treatment === "value" && rule.class === "unknown") return "heuristic";
  return { kind: "pseudo", cls: "value" };
}

/**
 * What a column gets: its rule's action, or for no rule (or unknown/value) the fail-closed
 * identifier-like test. An identifier-like column of people's names (prose.ts isPersonColumn) is
 * pseudonymised as `person`, not `value`, so their name parts recur in free text (AGT-1830).
 */
export function decide(rule: ColumnRule | undefined, values: readonly string[]): { action: ColumnAction; stats: ColumnStats | undefined } {
  const planned = rule === undefined ? "heuristic" : ruleAction(rule);
  if (planned !== "heuristic") return { action: planned, stats: undefined };
  const stats = columnStats(values);
  if (!isIdentifierLike(stats)) return { action: { kind: "free" }, stats };
  return { action: { kind: "pseudo", cls: isPersonColumn(values) ? "person" : "value" }, stats };
}

export function outcomeOf(action: ColumnAction, stats: ColumnStats | undefined): ColumnOutcome {
  if (stats !== undefined) {
    if (action.kind === "pseudo") return action.cls === "person" ? "unknown-person" : "unknown-pseudonymised";
    if (stats.count === 0) return "unknown-kept-empty";
    return stats.distinctRatio < THRESHOLDS.distinct ? "unknown-kept-low-cardinality" : "unknown-kept-not-identifier-like";
  }
  if (action.kind === "keep") return "kept";
  if (action.kind === "drop") return "dropped";
  if (action.kind === "redact") return "redacted";
  return action.kind === "pseudo" && action.cls !== "value" ? "blinded" : "value";
}
