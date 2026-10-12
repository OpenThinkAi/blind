// Parts and positions of an Office package that blind does not rewrite (connection strings, external
// link caches, query tables, custom XML ...). Whatever a handler leaves as written must not hold a
// spec value or a pattern match: such a file is not written. The refusal names the part and the
// element, never the value. Shared by the XLSX and DOCX handlers.

import { localName, type RewriteRules, rewriteOoxml } from "../formats/ooxml.ts";
import type { PatternName, Patterns } from "../schema.ts";
import { findPatternSpans, type Span } from "./text.ts";

/**
 * Every pattern shape, enabled in the spec or not: the audit flags ip, guid and mac whatever the
 * spec says, and email and host when enabled, and a part nothing rewrites cannot honour a switch.
 * `secret` is left out: it reads document text, and in markup, attributes and embedded data it
 * would refuse files over format structure (the audit reads it in document text only).
 */
export const ALL_PATTERNS: Patterns = { email: true, ip: true, mac: true, guid: true, host: true, phone: true, secret: false };

/**
 * Spans in text that nothing rewrites: spec entities, recurring values and speakers (`entities`),
 * and every pattern shape. A host under the keep list has no class and is not a hit.
 */
export function unrewrittenSpans(entities: (text: string) => Span[], keep: readonly string[]): (text: string) => Span[] {
  return (text) => [...entities(text), ...findPatternSpans(text, ALL_PATTERNS, keep)].filter((s) => s.cls !== null);
}

const URI_ELEMENTS = new Set(["ext", "compatSetting", "graphicData", "schemaRef"]);

/**
 * Worksheet attributes that address or format a row, column or cell: references, spans, styles,
 * types, sizes and counts. They are numbers and cell references, never document text, yet a
 * renumbered id of three digits equals a row number (`<row r="123">`). Text-bearing worksheet
 * attributes (hyperlink and data-validation text, filter values) are rewritten by the handler, and
 * any other attribute is still scanned.
 */
const WORKSHEET_STRUCTURE = new Set([
  "r", "spans", "ref", "sqref", "s", "t", "ht", "hidden", "collapsed", "outlineLevel", "customHeight", "customFormat",
  "thickBot", "thickTop", "min", "max", "width", "customWidth", "style", "bestFit", "count", "uniqueCount", "cm", "vm", "ph", "dyDescent",
  "x", "y", "i", "si", "zoomScale", "zoomScaleNormal", "topLeftCell", "activeCell", "tabSelected", "workbookViewId",
]);
const WORKSHEET_PART = /^xl\/(worksheets|chartsheets|dialogsheets|macrosheets)\/[^/]+\.xml$/i;

/**
 * Attribute positions that hold OOXML format structure, never document text: namespace
 * declarations, content-type and relationship-type URIs, extension URIs, a property set's format
 * id, and the fixed template ids. Matched by position, never by value. These mirror the positions
 * the audit exempts (src/audit/xml.ts), kept apart because the engine imports no audit code.
 */
export function structuralAttribute(member: string, element: string, attr: string): boolean {
  if (attr === "xmlns" || attr.startsWith("xmlns:")) return true;
  const el = localName(element);
  const at = localName(attr);
  if (attr === "ContentType") return member === "[Content_Types].xml" && (el === "Default" || el === "Override");
  if (attr === "Type") return el === "Relationship" && /\.rels$/i.test(member);
  if (attr.includes(":") && at === "Ignorable") return true;
  if (at === "uri") return URI_ELEMENTS.has(el);
  if (attr === "fmtid") return el === "property" && member === "docProps/custom.xml";
  if (el === "themeFamily" && (attr === "id" || attr === "vid")) return /(^|\/)theme\/theme\d*\.xml$/i.test(member);
  if (el === "tmpl" && at === "val") return true;
  // Worksheet addressing: an unprefixed attribute (or Excel's own dyDescent), never a name or a link.
  return WORKSHEET_PART.test(member) && WORKSHEET_STRUCTURE.has(at) && (!attr.includes(":") || attr === "x14ac:dyDescent");
}

/**
 * A reason the package must not be written, or null. Walks every XML member offering only what
 * `rewrites(member)` does not rewrite (and that is not format structure) to `scan`.
 */
export function refuseUnrewritten(bytes: Uint8Array, rewrites: (member: string) => RewriteRules, scan: (text: string) => Span[]): string | null {
  const hits: string[] = [];
  rewriteOoxml(
    bytes,
    (value, ctx) => {
      if (hits.length < 5 && scan(value).length > 0) {
        const where = `${ctx.member} <${ctx.element.name}>${ctx.attribute === undefined ? " text" : ` attribute ${ctx.attribute}`}`;
        if (!hits.includes(where)) hits.push(where);
      }
      return value;
    },
    (member) => {
      const r = rewrites(member);
      return {
        text: () => false,
        attribute: (el, a, parents) => !r.attribute(el, a, parents) && !structuralAttribute(member, el.name, a),
        runs: (el, parents) => !r.text(el, parents),
      };
    },
  );
  return hits.length === 0 ? null : `a spec value or pattern match (an email, host, IP address, GUID or MAC address) appears where blind does not rewrite it (${hits.join("; ")}); not written`;
}
