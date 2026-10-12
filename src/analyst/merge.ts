// Spec reuse. A later `blind plan` on a saved spec sends the analyst only what the spec does not
// cover yet: columns and JSON keys with no rule, and document and transcript excerpts it has not
// read (the spec's `seen` fingerprints). The reply is merged into the saved spec, which is the
// starting point: the analyst may add rules, entities and questions, and may classify a saved
// `unknown` rule of its own that no question is about. Every other change to a saved entry
// (a human rule, an answered question, an entity, a pattern) is dropped and reported, and the
// saved entry is written back as the same object, so its JSON is byte-identical.

import { createHash } from "node:crypto";
import type { BlindMap } from "../engine/map.ts";
import type { Policy } from "../policy.ts";
import { type ColumnRule, type Entities, type Entity, type EntityClassName, type Location, type PatternName, patternOn, type Profile, type Question, type Spec } from "../schema.ts";
import { completeProposal, locationKey } from "./analyst.ts";
import { profileLocations } from "./heuristic.ts";
import { shieldedForms, shieldReason } from "./vocabguard.ts";

type EntityClass = Exclude<EntityClassName, "unknown">;
const ENTITY_CLASSES: readonly EntityClass[] = ["person", "org", "host", "email", "id", "location", "vocabulary"];
const PATTERN_NAMES: readonly PatternName[] = ["ip", "email", "host", "guid", "mac", "phone"];

export type Dropped =
  | { kind: "column"; location: Location; reason: string }
  | { kind: "question"; id: string; reason: string }
  | { kind: "entity"; class: EntityClass; canonical: string; reason: string }
  | { kind: "pattern"; name: PatternName; reason: string }
  // An analyst vocabulary entry that would keep a blinded value in clear (vocabguard.ts).
  | { kind: "vocabulary"; canonical: string; reason: string };

/** What a plan changed. On a first plan everything is `added` and the rest is empty. */
export interface PlanDiff {
  reused: boolean;
  added: { columns: ColumnRule[]; entities: { class: EntityClass; canonical: string }[]; questions: string[] };
  classified: { location: Location; from: EntityClassName; to: EntityClassName }[];
  dropped: Dropped[];
}

/** First 16 hex digits of the SHA-256 of an excerpt: enough to recognise it, not to store it. */
export const fingerprint = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

const excerpts = (p: Profile): string[] => [
  ...p.documents.flatMap((d) => [...d.outline, ...d.sampleSentences]),
  ...p.transcripts.flatMap((t) => [...t.speakers, ...t.sampleLines]),
];

/** The spec's `seen` list after the analyst has read `sent`: sorted, unique. */
export function seenAfter(saved: readonly string[], sent: Profile): string[] {
  return [...new Set([...saved, ...excerpts(sent).map(fingerprint)])].sort();
}

/** The part of the profile the saved spec says nothing about. Always a valid profile. */
export function unseenPart(profile: Profile, saved: Spec): Profile {
  const ruled = new Set(saved.columns.map(locationKey));
  const seen = new Set(saved.seen ?? []);
  const unread = (s: string) => !seen.has(fingerprint(s));
  const fresh = new Set(profileLocations(profile).map(({ loc }) => locationKey(loc)).filter((k) => !ruled.has(k)));
  const at = (file: string, sheet: string | undefined, header: string): Location => (sheet === undefined ? { file, header } : { file, sheet, header });

  const tables = profile.tables
    .map((t) => ({ ...t, columns: t.columns.filter((c) => fresh.has(locationKey(at(t.file, t.sheet, c.header)))) }))
    .filter((t) => t.columns.length > 0);
  const jsonKeys = profile.jsonKeys.filter((j) => fresh.has(locationKey({ file: j.file, jsonPath: j.path })));
  const documents = profile.documents
    .map((d) => ({ ...d, outline: d.outline.filter(unread), sampleSentences: d.sampleSentences.filter(unread) }))
    .filter((d) => d.outline.length + d.sampleSentences.length > 0);
  const transcripts = profile.transcripts
    .map((t) => ({ ...t, speakers: t.speakers.filter(unread), sampleLines: t.sampleLines.filter(unread) }))
    .filter((t) => t.speakers.length + t.sampleLines.length > 0);
  const cooccurrence = profile.cooccurrence.filter((c) => fresh.has(locationKey(c.a)) && fresh.has(locationKey(c.b)));
  const used = new Set([...tables, ...jsonKeys, ...documents, ...transcripts].map((x) => x.file));
  return { ...profile, files: profile.files.filter((f) => used.has(f.path)), tables, jsonKeys, documents, transcripts, cooccurrence };
}

export const isEmptyPart = (p: Profile): boolean =>
  p.tables.length === 0 && p.jsonKeys.length === 0 && p.documents.length === 0 && p.transcripts.length === 0;

const locationOf = (r: ColumnRule): Location =>
  r.jsonPath === undefined
    ? r.sheet === undefined ? { file: r.file, header: r.header } : { file: r.file, sheet: r.sheet, header: r.header }
    : r.sheet === undefined ? { file: r.file, jsonPath: r.jsonPath } : { file: r.file, sheet: r.sheet, jsonPath: r.jsonPath };

const formsOf = (e: Entity): string[] => [e.canonical, ...e.aliases, ...e.parts];
const sameEntity = (a: Entity, b: Entity): boolean => JSON.stringify(formsOf(a)) === JSON.stringify(formsOf(b)) && a.aliases.length === b.aliases.length;

/** Why the analyst may not change a saved rule, or undefined when it may classify it. */
function locked(rule: ColumnRule, askedBy: string | undefined): string | undefined {
  if (rule.source === "human") return "the saved rule is a human decision";
  if (rule.source !== "analyst") return `the saved rule is ${rule.source}, and the analyst may classify only its own unknown rules`;
  if (rule.class !== "unknown") return `the saved rule is already ${rule.class}`;
  if (askedBy !== undefined) return `question ${askedBy} decides it`;
  return undefined;
}

/** A fresh plan's diff: everything in the spec is new. */
export function freshDiff(spec: Spec, dropped: Dropped[] = []): PlanDiff {
  return {
    reused: false,
    added: {
      columns: spec.columns,
      entities: ENTITY_CLASSES.flatMap((cls) => (spec.entities[cls] ?? []).map((e) => ({ class: cls, canonical: e.canonical }))),
      questions: spec.questions.map((q) => q.id),
    },
    classified: [],
    dropped,
  };
}

/** What the plan knows about the corpus beyond the part sent: the whole profile and the map, if one exists. */
export interface VocabGuard {
  profile: Profile;
  map?: BlindMap;
}

/** A first plan's spec without the analyst vocabulary that would shield a blinded value; the rest is untouched. */
export function guardFresh(spec: Spec, guard: VocabGuard): { spec: Spec; dropped: Dropped[] } {
  const vocabulary = spec.entities.vocabulary ?? [];
  if (vocabulary.length === 0) return { spec, dropped: [] };
  const shields = shieldedForms(guard.profile, spec.columns, spec.entities, guard.map);
  const dropped: Dropped[] = [];
  const kept = vocabulary.filter((e) => {
    const reason = shieldReason(e, shields);
    if (reason !== undefined) dropped.push({ kind: "vocabulary", canonical: e.canonical, reason });
    return reason === undefined;
  });
  if (dropped.length === 0) return { spec, dropped };
  const { vocabulary: _v, ...rest } = spec.entities;
  return { spec: { ...spec, entities: kept.length > 0 ? { ...rest, vocabulary: kept } : rest }, dropped };
}

/**
 * Merges what the analyst proposed for `part` (or, with `proposal` null, the heuristic rules)
 * into the saved spec. `proposal` has passed checkProposal against the whole profile.
 */
export function mergeProposal(
  saved: Spec,
  proposal: Spec | null,
  part: Profile,
  policy: Pick<Policy, "sensitive"> & Partial<Pick<Policy, "patterns">>,
  guard: VocabGuard,
): { spec: Spec; diff: PlanDiff; filled: Location[] } {
  const dropped: Dropped[] = [];
  const savedAt = new Map(saved.columns.map((c, i) => [locationKey(c), i]));

  // Questions first, so a column the analyst both classifies and asks about stays undecided.
  const asked = new Map<string, string>();
  for (const q of saved.questions) if (q.about !== undefined && !asked.has(locationKey(q.about))) asked.set(locationKey(q.about), q.id);
  const ids = new Set(saved.questions.map((q) => q.id));
  const texts = new Map(saved.questions.map((q) => [q.text, q.id]));
  const added: Question[] = [];
  let n = 1;
  for (const q of proposal?.questions ?? []) {
    if (q.about !== undefined) {
      const key = locationKey(q.about);
      const i = savedAt.get(key);
      const by = asked.get(key);
      const why = by !== undefined ? `question ${by} already asks about this column` : i === undefined ? undefined : locked(saved.columns[i] as ColumnRule, undefined);
      if (why !== undefined) {
        dropped.push({ kind: "question", id: q.id, reason: why });
        continue;
      }
    } else if (texts.has(q.text)) {
      dropped.push({ kind: "question", id: q.id, reason: `question ${texts.get(q.text)} already asks it` });
      continue;
    }
    let id = q.id;
    if (ids.has(id)) {
      while (ids.has(`q${n}`)) n++;
      id = `q${n}`;
    }
    ids.add(id);
    texts.set(q.text, id);
    if (q.about !== undefined) asked.set(locationKey(q.about), id);
    added.push({ ...q, id });
  }

  // Saved rules: kept as the same objects, unless the analyst classifies one it may classify.
  const columns = [...saved.columns];
  const classified: PlanDiff["classified"] = [];
  const proposed: ColumnRule[] = [];
  for (const c of proposal?.columns ?? []) {
    const i = savedAt.get(locationKey(c));
    if (i === undefined) {
      proposed.push(c);
      continue;
    }
    const rule = saved.columns[i] as ColumnRule;
    if (rule.class === c.class && rule.treatment === c.treatment) continue;
    const why = locked(rule, asked.get(locationKey(c))) ?? (c.class === "unknown" ? "an unknown rule may only be classified" : undefined);
    if (why !== undefined) {
      dropped.push({ kind: "column", location: locationOf(rule), reason: why });
      continue;
    }
    columns[i] = { ...locationOf(rule), class: c.class, treatment: c.treatment, confidence: c.confidence, source: "analyst" };
    classified.push({ location: locationOf(rule), from: rule.class, to: c.class });
  }

  // New columns: the analyst's rule or the heuristic one, unknown while any question about it is open.
  const fresh = completeProposal({ ...saved, columns: proposed, questions: [...saved.questions, ...added] }, part, policy);
  columns.push(...fresh.spec.columns);

  // Entities: new ones are added. A saved entity is never changed, so a proposal for a saved
  // canonical form is dropped, and a new entity's forms that already belong to a saved one are left out.
  const entities: Entities = { ...saved.entities };
  const owner = new Map<string, { cls: EntityClass; canonical: string }>();
  for (const cls of ENTITY_CLASSES) for (const e of saved.entities[cls] ?? []) for (const f of formsOf(e)) if (!owner.has(f)) owner.set(f, { cls, canonical: e.canonical });
  const addedEntities: PlanDiff["added"]["entities"] = [];
  let shields: ReturnType<typeof shieldedForms> | undefined;
  for (const cls of ENTITY_CLASSES) {
    for (const e of proposal?.entities[cls] ?? []) {
      if ((saved.entities[cls] ?? []).some((s) => sameEntity(s, e))) continue;
      const clash = owner.get(e.canonical);
      if (clash !== undefined) {
        dropped.push({ kind: "entity", class: cls, canonical: e.canonical, reason: `it would change the saved ${clash.cls} entity ${JSON.stringify(clash.canonical)}` });
        continue;
      }
      if (cls === "vocabulary") {
        // The last class, so `entities` already holds every person and org entity; `columns` is final.
        shields ??= shieldedForms(guard.profile, columns, entities, guard.map);
        const reason = shieldReason(e, shields);
        if (reason !== undefined) {
          dropped.push({ kind: "vocabulary", canonical: e.canonical, reason });
          continue;
        }
      }
      const taken = [...e.aliases, ...e.parts].filter((f) => owner.has(f));
      const entity = taken.length === 0 ? e : { canonical: e.canonical, aliases: e.aliases.filter((f) => !owner.has(f)), parts: e.parts.filter((f) => !owner.has(f)) };
      if (taken.length > 0) {
        dropped.push({ kind: "entity", class: cls, canonical: e.canonical, reason: `added without ${taken.map((f) => JSON.stringify(f)).join(", ")}, already forms of saved entities` });
      }
      entities[cls] = [...(entities[cls] ?? []), entity];
      for (const f of formsOf(entity)) if (!owner.has(f)) owner.set(f, { cls, canonical: entity.canonical });
      addedEntities.push({ class: cls, canonical: entity.canonical });
    }
  }

  // Patterns are saved entries too.
  if (proposal !== null) {
    for (const name of PATTERN_NAMES) {
      if (patternOn(proposal.patterns, name) !== patternOn(saved.patterns, name)) {
        dropped.push({ kind: "pattern", name, reason: `the saved spec has it ${patternOn(saved.patterns, name) ? "on" : "off"}` });
      }
    }
  }

  const seen = proposal === null ? (saved.seen ?? []) : seenAfter(saved.seen ?? [], part);
  const spec: Spec = {
    version: 1,
    columns,
    entities,
    patterns: saved.patterns,
    questions: [...saved.questions, ...added],
    ...(seen.length > 0 ? { seen } : {}),
  };
  return {
    spec,
    diff: {
      reused: true,
      added: { columns: fresh.spec.columns, entities: addedEntities, questions: added.map((q) => q.id) },
      classified,
      dropped,
    },
    filled: proposal === null ? [] : fresh.filled,
  };
}
