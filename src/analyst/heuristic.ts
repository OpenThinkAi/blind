// The heuristic analyst (`blind plan --no-model`, and privacy.mode "none"). It classifies a
// column only when one shape detector matches at least HEURISTIC_RATE of its values; every
// other column is `unknown`, which the engine decides at apply time (fail closed). No model,
// no entities, no questions.

import type { Policy, SensitiveClass } from "../policy.ts";
import type { ColumnRule, DetectorName, Location, PatternName, Profile, Spec, ValueStats } from "../schema.ts";

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

export function heuristicSpec(profile: Profile, policy: Pick<Policy, "sensitive">): Spec {
  return {
    version: 1,
    columns: profileLocations(profile).map(({ loc, stats }) => heuristicRule(loc, stats, policy)),
    entities: {},
    patterns: heuristicPatterns(policy),
    questions: [],
  };
}
