// DOCX: WordprocessingML blinded at the zip and XML level through
// src/formats/ooxml.ts. No document model; every byte not rewritten is copied.
//
// Word splits text into runs wherever formatting, spell-check state or an edit
// session changes, so "Acme Corp" can arrive as "Ac" + "me Corp". Text is
// therefore matched per paragraph: the text nodes of one paragraph are joined
// (with a separator wherever a tab, break, field character or other object sits
// between them, so "Acme<tab/>Corp" never reads as "AcmeCorp"), the spec's
// patterns and entities and the corpus's recurring values (recur.ts) are found
// in the joined text, and each match is written
// back into the runs it came from: its pseudonym goes where the match starts
// (the formatting of that run carries it) and the rest of the match is removed
// from the later runs. No run, property or paragraph is added or removed.
//
// Tracked changes are read both ways. A paragraph with insertions or deletions
// is matched once as accepted (plain and inserted text) and once as rejected
// (plain and deleted text), and every match from either reading is removed, so a
// name is hidden whichever way the reader resolves the revisions. When a match
// is only in one reading its pseudonym goes into text exclusive to that reading.
// Field instructions (`w:instrText`, `w:delInstrText`) are matched separately,
// per paragraph, so an instruction never joins the visible text.
//
// Identity metadata is replaced as a whole, whatever the spec says: revision,
// comment and person authors and initials (`w:author`, `w:initials`), presence
// user IDs, `dc:creator`, `cp:lastModifiedBy`, and the application's Manager
// (person) and Company (org). Other metadata and attribute text (titles,
// keywords, custom properties, drawing names and alt text, form-field and
// content-control text, document variables, mail-merge strings, field
// instructions, external hyperlink targets) is free text.
//
// Office's own linking IDs (edit-session rsids, paragraph, text and durable ids, document and
// list ids, data store ids: src/formats/officeids.ts) are rewritten wherever they are, so the
// blinded package cannot be matched back to the original by them (src/engine/officeid.ts). Fixed
// template IDs (a theme family's id) are copied.
//
// Fail closed. The package is not written when a part cannot be read, when a
// part outside the vocabularies below holds character data, or when it embeds
// a file (an OLE object, a workbook behind a chart, macros) that this handler
// cannot open. Images are copied unchanged and reported.

import { type Frame, localName, readOoxml, type RewriteRules, rewriteOoxml, rewriteXml, XmlError } from "../formats/ooxml.ts";
import { type LinkShape, officeLinkAttribute } from "../formats/officeids.ts";
import type { PseudoClass } from "./canonical.ts";
import { type HexNamer, rewriteOfficeId } from "./officeid.ts";
import type { Pseudonymizer } from "./pseudonym.ts";
import type { Span } from "./text.ts";

export interface DocxRequest {
  cls: PseudoClass;
  value: string;
}

export interface DocxPlan {
  bytes: Uint8Array;
  /** Per member, every offered value in document order: what the render pass must see again. */
  nodes: Map<string, Node[]>;
  kinds: Map<string, PartKind>;
  /** Unique matches across the package. */
  edits: Edit[];
  wholes: Node[];
  /** Paragraph text, field instructions and single values, in document order. */
  units: Unit[];
  /** Host matches kept because they are under a keep-list domain. */
  keptHosts: number;
  /** The main document part (the package's officeDocument relationship), when it names one. */
  main?: string;
  /** Pseudonyms the render needs, for the caller to derive in sorted order. */
  requests: DocxRequest[];
  /** Every original value, for the set no pseudonym may equal. */
  values: string[];
  /** Hex linking IDs the render needs, for the caller to derive in sorted order. */
  hexIds: string[];
  warnings: string[];
}

export interface DocxRender {
  bytes: Uint8Array;
  changed: boolean;
  entityReplacements: number;
  patternReplacements: number;
  /** Values a column pass pseudonymised elsewhere in the corpus, found again here. */
  mappedReplacements: number;
  /** Transcript speaker tags and spoken speaker names (see transcript.ts). */
  speakerReplacements: number;
  keptHosts: number;
  /** Identity metadata values replaced as a whole. */
  metadataReplacements: number;
}

/** The package cannot be blinded; the reason is user-facing. */
export class DocxError extends Error {
  override name = "DocxError";
}

type PartKind = "word" | "core" | "app" | "custom" | "rels" | "inert" | "unknown";
type Role = "plain" | "ins" | "del";

interface Node {
  value: string;
  role: Role;
  /** Set for a value replaced as a whole. */
  whole?: PseudoClass;
  /** Set for an Office linking ID, rewritten by its shape. */
  link?: LinkShape;
  /** Planned changes, in this node's own offsets. */
  blanks: [number, number][];
  inserts: { at: number; edit: Edit }[];
}

interface Edit {
  cls: PseudoClass;
  value: string;
  source: Span["source"];
}

type Item = { node: Node } | { sep: string; role: Role };

interface Unit {
  items: Item[];
  /** Set on a paragraph's run text (not its field instructions): the member it is in. */
  paragraph?: string;
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W_STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main";

const KINDS = new Map<string, PartKind>(Object.entries({
  [W]: "word",
  [W_STRICT]: "word",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "word",
  "http://purl.oclc.org/ooxml/drawingml/main": "word",
  "http://schemas.openxmlformats.org/drawingml/2006/chart": "word",
  "http://purl.oclc.org/ooxml/drawingml/chart": "word",
  "http://schemas.openxmlformats.org/drawingml/2006/diagram": "word",
  "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing": "word",
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties": "core",
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties": "app",
  "http://purl.oclc.org/ooxml/officeDocument/extendedProperties": "app",
  "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties": "custom",
  "http://purl.oclc.org/ooxml/officeDocument/customProperties": "custom",
  "http://schemas.openxmlformats.org/package/2006/relationships": "rels",
  "http://schemas.openxmlformats.org/package/2006/content-types": "inert",
  "http://schemas.openxmlformats.org/officeDocument/2006/customXml": "inert",
  "http://purl.oclc.org/ooxml/officeDocument/customXml": "inert",
}) as [string, PartKind][]);
// Word's own extension parts (people, comment extensions, chart styles and colours).
const KIND_PREFIXES: [string, PartKind][] = [
  ["http://schemas.microsoft.com/office/word/", "word"],
  ["http://schemas.microsoft.com/office/drawing/", "word"],
];

/** The namespace URI of `el`'s qualified name, resolved through its own and its ancestors' declarations. */
function namespaceOf(el: Frame, parents: readonly Frame[]): string | undefined {
  const i = el.name.indexOf(":");
  const decl = i < 0 ? "xmlns" : `xmlns:${el.name.slice(0, i)}`;
  for (const f of [el, ...[...parents].reverse()]) {
    const ns = f.attrs.get(decl);
    if (ns !== undefined) return ns;
  }
  return undefined;
}

function partKind(root: Frame): PartKind {
  const ns = namespaceOf(root, []) ?? "";
  return KINDS.get(ns) ?? KIND_PREFIXES.find(([p]) => ns.startsWith(p))?.[1] ?? "unknown";
}

const isWord = (el: Frame, parents: readonly Frame[]): boolean => {
  const ns = namespaceOf(el, parents);
  return ns === W || ns === W_STRICT;
};

const hasAncestor = (parents: readonly Frame[], names: ReadonlySet<string>): boolean => parents.some((f) => names.has(localName(f.name)));

// Text elements of WordprocessingML; `t` also covers DrawingML and math text.
const RUN_TEXT = new Set(["t", "delText"]);
const INSTR_TEXT = new Set(["instrText", "delInstrText"]);
const DELETED = new Set(["del", "moveFrom"]);
const INSERTED = new Set(["ins", "moveTo"]);
const CHART_STRINGS = new Set(["strCache", "strLit"]);

// Markup between text nodes of a paragraph and what it reads as when the paragraph is matched.
const OBJECT = "￼";
const SEPARATORS = new Map<string, string>(Object.entries({
  tab: "\t",
  ptab: "\t",
  br: "\n",
  cr: "\n",
  noBreakHyphen: "‑",
  sym: OBJECT,
  drawing: OBJECT,
  pict: OBJECT,
  object: OBJECT,
  fldChar: OBJECT,
  footnoteReference: OBJECT,
  endnoteReference: OBJECT,
  commentReference: OBJECT,
  footnoteRef: OBJECT,
  endnoteRef: OBJECT,
  annotationRef: OBJECT,
  separator: OBJECT,
  continuationSeparator: OBJECT,
  txbxContent: OBJECT,
}));

// Attributes replaced as a whole, by local name.
const WHOLE_ATTRIBUTES = new Map<string, PseudoClass>([["author", "person"], ["initials", "person"], ["userId", "id"]]);
// Free-text attributes: element local name, then attribute local names.
const FREE_ATTRIBUTES = new Map<string, ReadonlySet<string>>(Object.entries({
  fldSimple: new Set(["instr"]),
  hyperlink: new Set(["tooltip"]),
  docPr: new Set(["name", "descr", "title"]),
  cNvPr: new Set(["name", "descr", "title"]),
  imagedata: new Set(["title"]),
  shape: new Set(["alt"]),
  alias: new Set(["val"]),
  tag: new Set(["val"]),
  docVar: new Set(["name", "val"]),
  connectString: new Set(["val"]),
  query: new Set(["val"]),
  helpText: new Set(["val"]),
  statusText: new Set(["val"]),
  listEntry: new Set(["val"]),
  listItem: new Set(["displayText", "value"]),
}));

// docProps elements that hold other elements rather than text.
const PROPERTY_CONTAINERS = new Set(["HeadingPairs", "TitlesOfParts", "HLinks", "DigSig", "property", "vector", "variant", "array"]);
const PROPERTY_BINARY = new Set(["blob", "oblob", "stream", "ostream", "storage", "ostorage", "vstream", "cf"]);
const WHOLE_PROPERTIES = new Map<PartKind, ReadonlyMap<string, PseudoClass>>([
  ["core", new Map([["creator", "person"], ["lastModifiedBy", "person"]])],
  ["app", new Map([["Manager", "person"], ["Company", "org"]])],
]);

/**
 * The text nodes and attributes offered in a part of `kind`, with every Office linking ID position
 * offered as well; shared with reveal, so it reads exactly what blinding rewrites (it leaves the
 * linking IDs, nodes with `link` set, as written).
 */
export function rulesFor(kind: PartKind, visit?: RewriteRules["visit"]): RewriteRules {
  const rules = kindRules(kind, visit);
  return { ...rules, attribute: (el, attr, parents) => officeLinkAttribute(el.name, attr) !== null || rules.attribute(el, attr, parents) };
}

function kindRules(kind: PartKind, visit?: RewriteRules["visit"]): RewriteRules {
  const none = () => false;
  switch (kind) {
    case "word":
      return {
        text(el, parents) {
          const n = localName(el.name);
          if (RUN_TEXT.has(n) || INSTR_TEXT.has(n)) return true;
          // Chart text caches: series names and category labels.
          return n === "v" && (hasAncestor(parents, CHART_STRINGS) || localName(parents[parents.length - 1]?.name ?? "") === "tx");
        },
        attribute(el, attr, parents) {
          const a = localName(attr);
          if (WHOLE_ATTRIBUTES.has(a) || FREE_ATTRIBUTES.get(localName(el.name))?.has(a)) return true;
          // Form-field names and default text.
          return a === "val" && ["name", "default"].includes(localName(el.name)) && localName(parents[parents.length - 1]?.name ?? "") === "ffData";
        },
        preserveSpace: (el, parents) => (RUN_TEXT.has(localName(el.name)) || INSTR_TEXT.has(localName(el.name))) && isWord(el, parents),
        visit,
      };
    case "core":
      return { text: (_el, parents) => parents.length === 1, attribute: none };
    case "app":
    case "custom":
      return {
        text: (el, parents) => parents.length >= 1 && !PROPERTY_CONTAINERS.has(localName(el.name)) && !PROPERTY_BINARY.has(localName(el.name)),
        attribute: (el, attr) => kind === "custom" && localName(el.name) === "property" && attr === "name",
      };
    case "rels":
      return { text: none, attribute: (el, attr) => localName(el.name) === "Relationship" && attr === "Target" && el.attrs.get("TargetMode") === "External" };
    case "unknown":
      // Character data in an unknown part refuses the package (see planDocx); its attributes are free text.
      return { text: none, attribute: (_el, attr) => attr !== "xmlns" && !attr.startsWith("xmlns:") };
    case "inert":
      return { text: none, attribute: none };
  }
}

/** Character data (text or CDATA) anywhere in `xml`, outside markup. */
function hasCharacterData(xml: string): boolean {
  if (xml.includes("<![CDATA[")) return true;
  const stripped = xml.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, "").replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, "");
  return /[^ \t\r\n﻿]/.test(stripped);
}

const IMAGE = /\.(png|jpe?g|gif|bmp|tiff?|emf|wmf|svg|ico|webp)$/i;
const FONT = /\.(odttf|ttf|otf|fntdata)$/i;

/**
 * Read the package and collect its text units. Throws DocxError when the package
 * must not be written. Matching waits for scanDocx, once every column in the
 * corpus is decided.
 */
export function planDocx(bytes: Uint8Array): DocxPlan {
  let members;
  try {
    members = readOoxml(bytes);
  } catch (e) {
    throw new DocxError(`not a readable DOCX package (${(e as Error).message})`);
  }
  const plan: DocxPlan = { bytes, nodes: new Map(), kinds: new Map(), edits: [], wholes: [], units: [], keptHosts: 0, requests: [], values: [], hexIds: [], warnings: [] };

  const images: string[] = [];
  for (const m of members) {
    if (m.kind !== "other" || m.name.endsWith("/")) continue;
    if (IMAGE.test(m.name)) images.push(m.name);
    else if (!FONT.test(m.name)) throw new DocxError(`embedded file ${m.name} cannot be blinded inside a DOCX`);
  }
  if (images.length > 0) {
    plan.warnings.push(`${images.length} image${images.length === 1 ? "" : "s"} copied unchanged (images are not blinded): ${images.join(", ")}`);
  }

  const units = plan.units;
  const recorder = { pseudonym: (cls: PseudoClass, value: string) => (plan.requests.push({ cls, value }), value) };
  const hexRecorder: HexNamer = { hex: (value) => (plan.hexIds.push(value), value) };
  for (const m of members) {
    if (m.kind === "other") continue;
    if (m.kind === "error") throw new DocxError(`part ${m.name} cannot be read (${m.error})`);
    let root: Frame | undefined;
    try {
      rewriteXml(m.text, (v) => v, { text: () => false, attribute: () => false, visit: (el, parents) => void (parents.length === 0 && (root = el)) });
    } catch (e) {
      if (e instanceof XmlError) throw new DocxError(`part ${m.name} cannot be read (${e.message})`);
      throw e;
    }
    const kind = partKind(root as Frame);
    if (kind === "unknown" && hasCharacterData(m.text)) {
      throw new DocxError(`part ${m.name} is not a part this handler knows and holds text it cannot blind`);
    }
    plan.kinds.set(m.name, kind);
    // Parsed above, so this cannot throw.
    if (m.name === "_rels/.rels") plan.main = mainPart(m.text);
    const nodes: Node[] = [];
    plan.nodes.set(m.name, nodes);

    // Per paragraph: its run text and its field instructions, matched separately.
    const paragraphs = new Map<Frame, { text: Unit; instr: Unit }>();
    const paragraphOf = (parents: readonly Frame[]) => {
      for (let i = parents.length - 1; i >= 0; i--) {
        const f = parents[i] as Frame;
        if (localName(f.name) !== "p") continue;
        let p = paragraphs.get(f);
        if (p === undefined) {
          p = { text: { items: [], paragraph: m.name }, instr: { items: [] } };
          paragraphs.set(f, p);
          units.push(p.text, p.instr);
        }
        return p;
      }
      return undefined;
    };
    const roleOf = (el: Frame, parents: readonly Frame[]): Role => {
      const n = localName(el.name);
      if (n === "delText" || n === "delInstrText" || hasAncestor(parents, DELETED)) return "del";
      return hasAncestor(parents, INSERTED) ? "ins" : "plain";
    };
    const visit = (el: Frame, parents: readonly Frame[]) => {
      const sep = SEPARATORS.get(localName(el.name));
      if (sep === undefined) return;
      const p = paragraphOf(parents);
      if (p === undefined) return;
      const role = roleOf(el, parents);
      p.text.items.push({ sep, role });
      p.instr.items.push({ sep, role });
    };
    const whole = WHOLE_PROPERTIES.get(kind);

    try {
      rewriteXml(
        m.text,
        (value, ctx) => {
          const node: Node = { value, role: roleOf(ctx.element, ctx.parents), blanks: [], inserts: [] };
          nodes.push(node);
          plan.values.push(value);
          const link = ctx.attribute === undefined ? null : officeLinkAttribute(ctx.element.name, ctx.attribute);
          if (link !== null) {
            node.link = link;
            rewriteOfficeId(link, value, recorder, hexRecorder);
            return value;
          }
          const n = localName(ctx.element.name);
          const cls = ctx.attribute !== undefined ? (kind === "word" ? WHOLE_ATTRIBUTES.get(localName(ctx.attribute)) : undefined) : whole?.get(n);
          if (cls !== undefined) {
            node.whole = cls;
            if (value.trim() !== "") {
              plan.wholes.push(node);
              plan.requests.push({ cls, value: value.trim() });
            }
            return value;
          }
          const p = ctx.attribute === undefined && kind === "word" ? paragraphOf(ctx.parents) : undefined;
          if (p !== undefined) (INSTR_TEXT.has(n) ? p.instr : p.text).items.push({ node });
          else units.push({ items: [{ node }] });
          return value;
        },
        rulesFor(kind, kind === "word" ? visit : undefined),
      );
    } catch (e) {
      if (e instanceof XmlError) throw new DocxError(`part ${m.name} cannot be read (${e.message})`);
      throw e;
    }
  }

  return plan;
}

/** The target of the package relationship of type officeDocument, as a member name. */
function mainPart(xml: string): string | undefined {
  let main: string | undefined;
  rewriteXml(xml, (v) => v, {
    text: () => false,
    attribute: () => false,
    visit: (el) => {
      if (main !== undefined || localName(el.name) !== "Relationship" || el.attrs.get("TargetMode") === "External") return;
      if (!/\/officeDocument$/.test(el.attrs.get("Type") ?? "")) return;
      main = (el.attrs.get("Target") ?? "").replace(/^\//, "");
    },
  });
  return main;
}

/**
 * The run text of every paragraph, as accepted (deletions left out), in document order: of the
 * main document part only (`main`), or of every part (`all`). Transcript detection reads these.
 */
export function docxParagraphs(plan: DocxPlan, which: "main" | "all"): string[] {
  const out: string[] = [];
  for (const unit of plan.units) {
    if (unit.paragraph === undefined || (which === "main" && unit.paragraph !== plan.main)) continue;
    let text = "";
    for (const item of unit.items) {
      if ("node" in item) {
        if (item.node.role !== "del") text += item.node.value;
      } else if (item.role !== "del") text += item.sep;
    }
    out.push(text);
  }
  return out;
}

/**
 * Match every unit and record the edits on its nodes. `spanner` finds the spec's patterns, its
 * entities and the corpus's recurring values in a string (TextScanner.free).
 */
export function scanDocx(plan: DocxPlan, spanner: (s: string) => Span[]): void {
  for (const unit of plan.units) planUnit(unit, spanner, plan);
}

/** Match one unit (a paragraph's text, its instructions, or a single value) and record the edits on its nodes. */
function planUnit(unit: Unit, spanner: (s: string) => Span[], plan: DocxPlan): void {
  const nodes = unit.items.flatMap((i) => ("node" in i ? [i.node] : []));
  if (nodes.length === 0) return;
  const revised = unit.items.some((i) => ("node" in i ? i.node.role : i.role) !== "plain");
  // The accepted reading leaves deletions out, the rejected one insertions; `own` is the text only that reading has.
  const readings: { skip: Role; own: Role }[] = revised ? [{ skip: "del", own: "ins" }, { skip: "ins", own: "del" }] : [{ skip: "del", own: "ins" }];
  const ids = new Map(nodes.map((n, i) => [n, i]));
  // A match both readings find (same runs, same offsets) is recorded once.
  const recorded = new Set<string>();

  for (const { skip, own } of readings) {
    let text = "";
    const starts: { node: Node; start: number }[] = [];
    for (const item of unit.items) {
      if ("node" in item) {
        if (item.node.role === skip) continue;
        starts.push({ node: item.node, start: text.length });
        text += item.node.value;
      } else if (item.role !== skip) text += item.sep;
    }
    for (const span of spanner(text)) {
      const pieces: { node: Node; start: number; end: number }[] = [];
      for (const { node, start } of starts) {
        const s = Math.max(span.start, start) - start;
        const e = Math.min(span.end, start + node.value.length) - start;
        if (s < e) pieces.push({ node, start: s, end: e });
      }
      if (pieces.length === 0) continue;
      const key = `${pieces.map((p) => `${ids.get(p.node)}:${p.start}-${p.end}`).join(",")}|${span.cls}|${span.value}`;
      if (recorded.has(key)) continue;
      recorded.add(key);
      if (span.cls === null) {
        if (span.source === "pattern") plan.keptHosts++;
        continue;
      }
      const edit: Edit = { cls: span.cls, value: span.value, source: span.source };
      plan.edits.push(edit);
      plan.requests.push({ cls: span.cls, value: span.value });
      // A match in text both readings share that an earlier match already removed gets no second
      // pseudonym: it would read twice in the other reading. Its text is gone either way.
      const covered = pieces.every((p) => p.node.role === "plain" && p.node.blanks.some(([s, e]) => s <= p.start && p.end <= e));
      for (const p of pieces) p.node.blanks.push([p.start, p.end]);
      if (covered) continue;
      const anchor = pieces.find((p) => p.node.role === own) ?? (pieces[0] as (typeof pieces)[number]);
      anchor.node.inserts.push({ at: anchor.start, edit });
    }
  }
}

/** A node's value with its planned blanks removed and pseudonyms inserted. */
function renderNode(node: Node, pz: Pseudonymizer, ids: HexNamer): string {
  if (node.link !== undefined) return rewriteOfficeId(node.link, node.value, pz, ids);
  if (node.whole !== undefined) {
    const core = node.value.trim();
    if (core === "") return node.value;
    const lead = node.value.slice(0, node.value.indexOf(core));
    return lead + pz.pseudonym(node.whole, core) + node.value.slice(lead.length + core.length);
  }
  if (node.blanks.length === 0) return node.value;
  const blank = new Uint8Array(node.value.length);
  for (const [s, e] of node.blanks) blank.fill(1, s, e);
  const inserts = [...node.inserts].sort((a, b) => a.at - b.at);
  let out = "";
  let k = 0;
  for (let i = 0; i < node.value.length; i++) {
    for (; k < inserts.length && (inserts[k] as (typeof inserts)[number]).at === i; k++) {
      const { edit } = inserts[k] as (typeof inserts)[number];
      out += pz.pseudonym(edit.cls, edit.value);
    }
    if (!blank[i]) out += node.value[i];
  }
  return out;
}

/** Write the planned edits. Every pseudonym in `plan.requests` and hex id in `plan.hexIds` must already be derived. */
export function renderDocx(plan: DocxPlan, pz: Pseudonymizer, ids: HexNamer): DocxRender {
  const next = new Map<string, number>();
  const result = rewriteOoxml(
    plan.bytes,
    (value, ctx) => {
      const k = next.get(ctx.member) ?? 0;
      next.set(ctx.member, k + 1);
      const node = plan.nodes.get(ctx.member)?.[k];
      // The render pass sees the same values in the same order as the plan, or it stops.
      if (node === undefined || node.value !== value) throw new Error(`docx render: ${ctx.member} changed between plan and render`);
      return renderNode(node, pz, ids);
    },
    (member) => rulesFor(plan.kinds.get(member) ?? "inert"),
  );
  const failed = result.members.find((m) => m.kind === "error");
  if (failed !== undefined && failed.kind === "error") throw new DocxError(`part ${failed.name} cannot be written (${failed.error})`);
  let metadataReplacements = 0;
  for (const n of plan.wholes) if (renderNode(n, pz, ids) !== n.value) metadataReplacements++;
  return {
    bytes: result.bytes,
    changed: result.members.some((m) => m.kind === "xml" && m.changed),
    entityReplacements: plan.edits.filter((e) => e.source === "entity").length,
    patternReplacements: plan.edits.filter((e) => e.source === "pattern").length,
    mappedReplacements: plan.edits.filter((e) => e.source === "map").length,
    speakerReplacements: plan.edits.filter((e) => e.source === "speaker").length,
    keptHosts: plan.keptHosts,
    metadataReplacements,
  };
}
