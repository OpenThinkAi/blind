// Why a column is proposed the way it is: the notes `blind plan` prints beside its columns, built here as
// plain text so the CLI (src/analyst/plan.ts) and the library entry (explainProposal, src/lib.ts) say the
// same thing. Pure: no file system, no terminal, no masking. A note about one column or key comes back with
// its location and without it in the text; the CLI writes the location in front (masked when it masks
// values). Globs, names, classes, treatments and percentages only, never a sample value.

import { isBirthDateName, lastKey } from "../engine/birthdate.ts";
import { type Policy, POLICY_FILE } from "../policyrules.ts";
import type { ColumnRule, Location, Profile, Spec, ValueStats } from "../schema.ts";
import { heuristicDetector, heuristicReason, heuristicShape, locationKey, profileLocations } from "./heuristic.ts";
import { ColumnPolicy, describeMatch, type PolicyOverlay, type RuleMatch, type RuleOverlap, type ShadowedKeep } from "./policycolumns.ts";

/** A note about one column or JSON key. */
export interface ColumnNote {
  loc: Location;
  text: string;
}

type NotePolicy = Pick<Policy, "sensitive"> & Partial<Pick<Policy, "patterns">>;

/** The count of columns and keys blind.toml decided: `blind plan`'s note. */
export function decidedNote(count: number): string {
  return `${count} column(s) and key(s) decided by ${POLICY_FILE} (source policy)`;
}

/** Two or more rules that disagree on one column: each named (globs only), and which won and why. */
export function overlapNote(o: RuleOverlap): ColumnNote {
  const win = o.matches[0] as RuleMatch;
  return { loc: o.loc, text: `${o.matches.length} ${POLICY_FILE} rules match: ${o.matches.map(describeMatch).join("; ")}; columns[${win.index}] wins (${o.reason})` };
}

/** A keep rule that decides none of the columns it matches: `blind plan`'s warning, with its `warning: ` prefix. */
export function shadowedKeepNote(k: ShadowedKeep): string {
  const globs = [...(k.rule.header ?? []).map((h) => `header ${JSON.stringify(h)}`), ...(k.rule.path === undefined ? [] : [`path ${JSON.stringify(k.rule.path)}`])].join(", ");
  return `warning: ${POLICY_FILE} columns[${k.index}] (${globs}, keep) decides nothing: at all ${k.locations} column(s) and key(s) it matches, ${k.by.map((i) => `columns[${i}]`).join(", ")} wins instead`;
}

/**
 * The notes `blind plan` prints per column for the final spec, in profile order: a birth-date column no rule
 * decides (redacted at apply time), a heuristic blind made by a policy pattern although its class is not
 * listed, and a heuristic rule from a column shape (plate, handle, phone) with its rate.
 */
export function columnNotes(spec: Spec, profile: Profile, policy: NotePolicy): ColumnNote[] {
  const out: ColumnNote[] = [];
  // A heuristic rule is blind with its class unlisted only because the policy turned that shape's pattern on.
  const heuristic = new Set(spec.columns.filter((c) => c.source === "heuristic" && c.treatment === "blind").map(locationKey));
  // A heuristic rule from a column shape (plate, handle, phone) says which, and how much of the column matched.
  const shaped = new Map(spec.columns.filter((c) => c.source === "heuristic" && c.class !== "unknown").map((c) => [locationKey(c), c]));
  const ruled = new Map(spec.columns.map((c) => [locationKey(c), c]));
  for (const { loc, stats } of profileLocations(profile)) {
    // A birth-date column no rule decides is redacted at apply time (fail closed), not exempted as a date measure.
    const decided = ruled.get(locationKey(loc));
    if (isBirthDateName(loc.header ?? (loc.jsonPath === undefined ? undefined : lastKey(loc.jsonPath))) && (decided === undefined || (decided.class === "unknown" && decided.treatment === "value"))) {
      out.push({ loc, text: "redact, birth-date header, no rule" });
    }
    const pattern = heuristic.has(locationKey(loc)) ? heuristicReason(stats, policy, loc) : undefined;
    if (pattern !== undefined) out.push({ loc, text: `blind, because policy pattern ${pattern} on (its class is not in [sensitive].classes)` });
    const rule = shaped.get(locationKey(loc));
    const shape = rule === undefined ? undefined : heuristicShape(loc, stats, policy);
    if (rule !== undefined && shape !== undefined) {
      out.push({ loc, text: `${rule.class} ${rule.treatment}, shape: ${shape.shape}, ${Math.round(shape.rate * 100)}%${shape.named ? " (its header names the shape)" : ""}` });
    }
  }
  return out;
}

/**
 * Why a column has its rule when `blind plan` prints no note about it: the blind.toml rule that decided it,
 * the detector that classified it and how much of the column matched, or that nothing decides it until
 * apply time. Text for the library only; the CLI's output does not include it.
 */
export function baseReason(rule: ColumnRule, stats: ValueStats, policy: NotePolicy & Pick<Policy, "columns"> & Partial<Pick<Policy, "keep">>, cp: ColumnPolicy = new ColumnPolicy(policy)): string {
  const loc: Location = rule;
  if (rule.source === "policy") {
    const win = cp.matches(loc)[0];
    return win === undefined ? `decided by ${POLICY_FILE}: its name is a [keep] term` : `decided by ${POLICY_FILE} ${describeMatch(win)}`;
  }
  if (rule.class === "unknown") return `no ${POLICY_FILE} rule or detector decides it: ${rule.treatment}, decided at apply time (identifier-like values get Value_ pseudonyms)`;
  const d = heuristicDetector(loc, stats, policy);
  const listed = policy.sensitive.classes.includes(rule.class as never);
  const why = rule.treatment === "keep" && !listed ? " (its class is not in [sensitive].classes)" : "";
  return d === undefined ? `${rule.class} ${rule.treatment}` : `${rule.class} ${rule.treatment}, detector: ${d.detector}, ${Math.round(d.rate * 100)}%${why}`;
}

/** A `join_with` rule that found no single surname column: the column is decided, but on its own. */
export const UNJOINED_NOTE = `${POLICY_FILE} join_with matched no other header of this CSV or TSV table, or several, so no first/last name pair: the column is blinded on its own`;

/** The notes an overlay gives about columns (overlaps, unpaired join_with rules), and the ones about the plan as a whole, as `blind plan` orders them. */
export function overlayNotes(overlay: Pick<PolicyOverlay, "decided" | "overlaps" | "shadowedKeeps"> & Partial<Pick<PolicyOverlay, "unjoined">>): { decided: string | undefined; overlaps: ColumnNote[]; shadowedKeeps: string[] } {
  return {
    decided: overlay.decided.length > 0 ? decidedNote(overlay.decided.length) : undefined,
    overlaps: [...overlay.overlaps.map(overlapNote), ...(overlay.unjoined ?? []).map((loc) => ({ loc, text: UNJOINED_NOTE }))],
    shadowedKeeps: overlay.shadowedKeeps.map(shadowedKeepNote),
  };
}
