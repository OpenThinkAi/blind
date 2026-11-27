// Two name shapes the proposal points out (AGT-2787), after the analyst or heuristic and blind.toml's
// column rules have decided what they decide:
//
// - A first-name / last-name column pair in one CSV or TSV table ("first_name" and "last_name",
//   "First Name" and "Last Name", "Given" and "Surname", "emp_fname" and "emp_lname"). Each row's two
//   cells are one person, so the given-name rule is proposed with `joinWith` naming the surname column
//   (both class person, treatment blind): each cell then gets its part of the person's full-name
//   stand-in, and the pair joins to the same person written whole in another file. The reviewer
//   approves it like any rule, or removes `joinWith` (or marks the rules `source: "human"`) to decline.
// - A column whose sample values put a full name on each side of a comma ("Iris Halloway, Hugo
//   Okonkwo-Lund"). blind never splits a cell on a comma, so such a cell is read as one person written
//   "Surname, Given". Whether that is right is the reviewer's question, so the proposal asks it.
//
// Only rules nobody decided on purpose are touched: never a human rule, never an answered question,
// and a policy rule only when it already blinds the column as a person. Pure; names and headers only,
// never a sample value in a note or question.

import { commaNames } from "../engine/people.ts";
import { headerWords } from "../engine/shapes.ts";
import type { Policy } from "../policyrules.ts";
import type { ColumnRule, Location, Profile, Question, Spec } from "../schema.ts";
import { locationKey, profileLocations } from "./heuristic.ts";

/** Words that make a header a given-name column on their own ("forename", "fname"). */
const GIVEN = new Set(["forename", "forenames", "fname", "firstname", "givenname", "givennames"]);
/** Words that make a header a surname column on their own ("surname", "lname"). */
const FAMILY = new Set(["surname", "surnames", "lname", "lastname", "familyname"]);
/** Words that make a header a given-name or surname column only beside "name", or alone ("First Name", "Last"; not "first seen"). */
const GIVEN_IF_NAMED = new Set(["first", "given"]);
const FAMILY_IF_NAMED = new Set(["last", "family"]);
const NAME = new Set(["name", "names"]);

/** Which half of a person a header names, and the rest of its words (what the pair must share), or undefined. */
export function nameHalf(header: string): { half: "given" | "family"; rest: string } | undefined {
  const words = headerWords(header);
  const named = words.some((w) => NAME.has(w));
  const rest = words.filter((w) => !NAME.has(w));
  let half: "given" | "family" | undefined;
  let at = -1;
  for (const [i, w] of rest.entries()) {
    const h = GIVEN.has(w) ? "given" : FAMILY.has(w) ? "family" : GIVEN_IF_NAMED.has(w) ? "given?" : FAMILY_IF_NAMED.has(w) ? "family?" : undefined;
    if (h === undefined) continue;
    // Two half words ("first last name") say nothing clear.
    if (half !== undefined) return undefined;
    const plain = h.replace("?", "") as "given" | "family";
    // "first"/"last" alone name a half only beside "name" or as the whole header.
    if (h.endsWith("?") && !named && rest.length > 1) return undefined;
    half = plain;
    at = i;
  }
  if (half === undefined) return undefined;
  return { half, rest: rest.filter((_, i) => i !== at).join(" ") };
}

const undecided = (r: ColumnRule): boolean => r.class === "unknown" && r.treatment === "value";
const personBlind = (r: ColumnRule): boolean => r.class === "person" && r.treatment === "blind";
/** A rule the pass may set: not a human decision, and either undecided or already a blinded person (a policy rule only then). */
const settable = (r: ColumnRule | undefined): r is ColumnRule =>
  r !== undefined && r.source !== "human" && r.header !== undefined && (personBlind(r) || (r.source !== "policy" && undecided(r)));

export interface NameShapes {
  spec: Spec;
  /** One note per column the pass proposed or asked about: what and why, names only. */
  notes: { loc: Location; text: string }[];
}

/**
 * The spec with every first/last name pair proposed as one person (`joinWith`) and a question added for
 * every column whose samples put full names around a comma. Pairs are proposed only when the policy
 * lists people as sensitive, only in CSV and TSV tables (a worksheet pair is not blinded as one person),
 * and only between two columns of one table whose headers differ just by the half they name.
 */
export function proposeNameShapes(spec: Spec, profile: Profile, policy: Pick<Policy, "sensitive">): NameShapes {
  const notes: NameShapes["notes"] = [];
  const columns = [...spec.columns];
  const at = new Map(columns.map((c, i) => [locationKey(c), i]));
  const ruleAt = (loc: Location): ColumnRule | undefined => {
    const i = at.get(locationKey(loc));
    return i === undefined ? undefined : columns[i];
  };
  const set = (loc: Location, rule: ColumnRule): void => {
    const i = at.get(locationKey(loc));
    if (i !== undefined) columns[i] = rule;
  };
  const paired = new Set<string>();
  for (const c of columns) {
    if (c.joinWith === undefined || c.header === undefined) continue;
    paired.add(locationKey(c));
    paired.add(locationKey({ file: c.file, ...(c.sheet === undefined ? {} : { sheet: c.sheet }), header: c.joinWith }));
  }

  if (policy.sensitive.classes.includes("person")) {
    for (const t of profile.tables) {
      if (t.sheet !== undefined) continue;
      const halves = t.columns.flatMap((c) => {
        const h = nameHalf(c.header);
        return h === undefined || c.stats.digitRatio >= 0.1 ? [] : [{ header: c.header, ...h }];
      });
      for (const g of halves) {
        if (g.half !== "given") continue;
        const fs = halves.filter((f) => f.half === "family" && f.rest === g.rest);
        const gs = halves.filter((o) => o.half === "given" && o.rest === g.rest);
        // Exactly one of each with these other words: anything else is ambiguous, so nothing is proposed.
        if (fs.length !== 1 || gs.length !== 1) continue;
        const f = fs[0] as (typeof halves)[number];
        const gLoc: Location = { file: t.file, header: g.header };
        const fLoc: Location = { file: t.file, header: f.header };
        const gRule = ruleAt(gLoc);
        const fRule = ruleAt(fLoc);
        if (paired.has(locationKey(gLoc)) || paired.has(locationKey(fLoc)) || !settable(gRule) || !settable(fRule)) continue;
        set(gLoc, { ...gRule, class: "person", treatment: "blind", confidence: Math.max(gRule.confidence, 0.9), joinWith: f.header });
        set(fLoc, { ...fRule, class: "person", treatment: "blind", confidence: Math.max(fRule.confidence, 0.9) });
        paired.add(locationKey(gLoc));
        paired.add(locationKey(fLoc));
        notes.push({ loc: gLoc, text: `person blind, joinWith its surname column: the two columns read as one person's given name and surname, so each cell gets its part of that person's full-name stand-in; remove joinWith to blind each column on its own` });
        notes.push({ loc: fLoc, text: "person blind, the surname of a given-name column (joinWith on that column)" });
      }
    }
  }

  const questions: Question[] = [...spec.questions];
  const asked = new Set(questions.flatMap((q) => (q.about === undefined ? [] : [locationKey(q.about)])));
  const ids = new Set(questions.map((q) => q.id));
  let n = 0;
  for (const { loc, stats } of profileLocations(profile)) {
    const key = locationKey(loc);
    const rule = ruleAt(loc);
    if (asked.has(key) || paired.has(key) || rule === undefined || rule.source === "human" || rule.source === "policy") continue;
    if (!(undecided(rule) || personBlind(rule)) || !stats.samples.some(commaNames)) continue;
    do n++;
    while (ids.has(`names-${n}`));
    const id = `names-${n}`;
    ids.add(id);
    questions.push({
      id,
      text:
        "Some cells hold a full name on each side of a comma. blind never splits a cell on a comma: answer person to blind each such cell as ONE person written \"Surname, Given\", or value to blind each cell whole as a plain value. If a cell names two people, separate them with \";\" in the input and plan again: each person then gets their own stand-in.",
      options: ["person", "value"],
      answer: null,
      about: loc,
    });
    // While the question is open the column stays undecided (decided at apply time), as for any question.
    if (!undecided(rule)) set(loc, { ...rule, class: "unknown", treatment: "value", confidence: 0 });
    notes.push({ loc, text: `question ${id}: full names on each side of a comma (two people, or one name written "Surname, Given"?)` });
  }

  const changed = notes.length > 0;
  return { spec: changed ? { ...spec, columns, questions } : spec, notes };
}
