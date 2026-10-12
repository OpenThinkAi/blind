// The semantic audit layer: a candidate finder that does not share the engine's
// spec. The mechanical layer finds only what the spec and map know; this layer
// points at what nobody explained. It reads the same output tree (every file,
// every name, every zip member, the same text views) and reports, as
// candidates, anything shaped like something identifying:
//
// - identifier-shaped tokens: hex runs of 6 or more (with a digit and a letter),
//   tokens with 4 or more digits mixed with letters, and runs of 10 or more
//   digits (not the fraction of a decimal number);
// - Title-Case phrases of two or more words, after the policy keep list, the
//   spec's vocabulary (entity forms and the values of vocabulary columns) and
//   the spec's own column headers for that file are taken out;
// - email and host shapes.
//
// Anything `isPseudonym` recognises is excluded, and so is any value equal to a
// keep or vocabulary term. XML members (xlsx, docx) are read as their text
// nodes (adjacent runs joined, so a name split across runs is one phrase) and
// their attribute values, less a fixed list of format-structure attributes
// (namespaces, revision and paragraph ids, colours, fonts, content types,
// Office extension URIs); every other file or member is read in every view the
// mechanical layer uses. ISO 8601 timestamps are not identifier tokens.
//
// Candidates are deduplicated by value per file (the first location is
// reported, with how often the value occurs) and capped at MAX_PER_FILE per
// file, with one more finding giving the count of the rest. Every finding is a
// `candidate`: this layer never reports a leak and never removes or downgrades
// a mechanical finding. No model, no clock, no randomness.

import { CsvError, parseCsv, sniffDelimiter } from "../engine/csv.ts";
import { decode, EncodingError } from "../engine/encoding.ts";
import { JsonError, scanJson, scanJsonl } from "../engine/json.ts";
import type { BlindMap } from "../engine/map.ts";
import { isPseudonym } from "../engine/pseudonym.ts";
import { keepDomains, underKeptDomain } from "../engine/text.ts";
import type { Spec } from "../schema.ts";
import {
  addLayer,
  type AuditReport,
  type Finding,
  maskValue,
  MAX_ZIP_DEPTH,
  SHAPED_RE,
  type TreeEntry,
} from "./mechanical.ts";
import { fold, stringView, unescapeView, type View, viewsOf, xmlBaseView } from "./views.ts";
import { localName, looksLikeXml, officeDisplayName, officeIdAttribute, ooxmlUriAttribute, walkXml } from "./xml.ts";
import { looksLikeZip, readZip, ZipError } from "./zip.ts";

/** Distinct candidates listed per file; the rest are counted in one extra finding. */
export const MAX_PER_FILE = 200;

export type SemanticKind = "hex" | "alnum-id" | "digits" | "phrase" | "email" | "host";

export interface SemanticOptions {
  /** The policy keep list (`[keep] terms` in blind.toml). */
  keep: readonly string[];
}

const KIND_REASON: Record<SemanticKind, string> = {
  hex: "hex-shaped token (6 or more hex digits) that is not a pseudonym",
  "alnum-id": "identifier-shaped token (4 or more digits mixed with letters) that is not a pseudonym",
  digits: "run of 10 or more digits that is not a pseudonym",
  phrase: "Title-Case phrase not in the keep list or the spec's vocabulary",
  email: "email-shaped text that is not a pseudonym",
  host: "host-shaped text that is not a pseudonym",
};

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- Exclusions -----------------------------------------------------------

/** Leading words dropped from a Title-Case run before it is judged ("The Example Group" is judged as "Example Group"). */
const LEADING_FUNCTION_WORDS = new Set(
  "a an the this that these those and or but nor so if when then as is are was were be in on at for from to with by of per via our my your their his her its we all any no not".split(" "),
);

/** Final labels that make a dotted word a file name, not a host. */
const FILE_EXTENSIONS = new Set(
  "txt csv tsv tab md markdown log json jsonl xml rels vml xlsx xlsm xls docx docm doc pptx ppt pdf png jpg jpeg gif bmp tif tiff emf wmf svg html htm css js mjs cjs ts tsx jsx py rb sh toml yaml yml ini cfg conf zip gz tgz bin dat tmp bak vtt srt rtf odt ods eml msg".split(" "),
);

/** Hosts that only ever appear as format structure (OOXML and XML namespaces, schema URIs). */
const STRUCTURAL_HOSTS = new Set(["schemas.openxmlformats.org", "schemas.microsoft.com", "www.w3.org", "purl.org", "ns.adobe.com"]);

/** XML attributes that carry format structure only, by local name. */
const STRUCTURAL_ATTRIBUTES = new Set([
  "space", // xml:space
  "Ignorable",
  "ProcessContent",
  "PreserveAttributes",
  "MustUnderstand",
  "Requires",
  "paraId",
  "textId",
  "durableId",
  "uid",
  "typeface",
  "panose",
  "pitchFamily",
  "charset",
  "ContentType",
  "Extension",
  "PartName",
  "rgb",
  "lastClr",
  "themeColor",
  "themeFill",
  "themeTint",
  "themeShade",
]);
/** Elements whose every attribute is format structure, by local name: colours. */
const STRUCTURAL_ELEMENTS = new Set(["color", "srgbClr", "sysClr", "fgColor", "bgColor", "shd", "highlight", "tabColor"]);

/**
 * Every position the mechanical layer skips (ooxmlUriAttribute: namespace, content-type and
 * relationship-type URIs; officeIdAttribute "template": fixed template IDs), and more: this layer
 * also skips Office's linking IDs (officeIdAttribute "linking", which the engine replaces), ids,
 * fonts and colours, which are identifier-shaped but never identifying, and the display names of
 * Office themes, schemes and styles (officeDisplayName).
 */
function structuralAttribute(member: string, element: string, attr: string): boolean {
  if (ooxmlUriAttribute(member, element, attr) || officeIdAttribute(member, element, attr) !== null) return true;
  if (officeDisplayName(member, element, attr)) return true;
  const el = localName(element);
  const at = localName(attr);
  if (at.startsWith("rsid") || el.startsWith("rsid")) return true;
  return STRUCTURAL_ATTRIBUTES.has(at) || STRUCTURAL_ELEMENTS.has(el);
}

/** Folded word sequences of the keep and vocabulary terms, for whole-value and in-phrase matching. */
class Terms {
  readonly whole = new Set<string>();
  /** First folded word to every term (as folded words) starting with it, longest first. */
  private readonly byFirst = new Map<string, string[][]>();
  constructor(terms: Iterable<string>) {
    for (const t of terms) {
      const f = fold(t);
      if (f === "") continue;
      this.whole.add(f);
      const words = f.split(" ");
      const list = this.byFirst.get(words[0] as string) ?? [];
      list.push(words);
      this.byFirst.set(words[0] as string, list);
    }
    for (const list of this.byFirst.values()) list.sort((a, b) => b.length - a.length);
  }
  /** Length in words of the longest term starting at `words[i]`, or 0. */
  matchAt(words: readonly string[], i: number): number {
    for (const t of this.byFirst.get(words[i] as string) ?? []) {
      if (t.length <= words.length - i && t.every((w, k) => words[i + k] === w)) return t.length;
    }
    return 0;
  }
  static union(a: Terms, extra: Iterable<string>): Terms {
    const t = new Terms(extra);
    for (const w of a.whole) {
      t.whole.add(w);
      const words = w.split(" ");
      const list = t.byFirst.get(words[0] as string) ?? [];
      list.push(words);
      t.byFirst.set(words[0] as string, list);
    }
    for (const list of t.byFirst.values()) list.sort((x, y) => y.length - x.length);
    return t;
  }
}

// --- Finding candidates in one view ---------------------------------------

interface Candidate {
  start: number;
  end: number;
  kind: SemanticKind;
}

const ISO_DATETIME_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]*[A-Za-z0-9_%+-])?@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const HOST_RE = /(?<![A-Za-z0-9@.-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![A-Za-z0-9_+-]|\.[A-Za-z0-9])/g;
const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?![A-Za-z0-9_])/g;
const DIGIT_RUN_RE = /\d{10,}/g;
const HEX_SEGMENT_RE = /^(?=[0-9A-Fa-f]*\d)(?=[0-9A-Fa-f]*[A-Fa-f])[0-9A-Fa-f]{6,}$/;
/** A Title-Case word: an upper-case letter, a lower-case letter, then letters, marks and inner apostrophes or hyphens. */
const TITLE_WORD_RE = /(?<![\p{L}\p{M}\p{N}_'\u2019-])\p{Lu}\p{M}*\p{Ll}[\p{L}\p{M}]*(?:['\u2019-][\p{L}\p{M}]+)*(?![\p{L}\p{M}\p{N}_])/gu;

/** Character ranges already accounted for (timestamps, emails, hosts), one flag per code unit. */
class Covered {
  private readonly flags: Uint8Array;
  constructor(length: number) {
    this.flags = new Uint8Array(length);
  }
  add(s: number, e: number): void {
    this.flags.fill(1, s, e);
  }
  any(s: number, e: number): boolean {
    for (let i = s; i < e; i++) if (this.flags[i] === 1) return true;
    return false;
  }
}

/** Pseudonym shapes, also right after an underscore: a blinded name joins pieces with "_" ("Person_1E95_user_559f@host-f3ce.com.md"). */
const PSEUDONYM_SHAPE_RE = new RegExp(SHAPED_RE.source.replace("(?<![A-Za-z0-9_.-])", "(?<![A-Za-z0-9.-])"), "g");

function findCandidates(original: string, map: BlindMap, terms: Terms, kept: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  const masks = new Covered(original.length);
  const ascii = /[0-9A-Za-z]/.test(original);
  // Pseudonyms are blanked out (same length, so offsets hold) before any shape is looked for:
  // "user_559f@host-f3ce.com.md" is a pseudonym and an extension, not an unexplained email.
  let text = original;
  if (ascii) {
    const blanks: [number, number][] = [];
    for (const m of original.matchAll(PSEUDONYM_SHAPE_RE)) {
      if (isPseudonym(m[0], map)) blanks.push([m.index, m.index + m[0].length]);
    }
    if (blanks.length > 0) {
      let t = "";
      let at = 0;
      for (const [s, e] of blanks) {
        t += original.slice(at, s) + " ".repeat(e - s);
        at = e;
      }
      text = t + original.slice(at);
    }
  }
  const excluded = (value: string): boolean => isPseudonym(value, map) || terms.whole.has(fold(value));

  if (ascii) {
    for (const m of text.matchAll(ISO_DATETIME_RE)) masks.add(m.index, m.index + m[0].length);
    for (const m of text.matchAll(EMAIL_RE)) {
      const span: [number, number] = [m.index, m.index + m[0].length];
      masks.add(span[0], span[1]);
      if (!excluded(m[0])) out.push({ start: span[0], end: span[1], kind: "email" });
    }
    for (const m of text.matchAll(HOST_RE)) {
      let host = m[0];
      // A file extension is not a top-level domain: "db01.example.com.txt" names the host db01.example.com,
      // and "document.xml.rels" names no host at all.
      while (host.includes(".") && FILE_EXTENSIONS.has(host.slice(host.lastIndexOf(".") + 1).toLowerCase())) {
        host = host.slice(0, host.lastIndexOf("."));
      }
      if (!/\.[A-Za-z]{2,63}$/.test(host)) continue;
      const span: [number, number] = [m.index, m.index + host.length];
      if (masks.any(span[0], span[1])) continue;
      masks.add(span[0], span[1]);
      // A host under a keep-list domain is kept by the engine, by policy.
      if (STRUCTURAL_HOSTS.has(host.toLowerCase()) || underKeptDomain(host, kept) || excluded(host)) continue;
      out.push({ start: span[0], end: span[1], kind: "host" });
    }
    for (const m of text.matchAll(TOKEN_RE)) {
      const tok = m[0];
      const s = m.index;
      const e = s + tok.length;
      if (masks.any(s, e) || !/\d/.test(tok)) continue;
      if (excluded(tok)) continue;
      const digits = (tok.match(/\d/g) ?? []).length;
      const letters = /[A-Za-z]/.test(tok);
      if (digits >= 4 && letters) {
        out.push({ start: s, end: e, kind: "alnum-id" });
        continue;
      }
      if (tok.split(/[-_]/).some((seg) => HEX_SEGMENT_RE.test(seg))) {
        out.push({ start: s, end: e, kind: "hex" });
        continue;
      }
      for (const d of tok.matchAll(DIGIT_RUN_RE)) {
        const ds = s + d.index;
        // The fraction of a decimal number (45210.416666666664) is not an identifier.
        if (ds === s && text[s - 1] === "." && /\d/.test(text[s - 2] ?? "")) continue;
        out.push({ start: s, end: e, kind: "digits" });
        break;
      }
    }
  }

  // Title-Case runs: consecutive Title-Case words separated by one space.
  const words = [...text.matchAll(TITLE_WORD_RE)].map((m) => ({ s: m.index, e: m.index + m[0].length, f: fold(m[0]) }));
  let i = 0;
  while (i < words.length) {
    let j = i + 1;
    while (j < words.length && /^[ \u00a0]$/.test(text.slice((words[j - 1] as { e: number }).e, (words[j] as { s: number }).s))) j++;
    const run = words.slice(i, j);
    i = j;
    let k = 0;
    while (k < run.length && LEADING_FUNCTION_WORDS.has((run[k] as { f: string }).f)) k++;
    // Split the run at keep and vocabulary terms; what is left between them is judged on its own.
    const folded = run.map((w) => w.f);
    let segStart = k;
    const flush = (end: number) => {
      if (end - segStart >= 2) {
        const s = (run[segStart] as { s: number }).s;
        const e = (run[end - 1] as { e: number }).e;
        if (!masks.any(s, e) && !terms.whole.has(fold(text.slice(s, e)))) out.push({ start: s, end: e, kind: "phrase" });
      }
    };
    let p = k;
    while (p < run.length) {
      const n = terms.matchAt(folded, p);
      if (n > 0) {
        flush(p);
        p += n;
        segStart = p;
      } else p++;
    }
    flush(run.length);
  }
  return out;
}

// --- XML text and attribute views -----------------------------------------

/** Elements whose text is document text that may continue in the next run (docx w:t, xlsx and pptx t). */
const RUN_TEXT_ELEMENTS = new Set(["t", "delText", "instrText"]);
/** Elements that end a run of joined text: paragraphs, cells, rows, breaks, tabs. */
const BREAK_ELEMENTS = new Set(["p", "si", "c", "tc", "tr", "row", "br", "cr", "tab", "txbxContent", "comment", "is"]);

/**
 * Two views of an XML document: its character data (text nodes, CDATA, comments; adjacent
 * run-text elements joined, everything else separated by a newline) and its attribute values
 * (one per line, structural attributes left out). Processing instructions and the doctype are
 * markup, not content. `member` is the document's path (in its zip, when it is a member), for
 * the structural positions that depend on it.
 */
export function xmlViews(v: View, member = ""): View[] {
  const t = v.text;
  let text = "";
  const textMap: number[] = [];
  let attrs = "";
  const attrMap: number[] = [];
  const emitText = (s: string, at: number) => {
    text += s;
    for (let k = 0; k < s.length; k++) textMap.push(at + k);
  };
  const sep = (at: number) => {
    if (text !== "" && !text.endsWith("\n")) {
      text += "\n";
      textMap.push(at);
    }
  };
  const emitAttr = (s: string, at: number) => {
    attrs += s;
    for (let k = 0; k < s.length; k++) attrMap.push(at + k);
    attrs += "\n";
    attrMap.push(at + s.length);
  };
  /** True while the last text emitted came from a run-text element and nothing has broken the run since. */
  let joinable = false;
  const runText = (start: number, end: number, parent: string | undefined) => {
    const inRun = RUN_TEXT_ELEMENTS.has(localName(parent ?? ""));
    if (!(inRun && joinable)) sep(start);
    emitText(t.slice(start, end), start);
    joinable = inRun;
  };
  walkXml(t, {
    text(start, end, parent) {
      if (t.slice(start, end).trim() !== "") runText(start, end, parent);
    },
    comment(start, end) {
      sep(start - 4);
      emitText(t.slice(start, end), start);
      joinable = false;
    },
    cdata: runText,
    attribute(element, attr, start, end) {
      if (!structuralAttribute(member, element, attr) && end > start) emitAttr(t.slice(start, end), start);
    },
    tag(name) {
      if (BREAK_ELEMENTS.has(localName(name))) joinable = false;
    },
  });
  const out: View[] = [];
  const mk = (encoding: string, s: string, m: number[]): View => ({ encoding, text: s, byteAt: (k) => v.byteAt(m[k] ?? t.length) });
  for (const [suffix, s, m] of [["text", text, textMap], ["attributes", attrs, attrMap]] as const) {
    if (s === "") continue;
    const base = mk(`${v.encoding}+xml-${suffix}`, s, m);
    out.push(base);
    const u = unescapeView(base);
    if (u !== null) out.push(u);
  }
  return out;
}

// --- Walking the tree ------------------------------------------------------

interface Located {
  value: string;
  kind: SemanticKind;
  part: string;
  in: Finding["in"];
  offset: number;
  line: number | null;
  encoding: string | null;
}

/** 1-based line of index `i`, given the sorted offsets of every newline in the text. */
function lineOf(newlines: readonly number[], i: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((newlines[mid] as number) < i) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

interface Walk {
  map: BlindMap;
  terms: Terms;
  /** keepDomains of the keep list. */
  kept: readonly string[];
  found: Located[];
}

function scanViewsInto(w: Walk, part: string, where: Finding["in"], views: readonly View[], baseOffset = 0) {
  for (const v of views) {
    const cands = findCandidates(v.text, w.map, w.terms, w.kept);
    if (cands.length === 0) continue;
    const newlines = where === "content" ? [...v.text.matchAll(/\n/g)].map((m) => m.index) : [];
    for (const c of cands) {
      w.found.push({
        value: v.text.slice(c.start, c.end),
        kind: c.kind,
        part,
        in: where,
        offset: baseOffset + v.byteAt(c.start),
        line: where === "content" ? lineOf(newlines, c.start) : null,
        encoding: where === "content" ? v.encoding : null,
      });
    }
  }
}

function scanContent(w: Walk, name: string, part: string, bytes: Uint8Array, depth: number) {
  if (looksLikeZip(bytes) && depth < MAX_ZIP_DEPTH) {
    let members;
    try {
      members = readZip(bytes);
    } catch (e) {
      if (!(e instanceof ZipError)) throw e;
      // The mechanical layer reports the archive as unreadable; read its raw bytes here too.
      scanViewsInto(w, part, "content", viewsOf(bytes));
      return;
    }
    const residual = Uint8Array.from(bytes);
    for (const m of members) {
      for (const [a, b] of m.nameRanges) residual.fill(0, a, b);
      if (m.bytes !== undefined) residual.fill(0, m.dataRange[0], m.dataRange[1]);
    }
    scanViewsInto(w, part, "content", viewsOf(residual));
    for (const m of [...members].sort((a, b) => cmp(a.name, b.name))) {
      const memberPart = part === "" ? m.name : `${part}!${m.name}`;
      scanViewsInto(w, memberPart, "name", stringView(m.name));
      // A member that could not be decoded is already an `unscanned` mechanical candidate.
      if (m.bytes !== undefined) scanContent(w, m.name, memberPart, m.bytes, depth + 1);
    }
    return;
  }
  const base = bytes.length > 0 ? xmlBaseView(bytes) : null;
  if (base !== null && looksLikeXml(name, base.text)) scanViewsInto(w, part, "content", xmlViews(base, name));
  else scanViewsInto(w, part, "content", viewsOf(bytes));
}

const TABLE_EXTENSIONS: Record<string, "csv" | "tsv"> = { ".csv": "csv", ".tsv": "tsv", ".tab": "tsv" };
const extOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot <= path.lastIndexOf("/") + 1 ? "" : path.slice(dot).toLowerCase();
};

/**
 * Terms this file's own spec rules explain: the headers the spec names, and every value of a
 * column (CSV/TSV header, or JSON key path) the spec classifies as vocabulary. A table or JSON
 * file that cannot be read contributes none, so nothing is excluded that was not read.
 */
function fileTerms(path: string, bytes: Uint8Array, spec: Spec): string[] {
  const rules = spec.columns.filter((r) => r.file === path);
  if (rules.length === 0) return [];
  const terms: string[] = rules.flatMap((r) => (r.header !== undefined ? [r.header] : []));
  const vocabHeaders = new Set(rules.filter((r) => r.class === "vocabulary" && r.header !== undefined).map((r) => (r.header as string).trim()));
  const vocabPaths = new Set(rules.filter((r) => r.class === "vocabulary" && r.jsonPath !== undefined).map((r) => r.jsonPath as string));
  if (vocabHeaders.size === 0 && vocabPaths.size === 0) return terms;
  let text: string;
  try {
    text = decode(bytes).text;
  } catch (e) {
    if (!(e instanceof EncodingError)) throw e;
    return terms;
  }
  const ext = extOf(path);
  const format = TABLE_EXTENSIONS[ext];
  if (format !== undefined && vocabHeaders.size > 0) {
    try {
      const rows = parseCsv(text, format === "tsv" ? "\t" : sniffDelimiter(text));
      const header = rows[0]?.cells.map((c) => c.value.trim()) ?? [];
      const cols = header.flatMap((h, i) => (vocabHeaders.has(h) ? [i] : []));
      for (const r of rows.slice(1)) for (const c of cols) terms.push(r.cells[c]?.value ?? "");
    } catch (e) {
      if (!(e instanceof CsvError)) throw e;
    }
  }
  if ((ext === ".json" || ext === ".jsonl") && vocabPaths.size > 0) {
    try {
      for (const tok of ext === ".jsonl" ? scanJsonl(text) : scanJson(text)) {
        if (tok.kind === "string" && tok.column !== null && vocabPaths.has(tok.column)) terms.push(tok.value);
      }
    } catch (e) {
      if (!(e instanceof JsonError)) throw e;
    }
  }
  return terms;
}

/** Spec vocabulary entity forms plus the policy keep list: explained everywhere. */
export function globalTerms(spec: Spec, keep: readonly string[]): string[] {
  const out = [...keep];
  for (const e of spec.entities.vocabulary ?? []) out.push(e.canonical, ...e.aliases, ...e.parts);
  return out;
}

const IN_RANK: Record<Finding["in"], number> = { name: 0, link: 1, content: 2 };

/** Deduplicate by value (first location kept, occurrences counted), cap, and render as findings. */
function toFindings(file: string, found: readonly Located[]): Finding[] {
  const sorted = [...found].sort(
    (a, b) => cmp(a.part, b.part) || IN_RANK[a.in] - IN_RANK[b.in] || a.offset - b.offset || cmp(a.kind, b.kind) || cmp(a.value, b.value),
  );
  const byValue = new Map<string, { first: Located; places: Set<string> }>();
  for (const l of sorted) {
    const place = `${l.part}\0${l.in}\0${l.offset}`;
    const got = byValue.get(l.value);
    if (got === undefined) byValue.set(l.value, { first: l, places: new Set([place]) });
    else got.places.add(place);
  }
  const distinct = [...byValue.values()];
  const listed = distinct.slice(0, MAX_PER_FILE);
  const findings: Finding[] = listed.map(({ first: l, places }) => ({
    file,
    part: l.part,
    in: l.in,
    offset: l.offset,
    line: l.line,
    class: `semantic:${l.kind}`,
    source: "semantic",
    severity: "candidate",
    masked: maskValue(l.value),
    reason: places.size > 1 ? `${KIND_REASON[l.kind]} (${places.size} places in this file)` : KIND_REASON[l.kind],
    encoding: l.encoding,
  }));
  const rest = distinct.length - listed.length;
  if (rest > 0) {
    findings.push({
      file,
      part: "",
      in: "content",
      offset: null,
      line: null,
      class: "semantic:more",
      source: "semantic",
      severity: "candidate",
      masked: "",
      reason: `${rest} more distinct semantic candidate${rest === 1 ? "" : "s"} in this file not listed (cap ${MAX_PER_FILE} per file)`,
      encoding: null,
    });
  }
  return findings;
}

/** Semantic candidates per output path (only paths with any), each list deduplicated and capped. */
export function semanticFindings(entries: readonly TreeEntry[], spec: Spec, map: BlindMap, opts: SemanticOptions): Map<string, Finding[]> {
  const global = new Terms(globalTerms(spec, opts.keep));
  const kept = keepDomains(opts.keep);
  const out = new Map<string, Finding[]>();
  for (const entry of [...entries].sort((a, b) => cmp(a.path, b.path))) {
    const terms = entry.kind === "file" ? Terms.union(global, fileTerms(entry.path, entry.bytes, spec)) : global;
    const w: Walk = { map, terms, kept, found: [] };
    const nameAt = entry.path.lastIndexOf("/") + 1;
    scanViewsInto(w, "", "name", stringView(entry.path.slice(nameAt)), nameAt);
    if (entry.kind === "file") scanContent(w, entry.path, "", entry.bytes, 0);
    else if (entry.kind === "symlink") scanViewsInto(w, "", "link", stringView(entry.target));
    if (w.found.length > 0) out.set(entry.path, toFindings(entry.path, w.found));
  }
  return out;
}

/**
 * The report with the semantic layer added: "semantic" appended to the layers, its candidates
 * merged into each file (a file the mechanical layer had no line for is added), and every status
 * and count recomputed. Nothing already in the report is removed or downgraded.
 */
export function addSemanticLayer(report: AuditReport, entries: readonly TreeEntry[], spec: Spec, map: BlindMap, opts: SemanticOptions): AuditReport {
  return addLayer(report, "semantic", entries, semanticFindings(entries, spec, map, opts));
}
