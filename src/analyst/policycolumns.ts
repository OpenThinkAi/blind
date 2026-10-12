// Column rules from blind.toml (`[[columns]]`, and `[keep].terms` naming a header), written into the
// spec by `blind plan`. They decide a column ahead of the analyst and the heuristic, so a policy
// such as "keep species, weight and visit date" needs no model and no spec edit. A human rule in
// the spec (an answered question, or a rule written with `source: "human"`) is the one thing they
// do not override; the plan says so. Each rule the policy decides is written with `source: "policy"`; a saved policy rule that no longer matches
// (the rule was removed from blind.toml) goes back to the heuristic rule. An open question about
// a column the policy now decides is removed, since answering it could not change the column.

import type { ColumnPolicyRule, Policy } from "../policy.ts";
import type { ColumnRule, Location, Profile, Spec } from "../schema.ts";
import { locationKey } from "./analyst.ts";
import { heuristicRule, profileLocations } from "./heuristic.ts";

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A header glob: `*` any run of characters, `?` one; case and runs of whitespace do not matter. */
export function headerGlob(glob: string): RegExp {
  const body = [...fold(glob)].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : escapeRe(ch))).join("");
  return new RegExp(`^${body}$`, "su");
}

/** A path glob on a "/"-separated input-relative path: `*` and `?` within one segment, `**` across segments. */
export function pathGlob(glob: string): RegExp {
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more folders; a bare `**` anything at all.
      if (glob[i + 2] === "/") {
        body += "(?:[^/]*/)*";
        i += 2;
      } else {
        body += ".*";
        i += 1;
      }
    } else if (ch === "*") body += "[^/]*";
    else if (ch === "?") body += "[^/]";
    else body += escapeRe(ch);
  }
  return new RegExp(`^${body}$`, "su");
}

/**
 * The name a header glob is matched against: a table column's header, or a JSON key path's last
 * key name (`.owner.phone` → "phone", `.visits[*].weight` → "weight", `["visit date"]` → "visit
 * date"). Null for a path with no key name to match (the root, or the record-ID keys `.*~`).
 */
export function keyName(jsonPath: string): string | null {
  if (jsonPath.endsWith("~")) return null;
  const path = jsonPath.replace(/(?:\[\*\])+$/, "");
  const quoted = /\[("(?:[^"\\]|\\.)*")\]$/.exec(path);
  if (quoted) return JSON.parse(quoted[1] as string) as string;
  const plain = /\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  return plain ? (plain[1] as string) : null;
}

interface Compiled {
  rule: ColumnPolicyRule;
  headers: RegExp[];
  file: RegExp | null;
}

/** What blind.toml decides for each column: `[[columns]]` first (first match wins), then a header that is a keep term. */
export class ColumnPolicy {
  private readonly rules: Compiled[];
  private readonly keep: Set<string>;

  constructor(policy: Pick<Policy, "columns"> & Partial<Pick<Policy, "keep">>) {
    this.rules = policy.columns.map((rule) => ({ rule, headers: rule.header.map(headerGlob), file: rule.file === undefined ? null : pathGlob(rule.file) }));
    this.keep = new Set((policy.keep?.terms ?? []).map(fold).filter((t) => t !== ""));
  }

  /** The policy's rule for one location, or undefined when blind.toml says nothing about it. */
  ruleFor(loc: Location): ColumnRule | undefined {
    const name = loc.jsonPath !== undefined ? keyName(loc.jsonPath) : (loc.header as string);
    if (name === null || name.trim() === "") return undefined;
    const folded = fold(name);
    const hit = this.rules.find((c) => (c.file === null || c.file.test(loc.file)) && c.headers.some((h) => h.test(folded)));
    if (hit !== undefined) return { ...loc, class: hit.rule.class, treatment: hit.rule.treatment, confidence: 1, source: "policy" };
    if (this.keep.has(folded)) return { ...loc, class: "vocabulary", treatment: "keep", confidence: 1, source: "policy" };
    return undefined;
  }
}

export interface PolicyOverlay {
  spec: Spec;
  /** Locations blind.toml decided in this plan. */
  decided: Location[];
  /** Ids of open questions removed because blind.toml now decides their column. */
  removedQuestions: string[];
  /** Saved policy rules blind.toml no longer makes, put back to the heuristic rule. */
  reverted: Location[];
  /** Locations blind.toml has a rule for, left alone because the spec's rule there is a human decision. */
  human: Location[];
}

/** The spec with every profile column blind.toml decides set to the policy's rule. Other rules are untouched (same objects). */
export function applyColumnPolicy(spec: Spec, profile: Profile, policy: Pick<Policy, "columns" | "sensitive"> & Partial<Pick<Policy, "keep">>): PolicyOverlay {
  const cp = new ColumnPolicy(policy);
  const at = new Map(spec.columns.map((c, i) => [locationKey(c), i]));
  const columns: ColumnRule[] = [...spec.columns];
  const decided: Location[] = [];
  const reverted: Location[] = [];
  const human: Location[] = [];
  const decidedKeys = new Set<string>();
  for (const { loc, stats } of profileLocations(profile)) {
    const key = locationKey(loc);
    const i = at.get(key);
    const saved = i === undefined ? undefined : columns[i];
    const rule = cp.ruleFor(loc);
    if (rule === undefined) {
      if (saved?.source === "policy" && i !== undefined) {
        columns[i] = heuristicRule(loc, stats, policy);
        reverted.push(loc);
      }
      continue;
    }
    if (saved?.source === "human") {
      if (saved.class !== rule.class || saved.treatment !== rule.treatment) human.push(loc);
      continue;
    }
    decided.push(loc);
    decidedKeys.add(key);
    if (saved !== undefined && i !== undefined) {
      const same = saved.source === "policy" && saved.class === rule.class && saved.treatment === rule.treatment;
      if (!same) columns[i] = rule;
    } else {
      at.set(key, columns.length);
      columns.push(rule);
    }
  }
  const removedQuestions = spec.questions.filter((q) => q.answer === null && q.about !== undefined && decidedKeys.has(locationKey(q.about))).map((q) => q.id);
  const questions = removedQuestions.length === 0 ? spec.questions : spec.questions.filter((q) => !removedQuestions.includes(q.id));
  const changed = decided.length > 0 || reverted.length > 0 || removedQuestions.length > 0;
  return { spec: changed ? { ...spec, columns, questions } : spec, decided, removedQuestions, reverted, human };
}
