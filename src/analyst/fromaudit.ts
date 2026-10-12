// `blind plan --from-audit <report.json> -o <out>`: the loop back from the audit to the spec.
// Each value the audit could not explain becomes a candidate the human decides: accepted, it is
// added to the spec as an entity (or turns a shape pattern on); rejected, it is added to the
// spec's vocabulary so the audit does not raise it again. Undecided candidates change nothing.
//
// The report holds masked values only ("Qu***12"). The real value is never taken from it: each
// finding is mapped back to its place in the blinded output (file, zip member, name or content,
// decoding, byte offset), the value is read there, and it must mask to exactly what the report
// says, and not be a pseudonym the map knows, or the finding is listed as not mapped back.
//
// Saved entries are never changed, as in merge.ts: the spec gains entities, vocabulary entries
// and patterns turned on, all of them the human's decision (`source: "human"` on entities), and
// everything already saved is written back as the same object. No model is called.
//
// `--accept-leaks` (leakDecisions) decides the mechanical layer's leaks without asking: each is
// accepted at its suggested class. Candidates (semantic, model, variants) stay the human's.

import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { maskValue } from "../audit/mechanical.ts";
import { xmlViews } from "../audit/semantic.ts";
import { fold, stringView, type View, viewsOf, xmlBaseView } from "../audit/views.ts";
import { looksLikeXml } from "../audit/xml.ts";
import { looksLikeZip, readZip, type ZipBudget, zipBudget } from "../audit/zip.ts";
import type { BlindMap } from "../engine/map.ts";
import { isPseudonym } from "../engine/pseudonym.ts";
import { findPatternSpans } from "../engine/text.ts";
import { type Entities, type Entity, type EntityClassName, type PatternName, patternOn, type Spec } from "../schema.ts";

export class FromAuditError extends Error {
  override name = "FromAuditError";
}

/** Classes an accepted candidate may become: every entity class but vocabulary, which is what a rejection writes. */
export type AcceptClass = Exclude<EntityClassName, "unknown" | "vocabulary" | "secret">;
export const ACCEPT_CLASSES: readonly AcceptClass[] = ["person", "org", "host", "email", "id", "location"];
const PATTERN_NAMES: readonly PatternName[] = ["email", "ip", "mac", "guid", "phone", "host", "secret"];

type Source = "entity" | "map" | "pattern" | "spec" | "scan" | "semantic" | "model";
const SOURCES: readonly Source[] = ["entity", "map", "pattern", "spec", "scan", "semantic", "model"];
/** Findings about a value the spec or the map already knows: blinded on purpose, so never rejectable. */
const MECHANICAL: ReadonlySet<Source> = new Set(["entity", "map", "pattern"]);

/** The fields of an audit finding this module reads. */
export interface ReportFinding {
  file: string;
  part: string;
  in: "content" | "name" | "link";
  offset: number | null;
  line: number | null;
  class: string;
  source: Source;
  severity: "leak" | "candidate";
  masked: string;
  reason: string;
  encoding: string | null;
}

/** Where a candidate was found, as the report gives it. */
export interface Place {
  file: string;
  part: string;
  in: ReportFinding["in"];
  offset: number;
  line: number | null;
}

export interface Candidate {
  /** `c1`, `c2`, ... in the order the report first lists each value. */
  id: string;
  /** The real value, read from the blinded output; for a value found inside a longer word, that whole word. */
  value: string;
  /** Finding classes that raised it (`semantic:phrase`, `person`, `pattern:host`, ...), in report order. */
  kinds: string[];
  /** The class a bare `--accept <id>` gives it; null when the human must name one. */
  suggested: AcceptClass | null;
  /** The shape pattern the whole value matches, for `--accept <id>=pattern`; null when none does. */
  pattern: PatternName | null;
  /** Raised by the mechanical layer as a spec entity, map value or pattern match: blinded on purpose, so it cannot be rejected. */
  known: boolean;
  /** Most severe finding: a leak or a candidate. */
  severity: ReportFinding["severity"];
  places: Place[];
}

export interface Collected {
  candidates: Candidate[];
  /** Value findings whose value could not be read back from the output, with why. */
  unmapped: { finding: ReportFinding; why: string }[];
  /** Findings that are not about one value (columns, unanswered questions, unread parts): not turned into spec changes. */
  other: ReportFinding[];
}

// --- Reading the report ----------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isIntOrNull = (x: unknown): boolean => x === null || (typeof x === "number" && Number.isInteger(x) && x >= 0);

function checkFinding(x: unknown, path: string): ReportFinding {
  const bad = (field: string) => new FromAuditError(`${path}.${field}: not what blind audit --json writes`);
  if (!isObj(x)) throw new FromAuditError(`${path}: must be an object`);
  for (const f of ["file", "part", "class", "masked", "reason"]) if (typeof x[f] !== "string") throw bad(f);
  if (x.in !== "content" && x.in !== "name" && x.in !== "link") throw bad("in");
  if (!isIntOrNull(x.offset)) throw bad("offset");
  if (!isIntOrNull(x.line)) throw bad("line");
  if (!SOURCES.includes(x.source as Source)) throw bad("source");
  if (x.severity !== "leak" && x.severity !== "candidate") throw bad("severity");
  if (x.encoding !== null && typeof x.encoding !== "string") throw bad("encoding");
  return x as unknown as ReportFinding;
}

/** The findings of a `blind audit --json` report, in report order: every file's, then the general ones. */
export function parseAuditReport(text: string, source: string): ReportFinding[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FromAuditError(`${source}: not JSON; pass the output of \`blind audit <out> --json\``);
  }
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.files) || !Array.isArray(raw.general)) {
    throw new FromAuditError(`${source}: not a blind audit report (version 1, files, general); pass the output of \`blind audit <out> --json\``);
  }
  const out: ReportFinding[] = [];
  raw.files.forEach((f, i) => {
    if (!isObj(f) || !Array.isArray(f.findings)) throw new FromAuditError(`${source}: $.files[${i}].findings: must be an array`);
    f.findings.forEach((x, k) => out.push(checkFinding(x, `${source}: $.files[${i}].findings[${k}]`)));
  });
  raw.general.forEach((x, k) => out.push(checkFinding(x, `${source}: $.general[${k}]`)));
  return out;
}

/** A finding about one value at one place: the only kind that can become a spec entry. */
function isValueFinding(f: ReportFinding): boolean {
  if (f.offset === null || f.masked === "") return false;
  if (f.source === "spec" || f.source === "scan") return false;
  return f.class !== "unscanned" && f.class !== "model:unchecked" && f.class !== "semantic:more";
}

// --- Mapping a finding back to its value -----------------------------------

/** The blinded output tree, read on demand. Paths are the report's: relative, "/"-separated. */
class OutputTree {
  private readonly cache = new Map<string, Uint8Array | string>();
  private readonly views = new Map<string, View[]>();
  private readonly byOffset = new Map<View, Map<number, number[]>>();
  private readonly single: boolean;
  constructor(private readonly root: string) {
    let st;
    try {
      st = lstatSync(root);
    } catch {
      throw new FromAuditError(`${root} does not exist; -o names the output tree the report audited`);
    }
    this.single = !st.isDirectory();
  }

  private abs(file: string): string {
    if (this.single) {
      if (file !== basename(this.root)) throw new Error("not in the audited file");
      return this.root;
    }
    const segs = file.split("/");
    if (isAbsolute(file) || file.includes("\\") || segs.some((s) => s === "" || s === "." || s === "..")) throw new Error("not a path inside the output tree");
    // Every folder on the way must be a real directory: a symbolic link to one would lead outside the tree.
    for (let k = 1; k < segs.length; k++) {
      if (!lstatSync(join(this.root, ...segs.slice(0, k))).isDirectory()) throw new Error("a folder on its path is not a directory (symbolic links are never followed)");
    }
    return join(this.root, ...segs);
  }

  /** A regular file's bytes (symbolic links are never followed), or a link's target for `link`. */
  private entry(file: string, link: boolean): Uint8Array | string {
    const key = `${link ? "l" : "f"}\0${file}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const abs = this.abs(file);
    const st = lstatSync(abs);
    let got: Uint8Array | string;
    if (link) {
      if (!st.isSymbolicLink()) throw new Error("not a symbolic link any more");
      got = readlinkSync(abs);
    } else {
      if (!st.isFile()) throw new Error("not a regular file any more");
      got = readFileSync(abs);
    }
    this.cache.set(key, got);
    return got;
  }

  /** The member `part` ("a.xlsx!xl/x.xml", nested with "!") of `bytes`, with its own name. */
  private member(bytes: Uint8Array, part: string, budget: ZipBudget = zipBudget()): { name: string; bytes: Uint8Array } {
    if (!looksLikeZip(bytes)) throw new Error("not an archive any more");
    // Longest name first: a member name may itself contain "!".
    const members = readZip(bytes, budget).sort((a, b) => b.name.length - a.name.length);
    for (const m of members) {
      if (part !== m.name && !part.startsWith(`${m.name}!`)) continue;
      if (m.bytes === undefined) throw new Error(`member cannot be read (${m.error ?? "not decoded"})`);
      return part === m.name ? { name: m.name, bytes: m.bytes } : this.member(m.bytes, part.slice(m.name.length + 1), budget);
    }
    throw new Error("no such archive member any more");
  }

  /** Every text view the audit layers read the place in, keyed by file, part and where. */
  viewsAt(f: ReportFinding): View[] {
    const key = JSON.stringify([f.file, f.part, f.in]);
    const hit = this.views.get(key);
    if (hit !== undefined) return hit;
    let views: View[];
    if (f.in === "link") views = stringView(this.entry(f.file, true) as string);
    else if (f.in === "name") views = stringView(f.part === "" ? f.file : this.member(this.entry(f.file, false) as Uint8Array, f.part).name);
    else {
      const top = this.entry(f.file, false) as Uint8Array;
      const { name, bytes } = f.part === "" ? { name: f.file, bytes: top } : this.member(top, f.part);
      views = viewsOf(bytes);
      const base = bytes.length > 0 && !looksLikeZip(bytes) ? xmlBaseView(bytes) : null;
      if (base !== null && looksLikeXml(name, base.text)) views.push(...xmlViews(base, name));
    }
    this.views.set(key, views);
    return views;
  }

  /** Indices of `view` whose code unit came from byte `offset`. */
  indicesAt(view: View, offset: number): number[] {
    let idx = this.byOffset.get(view);
    if (idx === undefined) {
      idx = new Map();
      for (let i = 0; i < view.text.length; i++) {
        const b = view.byteAt(i);
        const list = idx.get(b);
        if (list === undefined) idx.set(b, [i]);
        else list.push(i);
      }
      this.byOffset.set(view, idx);
    }
    return idx.get(offset) ?? [];
  }
}

/** The length a masked value records ("Qu***12" → 12), or null. */
function maskedLength(masked: string): number | null {
  const m = /\*\*\*(\d+)$/.exec(masked);
  return m === null ? null : Number(m[1]);
}

/** `n` code points of `text` from index `i`, or null when the text ends first. */
function codePoints(text: string, i: number, n: number): string | null {
  const out = [...text.slice(i, i + 2 * n)].slice(0, n);
  return out.length === n ? out.join("") : null;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The whole word around text[i, i + len): a value the audit found inside a longer word
 * ("Marisol" in "Marisole") is decided as that word, which is what the spec would need.
 */
function wordAround(text: string, i: number, len: number): string {
  let a = i;
  let b = i + len;
  while (a > 0 && WORD_CHAR.test(String.fromCodePoint(text.codePointAt(a - 1) as number))) a--;
  while (b < text.length && WORD_CHAR.test(String.fromCodePoint(text.codePointAt(b) as number))) b += String.fromCodePoint(text.codePointAt(b) as number).length;
  return text.slice(a, b);
}

/**
 * The value a finding points at, read from the output, or why it cannot be. `word` is the whole
 * word it sits in when that is longer (see wordAround).
 */
function recover(tree: OutputTree, f: ReportFinding, map: BlindMap): { value: string; word: string } | { why: string } {
  const n = maskedLength(f.masked);
  if (n === null || n === 0) return { why: "the report's masked value has no length" };
  let views: View[];
  try {
    views = tree.viewsAt(f);
  } catch (e) {
    return { why: `${(e as Error).message}; audit the output again` };
  }
  const values = new Map<string, string>();
  for (const v of views) {
    if (f.in === "content" && v.encoding !== f.encoding) continue;
    for (const i of tree.indicesAt(v, f.offset as number)) {
      const value = codePoints(v.text, i, n);
      if (value !== null && maskValue(value) === f.masked && !values.has(value)) values.set(value, wordAround(v.text, i, value.length));
    }
  }
  if (values.size === 0) return { why: "no value at that place masks as the report says: the output changed since the audit, or the value is split there; audit the output again" };
  if (values.size > 1) return { why: "more than one value at that place masks as the report says" };
  const [value, word] = [...values][0] as [string, string];
  if (isPseudonym(value, map) || isPseudonym(word, map)) return { why: "the value at that place is a pseudonym: the output changed since the audit; audit the output again" };
  return { value, word };
}

// --- Candidates ------------------------------------------------------------

const SEMANTIC_CLASS: Record<string, AcceptClass | null> = {
  "semantic:hex": "id",
  "semantic:alnum-id": "id",
  "semantic:digits": "id",
  "semantic:email": "email",
  "semantic:host": "host",
  "semantic:phrase": null,
};
// A surviving secret is accepted as an `id` entity: the value is pseudonymised from then on.
const PATTERN_CLASS: Record<PatternName, AcceptClass> = { email: "email", ip: "host", host: "host", guid: "id", mac: "id", phone: "id", secret: "id" };

/** The class a finding suggests for its value, or null when only the human can say. */
function suggestion(f: ReportFinding): AcceptClass | null {
  const as = (c: string): AcceptClass | null => (ACCEPT_CLASSES.includes(c as AcceptClass) ? (c as AcceptClass) : null);
  switch (f.source) {
    case "entity":
    case "map":
      // A map host-label, email-local or neutral value says what it was part of, not what it is.
      return as(f.class);
    case "pattern":
      return PATTERN_CLASS[f.class.slice("pattern:".length) as PatternName] ?? null;
    case "semantic":
      return SEMANTIC_CLASS[f.class] ?? null;
    case "model":
      return as(f.class.slice("model:".length));
    default:
      return null;
  }
}

/** The shape pattern the whole value matches, or null. */
export function shapeOf(value: string): PatternName | null {
  for (const name of PATTERN_NAMES) {
    const only = { ip: false, email: false, host: false, guid: false, mac: false, phone: false, secret: false, [name]: true };
    const [s] = findPatternSpans(value, only);
    if (s !== undefined && s.start === 0 && s.end === value.length) return name;
  }
  return null;
}

/**
 * Every value finding of the report mapped back to its value in the output tree at `root`, one
 * candidate per distinct value. Throws FromAuditError when the tree does not exist.
 */
export function collectCandidates(findings: readonly ReportFinding[], root: string, map: BlindMap): Collected {
  const tree = new OutputTree(root);
  const byValue = new Map<string, Candidate>();
  const unmapped: Collected["unmapped"] = [];
  const other: ReportFinding[] = [];
  for (const f of findings) {
    if (!isValueFinding(f)) {
      other.push(f);
      continue;
    }
    const got = recover(tree, f, map);
    if ("why" in got) {
      unmapped.push({ finding: f, why: got.why });
      continue;
    }
    let c = byValue.get(got.word);
    if (c === undefined) {
      c = { id: `c${byValue.size + 1}`, value: got.word, kinds: [], suggested: null, pattern: shapeOf(got.word), known: false, severity: "candidate", places: [] };
      byValue.set(got.word, c);
    }
    if (!c.kinds.includes(f.class)) c.kinds.push(f.class);
    // The first finding with a suggestion decides it: the mechanical layer's findings come first in each file.
    c.suggested ??= suggestion(f);
    // Known only when the word is itself the spec or map value, not a longer word around one.
    if (MECHANICAL.has(f.source) && got.word === got.value) c.known = true;
    if (f.severity === "leak") c.severity = "leak";
    c.places.push({ file: f.file, part: f.part, in: f.in, offset: f.offset as number, line: f.line });
  }
  return { candidates: [...byValue.values()], unmapped, other };
}

// --- Decisions -------------------------------------------------------------

export type Decision = { id: string; action: "accept"; as: AcceptClass | "pattern" | null } | { id: string; action: "reject" };

/** `--accept c1,c2=org` and `--reject c3,c4`, each repeatable. Throws FromAuditError on a bad entry. */
export function parseDecisions(accept: readonly string[], reject: readonly string[]): Decision[] {
  const out: Decision[] = [];
  const seen = new Map<string, string>();
  const note = (id: string, flag: string) => {
    if (!/^c[1-9]\d*$/.test(id)) throw new FromAuditError(`${flag} takes candidate ids such as c1 (comma-separated), got ${JSON.stringify(id)}`);
    const before = seen.get(id);
    if (before !== undefined) throw new FromAuditError(`${id} is given twice (${before} and ${flag}); decide each candidate once`);
    seen.set(id, flag);
  };
  for (const item of accept.flatMap((a) => a.split(","))) {
    const eq = item.indexOf("=");
    const id = (eq < 0 ? item : item.slice(0, eq)).trim();
    note(id, "--accept");
    if (eq < 0) {
      out.push({ id, action: "accept", as: null });
      continue;
    }
    const as = item.slice(eq + 1).trim();
    if (as !== "pattern" && !ACCEPT_CLASSES.includes(as as AcceptClass)) {
      throw new FromAuditError(`--accept ${id}=${as}: the class must be one of ${ACCEPT_CLASSES.join(", ")}, or "pattern" (to reject, use --reject ${id})`);
    }
    out.push({ id, action: "accept", as: as as AcceptClass | "pattern" });
  }
  for (const item of reject.flatMap((r) => r.split(","))) {
    const id = item.trim();
    note(id, "--reject");
    out.push({ id, action: "reject" });
  }
  return out;
}

/**
 * The class `--accept-leaks` gives a leak that suggests none: a value from the map that a column
 * pass pseudonymised as `Value_`, or an account name in a path. Both identify a record or an
 * account, which is what `id` is for.
 */
export const LEAK_FALLBACK_CLASS: AcceptClass = "id";

/**
 * `--accept-leaks`: an accept decision for every candidate the mechanical layer raised as a leak
 * and `decided` does not already decide, at its suggested class (LEAK_FALLBACK_CLASS when it has
 * none). Semantic and model findings are never leaks, so candidates stay the human's. Each one is
 * tried on top of `decided` and the ones before it; a leak that cannot be accepted (a vocabulary
 * form, say) is left out with why, and nothing else is affected.
 */
export function leakDecisions(
  saved: Spec,
  candidates: readonly Candidate[],
  decided: readonly Decision[],
  map: BlindMap,
): { decisions: Decision[]; skipped: { id: string; value: string; why: string }[] } {
  const ids = new Set(decided.map((d) => d.id));
  const decisions = [...decided];
  const skipped: { id: string; value: string; why: string }[] = [];
  for (const c of candidates) {
    if (c.severity !== "leak" || ids.has(c.id)) continue;
    const d: Decision = { id: c.id, action: "accept", as: c.suggested ?? LEAK_FALLBACK_CLASS };
    try {
      applyDecisions(saved, candidates, [...decisions, d], map);
    } catch (e) {
      if (!(e instanceof FromAuditError)) throw e;
      skipped.push({ id: c.id, value: c.value, why: e.message });
      continue;
    }
    decisions.push(d);
  }
  return { decisions, skipped };
}

/** What one decision did to the spec. */
export interface Change {
  id: string;
  value: string;
  /** `entity`: added as an entity of `class`; `vocabulary`: added to the vocabulary; `pattern`: turned `pattern` on; `unchanged`: the spec already says so. */
  result: "entity" | "vocabulary" | "pattern" | "unchanged";
  class?: AcceptClass;
  pattern?: PatternName;
  note?: string;
}

const ENTITY_KEYS = ["person", "org", "host", "email", "id", "location"] as const;
const formsOf = (e: Entity): string[] => [e.canonical, ...e.aliases, ...e.parts];

/** `inner` occurs in `outer` as whole words, both folded. */
function containsWord(outer: string, inner: string): boolean {
  if (inner === "") return false;
  const word = /[\p{L}\p{N}]/u;
  for (let i = outer.indexOf(inner); i >= 0; i = outer.indexOf(inner, i + 1)) {
    const before = i === 0 ? "" : (outer[i - 1] as string);
    const after = outer[i + inner.length] ?? "";
    if (!word.test(before) && !word.test(after)) return true;
  }
  return false;
}

/**
 * The saved spec with the decisions applied. Saved entries are kept as the same objects; new
 * entities and vocabulary entries are appended in decision order with `source: "human"`.
 * Throws FromAuditError, naming the candidate, for a decision that cannot be applied; then
 * nothing is applied.
 */
export function applyDecisions(saved: Spec, candidates: readonly Candidate[], decisions: readonly Decision[], map: BlindMap): { spec: Spec; changes: Change[] } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const entities: Entities = { ...saved.entities };
  let patterns = saved.patterns;
  const changes: Change[] = [];

  /** Who owns a form exactly: a saved or just-added non-vocabulary entity. */
  const owner = new Map<string, { cls: AcceptClass; canonical: string }>();
  for (const cls of ENTITY_KEYS) for (const e of saved.entities[cls] ?? []) for (const f of formsOf(e)) if (!owner.has(f)) owner.set(f, { cls, canonical: e.canonical });
  const vocab = new Map<string, string>();
  for (const e of saved.entities.vocabulary ?? []) for (const f of formsOf(e)) if (!vocab.has(fold(f))) vocab.set(fold(f), f);
  /** Folded forms a vocabulary entry must not contain: every entity form and every value and canonical form in the map. */
  const sensitive = [...owner.keys(), ...map.entries.flatMap((m) => [m.value, m.canonical])].map(fold).filter((s) => s !== "");

  const add = (cls: AcceptClass | "vocabulary", value: string) => {
    const entity: Entity = { canonical: value, aliases: [], parts: [], source: "human" };
    entities[cls] = [...(entities[cls] ?? []), entity];
  };

  for (const d of decisions) {
    const c = byId.get(d.id);
    if (c === undefined) {
      throw new FromAuditError(`no candidate ${d.id} in this report${candidates.length > 0 ? ` (candidates: c1..c${candidates.length})` : ""}`);
    }
    const value = c.value;
    if (d.action === "reject") {
      if (c.known) {
        throw new FromAuditError(
          `${d.id} cannot be rejected: the audit found it as ${c.kinds.join(", ")}, a value the spec or the map already treats as sensitive, so it cannot be kept from here. Accept it, or leave it undecided`,
        );
      }
      const folded = fold(value);
      const inside = sensitive.find((s) => containsWord(folded, s));
      if (inside !== undefined) {
        throw new FromAuditError(`${d.id} cannot be rejected: it contains a spec entity form or a value from the map, which vocabulary would keep. Accept it, or leave it undecided`);
      }
      if (vocab.has(folded)) {
        changes.push({ id: d.id, value, result: "unchanged", note: "already in the spec's vocabulary" });
        continue;
      }
      add("vocabulary", value);
      vocab.set(folded, value);
      changes.push({ id: d.id, value, result: "vocabulary" });
      continue;
    }

    if (vocab.has(fold(value))) {
      throw new FromAuditError(`${d.id} cannot be accepted: it is the vocabulary form ${JSON.stringify(vocab.get(fold(value)))} in .blind/spec.json. Delete that entry by hand first`);
    }
    if (d.as === "pattern") {
      const p = c.pattern;
      if (p === null) throw new FromAuditError(`${d.id} matches no shape pattern (${PATTERN_NAMES.join(", ")}); accept it as a class instead`);
      if (patternOn(patterns, p)) {
        changes.push({ id: d.id, value, result: "unchanged", pattern: p, note: `pattern ${p} is already on` });
        continue;
      }
      patterns = { ...patterns, [p]: true };
      changes.push({ id: d.id, value, result: "pattern", pattern: p });
      continue;
    }
    const cls = d.as ?? c.suggested;
    if (cls === null) {
      throw new FromAuditError(`${d.id} needs a class: --accept ${d.id}=<${ACCEPT_CLASSES.join("|")}> (the audit raised it as ${c.kinds.join(", ")})`);
    }
    const own = owner.get(value);
    if (own !== undefined) {
      changes.push({ id: d.id, value, result: "unchanged", class: own.cls, note: `already a form of the ${own.cls} entity ${JSON.stringify(own.canonical)}` });
      continue;
    }
    add(cls, value);
    owner.set(value, { cls, canonical: value });
    sensitive.push(fold(value));
    changes.push({ id: d.id, value, result: "entity", class: cls });
  }
  const changed = changes.some((x) => x.result !== "unchanged");
  return { spec: changed ? { ...saved, entities, patterns } : saved, changes };
}
