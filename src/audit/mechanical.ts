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
// - every match of an enabled spec pattern that is not a pseudonym.
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

import type { ColumnRule, PatternName, Spec } from "../schema.ts";
import { CsvError, parseCsv, sniffDelimiter } from "../engine/csv.ts";
import { decode, EncodingError } from "../engine/encoding.ts";
import type { BlindMap } from "../engine/map.ts";
import { isPseudonym } from "../engine/pseudonym.ts";
import { findPatternSpans } from "../engine/text.ts";
import { detectHeaderRow } from "../profile/table.ts";
import { fold, foldWithMap, stringView, type View, viewsOf } from "./views.ts";
import { looksLikeZip, readZip, ZipError } from "./zip.ts";

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
  source: "entity" | "map" | "pattern" | "spec" | "scan";
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
  /** Layers that ran. Only `mechanical` exists in this build. */
  layers: string[];
  files: FileAudit[];
  /** Findings not tied to one file (unanswered spec questions). */
  general: Finding[];
  summary: { files: number; leaks: number; candidates: number };
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

/** First characters (at most 2, never more than half), `***`, length. Control characters show as `?`. */
export function maskValue(s: string): string {
  const chars = cps(s);
  const show = Math.min(2, Math.floor(chars.length / 2));
  return `${chars.slice(0, show).join("").replace(/[\p{C}\s]/gu, "?")}***${chars.length}`;
}

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
  wordStart: boolean;
  wordEnd: boolean;
}

function needle(value: string, rule: CaseRule, cls: string, role: Needle["role"], source: Needle["source"], component = false): Needle | null {
  const folded = fold(value);
  if (folded === "") return null;
  return {
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

/** Everything to look for, and every pseudonym and vocabulary form whose text is not a finding. */
export function buildNeedles(spec: Spec, map: BlindMap): Needle[] {
  const out = new Map<string, Needle>();
  const add = (n: Needle | null) => {
    if (n === null) return;
    const key = `${n.role}\0${n.folded}\0${n.rule}\0${n.class}\0${n.source}\0${n.component}`;
    if (!out.has(key)) out.set(key, n);
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
    add(needle(e.value, "fold", e.kind, "find", "map", component));
    add(needle(e.canonical, "fold", e.kind, "find", "map", component));
    add(needle(e.pseudonym, "fold", e.kind, "mask", "map"));
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
const SHAPED_RE =
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
}

/** Findings in one view: needle survivors outside pseudonym and vocabulary text, and non-pseudonym pattern matches. */
function scanView(view: View, ctx: Context): Hit[] {
  const text = view.text;
  const f = foldWithMap(text);
  const srcEnd = (foldedEnd: number): number => {
    const at = f.map[foldedEnd - 1] as number;
    return at + String.fromCodePoint(text.codePointAt(at) as number).length;
  };
  const masks: [number, number][] = [];
  // Every pseudonym and pattern shape needs ASCII letters or digits; most non-text views have none.
  const ascii = /[0-9A-Za-z]/.test(text);
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
    if (exactCase) push(start, end, { ...base, severity: "leak", reason: `${what} survives` });
    else push(start, end, { ...base, severity: "candidate", reason: `${what}, in another case, accent or width` });
  }
  for (const s of ascii ? findPatternSpans(text, ctx.spec.patterns) : []) {
    if (isPseudonym(s.value, ctx.map) || masked(s.start, s.end)) continue;
    const name = patternName(s.value, ctx.spec.patterns);
    push(s.start, s.end, { class: `pattern:${name}`, source: "pattern", severity: "leak", reason: `${name} pattern match that is not a pseudonym` });
  }
  return hits;
}

const PATTERN_NAMES: readonly PatternName[] = ["email", "ip", "mac", "guid", "host"];

/** Which enabled pattern matches the whole value (the span itself only records the pseudonym class). */
function patternName(value: string, patterns: Record<PatternName, boolean>): PatternName | "pattern" {
  for (const name of PATTERN_NAMES) {
    if (!patterns[name]) continue;
    const only = { ip: false, email: false, host: false, guid: false, mac: false, [name]: true };
    const [s] = findPatternSpans(value, only);
    if (s !== undefined && s.start === 0 && s.end === value.length) return name;
  }
  return "pattern";
}

type PlacedHit = Hit & { byteStart: number; byteEnd: number };

const SOURCE_RANK: Record<Finding["source"], number> = { entity: 0, map: 1, pattern: 2, spec: 3, scan: 4 };
const SEVERITY_RANK: Record<Severity, number> = { candidate: 0, leak: 1 };

/**
 * Hits from every view, without repeats: a hit that overlaps one already kept is dropped. The same
 * value read in two decodings of the same bytes is one hit (UTF-16 read at both alignments sees
 * ASCII text twice, one byte apart), and "Avery" inside "Avery Quill" is reported once, as the
 * longer value. The most severe hit is kept first, then the longest, then spec entities before map
 * values before patterns, then the earliest view.
 */
function scanViews(views: readonly View[], ctx: Context): PlacedHit[] {
  const all: PlacedHit[] = [];
  for (const v of views) {
    for (const h of scanView(v, ctx)) all.push({ ...h, byteStart: v.byteAt(h.start), byteEnd: v.byteAt(h.end) });
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

function scanBytes(sink: PartSink, part: string, bytes: Uint8Array, depth: number, ctx: Context) {
  if (!looksLikeZip(bytes)) {
    const kind = binaryKind(bytes);
    if (kind !== null) {
      unscanned(sink, part, `${kind} content: raw bytes and text encodings were scanned, but compressed or otherwise encoded content inside it cannot be checked`);
    }
    pushHits(sink, part, "content", scanViews(viewsOf(bytes), ctx));
    return;
  }
  if (depth >= MAX_ZIP_DEPTH) {
    unscanned(sink, part, `archive nested more than ${MAX_ZIP_DEPTH} deep: not opened, raw bytes scanned only`);
    pushHits(sink, part, "content", scanViews(viewsOf(bytes), ctx));
    return;
  }
  let members;
  try {
    members = readZip(bytes);
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
  for (const m of [...members].sort((a, b) => cmp(a.name, b.name))) {
    const memberPart = part === "" ? m.name : `${part}!${m.name}`;
    pushHits(sink, memberPart, "name", scanViews(stringView(m.name), ctx));
    if (m.bytes === undefined) {
      unscanned(sink, memberPart, `${m.error ?? "not decoded"}; its raw bytes were scanned only`);
      continue;
    }
    scanBytes(sink, memberPart, m.bytes, depth + 1, ctx);
  }
}

const TABLE_EXTENSIONS: Record<string, "csv" | "tsv"> = { ".csv": "csv", ".tsv": "tsv", ".tab": "tsv" };

function tableFormat(path: string): "csv" | "tsv" | null {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/") + 1) return null;
  return TABLE_EXTENSIONS[path.slice(dot).toLowerCase()] ?? null;
}

const columnLabel = (r: ColumnRule): string =>
  r.jsonPath !== undefined ? `key ${maskValue(r.jsonPath)}` : `column ${r.header === "" ? "(blank header)" : maskValue(r.header)}`;

/** Declared unknowns (spec rules with class `unknown`) and, for CSV/TSV, columns the spec does not mention. */
function columnFindings(sink: PartSink, bytes: Uint8Array, rules: readonly ColumnRule[]) {
  const spec = (reason: string, masked = "") =>
    sink.findings.push({ file: sink.file, part: "", in: "content", offset: null, line: null, class: "unknown", source: "spec", severity: "candidate", masked, reason, encoding: null });
  for (const r of rules) {
    if (r.class === "unknown") spec(`the spec declares ${columnLabel(r)} as unknown (treatment ${r.treatment})`);
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
    rows = parseCsv(text, format === "tsv" ? "\t" : sniffDelimiter(text));
  } catch (e) {
    if (!(e instanceof CsvError)) throw e;
    spec(`cannot parse the table to check its columns against the spec (${e.message})`);
    return;
  }
  if (rows.length === 0) return;
  const headerRow = (detectHeaderRow(rows.map((r) => r.cells.map((c) => c.value))) ?? 1) - 1;
  const headers = (rows[headerRow]?.cells ?? []).map((c) => c.value);
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  const named = new Set(rules.filter((r) => r.header !== undefined).map((r) => (r.header as string).trim()));
  for (let col = 0; col < width; col++) {
    const h = headers[col] ?? "";
    if (named.has(h.trim())) continue;
    spec(
      `column ${col + 1} (${h.trim() === "" ? "blank header" : `header ${maskValue(h)}`}) has no spec rule; the engine decided it at apply time`,
      h.trim() === "" ? "" : maskValue(h),
    );
  }
}

const lastSegment = (p: string): number => p.lastIndexOf("/") + 1;

function statusOf(findings: readonly Finding[]): Status {
  if (findings.some((f) => f.severity === "leak")) return "leak";
  return findings.length > 0 ? "candidates" : "clean";
}

const IN_RANK: Record<Finding["in"], number> = { name: 0, link: 1, content: 2 };

function compareFindings(a: Finding, b: Finding): number {
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

/** Audit an output tree (every entry under it, paths relative to its root) against the spec and map. */
export function auditTree(entries: readonly TreeEntry[], spec: Spec, map: BlindMap): AuditReport {
  const ctx: Context = { spec, map, index: new NeedleIndex(buildNeedles(spec, map)) };
  const rulesByFile = new Map<string, ColumnRule[]>();
  for (const r of spec.columns) rulesByFile.set(r.file, [...(rulesByFile.get(r.file) ?? []), r]);

  const files: FileAudit[] = [];
  for (const entry of [...entries].sort((a, b) => cmp(a.path, b.path))) {
    const sink: PartSink = { file: entry.path, findings: [] };
    const nameAt = lastSegment(entry.path);
    pushHits(sink, "", "name", scanViews(stringView(entry.path.slice(nameAt)), ctx), nameAt);
    switch (entry.kind) {
      case "file":
        scanBytes(sink, "", entry.bytes, 0, ctx);
        columnFindings(sink, entry.bytes, rulesByFile.get(entry.path) ?? []);
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
