// Column rules from blind.toml (`[[columns]]`, and `[keep].terms` naming a header), written into the
// spec by `blind plan`. They decide a column ahead of the analyst and the heuristic, so a policy
// such as "keep species, weight and visit date" needs no model and no spec edit. A human rule in
// the spec (an answered question, or a rule written with `source: "human"`) is the one thing they
// do not override; the plan says so. Each rule the policy decides is written with
// `source: "policy"`; a saved policy rule that no longer matches (the rule was removed from
// blind.toml) goes back to the heuristic rule. An open question about a column the policy now
// decides is removed, since answering it could not change the column.

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

/**
 * A JSON key path's key names, for a `path` rule: `$.users[*].profile.dob` → users, profile, dob;
 * `$["visit date"]` → visit date. Array markers (`[*]`) are dropped, so `users.profile.dob` and
 * `users[*].profile.dob` name the same keys; a member of an object keyed by record IDs is the key
 * `*`. Null for the record-ID keys themselves (`.*~`), which no rule matches.
 */
export function keySegments(jsonPath: string): string[] | null {
  if (jsonPath.endsWith("~")) return null;
  const out: string[] = [];
  let i = jsonPath.startsWith("$") ? 1 : 0;
  while (i < jsonPath.length) {
    const rest = jsonPath.slice(i);
    if (rest.startsWith("[*]")) {
      i += 3;
      continue;
    }
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    if (quoted) {
      out.push(JSON.parse(quoted[1] as string) as string);
      i += quoted[0].length;
      continue;
    }
    const plain = /^\.([^.[]*)/.exec(rest);
    if (plain) {
      out.push(plain[1] as string);
      i += plain[0].length;
      continue;
    }
    // Not a key path blind writes; match nothing rather than guess.
    return null;
  }
  return out;
}

/**
 * The segments of a `path` glob, written like a key path with or without the leading `$`:
 * `owner.dob`, `$.users[*].profile.*`, `**.profile.dob`, `clinic["visit date"]`. `[*]` is ignored.
 */
export function pathGlobSegments(glob: string): string[] {
  let g = glob.trim();
  if (g.startsWith("$")) g = g.slice(1);
  if (!g.startsWith(".") && !g.startsWith("[")) g = `.${g}`;
  const out: string[] = [];
  let i = 0;
  while (i < g.length) {
    const rest = g.slice(i);
    if (rest.startsWith("[*]")) {
      i += 3;
      continue;
    }
    const quoted = /^\[("(?:[^"\\]|\\.)*")\]/.exec(rest);
    if (quoted) {
      out.push(JSON.parse(quoted[1] as string) as string);
      i += quoted[0].length;
      continue;
    }
    const plain = /^\.?([^.[]*)/.exec(rest) as RegExpExecArray;
    out.push(plain[1] as string);
    i += Math.max(plain[0].length, 1);
  }
  return out;
}

/** A compiled `path` glob: each segment a header glob, `**` any number of keys (none included). */
class KeyPathGlob {
  private readonly segs: (RegExp | "**")[];
  constructor(readonly glob: string) {
    this.segs = pathGlobSegments(glob).map((s) => (s === "**" ? "**" : headerGlob(s)));
  }
  test(path: string[]): boolean {
    const folded = path.map(fold);
    const memo = new Map<string, boolean>();
    const go = (i: number, j: number): boolean => {
      const k = `${i},${j}`;
      const hit = memo.get(k);
      if (hit !== undefined) return hit;
      let r: boolean;
      if (i === this.segs.length) r = j === folded.length;
      else {
        const s = this.segs[i] as RegExp | "**";
        if (s === "**") r = go(i + 1, j) || (j < folded.length && go(i, j + 1));
        else r = j < folded.length && s.test(folded[j] as string) && go(i + 1, j + 1);
      }
      memo.set(k, r);
      return r;
    };
    return go(0, 0);
  }
}

/** How specific a glob is: wildcard characters (`*`, `?`; `**` counts two) and literal characters. */
function globWeight(glob: string): { wild: number; literal: number } {
  const g = fold(glob).replace(/\[\*\]/g, "");
  const wild = [...g].filter((ch) => ch === "*" || ch === "?").length;
  return { wild, literal: [...g].length - wild };
}

/**
 * A matching rule's rank, compared field by field (higher first): scoped (path, sheet or file) over
 * unscoped; then exact (no wildcard in the globs that matched) over glob; then fewer wildcards;
 * then more literal text. A full tie goes to the rule written first in blind.toml.
 */
export interface RuleRank {
  scoped: number;
  exact: number;
  wild: number;
  literal: number;
}

const RANK_REASONS: [keyof RuleRank, string][] = [
  ["scoped", "a rule scoped by path, sheet or file beats an unscoped one"],
  ["exact", "an exact name beats a glob"],
  ["wild", "fewer wildcards beat more"],
  ["literal", "more literal text beats less"],
];

/** >0 when a ranks above b. */
function compareRank(a: RuleRank, b: RuleRank): number {
  return a.scoped - b.scoped || a.exact - b.exact || b.wild - a.wild || a.literal - b.literal;
}

/** One `[[columns]]` rule that matches a location. `index` is its 0-based place in blind.toml (`columns[index]`). */
export interface RuleMatch {
  index: number;
  rule: ColumnPolicyRule;
  /** The globs that matched, for notes: `header "dob"`, `path "owner.*"`. */
  globs: string[];
  rank: RuleRank;
}

/** Two or more rules match one location and disagree on its treatment or class. */
export interface RuleOverlap {
  loc: Location;
  /** Every matching rule, the winner first. */
  matches: RuleMatch[];
  /** Why the winner beat the runner-up. */
  reason: string;
}

/** A keep rule that matches columns but decides none of them: a more specific (or earlier) rule wins at every one. */
export interface ShadowedKeep {
  index: number;
  rule: ColumnPolicyRule;
  /** Indices of the rules that won where it matched. */
  by: number[];
  /** How many columns and keys it matched. */
  locations: number;
}

interface Compiled {
  index: number;
  rule: ColumnPolicyRule;
  headers: { glob: string; re: RegExp }[] | null;
  path: KeyPathGlob | null;
  sheet: RegExp | null;
  file: RegExp | null;
}

/** What blind.toml decides for each column: the most specific `[[columns]]` rule, then a header that is a keep term. */
export class ColumnPolicy {
  private readonly rules: Compiled[];
  private readonly keep: Set<string>;

  constructor(policy: Pick<Policy, "columns"> & Partial<Pick<Policy, "keep">>) {
    this.rules = policy.columns.map((rule, index) => ({
      index,
      rule,
      headers: rule.header === undefined ? null : rule.header.map((glob) => ({ glob, re: headerGlob(glob) })),
      path: rule.path === undefined ? null : new KeyPathGlob(rule.path),
      sheet: rule.sheet === undefined ? null : headerGlob(rule.sheet),
      file: rule.file === undefined ? null : pathGlob(rule.file),
    }));
    this.keep = new Set((policy.keep?.terms ?? []).map(fold).filter((t) => t !== ""));
  }

  /** Every `[[columns]]` rule that matches a location, most specific first. */
  matches(loc: Location): RuleMatch[] {
    const name = loc.jsonPath !== undefined ? keyName(loc.jsonPath) : (loc.header as string);
    const segs = loc.jsonPath !== undefined ? keySegments(loc.jsonPath) : null;
    const folded = name === null ? null : fold(name);
    const out: RuleMatch[] = [];
    for (const c of this.rules) {
      // parsePolicy refuses a rule with neither; built by hand, it matches nothing rather than everything.
      if (c.headers === null && c.path === null) continue;
      if (c.file !== null && !c.file.test(loc.file)) continue;
      if (c.sheet !== null && (loc.sheet === undefined || !c.sheet.test(fold(loc.sheet)))) continue;
      const globs: string[] = [];
      const weights: { wild: number; literal: number }[] = [];
      if (c.path !== null) {
        if (segs === null || !c.path.test(segs)) continue;
        globs.push(`path ${JSON.stringify(c.path.glob)}`);
        weights.push(globWeight(c.path.glob));
      }
      if (c.headers !== null) {
        if (folded === null || folded === "") continue;
        // The most specific of the rule's header globs that matches.
        let best: { glob: string; w: { wild: number; literal: number } } | undefined;
        for (const h of c.headers) {
          if (!h.re.test(folded)) continue;
          const w = globWeight(h.glob);
          if (best === undefined || w.wild < best.w.wild || (w.wild === best.w.wild && w.literal > best.w.literal)) best = { glob: h.glob, w };
        }
        if (best === undefined) continue;
        globs.push(`header ${JSON.stringify(best.glob)}`);
        weights.push(best.w);
      }
      const wild = weights.reduce((n, w) => n + w.wild, 0);
      const literal = weights.reduce((n, w) => n + w.literal, 0);
      const scoped = c.rule.path !== undefined || c.rule.sheet !== undefined || c.rule.file !== undefined ? 1 : 0;
      out.push({ index: c.index, rule: c.rule, globs, rank: { scoped, exact: wild === 0 ? 1 : 0, wild, literal } });
    }
    // Stable sort: a full tie keeps file order.
    return out.sort((a, b) => compareRank(b.rank, a.rank) || a.index - b.index);
  }

  /** The policy's rule for one location, or undefined when blind.toml says nothing about it. */
  ruleFor(loc: Location): ColumnRule | undefined {
    const hit = this.matches(loc)[0];
    if (hit !== undefined) return { ...loc, class: hit.rule.class, treatment: hit.rule.treatment, confidence: 1, source: "policy" };
    const name = loc.jsonPath !== undefined ? keyName(loc.jsonPath) : (loc.header as string);
    if (name !== null && this.keep.has(fold(name))) return { ...loc, class: "vocabulary", treatment: "keep", confidence: 1, source: "policy" };
    return undefined;
  }
}

/** Why `a` (the winner) outranks `b`. */
export function rankReason(a: RuleMatch, b: RuleMatch): string {
  for (const [key, reason] of RANK_REASONS) if (a.rank[key] !== b.rank[key]) return reason;
  return "equally specific, so the one written first wins";
}

/** A rule as a note names it: `columns[2] (header "owner*", blind/person)`. Globs and names only, never a value. */
export function describeMatch(m: RuleMatch): string {
  return `columns[${m.index}] (${m.globs.join(", ")}, ${m.rule.treatment}/${m.rule.class})`;
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
  /** Locations two or more `[[columns]]` rules match with different treatments or classes. */
  overlaps: RuleOverlap[];
  /** Keep rules that match columns here but decide none of them. */
  shadowedKeeps: ShadowedKeep[];
}

/** The spec with every profile column blind.toml decides set to the policy's rule. Other rules are untouched (same objects). */
export function applyColumnPolicy(spec: Spec, profile: Profile, policy: Pick<Policy, "columns" | "sensitive"> & Partial<Pick<Policy, "keep" | "patterns">>): PolicyOverlay {
  const cp = new ColumnPolicy(policy);
  const at = new Map(spec.columns.map((c, i) => [locationKey(c), i]));
  const columns: ColumnRule[] = [...spec.columns];
  const decided: Location[] = [];
  const reverted: Location[] = [];
  const human: Location[] = [];
  const decidedKeys = new Set<string>();
  const overlaps: RuleOverlap[] = [];
  // Per keep rule: how many locations it matched, and which rules won them.
  const keepSeen = new Map<number, { locations: number; won: boolean; by: Set<number> }>();
  for (const { loc, stats } of profileLocations(profile)) {
    const key = locationKey(loc);
    const matches = cp.matches(loc);
    const winner = matches[0];
    if (winner !== undefined) {
      if (matches.some((m) => m.rule.treatment !== winner.rule.treatment || m.rule.class !== winner.rule.class)) {
        overlaps.push({ loc, matches, reason: rankReason(winner, matches[1] as RuleMatch) });
      }
      for (const m of matches) {
        if (m.rule.treatment !== "keep") continue;
        const k = keepSeen.get(m.index) ?? { locations: 0, won: false, by: new Set<number>() };
        k.locations++;
        // Another keep rule with the same class winning decides the same thing: not shadowed there.
        if (m === winner || (winner.rule.treatment === "keep" && winner.rule.class === m.rule.class)) k.won = true;
        else k.by.add(winner.index);
        keepSeen.set(m.index, k);
      }
    }
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
  const shadowedKeeps: ShadowedKeep[] = [...keepSeen]
    .filter(([, k]) => !k.won)
    .sort(([a], [b]) => a - b)
    .map(([index, k]) => ({ index, rule: policy.columns[index] as ColumnPolicyRule, by: [...k.by].sort((a, b) => a - b), locations: k.locations }));
  return { spec: changed ? { ...spec, columns, questions } : spec, decided, removedQuestions, reverted, human, overlaps, shadowedKeeps };
}
