// Column decisions shared by every table-shaped format (CSV/TSV, JSON key paths,
// worksheets): what a spec rule, or its absence, does to a column's cells.

import type { ColumnRule, EntityClassName } from "../schema.ts";
import { type PseudoClass, phoneDigits } from "./canonical.ts";
import { isPersonColumn } from "./prose.ts";
import type { ExtraForm } from "./text.ts";
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

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A phone number, an email address or a token with digits and no spaces (an account or record number). */
function idShaped(value: string): boolean {
  const v = value.trim();
  return phoneDigits(v) !== undefined || EMAIL_SHAPE.test(v) || (/^\S{4,}$/.test(v) && (v.match(/\d/g) ?? []).length >= 3);
}

/**
 * The recurrence forms of a `drop` or `redact` column: every non-empty value, so it is replaced
 * where it appears in other cells and files although its own cell leaves (AGT-1835). The class is
 * the rule's when that is a sensitive class; else `person` for a column of people's names; else
 * `id` for a phone, email or id-shaped value; else `value`. A column classed `vocabulary` has none.
 */
export function removedForms(rule: ColumnRule | undefined, values: readonly string[]): ExtraForm[] {
  if (rule?.class === "vocabulary") return [];
  const filled = values.filter((v) => v.trim() !== "");
  if (filled.length === 0) return [];
  const sensitive = rule !== undefined && SENSITIVE.has(rule.class) ? (rule.class as PseudoClass) : undefined;
  const people = sensitive === undefined && isPersonColumn(filled);
  return filled.map((value) => ({ cls: sensitive ?? (people ? "person" : idShaped(value) ? "id" : "value"), value }));
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
