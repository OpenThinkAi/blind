// A vocabulary form shields its words from replacement (the EntityMatcher sort ranks it above
// everything else at equal length). So an analyst reply that lists a blinded value as vocabulary,
// by mistake or because a document told it to, would keep that value in clear, and
// `blind run --yes` skips the human review that would catch it. This module finds the forms an
// analyst's vocabulary entry may not carry. Human vocabulary (--answer, --from-audit, hand edits)
// is never passed through here.

import { PSEUDO_CLASSES, type PseudoClass } from "../engine/canonical.ts";
import type { BlindMap } from "../engine/map.ts";
import { recurrenceForms } from "../engine/recur.ts";
import type { ExtraForm } from "../engine/text.ts";
import type { ColumnRule, Entities, Entity, Profile } from "../schema.ts";
import { locationKey } from "./analyst.ts";
import { profileLocations } from "./heuristic.ts";

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const formsOf = (e: Entity): string[] => [e.canonical, ...e.aliases, ...e.parts];

/** Why a form would shield a blinded value, keyed by the folded form. */
export type Shields = Map<string, string>;

/**
 * Every form a vocabulary entry may not carry: the values the profile shows in columns the rules
 * pseudonymise (any treatment but `keep`; an `unknown` column counts, apply decides it later) with
 * their canonical forms and name parts, the same forms the engine matches as recurrences; the
 * map's values and canonical forms; and every person or org entity form and part in `entities`.
 * `rules` are the column rules the plan will use. The profile holds samples, not whole columns.
 */
export function shieldedForms(profile: Profile, rules: readonly ColumnRule[], entities: Entities, map: BlindMap | undefined): Shields {
  const byKey = new Map(rules.map((r) => [locationKey(r), r]));
  const values: ExtraForm[] = [];
  const why = new Map<string, string>();
  for (const { loc, stats } of profileLocations(profile)) {
    const rule = byKey.get(locationKey(loc));
    if (rule === undefined || rule.treatment === "keep") continue;
    const cls: PseudoClass = (PSEUDO_CLASSES as readonly string[]).includes(rule.class) ? (rule.class as PseudoClass) : "value";
    for (const value of stats.samples) {
      values.push({ cls, value });
      why.set(fold(value), "a value blinded in a column of the profile");
    }
  }
  const out: Shields = new Map();
  for (const f of recurrenceForms(values, {}, map)) {
    const k = fold(f.form ?? f.value);
    out.set(k, why.get(fold(f.value)) ?? (map?.entries.some((e) => fold(e.value) === fold(f.value)) ? "a value in the map" : "a name part of a blinded person"));
  }
  for (const e of map?.entries ?? []) {
    out.set(fold(e.value), "a value in the map");
    out.set(fold(e.canonical), "a canonical form in the map");
  }
  for (const cls of ["person", "org"] as const) {
    for (const e of entities[cls] ?? []) for (const f of formsOf(e)) out.set(fold(f), `a form of the ${cls} entity ${JSON.stringify(e.canonical)}`);
  }
  return out;
}

/** The reason an analyst vocabulary entry is unsafe, or undefined when none of its forms shields a blinded value. */
export function shieldReason(entry: Entity, shields: Shields): string | undefined {
  for (const f of formsOf(entry)) {
    const why = shields.get(fold(f));
    if (why !== undefined) return `${JSON.stringify(f)} is ${why}, and vocabulary would keep it in clear`;
  }
  return undefined;
}
