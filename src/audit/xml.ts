// XML reading shared by the audit layers: one tokenizer, so the mechanical and
// semantic layers agree on what is an attribute value and what is document text,
// and one list of the attribute positions that carry OOXML format structure
// (namespace, content-type and relationship-type URIs). Independent of
// src/formats/ooxml.ts: the audit does not read the output the way the engine
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

/** Elements whose `uri` attribute names a namespace or extension, never content: extension lists, compatibility settings, graphic data. */
const URI_ELEMENTS = new Set(["ext", "compatSetting", "graphicData"]);

/**
 * True when `attr` on `element`, in the package member `member` (its path in the zip), holds a
 * namespace, content-type or relationship-type URI: format structure, never document text.
 *
 * - `xmlns` and `xmlns:*` (namespace declarations), in any member;
 * - `ContentType` on `Default` and `Override` in `[Content_Types].xml`;
 * - `Type` on `Relationship` in a `.rels` member (a relationship's `Target` is NOT exempt);
 * - a namespaced `*:Ignorable` (markup compatibility: a list of namespace prefixes);
 * - `uri` (or `*:uri`) on `ext`, `compatSetting` and `graphicData` elements;
 * - `fmtid` on `property` in `docProps/custom.xml` (the property set's format id, a GUID naming
 *   the format; the property's `name` and value are NOT exempt).
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
  return false;
}
