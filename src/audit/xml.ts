// XML reading shared by the audit layers: one tokenizer, so the mechanical and
// semantic layers agree on what is an attribute value and what is document text,
// and the lists of the attribute positions that carry OOXML format structure
// (ooxmlUriAttribute: namespace, content-type and relationship-type URIs;
// officeIdAttribute: Office's own template and linking IDs). Independent of
// src/formats/ooxml.ts and src/formats/officeids.ts: the audit does not read the output the way the engine
// wrote it. No model, no clock, no randomness.

export const localName = (qname: string): string => qname.slice(qname.indexOf(":") + 1);

/** A member read as XML: by its extension, or by an XML declaration at the start. */
export function looksLikeXml(name: string, text: string): boolean {
  if (/\.(?:xml|rels|vml)$/i.test(name)) return true;
  return /^﻿?\s*<\?xml[\s?]/.test(text.slice(0, 64));
}

export interface XmlHandlers {
  /** Character data between tags, raw (entities not undone): text[start, end); `parent` is the open element. */
  text?(start: number, end: number, parent: string | undefined): void;
  /** A comment's body. */
  comment?(start: number, end: number): void;
  /** A CDATA section's body; `parent` is the open element. */
  cdata?(start: number, end: number, parent: string | undefined): void;
  /** An attribute value, without its quotes: text[start, end). */
  attribute?(element: string, attr: string, start: number, end: number): void;
  /** A start, end or empty tag, after its attributes. */
  tag?(name: string, closing: boolean, selfClosing: boolean): void;
}

/**
 * A lenient, single-pass XML tokenizer: it never throws, and reads malformed input as far as it
 * can. Processing instructions and the doctype are skipped as markup. Attribute values may contain
 * ">" only when quoted. Positions are code-unit offsets in `t`.
 */
export function walkXml(t: string, h: XmlHandlers): void {
  const stack: string[] = [];
  let i = 0;
  while (i < t.length) {
    const lt = t.indexOf("<", i);
    const end = lt < 0 ? t.length : lt;
    if (end > i) h.text?.(i, end, stack[stack.length - 1]);
    if (lt < 0) break;
    if (t.startsWith("<!--", lt)) {
      const close = t.indexOf("-->", lt + 4);
      h.comment?.(lt + 4, close < 0 ? t.length : close);
      i = close < 0 ? t.length : close + 3;
      continue;
    }
    if (t.startsWith("<![CDATA[", lt)) {
      const close = t.indexOf("]]>", lt + 9);
      h.cdata?.(lt + 9, close < 0 ? t.length : close, stack[stack.length - 1]);
      i = close < 0 ? t.length : close + 3;
      continue;
    }
    if (t.startsWith("<?", lt) || t.startsWith("<!", lt)) {
      const close = t.indexOf(">", lt);
      i = close < 0 ? t.length : close + 1;
      continue;
    }
    let j = lt + 1;
    const closing = t[j] === "/";
    if (closing) j++;
    const nameStart = j;
    while (j < t.length && !/[\s/>]/.test(t[j] as string)) j++;
    const name = t.slice(nameStart, j);
    let selfClosing = false;
    while (j < t.length && t[j] !== ">") {
      if (t[j] === "/" && t[j + 1] === ">") {
        selfClosing = true;
        j++;
        break;
      }
      if (/\s/.test(t[j] as string)) {
        j++;
        continue;
      }
      const an = j;
      while (j < t.length && !/[\s=/>]/.test(t[j] as string)) j++;
      const attr = t.slice(an, j);
      while (j < t.length && /\s/.test(t[j] as string)) j++;
      if (t[j] !== "=") continue;
      j++;
      while (j < t.length && /\s/.test(t[j] as string)) j++;
      const q = t[j];
      if (q === '"' || q === "'") {
        const close = t.indexOf(q, j + 1);
        const stop = close < 0 ? t.length : close;
        h.attribute?.(name, attr, j + 1, stop);
        j = close < 0 ? t.length : close + 1;
      } else {
        const vs = j;
        while (j < t.length && !/[\s>]/.test(t[j] as string)) j++;
        h.attribute?.(name, attr, vs, j);
      }
    }
    i = j + 1;
    h.tag?.(name, closing, selfClosing);
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
    } else if (!selfClosing) stack.push(name);
  }
}

/** The part every OOXML package has; its presence makes a zip an OOXML package. */
export const CONTENT_TYPES_PART = "[Content_Types].xml";

/** The custom document properties part. */
const CUSTOM_PROPERTIES_PART = "docProps/custom.xml";

/** Worksheet attributes that address or format a row, column or cell: references, spans, styles, sizes. Kept in step with src/engine/unrewritten.ts, which imports no audit code. */
const WORKSHEET_STRUCTURE = new Set([
  "r", "spans", "ref", "sqref", "s", "t", "ht", "hidden", "collapsed", "outlineLevel", "customHeight", "customFormat",
  "thickBot", "thickTop", "min", "max", "width", "customWidth", "style", "bestFit", "count", "uniqueCount", "cm", "vm", "ph", "dyDescent",
  "x", "y", "i", "si", "zoomScale", "zoomScaleNormal", "topLeftCell", "activeCell", "tabSelected", "workbookViewId",
]);
const WORKSHEET_PART = /^xl\/(worksheets|chartsheets|dialogsheets|macrosheets)\/[^/]+\.xml$/i;

/** Elements whose `uri` attribute names a namespace or extension, never content: extension lists, compatibility settings, graphic data, custom XML schema references. */
const URI_ELEMENTS = new Set(["ext", "compatSetting", "graphicData", "schemaRef"]);

/**
 * True when `attr` on `element`, in the package member `member` (its path in the zip), holds a
 * namespace, content-type or relationship-type URI: format structure, never document text.
 *
 * - `xmlns` and `xmlns:*` (namespace declarations), in any member;
 * - `ContentType` on `Default` and `Override` in `[Content_Types].xml`;
 * - `Type` on `Relationship` in a `.rels` member (a relationship's `Target` is NOT exempt);
 * - a namespaced `*:Ignorable` (markup compatibility: a list of namespace prefixes);
 * - `uri` (or `*:uri`) on `ext`, `compatSetting`, `graphicData` and `schemaRef` elements;
 * - `fmtid` on `property` in `docProps/custom.xml` (the property set's format id, a GUID naming
 *   the format; the property's `name` and value are NOT exempt);
 * - worksheet addressing attributes (`r`, `spans`, `ref`, `s`, `t`, `ht` ...) in `xl/worksheets/*.xml`:
 *   row and cell references and sizes, never text.
 *
 * Exemption is by position only, never by value: the same URI anywhere else (text, another
 * attribute, an external relationship's Target) is read as usual. Both audit layers skip these
 * positions; the semantic layer skips more (see semantic.ts).
 */
export function ooxmlUriAttribute(member: string, element: string, attr: string): boolean {
  if (attr === "xmlns" || attr.startsWith("xmlns:")) return true;
  const el = localName(element);
  if (attr === "ContentType") return member === CONTENT_TYPES_PART && (el === "Default" || el === "Override");
  if (attr === "Type") return el === "Relationship" && /\.rels$/i.test(member);
  if (attr.includes(":") && localName(attr) === "Ignorable") return true;
  if (localName(attr) === "uri") return URI_ELEMENTS.has(el);
  if (attr === "fmtid") return el === "property" && member === CUSTOM_PROPERTIES_PART;
  return WORKSHEET_PART.test(member) && WORKSHEET_STRUCTURE.has(localName(attr)) && (!attr.includes(":") || attr === "x14ac:dyDescent");
}

/** What an Office structural ID position holds; see officeIdAttribute. */
export type OfficeIdGroup = "template" | "linking";

/** A theme part, in any package. */
const THEME_PART = /(^|\/)theme\/theme\d*\.xml$/i;

/** Namespaced attributes, on any element, that hold a hex linking ID (local names). */
const LINKING_HEX_ATTRIBUTES = new Set(["paraId", "textId", "paraIdParent", "durableId", "anchorId", "editId"]);
/** Elements whose `val` is a linking ID (local names). */
const LINKING_VAL_ELEMENTS = new Set(["rsid", "rsidRoot", "docId", "nsid", "guid", "uniqueId"]);
/** Element, then its attributes, that hold a GUID linking ID (local names). */
const LINKING_ID_ATTRIBUTES = new Map<string, ReadonlySet<string>>([
  ["threadedComment", new Set(["id", "personId", "parentId"])],
  ["person", new Set(["id"])],
  ["cfRule", new Set(["id"])],
  ["creationId", new Set(["id"])],
  ["datastoreItem", new Set(["itemID"])],
  ["dataBinding", new Set(["storeItemID"])],
  ["revisionPtr", new Set(["documentId", "uidLastSave"])],
]);

/**
 * The Office structural ID positions: attributes where Word or Excel writes an ID of its own, never
 * document text. Matched by position (member, element and attribute), never by value.
 *
 * `template`: the same in every file made from the same template. The audit does not read them
 * (both layers skip them, as they skip ooxmlUriAttribute's positions):
 * - `id` and `vid` on `thm15:themeFamily` in a theme part (`word/theme/theme1.xml`,
 *   `xl/theme/theme1.xml`): the theme's family GUID and variant GUID;
 * - `val` on `w:tmpl` (numbering.xml): a list template's code.
 *
 * `linking`: random per document, so they could link a blinded file to its original. `blind apply`
 * rewrites every one (GUIDs with an `id` pseudonym recorded in the map, hex values with a same-length
 * HMAC-derived value). The mechanical layer still reads them: a GUID the engine did not replace is
 * not a pseudonym in the map and is reported as a `pattern:guid` leak. The hex ones match no
 * mechanical pattern. The semantic layer skips them all:
 * - `w:rsid*` (rsidR, rsidRPr, rsidRDefault, rsidP, rsidDel, rsidSect, rsidTr): edit-session ids;
 *   `val` on `w:rsid` and `w:rsidRoot` in settings.xml: the session list;
 * - `w14:paraId`, `w14:textId` (paragraphs, table rows), `w15:paraId`, `w15:paraIdParent`
 *   (commentsExtended.xml), `w16cid:paraId`, `w16cid:durableId`, `w16cex:durableId` (comment ids);
 * - `wp14:anchorId`, `wp14:editId` (drawing anchors);
 * - `val` on `w14:docId` (hex) and `w15:docId` (GUID): the document's id; on `w:nsid`: a list's id;
 *   on `w:guid`: a building block's id (glossary); on `c16:uniqueId`: a chart series' id;
 * - `xr:uid`, `xr2:uid`, `xr3:uid`, `xr10:uid` and any other namespaced `uid` (worksheets, tables,
 *   table columns, autofilters, data validations, pivot tables, sparkline groups, slicers);
 * - `documentId` and `xr10:uidLastSave` on `xr:revisionPtr` (workbook.xml): the cloud save's ids;
 * - `id`, `personId`, `parentId` on `threadedComment` and `id` on `person` (Excel threaded comments);
 * - `id` on `x14:cfRule` (an extended conditional format; the `x14:id` text that points at it is
 *   text, and read as text);
 * - `id` on `a16:creationId` (any drawing object);
 * - `ds:itemID` on `ds:datastoreItem` (customXml/itemProps*.xml) and `w:storeItemID` on
 *   `w:dataBinding` (a content control bound to it).
 */
export function officeIdAttribute(member: string, element: string, attr: string): OfficeIdGroup | null {
  const el = localName(element);
  const at = localName(attr);
  if (el === "themeFamily" && (attr === "id" || attr === "vid")) return THEME_PART.test(member) ? "template" : null;
  if (el === "tmpl" && at === "val") return "template";
  const namespaced = attr.includes(":") && !attr.startsWith("xmlns:");
  if (namespaced && (at.startsWith("rsid") || LINKING_HEX_ATTRIBUTES.has(at) || at === "uid")) return "linking";
  if (at === "val" && LINKING_VAL_ELEMENTS.has(el)) return "linking";
  return LINKING_ID_ATTRIBUTES.get(el)?.has(at) ? "linking" : null;
}

/** A styles part, in any package (`word/styles.xml`, `xl/styles.xml`). */
const STYLES_PART = /(^|\/)styles\.xml$/i;
/** Theme elements whose `name` is the scheme's display name (local names). */
const THEME_NAME_ELEMENTS = new Set(["theme", "clrScheme", "fontScheme", "fmtScheme", "themeFamily", "extraClrScheme"]);
/** Style elements whose `val` is a style's display name or a reference to one (local names, in a styles part). */
const STYLE_NAME_VAL_ELEMENTS = new Set(["name", "aliases", "basedOn", "next", "link"]);
/** Style elements whose `name` attribute is a style's display name (local names, in a styles part). */
const STYLE_NAME_ATTR_ELEMENTS = new Set(["lsdException", "cellStyle", "tableStyle"]);

/**
 * True when `attr` on `element`, in the package member `member`, holds the display name of an
 * Office theme, font scheme, colour scheme or style ("Office Theme", "Heading 1", "Normal"): names
 * the application writes into every file, not document text. Matched by position (member, element
 * and attribute), never by value:
 * - `name` on `a:theme`, `a:clrScheme`, `a:fontScheme`, `a:fmtScheme` and `thm15:themeFamily` in a theme part;
 * - `w:val` on `w:name`, `w:aliases`, `w:basedOn`, `w:next` and `w:link` in a styles part (a style's names);
 * - `w:name` on `w:lsdException` (latent styles), `name` on `cellStyle` and `tableStyle`, and
 *   `defaultTableStyle` / `defaultPivotStyle` on `tableStyles`, in a styles part.
 *
 * The same words in body text, a cell, a document property or any other member are read as usual.
 * The semantic layer skips these positions; the mechanical layer, which has no name rule, is unchanged.
 */
export function officeDisplayName(member: string, element: string, attr: string): boolean {
  const el = localName(element);
  const at = localName(attr);
  if (THEME_PART.test(member)) return at === "name" && THEME_NAME_ELEMENTS.has(el);
  if (!STYLES_PART.test(member)) return false;
  if (at === "val") return STYLE_NAME_VAL_ELEMENTS.has(el);
  if (at === "name") return STYLE_NAME_ATTR_ELEMENTS.has(el);
  return el === "tableStyles" && (attr === "defaultTableStyle" || attr === "defaultPivotStyle");
}
