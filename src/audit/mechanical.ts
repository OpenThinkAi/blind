// The mechanical audit: no value the spec or the map knows survives in any
// byte of the output. It reads the output as it is on disk, independently of
// how the engine walked it: every file, every directory and file name, every
// zip member (recursively, names included), each read in several encodings
// (see views.ts). No model, no clock, no randomness: the same tree, spec and
// map give the same report.
//
// What it looks for:
// - every entity form in the spec (canonical, aliases, parts; vocabulary
//   excepted), with the engine's case rule for that form;
// - every original value recorded in the map (surface form and canonical);
// - every word of a multi-word person value in the map (a given name or a
//   surname, AGT-1801), found alone: the engine replaces only the forms the spec
//   lists, so a part the spec missed survives. Matched whole-word only, under the
//   case rule the engine gives a single-word form (a capitalised word only where
//   the text is capitalised too, a short acronym only exactly); a survivor in
//   that case is a `leak`, in another case a `candidate`. A part that is also an
//   ordinary word (src/engine/words.ts) or a keep term is never a leak: in its
//   rule's case it is a candidate, otherwise not reported;
// - every match of an enabled spec pattern that is not a pseudonym;
// - in a CSV/TSV table, a column written as licence plates or usernames/handles (the column shapes
//   the heuristic classifies by, src/engine/shapes.ts), unless the spec keeps, drops or redacts it;
// - in an OOXML package, an account name in a path (`C:\Users\avery\`, `/Users/avery/`:
//   src/formats/paths.ts) that is not a pseudonym, in any attribute and in the
//   app.xml Template and HyperlinkBase text: the engine replaces every one.
//
// In an OOXML package, namespace, content-type and relationship-type URIs and
// fixed template IDs are format structure and are blanked before scanning, by
// their attribute position in the parsed XML (see xml.ts ooxmlUriAttribute and
// officeIdAttribute); everything else is read, Office's per-document linking
// IDs included (the engine replaces them, so one left in place still shows).
//
// Severity. A whole-word survivor of a spec value in the case the engine would
// have replaced is a `leak`. Anything the audit finds but cannot call a leak
// with certainty is a `candidate`: a case, accent or width variant, a value
// embedded in a longer word, a value under 3 characters, a host label or email
// local part of a blinded value, a column the spec declares `unknown` or does
// not mention, an unanswered spec question, and any part the audit could not
// decode (encrypted or corrupt archive members, binary content, images,
// symbolic links). Status is `leak` if any leak, else `candidates` if any
// candidate, else `clean`; the audit never reports `clean` for something it
// did not read.

import { type ColumnRule, type PatternName, type Patterns, patternOn, REDACTED_VALUE, type Spec } from "../schema.ts";
import { isBirthDateName } from "../engine/birthdate.ts";
import { customDataPart, customPartRefusal } from "../engine/customxml.ts";
import { CsvError, parseCsv, sniffDelimiter } from "../engine/csv.ts";
import { inDateContext, isDateWord } from "../engine/datecontext.ts";
import { decode, EncodingError, isEightBit } from "../engine/encoding.ts";
import type { BlindMap } from "../engine/map.ts";
import { isPlaceholderImage } from "../engine/images.ts";
import { isPseudonym } from "../engine/pseudonym.ts";
import { nameWordExcluded, onNameTokens } from "../engine/names.ts";
import { findPatternSpans, keepDomains, secretSpans, type Span } from "../engine/text.ts";
import { nameShaped, recurrenceExclusion, vocabularyForms } from "../engine/recur.ts";
import { isLabelWord } from "../engine/labels.ts";
import { keptCells } from "./keptcells.ts";
import { Shield } from "../engine/shield.ts";
import { detectHeaderRow } from "../profile/table.ts";
import { valueStats } from "../profile/stats.ts";
import { isHandle, isPlate, shapeHolds } from "../engine/shapes.ts";
import { DICTIONARY } from "../engine/words.ts";
import { fold, foldWithMap, stringView, type View, viewsOf, xmlBaseView } from "./views.ts";
import { maskValue } from "../mask.ts";
import { accountSegments } from "../formats/paths.ts";
import { CONTENT_TYPES_PART, localName, looksLikeXml, officeIdAttribute, ooxmlUriAttribute, walkXml } from "./xml.ts";
import { looksLikeZip, readZip, type ZipBudget, ZipError, zipBudget } from "./zip.ts";

export type Status = "clean" | "candidates" | "leak";
export type Severity = "leak" | "candidate";

export interface Finding {
  /** Path in the output tree, "/"-separated; "(spec)" for findings about the spec itself. */
  file: string;
  /** Zip member path inside the file ("a.zip!inner/b.xml" for nested archives); "" for the file itself. */
  part: string;
  /** Where in the part: its content, its name, or a symbolic link's target. */
  in: "content" | "name" | "link";
  /** Byte offset in the part's content (code-unit offset for a name); null when not about a position. */
  offset: number | null;
  /** 1-based line in the decoded view; null for names and positionless findings. */
  line: number | null;
  /** Entity class, map kind, `pattern:<name>`, `unknown`, or `unscanned`. */
  class: string;
  source: "entity" | "map" | "pattern" | "spec" | "scan" | "semantic" | "model";
  severity: Severity;
  /** First characters, `***`, then the length in characters; never the whole value. */
  masked: string;
  reason: string;
  /** The decoding the value was found in; null when not about a position. */
  encoding: string | null;
}

export interface FileAudit {
  path: string;
  kind: TreeEntry["kind"];
  status: Status;
  findings: Finding[];
}

export interface AuditReport {
  version: 1;
  status: Status;
  /** Layers that ran, in order: `mechanical`, then `semantic` (src/audit/semantic.ts), then `model` (src/audit/auditor.ts). */
  layers: string[];
  files: FileAudit[];
  /** Findings not tied to one file (unanswered spec questions, a model layer that could not finish). */
  general: Finding[];
  summary: { files: number; leaks: number; candidates: number };
  /** What the model layer was configured with and sent; present only when it was called. */
  model?: ModelLayerSummary;
  /** Whether the model layer read anything. Set by `blind audit` whenever the layer was reached or deliberately skipped. */
  modelLayer?: ModelLayerStatus;
}

/**
 * `ran`: every call was answered. `partial`: some were, then one failed. `unreachable`: no answer
 * was received (connection, timeout, HTTP or backend failure). `rejected`: the endpoint answered
 * but no reply passed the schema. `skipped`: the layer was not called (`reason` says why).
 * Only `ran` is listed in `layers` as plain "model"; the others read `model (<status>)`, and a
 * skipped layer is not listed.
 */
export interface ModelLayerStatus {
  status: "ran" | "partial" | "unreachable" | "rejected" | "skipped";
  /** The endpoint's host and port only (never credentials, path or query); null for claude-cli or when skipped. */
  host: string | null;
  /** Why it was skipped, or the first line of the failure. */
  reason: string;
}

/** The name `layers` gives a model layer in this state. */
export const modelLayerName = (s: ModelLayerStatus): string => (s.status === "ran" ? "model" : `model (${s.status})`);

export interface ModelLayerSummary {
  /** `auditor`, or `analyst` when blind.toml has no [models.auditor] and the analyst's backend was reused. */
  config: "auditor" | "analyst";
  backend: string;
  /** The configured model name; "" when the backend's default or the server's first model is used. */
  model: string;
  mode: string;
  /** `text`: the output's extracted text (local-only); `profile`: the output's profile only (profile-only). */
  sent: "text" | "profile";
  /** Calls planned and calls whose reply was accepted. */
  chunks: number;
  answered: number;
  /** Files and members the model was not sent, with why (the other layers still read them). */
  notSent: { file: string; part: string; reason: string }[];
}

export type TreeEntry =
  | { path: string; kind: "file"; bytes: Uint8Array }
  | { path: string; kind: "dir" }
  | { path: string; kind: "symlink"; target: string }
  | { path: string; kind: "other" }
  | { path: string; kind: "unreadable"; reason: string };

/** Nested archives deeper than this are reported, not opened. */
export const MAX_ZIP_DEPTH = 8;
/** Shorter values are only ever candidates: too short to call a match a leak. */
export const MIN_LEAK_LENGTH = 3;
/** A value embedded inside a longer word is a candidate only from this length up. */
export const MIN_EMBEDDED_LENGTH = 4;

const STATUS_RANK: Record<Status, number> = { clean: 0, candidates: 1, leak: 2 };

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const cps = (s: string): string[] => [...s];

type CaseRule = "exact" | "capital" | "fold";

/** The engine's case rule for an entity form (src/engine/text.ts), applied the same way here. */
function caseRule(form: string): CaseRule {
  const letters = form.match(/\p{L}/gu) ?? [];
  if (letters.length > 0 && letters.length <= 6 && !/\p{Ll}/u.test(form)) return "exact";
  if (!/\s/.test(form.trim()) && /^\p{Lu}/u.test(form.trim())) return "capital";
  return "fold";
}

const collapse = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim();

const WORD_RE = /[\p{L}\p{N}]/u;
const isWordAt = (s: string, i: number): boolean => {
  if (i < 0 || i >= s.length) return false;
  const c = s.codePointAt(i) as number;
  // Step back over a low surrogate to its high half.
  if (c >= 0xdc00 && c <= 0xdfff && i > 0) return WORD_RE.test(String.fromCodePoint(s.codePointAt(i - 1) as number));
  return WORD_RE.test(String.fromCodePoint(c));
};

interface Needle {
  folded: string;
  /** The value as written (NFC, whitespace collapsed): what a leak must equal under `rule`. */
  original: string;
  rule: CaseRule;
  class: string;
  /** `find`: report; `mask`: a pseudonym or a vocabulary form, whose text is never reported. */
  role: "find" | "mask";
  source: "entity" | "map";
  /** Host labels and email local parts are pieces of a blinded value: candidates, not leaks. */
  component: boolean;
  /**
   * A word of a multi-word person value in the map, looked for alone: `name` when it may be a leak,
   * `word` when it is also an ordinary word or a keep term (a candidate at most). Whole words only.
   */
  part?: "name" | "word";
  /**
   * Why blind never recurs this value (recurrenceExclusion: only dictionary words, too short, a
   * vocabulary form), for a whole value from the map: a survivor is a candidate, not a leak.
   */
  excluded?: string;
  wordStart: boolean;
  wordEnd: boolean;
}

function needle(value: string, rule: CaseRule, cls: string, role: Needle["role"], source: Needle["source"], component = false, part?: Needle["part"]): Needle | null {
  const folded = fold(value);
  if (folded === "") return null;
  return {
    ...(part !== undefined ? { part } : {}),
    folded,
    original: collapse(value),
    rule,
    class: cls,
    role,
    source,
    component,
    wordStart: isWordAt(folded, 0),
    wordEnd: isWordAt(folded, folded.length - 1),
  };
}

const ENTITY_KEYS = ["person", "org", "host", "email", "id", "location", "vocabulary"] as const;

const NAME_WORD_RE = /[\p{L}\p{M}]+(?:['\u2019-][\p{L}\p{M}]+)*/gu;

/**
 * The words of a multi-word person value, each cased as the value writes it (a word only in the
 * lowercase canonical form is capitalised, as a name part is written), with the engine's case rule
 * for a single-word form. Words under MIN_LEAK_LENGTH letters are left out.
 */
function personWords(value: string, canonical: string): [string, CaseRule][] {
  const written = value.match(NAME_WORD_RE) ?? [];
  const canon = canonical.match(NAME_WORD_RE) ?? [];
  if (written.length < 2 && canon.length < 2) return [];
  const byFold = new Map<string, string>();
  for (const w of written) if (!byFold.has(fold(w))) byFold.set(fold(w), w);
  for (const w of canon) if (!byFold.has(fold(w))) byFold.set(fold(w), w.charAt(0).toUpperCase() + w.slice(1));
  const out: [string, CaseRule][] = [];
  for (const w of byFold.values()) {
    if ((w.match(/\p{L}/gu) ?? []).length < MIN_LEAK_LENGTH) continue;
    out.push([w, caseRule(/^\p{Lu}/u.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))]);
  }
  return out;
}

/**
 * Everything to look for, and every pseudonym and vocabulary form whose text is not a finding.
 * `keep` (the policy keep list) only lowers person-name words that are keep terms to candidates.
 */
export function buildNeedles(spec: Spec, map: BlindMap, keep: readonly string[] = []): Needle[] {
  const out = new Map<string, Needle>();
  const add = (n: Needle | null) => {
    if (n === null) return;
    const key = `${n.role}\0${n.folded}\0${n.rule}\0${n.class}\0${n.source}\0${n.component}\0${n.part ?? ""}`;
    if (!out.has(key)) out.set(key, n);
  };
  const keepFolds = new Set(keep.map(fold));
  const vocabulary = vocabularyForms(spec.entities);
  const unrecurred = (n: Needle | null, value: string): Needle | null => {
    const why = n === null ? null : recurrenceExclusion(value, vocabulary);
    return n !== null && why !== null ? { ...n, excluded: why } : n;
  };
  for (const key of ENTITY_KEYS) {
    for (const e of spec.entities[key] ?? []) {
      for (const form of [e.canonical, ...e.aliases, ...e.parts]) {
        if (key === "vocabulary") add(needle(form, "fold", "vocabulary", "mask", "entity"));
        else add(needle(form, caseRule(form), key, "find", "entity"));
      }
    }
  }
  for (const e of map.entries) {
    const component = e.kind === "host-label" || e.kind === "email-local";
    add(unrecurred(needle(e.value, "fold", e.kind, "find", "map", component), e.value));
    add(unrecurred(needle(e.canonical, "fold", e.kind, "find", "map", component), e.canonical));
    add(needle(e.pseudonym, "fold", e.kind, "mask", "map"));
    // Only a name-shaped value has name parts, as the engine reads it (AGT-1852): a date or an
    // organisation blinded as a person ("17-Sep-1983", "Hill Valley Rescue") survives only whole.
    if (e.kind === "person" && nameShaped(e.value)) {
      for (const [w, rule] of personWords(e.value, e.canonical)) {
        const ordinary = DICTIONARY.has(w.toLowerCase()) || isLabelWord(w) || keepFolds.has(fold(w));
        add(needle(w, rule, "person", "find", "map", false, ordinary ? "word" : "name"));
      }
    }
  }
  return [...out.values()].sort((a, b) => cmp(a.folded, b.folded) || cmp(a.class, b.class) || cmp(a.role, b.role));
}

/** Needles bucketed by their first two code units (one for single-unit needles), for one pass over a text. */
class NeedleIndex {
  private readonly two = new Map<number, Needle[]>();
  private readonly one = new Map<number, Needle[]>();
  constructor(needles: readonly Needle[]) {
    for (const n of needles) {
      const long = n.folded.length >= 2;
      const m = long ? this.two : this.one;
      const k = long ? n.folded.charCodeAt(0) * 0x10000 + n.folded.charCodeAt(1) : n.folded.charCodeAt(0);
      const list = m.get(k) ?? [];
      list.push(n);
      m.set(k, list);
    }
  }
  /** Every (index, needle) occurrence in `text`, overlapping ones included. */
  *find(text: string): Generator<[number, Needle]> {
    const ones = this.one.size > 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (i + 1 < text.length) {
        const list = this.two.get(c * 0x10000 + text.charCodeAt(i + 1));
        if (list !== undefined) for (const n of list) if (text.startsWith(n.folded, i)) yield [i, n];
      }
      if (ones) for (const n of this.one.get(c) ?? []) yield [i, n];
    }
  }
}

// Pseudonym shapes, recognised by shape alone (and confirmed with isPseudonym), so pseudonyms from an
// earlier map are still recognised.
export const SHAPED_RE =
  /(?<![A-Za-z0-9_.-])(?:user_[0-9a-f]{4}@host-[0-9a-f]{4}(?:\.host-[0-9a-f]{4})*(?:\.[a-z]{2,63})?|host-[0-9a-f]{4}(?:\.host-[0-9a-f]{4})*(?:\.[a-z]{2,63})?|(?:Person|Org|Host|Id|Value|Loc)_[0-9A-F]{4}|(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3})/g;

interface Hit {
  start: number;
  end: number;
  severity: Severity;
  class: string;
  source: Finding["source"];
  reason: string;
  value: string;
  encoding: string;
  line: number;
}

function lineAt(text: string, newlines: number[] | undefined, i: number): [number, number[]] {
  const nl = newlines ?? [...text.matchAll(/\n/g)].map((m) => m.index);
  let lo = 0;
  let hi = nl.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((nl[mid] as number) < i) lo = mid + 1;
    else hi = mid;
  }
  return [lo + 1, nl];
}

interface Context {
  spec: Spec;
  map: BlindMap;
  index: NeedleIndex;
  /** Keep-list domains (keepDomains): host names under them are kept by the engine, by policy. */
  keep: string[];
  /** The keep list, folded: a lone word among them is never replaced in another case inside a name. */
  keepTerms: ReadonlySet<string>;
  /** The spec's patterns less `secret`, which is read in document text only (secretHits), never in every view. */
  shapes: Patterns;
  /** The values the output keeps whole in `keep` columns, and the placeholders: text the engine leaves as written wherever it stands (shield.ts). */
  shield: Shield;
}

// The same shapes unanchored, for "is this pattern match made only of pseudonyms?": a blinded name
// joins pseudonyms with "_" ("Person_1E95_user_559f@host-f3ce.com"), which reads as one email.
const SHAPED_ANY_RE = new RegExp(SHAPED_RE.source.replace("(?<![A-Za-z0-9_.-])", ""), "g");

/**
 * Pattern matches in a view. A name is also read piece by piece between underscores, as the
 * engine reads it, so "backup_db01.example.com" is checked as a host. Hosts under a keep-list
 * domain are dropped: the engine keeps them because the policy says to.
 */
function patternSpans(text: string, ctx: Context, isName: boolean): Span[] {
  const spans = findPatternSpans(text, ctx.shapes, ctx.keep);
  if (isName && text.includes("_")) {
    let offset = 0;
    for (const piece of text.split("_")) {
      for (const s of findPatternSpans(piece, ctx.shapes, ctx.keep)) {
        const start = s.start + offset;
        const end = s.end + offset;
        if (!spans.some((x) => x.start === start && x.end === end)) spans.push({ ...s, start, end });
      }
      offset += piece.length + 1;
    }
  }
  return spans.filter((s) => s.cls !== null);
}

/** Findings in one view: needle survivors outside pseudonym and vocabulary text, and non-pseudonym pattern matches. */
function scanView(view: View, ctx: Context, isName: boolean): Hit[] {
  const text = view.text;
  const f = foldWithMap(text);
  const srcEnd = (foldedEnd: number): number => {
    const at = f.map[foldedEnd - 1] as number;
    return at + String.fromCodePoint(text.codePointAt(at) as number).length;
  };
  const masks: [number, number][] = [];
  // Every pseudonym and pattern shape needs ASCII letters or digits; most non-text views have none.
  const ascii = /[0-9A-Za-z]/.test(text);
  const pseudo = new Uint8Array(ascii ? text.length : 0);
  for (const m of ascii ? text.matchAll(SHAPED_ANY_RE) : []) {
    if (isPseudonym(m[0], ctx.map)) pseudo.fill(1, m.index, m.index + m[0].length);
  }
  /** Every letter and digit of text[s, e) is inside a pseudonym. */
  const onlyPseudonyms = (s: number, e: number): boolean => {
    for (let i = s; i < e; i++) if (pseudo[i] === 0 && /[\p{L}\p{N}]/u.test(text[i] as string)) return false;
    return true;
  };
  for (const m of ascii ? text.matchAll(SHAPED_RE) : []) {
    if (isPseudonym(m[0], ctx.map)) masks.push([m.index, m.index + m[0].length]);
  }
  const found: [number, Needle][] = [];
  for (const [i, n] of ctx.index.find(f.text)) {
    const whole = (!n.wordStart || !isWordAt(f.text, i - 1)) && (!n.wordEnd || !isWordAt(f.text, i + n.folded.length));
    if (n.role === "mask") {
      if (whole) masks.push([f.map[i] as number, srcEnd(i + n.folded.length)]);
    } else found.push([i, n]);
  }
  // Sorted by start, with the furthest end so far: a range is masked when some mask starting at or
  // before it ends at or after it.
  for (const o of ctx.shield.occurrences(text)) masks.push([o.start, o.end]);
  masks.sort((x, y) => x[0] - y[0]);
  const reach: number[] = [];
  for (const [k, m] of masks.entries()) reach.push(Math.max(m[1], reach[k - 1] ?? -1));
  const masked = (s: number, e: number): boolean => {
    let lo = 0;
    let hi = masks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((masks[mid] as [number, number])[0] <= s) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && (reach[lo - 1] as number) >= e;
  };

  const hits: Hit[] = [];
  let newlines: number[] | undefined;
  const push = (start: number, end: number, h: Omit<Hit, "start" | "end" | "value" | "encoding" | "line">) => {
    let line: number;
    [line, newlines] = lineAt(text, newlines, start);
    hits.push({ ...h, start, end, value: text.slice(start, end), encoding: view.encoding, line });
  };
  for (const [i, n] of found) {
    const start = f.map[i] as number;
    const end = srcEnd(i + n.folded.length);
    if (masked(start, end)) continue;
    const whole = (!n.wordStart || !isWordAt(f.text, i - 1)) && (!n.wordEnd || !isWordAt(f.text, i + n.folded.length));
    const len = cps(n.folded).length;
    const what = n.source === "entity" ? `spec ${n.class} entity` : `${n.class} value from the map`;
    const base = { class: n.class, source: n.source };
    // A file, folder, sheet or defined name is also read as an identifier (AGT-1845): its words are
    // replaced in any case and across "_", "-", ".", spaces and CamelCase joins, so a match on word
    // boundaries there is a leak, as it is for the engine (names.ts), unless the engine would leave
    // a lone dictionary word, honorific or keep term alone.
    const asWords = isName && n.rule !== "exact" && !n.component && n.role === "find" && onNameTokens(text, start, end);
    if (asWords && !(n.part === "word" || (!/\s/.test(n.folded) && nameWordExcluded(text.slice(start, end), undefined, ctx.keepTerms)))) {
      const kind = n.part === undefined ? `${what}, as a word of the name` : "a word of a blinded person's name (from the map), as a word of the name";
      push(start, end, { ...base, severity: "leak", reason: `${kind}: blind replaces it there in any case` });
      continue;
    }
    if (n.part !== undefined) {
      // A word of a blinded person's name, alone: whole words only, never an embedded one.
      if (!whole) continue;
      const got = text.slice(start, end);
      // A month or weekday word in a date ("9 Jan.") is a date, as the engine reads it (AGT-1813).
      if (isDateWord(got) && inDateContext(text, start, end)) continue;
      const ruleCase = n.rule === "exact" ? got === n.original : /^\p{Lu}/u.test(got) && got.toLowerCase() === n.original.toLowerCase();
      if (ruleCase && n.part === "name") push(start, end, { ...base, severity: "leak", reason: "a word of a blinded person's name (from the map) survives on its own" });
      else if (ruleCase) push(start, end, { ...base, severity: "candidate", reason: "a word of a blinded person's name (from the map), also an ordinary word or a keep term" });
      else if (n.part === "name") push(start, end, { ...base, severity: "candidate", reason: "a word of a blinded person's name (from the map), in another case, accent or width" });
      continue;
    }
    if (!whole) {
      if (len >= MIN_EMBEDDED_LENGTH) push(start, end, { ...base, severity: "candidate", reason: `${what}, inside a longer word` });
      continue;
    }
    if (len < MIN_LEAK_LENGTH) {
      push(start, end, { ...base, severity: "candidate", reason: `${what}, under ${MIN_LEAK_LENGTH} characters` });
      continue;
    }
    if (n.component) {
      push(start, end, { ...base, severity: "candidate", reason: `part of a blinded value (${n.class})` });
      continue;
    }
    const got = collapse(text.slice(start, end));
    const exactCase =
      n.rule === "exact"
        ? got === n.original
        : got.toLowerCase() === n.original.toLowerCase() && (n.rule === "fold" || /^\p{Lu}/u.test(got));
    if (exactCase && n.excluded !== undefined) {
      push(start, end, { ...base, severity: "candidate", reason: `${what} survives, but blind does not recur it (${n.excluded})` });
    } else if (exactCase) push(start, end, { ...base, severity: "leak", reason: `${what} survives` });
    else push(start, end, { ...base, severity: "candidate", reason: `${what}, in another case, accent or width` });
  }
  for (const s of ascii ? patternSpans(text, ctx, isName) : []) {
    if (isPseudonym(s.value, ctx.map) || masked(s.start, s.end) || onlyPseudonyms(s.start, s.end)) continue;
    const name = s.pattern ?? patternName(s.value, ctx.spec.patterns);
    push(s.start, s.end, { class: `pattern:${name}`, source: "pattern", severity: "leak", reason: `${name} pattern match that is not a pseudonym` });
  }
  return hits;
}

const PATTERN_NAMES: readonly PatternName[] = ["email", "ip", "mac", "guid", "phone", "card", "address", "host", "secret"];

/** Which enabled pattern matches the whole value (the span itself only records the pseudonym class). */
function patternName(value: string, patterns: Patterns): PatternName | "pattern" {
  for (const name of PATTERN_NAMES) {
    if (!patternOn(patterns, name)) continue;
    const only = { ip: false, email: false, host: false, guid: false, mac: false, phone: false, card: false, address: false, secret: false, [name]: true };
    const [s] = findPatternSpans(value, only);
    if (s !== undefined && s.start === 0 && s.end === value.length) return name;
  }
  return "pattern";
}

type PlacedHit = Hit & { byteStart: number; byteEnd: number };

const SOURCE_RANK: Record<Finding["source"], number> = { entity: 0, map: 1, pattern: 2, spec: 3, scan: 4, semantic: 5, model: 6 };
const SEVERITY_RANK: Record<Severity, number> = { candidate: 0, leak: 1 };

/**
 * Hits from every view, without repeats: a hit that overlaps one already kept is dropped. The same
 * value read in two decodings of the same bytes is one hit (UTF-16 read at both alignments sees
 * ASCII text twice, one byte apart), and "Avery" inside "Avery Quill" is reported once, as the
 * longer value. The most severe hit is kept first, then the longest, then spec entities before map
 * values before patterns, then the earliest view.
 */
function scanViews(views: readonly View[], ctx: Context, isName = false): PlacedHit[] {
  const all: PlacedHit[] = [];
  for (const v of views) {
    for (const h of scanView(v, ctx, isName)) all.push({ ...h, byteStart: v.byteAt(h.start), byteEnd: v.byteAt(h.end) });
  }
  // Stable sort: equal hits keep view order.
  const ranked = all
    .map((h, i) => ({ h, i }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.h.severity] - SEVERITY_RANK[a.h.severity] ||
        b.h.byteEnd - b.h.byteStart - (a.h.byteEnd - a.h.byteStart) ||
        SOURCE_RANK[a.h.source] - SOURCE_RANK[b.h.source] ||
        a.i - b.i,
    );
  const kept: PlacedHit[] = [];
  for (const { h } of ranked) {
    const covered = kept.some((k) => k.byteStart < h.byteEnd && h.byteStart < k.byteEnd);
    if (!covered) kept.push(h);
  }
  return kept;
}

const IMAGE_MAGIC: [string, number[]][] = [
  ["PNG", [0x89, 0x50, 0x4e, 0x47]],
  ["JPEG", [0xff, 0xd8, 0xff]],
  ["GIF", [0x47, 0x49, 0x46, 0x38]],
  ["WebP/RIFF", [0x52, 0x49, 0x46, 0x46]],
  ["TIFF", [0x49, 0x49, 0x2a, 0x00]],
  ["TIFF", [0x4d, 0x4d, 0x00, 0x2a]],
  ["EMF", [0x01, 0x00, 0x00, 0x00]],
];

/** UTF-16 without a byte-order mark: one byte of nearly every pair is zero. Fully read by the UTF-16 views. */
function looksLikeUtf16(b: Uint8Array): boolean {
  if (b.length < 4 || b.length % 2 !== 0) return false;
  const zeros = [0, 0];
  for (let i = 0; i < b.length; i++) if (b[i] === 0) (zeros[i % 2] as number)++;
  const pairs = b.length / 2;
  return Math.max(zeros[0] as number, zeros[1] as number) >= 0.9 * pairs && Math.min(zeros[0] as number, zeros[1] as number) === 0;
}

function binaryKind(b: Uint8Array): string | null {
  for (const [name, magic] of IMAGE_MAGIC) if (magic.every((x, i) => b[i] === x)) return `${name} image`;
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return null;
  if (looksLikeUtf16(b)) return null;
  for (const x of b) if (x <= 0x08 || (x >= 0x0e && x <= 0x1a) || (x >= 0x1c && x <= 0x1f)) return "binary";
  return null;
}

interface PartSink {
  file: string;
  findings: Finding[];
}

function pushHits(sink: PartSink, part: string, where: Finding["in"], hits: readonly PlacedHit[], baseOffset = 0) {
  for (const h of hits) {
    sink.findings.push({
      file: sink.file,
      part,
      in: where,
      offset: baseOffset + h.byteStart,
      line: where === "content" ? h.line : null,
      class: h.class,
      source: h.source,
      severity: h.severity,
      masked: maskValue(h.value),
      reason: h.reason,
      encoding: where === "content" ? h.encoding : null,
    });
  }
}

function unscanned(sink: PartSink, part: string, reason: string, where: Finding["in"] = "content") {
  sink.findings.push({ file: sink.file, part, in: where, offset: null, line: null, class: "unscanned", source: "scan", severity: "candidate", masked: "", reason, encoding: null });
}

/**
 * A file or zip member name. A file's extension is read on its own, as the engine leaves it:
 * "….com.json" is not one host, and "word/_rels/document.xml.rels" is not the host
 * "document.xml.rels". Everything before the extension is still read, the stem's own dots included.
 */
function scanName(sink: PartSink, part: string, where: Finding["in"], name: string, ctx: Context, isName: boolean, hasExtension = true, at = 0) {
  const dot = hasExtension ? name.lastIndexOf(".") : -1;
  const stemEnd = dot > lastSegment(name) ? dot : name.length;
  pushHits(sink, part, where, scanViews(stringView(name.slice(0, stemEnd)), ctx, isName), at);
  if (stemEnd < name.length) pushHits(sink, part, where, scanViews(stringView(name.slice(stemEnd)), ctx, isName), at + stemEnd);
}

function scanBytes(sink: PartSink, part: string, bytes: Uint8Array, depth: number, ctx: Context, budget: ZipBudget) {
  if (!looksLikeZip(bytes)) {
    const kind = binaryKind(bytes);
    // A placeholder blind wrote in place of a picture (engine/images.ts) holds nothing to check.
    if (kind !== null && !isPlaceholderImage(bytes)) {
      unscanned(sink, part, `${kind} content: raw bytes and text encodings were scanned, but compressed or otherwise encoded content inside it cannot be checked`);
    }
    pushHits(sink, part, "content", scanViews(viewsOf(bytes), ctx));
    if (kind === null) secretHits(sink, part, bytes, ctx);
    return;
  }
  if (depth >= MAX_ZIP_DEPTH) {
    unscanned(sink, part, `archive nested more than ${MAX_ZIP_DEPTH} deep: not opened, raw bytes scanned only`);
    pushHits(sink, part, "content", scanViews(viewsOf(bytes), ctx));
    return;
  }
  let members;
  try {
    members = readZip(bytes, budget);
  } catch (e) {
    if (!(e instanceof ZipError)) throw e;
    unscanned(sink, part, `looks like a zip archive but cannot be read (${e.message}): raw bytes scanned only`);
    pushHits(sink, part, "content", scanViews(viewsOf(bytes), ctx));
    return;
  }
  // The archive's own bytes, less what is scanned below in decoded form (member data and names):
  // headers, extra fields, comments, data of members that could not be decoded, and anything between.
  const residual = Uint8Array.from(bytes);
  for (const m of members) {
    for (const [a, b] of m.nameRanges) residual.fill(0, a, b);
    if (m.bytes !== undefined) residual.fill(0, m.dataRange[0], m.dataRange[1]);
  }
  pushHits(sink, part, "content", scanViews(viewsOf(residual), ctx));
  const ooxml = members.some((m) => m.name === CONTENT_TYPES_PART);
  for (const m of [...members].sort((a, b) => cmp(a.name, b.name))) {
    const memberPart = part === "" ? m.name : `${part}!${m.name}`;
    scanName(sink, memberPart, "name", m.name, ctx, false);
    if (m.bytes === undefined) {
      unscanned(sink, memberPart, `${m.error ?? "not decoded"}; its raw bytes were scanned only`);
      continue;
    }
    scanBytes(sink, memberPart, ooxml ? blankOoxmlUris(m.name, m.bytes) : m.bytes, depth + 1, ctx, budget);
    if (ooxml) accountFindings(sink, memberPart, m.name, m.bytes, ctx);
    if (ooxml) customXmlFinding(sink, memberPart, m.name, m.bytes);
  }
}

/**
 * A custom XML data part (customXml/item*.xml) of an OOXML package holding any attribute value or
 * text that is not empty or structure. Blind rewrites nothing in such a part, so a written package
 * that still has one is a leak whatever the values are; the finding names the part, never a value.
 * The empty parts Word and Excel write themselves (a bibliography with no sources, cover-page and
 * SharePoint stubs) are not reported.
 */
function customXmlFinding(sink: PartSink, part: string, member: string, bytes: Uint8Array) {
  if (!customDataPart(member) || bytes.length === 0 || looksLikeZip(bytes)) return;
  const reason = customPartRefusal(member, xmlBaseView(bytes).text);
  if (reason === null) return;
  sink.findings.push({ file: sink.file, part, in: "content", offset: null, line: null, class: "custom-xml", source: "scan", severity: "leak", masked: "", reason, encoding: null });
}

// Tables and JSON: each cell or value is its own text to the engine, so no trigger reaches past it.
const STRUCTURED_RE = /\.(?:csv|tsv|tab|json|jsonl)$/i;
// XML elements whose text runs on into the next one's: a run and its text, and the wrappers around runs.
const INLINE_XML = new Set(["t", "r", "rPr", "hyperlink", "smartTag", "ins", "del", "sdt", "sdtContent", "fldSimple", "customXml", "moveFrom", "moveTo"]);
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Document text of an XML member, as the engine reads it: the text of runs joined, a line break
 * between paragraphs, cells and other elements, entities undone. `at[i]` is the view offset of
 * character i.
 */
function xmlDocumentText(t: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  const add = (s: string, from: number) => {
    for (let k = 0; k < s.length; k++) at.push(from);
    text += s;
  };
  walkXml(t, {
    text(start, end, parent) {
      if (parent === undefined) return;
      const run = localName(parent) === "t";
      if (!run) add("\n", start);
      for (const m of t.slice(start, end).matchAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);|[^&]+|&/giu)) {
        const from = start + m.index;
        const e = m[1];
        if (e === undefined) {
          for (let k = 0; k < m[0].length; k++) at.push(from + k);
          text += m[0];
          continue;
        }
        const cp = e.startsWith("#x") || e.startsWith("#X") ? Number.parseInt(e.slice(2), 16) : e.startsWith("#") ? Number(e.slice(1)) : undefined;
        add(cp === undefined ? (XML_ENTITIES[e] ?? m[0]) : Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m[0], from);
      }
      if (!run) add("\n", end);
    },
    tag(name, closing, selfClosing) {
      const local = localName(name);
      if (selfClosing && (local === "br" || local === "tab" || local === "cr")) add(" ", text.length === 0 ? 0 : (at[at.length - 1] as number));
      else if (closing && !INLINE_XML.has(local)) add("\n", text.length === 0 ? 0 : (at[at.length - 1] as number));
    },
  });
  return { text, at };
}

/**
 * Secret pattern matches (secret.ts) that survive in a part's document text: the whole text of a
 * plain file, read with the trigger boost unless it is a table or JSON, and the text nodes of an
 * XML member (never its markup or attributes). Images and binary parts are not read for secrets:
 * their bytes are not document text, and random bytes look like keys. Every match is a leak.
 */
function secretHits(sink: PartSink, part: string, bytes: Uint8Array, ctx: Context) {
  if (!patternOn(ctx.spec.patterns, "secret") || bytes.length === 0) return;
  const name = part === "" ? sink.file : part.slice(part.lastIndexOf("!") + 1);
  const view = xmlBaseView(bytes);
  const xml = looksLikeXml(name, view.text);
  const doc = xml ? xmlDocumentText(view.text) : null;
  const text = doc === null ? view.text : doc.text;
  const viewAt = (i: number): number => (doc === null ? i : (doc.at[i] as number));
  const found: PlacedHit[] = [];
  for (const s of secretSpans(text, { boost: xml || !STRUCTURED_RE.test(name) })) {
    const a = viewAt(s.start);
    const b = viewAt(s.end - 1) + 1;
    found.push({
      start: a,
      end: b,
      value: text.slice(s.start, s.end),
      encoding: view.encoding,
      line: lineAt(view.text, undefined, a)[0],
      class: "pattern:secret",
      source: "pattern",
      severity: "leak",
      reason: "secret pattern match (a password, key or token shape) that is not the placeholder",
      byteStart: view.byteAt(a),
      byteEnd: view.byteAt(b),
    });
  }
  pushHits(sink, part, "content", found);
}

/** app.xml elements whose text is a path. */
const PATH_ELEMENTS = new Set(["Template", "HyperlinkBase"]);

/**
 * Account names left in the paths of an OOXML package member: in any attribute but a namespace,
 * content-type or relationship-type URI, and in the text of Template and HyperlinkBase. Each one
 * that is not a pseudonym is a leak (`class` "account"), unless another finding already covers it.
 */
function accountFindings(sink: PartSink, part: string, member: string, bytes: Uint8Array, ctx: Context) {
  if (bytes.length === 0 || looksLikeZip(bytes)) return;
  const view = xmlBaseView(bytes);
  if (!looksLikeXml(member, view.text)) return;
  const found: PlacedHit[] = [];
  const check = (start: number, end: number) => {
    for (const seg of accountSegments(view.text.slice(start, end))) {
      if (isPseudonym(seg.value, ctx.map)) continue;
      const a = start + seg.start;
      const b = start + seg.end;
      const byteStart = view.byteAt(a);
      const byteEnd = view.byteAt(b);
      if (sink.findings.some((f) => f.part === part && f.in === "content" && f.offset !== null && f.offset >= byteStart && f.offset < byteEnd)) continue;
      found.push({
        start: a,
        end: b,
        value: seg.value,
        encoding: view.encoding,
        line: lineAt(view.text, undefined, a)[0],
        class: "account",
        source: "pattern",
        severity: "leak",
        reason: "an account name in a path survives",
        byteStart,
        byteEnd,
      });
    }
  };
  walkXml(view.text, {
    attribute(element, attr, start, end) {
      if (!ooxmlUriAttribute(member, element, attr)) check(start, end);
    },
    text(start, end, parent) {
      if (parent !== undefined && PATH_ELEMENTS.has(localName(parent))) check(start, end);
    },
  });
  pushHits(sink, part, "content", found);
}

/**
 * An OOXML package member with its namespace, content-type and relationship-type URIs
 * (ooxmlUriAttribute) and its fixed template IDs (officeIdAttribute "template") overwritten by spaces, same length, so offsets hold. Those values are format
 * structure: every package declares schemas.openxmlformats.org and the like, and they are never
 * document text. The positions come from parsing the member; the values themselves are never
 * consulted, so the same host anywhere else in the member is still found. A member that is not
 * XML, or is itself an archive, is returned as it is.
 */
export function blankOoxmlUris(member: string, bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0 || looksLikeZip(bytes)) return bytes;
  const view = xmlBaseView(bytes);
  if (!looksLikeXml(member, view.text)) return bytes;
  const ranges: [number, number][] = [];
  walkXml(view.text, {
    attribute(element, attr, start, end) {
      if (end > start && (ooxmlUriAttribute(member, element, attr) || officeIdAttribute(member, element, attr) === "template")) ranges.push([view.byteAt(start), view.byteAt(end)]);
    },
  });
  if (ranges.length === 0) return bytes;
  const out = Uint8Array.from(bytes);
  // A space in the member's own encoding: UTF-16 views map code unit k to bytes 2k and 2k + 1.
  const space = view.encoding === "utf-16le" ? [0x20, 0x00] : view.encoding === "utf-16be" ? [0x00, 0x20] : [0x20];
  for (const [a, b] of ranges) for (let k = a; k < b; k++) out[k] = space[(k - a) % space.length] as number;
  return out;
}

const TABLE_EXTENSIONS: Record<string, "csv" | "tsv"> = { ".csv": "csv", ".tsv": "tsv", ".tab": "tsv" };

function tableFormat(path: string): "csv" | "tsv" | null {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/") + 1) return null;
  return TABLE_EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

const columnLabel = (r: ColumnRule): string =>
  r.jsonPath !== undefined ? `key ${maskValue(r.jsonPath)}` : `column ${r.header === "" ? "(blank header)" : maskValue(r.header)}`;

/**
 * Declared unknowns (spec rules with class `unknown`, apart from dropped, redacted and scanned
 * columns, which are decided) and, for CSV/TSV, columns the spec does not mention, a dropped column still present
 * and a redacted column holding anything but the placeholder.
 */
function columnFindings(sink: PartSink, bytes: Uint8Array, rules: readonly ColumnRule[]) {
  const spec = (reason: string, masked = "") =>
    sink.findings.push({ file: sink.file, part: "", in: "content", offset: null, line: null, class: "unknown", source: "spec", severity: "candidate", masked, reason, encoding: null });
  const breach = (r: ColumnRule, reason: string) =>
    sink.findings.push({ file: sink.file, part: "", in: "content", offset: null, line: null, class: r.class, source: "spec", severity: "leak", masked: "", reason, encoding: null });
  for (const r of rules) {
    // A `scan` column needs no class: it is kept and scanned as free text, and audited as free text.
    if (r.class === "unknown" && r.treatment !== "drop" && r.treatment !== "redact" && r.treatment !== "scan") spec(`the spec declares ${columnLabel(r)} as unknown (treatment ${r.treatment})`);
  }
  const format = tableFormat(sink.file);
  if (format === null) return;
  let text: string;
  try {
    text = decode(bytes).text;
  } catch (e) {
    if (!(e instanceof EncodingError)) throw e;
    spec(`cannot decode the table to check its columns against the spec (${e.message})`);
    return;
  }
  let rows;
  try {
    rows = parseCsv(text, sniffDelimiter(text, format === "tsv" ? "\t" : undefined));
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    spec(`cannot parse the table to check its columns against the spec (${e.message})`);
    return;
  }
  if (rows.length === 0) return;
  const headerRow = (detectHeaderRow(rows.map((r) => r.cells.map((c) => c.value))) ?? 1) - 1;
  const headers = (rows[headerRow]?.cells ?? []).map((c) => c.value);
  // The header sets the columns; a data row's extra cells continue the last column, as the engine reads them.
  const width = headers.length;
  const named = new Set(rules.filter((r) => r.header !== undefined).map((r) => (r.header as string).trim()));
  for (const r of rules) {
    // A `secret` column under `blind` is redacted too (columns.ts).
    const redacts = r.treatment === "redact" || (r.treatment === "blind" && r.class === "secret");
    if (r.header === undefined || (r.treatment !== "drop" && !redacts)) continue;
    const col = headers.findIndex((h) => h.trim() === (r.header as string).trim());
    if (col < 0) continue;
    if (r.treatment === "drop") {
      breach(r, `the spec drops ${columnLabel(r)}, but the output still has it (column ${col + 1})`);
      continue;
    }
    const left = rows.slice(headerRow + 1).filter((row) => {
      const owned = col === width - 1 ? row.cells.slice(col) : row.cells.slice(col, col + 1);
      return owned.some((c) => c.value.trim() !== "" && c.value !== REDACTED_VALUE);
    }).length;
    if (left > 0) breach(r, `the spec redacts ${columnLabel(r)}, but ${left} cell(s) in it are not ${REDACTED_VALUE}`);
  }
  shapedColumns(sink, rows, headerRow, headers, rules);
  birthDateColumns(sink, rows, headerRow, headers, rules);
  for (let col = 0; col < width; col++) {
    const h = headers[col] ?? "";
    if (named.has(h.trim())) continue;
    spec(
      `column ${col + 1} (${h.trim() === "" ? "blank header" : `header ${maskValue(h)}`}) has no spec rule; the engine decided it at apply time`,
      h.trim() === "" ? "" : maskValue(h),
    );
  }
}

/**
 * A CSV/TSV column named for a birth date that no rule decides (no rule, or `unknown`/`value`) is
 * redacted by the engine (AGT-1858); a cell in it that is anything but the placeholder is a leak. A
 * column the spec keeps, drops, redacts, scans or blinds is decided, and not checked here.
 */
function birthDateColumns(sink: PartSink, rows: readonly { cells: { value: string }[] }[], headerRow: number, headers: readonly string[], rules: readonly ColumnRule[]) {
  const width = headers.length;
  for (let col = 0; col < width; col++) {
    const h = headers[col] ?? "";
    if (!isBirthDateName(h)) continue;
    const rule = rules.find((r) => r.header !== undefined && r.header.trim() === h.trim());
    if (rule !== undefined && !(rule.class === "unknown" && rule.treatment === "value")) continue;
    const left = rows
      .slice(headerRow + 1)
      .flatMap((row) => (col === width - 1 ? row.cells.slice(col) : row.cells.slice(col, col + 1)))
      .filter((c) => c.value.trim() !== "" && c.value !== REDACTED_VALUE);
    if (left.length === 0) continue;
    sink.findings.push({
      file: sink.file, part: "", in: "content", offset: null, line: null, class: "id", source: "spec", severity: "leak", masked: maskValue((left[0] as { value: string }).value),
      reason: `column ${col + 1} (header ${maskValue(h)}) is a birth-date column with no rule, but ${left.length} cell(s) in it are not ${REDACTED_VALUE}`,
      encoding: null,
    });
  }
}

/**
 * A CSV/TSV column written as licence plates or usernames/handles (src/engine/shapes.ts, the test the
 * heuristic classifies columns by) is a leak: no free-text pattern replaces those, so a column of them
 * left in clear (unruled under `[defaults] columns = "scan"`, or ruled `scan`) is the whole column
 * leaking. A column the spec keeps, drops or redacts, or classes vocabulary, is not checked.
 */
function shapedColumns(sink: PartSink, rows: readonly { cells: { value: string }[] }[], headerRow: number, headers: readonly string[], rules: readonly ColumnRule[]) {
  const width = headers.length;
  for (let col = 0; col < width; col++) {
    const h = headers[col] ?? "";
    const rule = rules.find((r) => r.header !== undefined && r.header.trim() === h.trim());
    if (rule !== undefined && (rule.treatment === "keep" || rule.treatment === "drop" || rule.treatment === "redact" || rule.class === "vocabulary")) continue;
    const values = rows.slice(headerRow + 1).flatMap((row) => (col === width - 1 ? row.cells.slice(col) : row.cells.slice(col, col + 1)).map((c) => c.value));
    const stats = valueStats(values, 0);
    for (const shape of ["plate", "handle"] as const) {
      if (!shapeHolds(shape, stats, h)) continue;
      const first = values.find((v) => (shape === "plate" ? isPlate(v) : isHandle(v))) ?? "";
      const what = shape === "plate" ? "licence plates" : "usernames or handles";
      sink.findings.push({
        file: sink.file, part: "", in: "content", offset: null, line: null, class: "id", source: "scan", severity: "leak", masked: maskValue(first),
        reason: `column ${col + 1} (${h.trim() === "" ? "blank header" : `header ${maskValue(h)}`}) is written as ${what} in clear (shape: ${shape}, ${Math.round((stats.detectorRates[shape] ?? 0) * 100)}%)`,
        encoding: null,
      });
      break;
    }
  }
}

/**
 * 8-bit text that is not UTF-8 in an output tree. The engine refuses to read or write such a file
 * (AGT-1857), so one present in the output was never blinded: a leak whatever its values are.
 */
const TEXT_FORMAT_RE = /\.(?:csv|tsv|tab|json|jsonl|ndjson|txt|text|md|markdown|log|vtt|srt)$/i;
function eightBitFinding(sink: PartSink, path: string, bytes: Uint8Array) {
  if (!TEXT_FORMAT_RE.test(path) || !isEightBit(bytes)) return;
  sink.findings.push({
    file: sink.file, part: "", in: "content", offset: null, line: null, class: "encoding", source: "scan", severity: "leak", masked: "",
    reason: "8-bit text that is not UTF-8 is in the output; blind refuses such files, so it was never blinded", encoding: null,
  });
}

/**
 * A pattern match, entity or map value inside a cell of a column the spec keeps is kept on purpose:
 * blind leaves that cell as it is, so the finding is a candidate saying so, not a leak. Only a
 * table read as UTF-8 or Latin-1 is placed (byte offsets are exact there); in any other the
 * findings stand.
 */
function keptByRule(sink: PartSink, bytes: Uint8Array, rules: readonly ColumnRule[]) {
  const format = tableFormat(sink.file);
  if (format === null || !rules.some((r) => r.treatment === "keep")) return;
  let decoded;
  try {
    decoded = decode(bytes);
  } catch (e) {
    if (!(e instanceof EncodingError)) throw e;
    return;
  }
  if (decoded.encoding !== "utf8" && decoded.encoding !== "utf8-bom") return;
  const cells = keptCells(decoded.text, format === "tsv", rules);
  if (cells.length === 0) return;
  const bom = decoded.encoding === "utf8-bom" ? 3 : 0;
  const place = (at: number): number => Buffer.byteLength(decoded.text.slice(0, at), "utf8") + bom;
  const ranges = cells.map((c) => [place(c.start), place(c.end)] as const);
  sink.findings = sink.findings.map((f) => {
    if (f.severity !== "leak" || f.part !== "" || f.in !== "content" || f.offset === null) return f;
    if (f.source !== "pattern" && f.source !== "entity" && f.source !== "map") return f;
    const at = f.offset;
    if (!ranges.some(([a, b]) => at >= a && at < b)) return f;
    return { ...f, severity: "candidate" as const, reason: `${f.reason}; in a column the spec keeps (kept by rule)` };
  });
}

/**
 * The shield the engine used, read back from the output: every value held whole in a CSV/TSV `keep`
 * column, less those the map or a spec entity also blinds, and the built-in placeholders.
 */
function shieldOf(entries: readonly TreeEntry[], spec: Spec, map: BlindMap, rulesByFile: ReadonlyMap<string, readonly ColumnRule[]>, placeholders: boolean): Shield {
  const kept: string[] = [];
  for (const entry of entries) {
    const rules = rulesByFile.get(entry.path);
    const format = tableFormat(entry.path);
    if (entry.kind !== "file" || format === null || rules === undefined || !rules.some((r) => r.treatment === "keep")) continue;
    try {
      for (const c of keptCells(decode(entry.bytes).text, format === "tsv", rules)) kept.push(c.value);
    } catch (e) {
      if (!(e instanceof EncodingError)) throw e;
    }
  }
  const explicit = [
    ...map.entries.map((e) => e.value),
    ...Object.values(spec.entities).flatMap((list) => (list ?? []).flatMap((e) => [e.canonical, ...e.aliases])),
  ];
  return new Shield(kept, explicit, placeholders);
}

const lastSegment = (p: string): number => p.lastIndexOf("/") + 1;

export function statusOf(findings: readonly Finding[]): Status {
  if (findings.some((f) => f.severity === "leak")) return "leak";
  return findings.length > 0 ? "candidates" : "clean";
}

const IN_RANK: Record<Finding["in"], number> = { name: 0, link: 1, content: 2 };

export function compareFindings(a: Finding, b: Finding): number {
  return (
    cmp(a.file, b.file) ||
    cmp(a.part, b.part) ||
    IN_RANK[a.in] - IN_RANK[b.in] ||
    (a.offset ?? -1) - (b.offset ?? -1) ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
    cmp(a.class, b.class) ||
    cmp(a.reason, b.reason) ||
    cmp(a.masked, b.masked)
  );
}

/**
 * The report with one more layer's findings added: `layer` appended to the layers, `perFile`
 * merged into each file (a file with no line yet is added), `general` added, and every status and
 * count recomputed. Nothing already in the report is removed or downgraded.
 */
export function addLayer(
  report: AuditReport,
  layer: string,
  entries: readonly TreeEntry[],
  perFile: ReadonlyMap<string, readonly Finding[]>,
  general: readonly Finding[] = [],
): AuditReport {
  const kinds = new Map(entries.map((e) => [e.path, e.kind]));
  const files = new Map<string, FileAudit>(report.files.map((f) => [f.path, { ...f, findings: [...f.findings] }]));
  for (const [path, findings] of perFile) {
    if (findings.length === 0) continue;
    const f = files.get(path) ?? { path, kind: kinds.get(path) ?? "file", status: "clean" as Status, findings: [] };
    f.findings.push(...findings);
    f.findings.sort(compareFindings);
    f.status = statusOf(f.findings);
    files.set(path, f);
  }
  const merged = [...files.values()].sort((a, b) => cmp(a.path, b.path));
  const allGeneral = [...report.general, ...general].sort(compareFindings);
  const all = [...merged.flatMap((f) => f.findings), ...allGeneral];
  const leaks = all.filter((f) => f.severity === "leak").length;
  const status = merged.reduce<Status>((s, f) => (STATUS_RANK[f.status] > STATUS_RANK[s] ? f.status : s), statusOf(allGeneral));
  return {
    ...report,
    status,
    layers: [...report.layers, layer],
    files: merged,
    general: allGeneral,
    summary: { files: report.summary.files, leaks, candidates: all.length - leaks },
  };
}

/** Audit an output tree (every entry under it, paths relative to its root) against the spec and map. */
export function auditTree(entries: readonly TreeEntry[], spec: Spec, map: BlindMap, keep: readonly string[] = [], placeholders = true): AuditReport {
  const rulesByFile = new Map<string, ColumnRule[]>();
  for (const r of spec.columns) rulesByFile.set(r.file, [...(rulesByFile.get(r.file) ?? []), r]);
  const ctx: Context = {
    spec,
    map,
    index: new NeedleIndex(buildNeedles(spec, map, keep)),
    keep: keepDomains(keep),
    keepTerms: new Set(keep.map(fold)),
    shapes: { ...spec.patterns, card: patternOn(spec.patterns, "card"), secret: false },
    shield: shieldOf(entries, spec, map, rulesByFile, placeholders),
  };

  const files: FileAudit[] = [];
  for (const entry of [...entries].sort((a, b) => cmp(a.path, b.path))) {
    const sink: PartSink = { file: entry.path, findings: [] };
    const nameAt = lastSegment(entry.path);
    scanName(sink, "", "name", entry.path.slice(nameAt), ctx, true, entry.kind === "file", nameAt);
    switch (entry.kind) {
      case "file":
        scanBytes(sink, "", entry.bytes, 0, ctx, zipBudget());
        eightBitFinding(sink, entry.path, entry.bytes);
        columnFindings(sink, entry.bytes, rulesByFile.get(entry.path) ?? []);
        keptByRule(sink, entry.bytes, rulesByFile.get(entry.path) ?? []);
        break;
      case "symlink":
        unscanned(sink, "", "symbolic link, not followed: whatever it points to was not audited", "link");
        pushHits(sink, "", "link", scanViews(stringView(entry.target), ctx));
        break;
      case "other":
        unscanned(sink, "", "not a regular file, directory or symbolic link: not read");
        break;
      case "unreadable":
        unscanned(sink, "", `cannot be read (${entry.reason})`);
        break;
      case "dir":
        break;
    }
    sink.findings.sort(compareFindings);
    if (entry.kind === "dir" && sink.findings.length === 0) continue;
    files.push({ path: entry.path, kind: entry.kind, status: statusOf(sink.findings), findings: sink.findings });
  }

  const general: Finding[] = spec.questions
    .filter((q) => q.answer === null)
    .map((q) => ({
      file: "(spec)",
      part: "",
      in: "content" as const,
      offset: null,
      line: null,
      class: "unknown",
      source: "spec" as const,
      severity: "candidate" as const,
      masked: "",
      reason: `spec question ${JSON.stringify(q.id)} is unanswered`,
      encoding: null,
    }));
  general.sort(compareFindings);

  const all = [...files.flatMap((f) => f.findings), ...general];
  const leaks = all.filter((f) => f.severity === "leak").length;
  const status = files.reduce<Status>((s, f) => (STATUS_RANK[f.status] > STATUS_RANK[s] ? f.status : s), statusOf(general));
  return {
    version: 1,
    status,
    layers: ["mechanical"],
    files,
    general,
    summary: { files: entries.filter((e) => e.kind !== "dir").length, leaks, candidates: all.length - leaks },
  };
}
