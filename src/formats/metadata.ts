// Document dates and zip metadata in a blinded DOCX or XLSX (AGT-2459).
//
// The text blinding leaves every date a package records about itself: when the
// original was created, last saved and last printed, how long it was edited and
// how many times it was saved, when each tracked change and comment was made,
// and the zip's own per-member timestamps and extra fields (extended and NTFS
// times, Unix owner IDs). None of them names anyone, but together they can tie
// a blinded file back to its source. `scrubPackage` writes each as a constant:
//
// - core properties (`docProps/core.xml`): `dcterms:created`, `dcterms:modified`
//   and `cp:lastPrinted` become SCRUBBED_DATE; `cp:revision` becomes 1.
// - extended properties (`docProps/app.xml`): `TotalTime` becomes 0.
// - WordprocessingML and Word's extension parts: every `date` or `dateUtc`
//   attribute in a Word namespace (`w:date` on revisions and comments,
//   `w16cex:dateUtc` in commentsExtensible) becomes SCRUBBED_DATE.
// - SpreadsheetML: a threaded comment's `dT` becomes SCRUBBED_DATE; a pivot
//   cache's `refreshedDate` (a serial day) becomes SCRUBBED_SERIAL and its
//   `refreshedDateIso` SCRUBBED_DATE.
// - the zip: every member's DOS time and date become 1980-01-01 00:00 and every
//   extra field is dropped (ooxml.ts normalizedRecord), and so is the archive
//   comment.
//
// Constants, never a clock, so the output still depends only on the input.
// blind.toml `[metadata] keep_dates = true` skips this pass and writes the
// dates and zip metadata as the original had them.

import { type Frame, localName, rewriteOoxml, type RewriteRules } from "./ooxml.ts";

/** What every document date is written as: the zip epoch, the earliest date a zip member can carry. */
export const SCRUBBED_DATE = "1980-01-01T00:00:00Z";
/** SCRUBBED_DATE as a spreadsheet serial day (1900 date system), for a pivot cache's `refreshedDate`. */
export const SCRUBBED_SERIAL = "29221";

const CORE = new Set([
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
]);
const APP = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
  "http://purl.oclc.org/ooxml/officeDocument/extendedProperties",
]);
const WORD = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const WORD_PREFIX = "http://schemas.microsoft.com/office/word/";
const SHEET = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const THREADED = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments";

/** Core property elements written as SCRUBBED_DATE, and the one written as 1. */
const CORE_DATES = new Set(["created", "modified", "lastPrinted"]);

/** The namespace URI bound to `prefix` (empty: the default namespace) at `el`. */
function resolve(prefix: string, el: Frame, parents: readonly Frame[]): string | undefined {
  const decl = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
  for (const f of [el, ...[...parents].reverse()]) {
    const ns = f.attrs.get(decl);
    if (ns !== undefined) return ns;
  }
  return undefined;
}

const prefixOf = (qname: string): string => {
  const i = qname.indexOf(":");
  return i < 0 ? "" : qname.slice(0, i);
};

const elementNs = (el: Frame, parents: readonly Frame[]): string | undefined => resolve(prefixOf(el.name), el, parents);

/** An unprefixed attribute has no namespace; it takes its element's meaning. */
const attributeNs = (el: Frame, attr: string, parents: readonly Frame[]): string | undefined =>
  prefixOf(attr) === "" ? elementNs(el, parents) : resolve(prefixOf(attr), el, parents);

const isWordNs = (ns: string | undefined): boolean => ns !== undefined && (WORD.has(ns) || ns.startsWith(WORD_PREFIX));

/** The constant a text node or attribute is written as, or null when it is not a date slot. */
function replacement(el: Frame, parents: readonly Frame[], attribute?: string): string | null {
  const root = parents[0] ?? el;
  const rootNs = elementNs(root, []);
  const name = localName(el.name);
  if (attribute === undefined) {
    if (parents.length !== 1) return null;
    if (rootNs !== undefined && CORE.has(rootNs)) return CORE_DATES.has(name) ? SCRUBBED_DATE : name === "revision" ? "1" : null;
    if (rootNs !== undefined && APP.has(rootNs)) return name === "TotalTime" ? "0" : null;
    return null;
  }
  const attr = localName(attribute);
  if ((attr === "date" || attr === "dateUtc") && isWordNs(attributeNs(el, attribute, parents))) return SCRUBBED_DATE;
  if (rootNs === THREADED && name === "threadedComment" && attr === "dT") return SCRUBBED_DATE;
  if (rootNs !== undefined && SHEET.has(rootNs) && name === "pivotCacheDefinition" && prefixOf(attribute) === "") {
    if (attr === "refreshedDate") return SCRUBBED_SERIAL;
    if (attr === "refreshedDateIso") return SCRUBBED_DATE;
  }
  return null;
}

const DATE_RULES: RewriteRules = {
  text: (el, parents) => replacement(el, parents) !== null,
  attribute: (el, attr, parents) => replacement(el, parents, attr) !== null,
};

export interface ScrubResult {
  bytes: Uint8Array;
  /** Date and edit-history values written as a constant (zip headers not counted). */
  dates: number;
  /** Whether the output differs from the input at all (a value or a zip header). */
  changed: boolean;
}

/**
 * Write every document date and the zip's timestamps and extra fields as constants (see the file
 * header). The bytes must be a package blind has already read: a member that cannot be read here is
 * copied as it is (the blinding pass has refused such a package before this runs). Throws ZipError
 * when the archive cannot be read.
 */
export function scrubPackage(bytes: Uint8Array): ScrubResult {
  let dates = 0;
  const r = rewriteOoxml(
    bytes,
    (value, ctx) => {
      const to = replacement(ctx.element, ctx.parents, ctx.attribute);
      if (to === null || to === value.trim()) return value;
      dates++;
      return to;
    },
    DATE_RULES,
    undefined,
    { normalizeZip: true },
  );
  const changed = r.bytes.length !== bytes.length || r.bytes.some((b, i) => b !== bytes[i]);
  return { bytes: r.bytes, dates, changed };
}
