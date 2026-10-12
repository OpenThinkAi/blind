// The heuristic analyst (`blind plan --no-model`, and privacy.mode "none"). It classifies a
// column only when one shape detector matches at least HEURISTIC_RATE of its values; every
// other column is `unknown`, which the engine decides at apply time (fail closed). Transcript
// speakers are proposed as people (one person entity per speaker, with its name parts) when the
// policy calls people sensitive. No model, no other entities, no questions.

import type { Policy, SensitiveClass } from "../policy.ts";
import { isHonorificOrRole, isOnlyHonorificsOrRoles } from "../engine/honorifics.ts";
import { DICTIONARY } from "../profile/words.ts";
import type { ColumnRule, DetectorName, Entity, Location, PatternName, Profile, Spec, ValueStats } from "../schema.ts";

export const HEURISTIC_RATE = 0.8;

/** Checked in this order, so a column matching several shapes gets the first. */
const DETECTOR_CLASS: [DetectorName, SensitiveClass][] = [
  ["email", "email"],
  ["ip", "host"],
  ["guid", "id"],
  ["host", "host"],
  ["numericId", "id"],
];

const PATTERN_CLASS: Record<PatternName, SensitiveClass> = { ip: "host", email: "email", host: "host", guid: "id", mac: "host" };

/** Every column and JSON key the profile describes, with its stats, in profile order. */
export function profileLocations(profile: Profile): { loc: Location; stats: ValueStats }[] {
  const out: { loc: Location; stats: ValueStats }[] = [];
  for (const t of profile.tables) {
    for (const c of t.columns) {
      out.push({ loc: t.sheet === undefined ? { file: t.file, header: c.header } : { file: t.file, sheet: t.sheet, header: c.header }, stats: c.stats });
    }
  }
  for (const j of profile.jsonKeys) out.push({ loc: { file: j.file, jsonPath: j.path }, stats: j.stats });
  return out;
}

/** The heuristic rule for one column. */
export function heuristicRule(loc: Location, stats: ValueStats, policy: Pick<Policy, "sensitive">): ColumnRule {
  for (const [detector, cls] of DETECTOR_CLASS) {
    const rate = stats.detectorRates[detector];
    if (rate >= HEURISTIC_RATE) {
      const treatment = policy.sensitive.classes.includes(cls) ? "blind" : "keep";
      return { ...loc, class: cls, treatment, confidence: rate, source: "heuristic" };
    }
  }
  return { ...loc, class: "unknown", treatment: "value", confidence: 0, source: "heuristic" };
}

/** Patterns on for every shape whose class the policy calls sensitive. */
export function heuristicPatterns(policy: Pick<Policy, "sensitive">): Spec["patterns"] {
  const on = (p: PatternName) => policy.sensitive.classes.includes(PATTERN_CLASS[p]);
  return { ip: on("ip"), email: on("email"), host: on("host"), guid: on("guid"), mac: on("mac") };
}

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * One person entity per distinct transcript speaker (folded), sorted, leaving out keep-list terms.
 * Parts are the name's capitalised words of two or more letters that are not dictionary words, honorifics or
 * roles; a speaker made only of those ("Front Desk") is no person.
 */
export function speakerEntities(profile: Profile, keep: readonly string[] = []): Entity[] {
  const kept = new Set(keep.map(fold));
  const byKey = new Map<string, string>();
  for (const t of profile.transcripts) {
    for (const raw of t.speakers) {
      const name = raw.trim().replace(/\s+/g, " ");
      const key = fold(name);
      if (name === "" || name.endsWith("…") || kept.has(key) || isOnlyHonorificsOrRoles(name)) continue;
      const prior = byKey.get(key);
      if (prior === undefined || name < prior) byKey.set(key, name);
    }
  }
  return [...byKey.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((canonical) => {
    const words = /\p{N}/u.test(canonical) ? [] : canonical.split(/[\s,]+/).map((w) => w.replace(/\.$/, ""));
    const parts = [...new Set(words.filter((w) => /^\p{Lu}/u.test(w) && (w.match(/\p{L}/gu) ?? []).length >= 2 && !DICTIONARY.has(w.toLowerCase()) && !isHonorificOrRole(w) && fold(w) !== fold(canonical)))];
    return { canonical, aliases: [], parts };
  });
}

export function heuristicSpec(profile: Profile, policy: Pick<Policy, "sensitive"> & Partial<Pick<Policy, "keep">>): Spec {
  const people = policy.sensitive.classes.includes("person") ? speakerEntities(profile, policy.keep?.terms) : [];
  return {
    version: 1,
    columns: profileLocations(profile).map(({ loc, stats }) => heuristicRule(loc, stats, policy)),
    entities: people.length > 0 ? { person: people } : {},
    patterns: heuristicPatterns(policy),
    questions: [],
  };
}
