// Column decisions shared by every table-shaped format (CSV/TSV, JSON key paths,
// worksheets): what a spec rule, or its absence, does to a column's cells.

import type { ColumnRule, EntityClassName } from "../schema.ts";
import type { PseudoClass } from "./canonical.ts";
import { isPersonColumn } from "./prose.ts";
import type { ExtraForm } from "./text.ts";
import { type ColumnContext, type ColumnStats, columnStats, isIdentifierLike, THRESHOLDS } from "./stats.ts";

export type ColumnOutcome =
  | "blinded"
  | "value"
  | "kept"
  | "dropped"
  | "redacted"
  | "scanned"
  | "unknown-scanned"
  | "unknown-pseudonymised"
  | "unknown-person"
  | "unknown-kept-low-cardinality"
  | "unknown-kept-not-identifier-like"
  | "unknown-kept-empty";

const SENSITIVE: ReadonlySet<EntityClassName> = new Set(["person", "org", "host", "email", "id", "location"]);

/**
 * What a column with no rule gets (blind.toml `[defaults] columns`): `fallback`, the fail-closed
 * identifier-like test; or `scan`, every cell kept as written apart from what the free-text scanner
 * finds in it, so no column is pseudonymised whole unless a rule says so.
 */
export type ColumnDefault = "fallback" | "scan";
export const COLUMN_DEFAULTS: readonly ColumnDefault[] = ["fallback", "scan"];

/**
 * `drop` removes the column (or key); `redact` writes REDACTED_VALUE in each non-empty cell; `free`
 * is a cell scanned as free text (a `scan` rule, or a column the fallback or the default leaves as text).
 */
export type ColumnAction = { kind: "keep" } | { kind: "pseudo"; cls: PseudoClass } | { kind: "free" } | { kind: "drop" } | { kind: "redact" };

function ruleAction(rule: ColumnRule): ColumnAction | "heuristic" {
  if (rule.treatment === "keep") return { kind: "keep" };
  if (rule.treatment === "drop") return { kind: "drop" };
  if (rule.treatment === "redact") return { kind: "redact" };
  if (rule.treatment === "scan") return { kind: "free" };
  // A credential column: no pseudonym could be safer than the placeholder, and none is revealable.
  if (rule.treatment === "blind" && rule.class === "secret") return { kind: "redact" };
  if (rule.treatment === "blind" && SENSITIVE.has(rule.class)) return { kind: "pseudo", cls: rule.class as PseudoClass };
  if (rule.treatment === "value" && rule.class === "unknown") return "heuristic";
  return { kind: "pseudo", cls: "value" };
}

export interface Decision {
  action: ColumnAction;
  /** Set only when the fail-closed identifier-like test decided the column. */
  stats: ColumnStats | undefined;
  outcome: ColumnOutcome;
}

/**
 * What a column gets: its rule's action, or for no rule (or unknown/value) what `unruled` says:
 * the fail-closed identifier-like test, or `scan`. An identifier-like column of people's names
 * (prose.ts isPersonColumn) is pseudonymised as `person`, not `value`, so their name parts recur in
 * free text (AGT-1830).
 */
export function decide(rule: ColumnRule | undefined, values: readonly string[], ctx: ColumnContext = {}, unruled: ColumnDefault = "fallback"): Decision {
  const planned = rule === undefined ? "heuristic" : ruleAction(rule);
  if (planned !== "heuristic") return { action: planned, stats: undefined, outcome: outcomeOf(planned, undefined) };
  if (unruled === "scan") return { action: { kind: "free" }, stats: undefined, outcome: "unknown-scanned" };
  const stats = columnStats(values, ctx);
  const action: ColumnAction = isIdentifierLike(stats) ? { kind: "pseudo", cls: isPersonColumn(values) ? "person" : "value" } : { kind: "free" };
  return { action, stats, outcome: outcomeOf(action, stats) };
}

/** A column whose cell values are held whole on purpose (`keep`, `scan`, or the `scan` default): the fallback never pseudonymises them elsewhere. */
export const holdsWhole = (outcome: ColumnOutcome): boolean => outcome === "kept" || outcome === "scanned" || outcome === "unknown-scanned";

/** A column the fail-closed identifier-like test pseudonymised whole. */
export const isFallback = (outcome: ColumnOutcome): boolean => outcome === "unknown-pseudonymised" || outcome === "unknown-person";

/**
 * The recurrence forms of a `drop` or `redact` column (or a credential-class one): every non-empty
 * value, so it is replaced where it appears in other cells and files although its own cell leaves
 * (AGT-1835). They are class `redact`: written as the placeholder, never a pseudonym and never
 * recorded in the map, whatever the rule's class (AGT-1847). A column of people's names is marked
 * `named`, so apply redacts the name parts too. A column classed `vocabulary` has none.
 */
export function removedForms(rule: ColumnRule | undefined, values: readonly string[]): ExtraForm[] {
  if (rule?.class === "vocabulary") return [];
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return [];
  const named = rule?.class === "person" || isPersonColumn(filled);
  return filled.map((value) => ({ cls: "redact" as const, value, ...(named ? { named: true } : {}) }));
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
  if (action.kind === "free") return "scanned";
  return action.kind === "pseudo" && action.cls !== "value" ? "blinded" : "value";
}
