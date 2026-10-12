// Office's own per-document identifiers: the places in Word and Excel output where the
// application writes a random ID of its own (an edit session, a paragraph, a worksheet, a
// comment thread, a drawing object, a custom XML store). They name no person, but the same
// value is in the original file, so left as they are they link a blinded file back to it.
// The engine rewrites every one of them (src/engine/officeid.ts): GUID-shaped values with an
// `id` pseudonym, hex values with a same-length HMAC-derived hex value.
//
// Matched by position (element and attribute local names), never by value: whatever sits at
// one of these positions is rewritten, and nothing elsewhere is. Fixed template IDs (a theme
// family's id and vid, a list template code) are not here: they are the same in every file
// made from the template and are copied as they are.
//
// Independent of src/audit/xml.ts, which keeps its own list: the audit does not trust the
// engine's.

import { localName } from "./ooxml.ts";

/** How a linking ID is rewritten: `id` by its value's shape (GUID, hex), `documentId` as Excel's `<prefix>_<GUID or hex>[_...]`. */
export type LinkShape = "id" | "documentId";

/** Namespaced attributes, on any element, that hold a hex linking ID: `w:rsid*`, `w14:paraId`, `w14:textId`, `w15:paraIdParent`, `w16cid:durableId`, `wp14:anchorId`, `wp14:editId`. */
const HEX_ATTRIBUTES = new Set(["paraId", "textId", "paraIdParent", "durableId", "anchorId", "editId"]);

/** Elements whose `val` attribute is a linking ID: `w:rsid`, `w:rsidRoot` (settings), `w14:docId`, `w15:docId`, `w:nsid` (a list's id), `w:guid` (a building block), `c16:uniqueId` (a chart series). */
const VAL_ELEMENTS = new Set(["rsid", "rsidRoot", "docId", "nsid", "guid", "uniqueId"]);

/** Element, then its attributes that hold a GUID linking ID. */
const ID_ATTRIBUTES = new Map<string, ReadonlySet<string>>([
  // Excel threaded comments and their people.
  ["threadedComment", new Set(["id", "personId", "parentId"])],
  ["person", new Set(["id"])],
  // x14:cfRule, the extension half of a conditional format.
  ["cfRule", new Set(["id"])],
  // a16:creationId on a drawing object.
  ["creationId", new Set(["id"])],
  // Custom XML data stores and the content controls bound to them.
  ["datastoreItem", new Set(["itemID"])],
  ["dataBinding", new Set(["storeItemID"])],
  // xr:revisionPtr in workbook.xml: the cloud save's ids.
  ["revisionPtr", new Set(["uidLastSave"])],
]);

/**
 * The shape of the linking ID at attribute `attribute` (qualified) of `element` (qualified), or
 * null when the position holds no linking ID.
 */
export function officeLinkAttribute(element: string, attribute: string): LinkShape | null {
  const el = localName(element);
  const at = localName(attribute);
  const namespaced = attribute.includes(":") && !attribute.startsWith("xmlns:");
  if (el === "revisionPtr" && at === "documentId") return "documentId";
  if (namespaced && (at.startsWith("rsid") || HEX_ATTRIBUTES.has(at) || at === "uid")) return "id";
  if (at === "val" && VAL_ELEMENTS.has(el)) return "id";
  return ID_ATTRIBUTES.get(el)?.has(at) ? "id" : null;
}

/** True when the text of `element` (qualified), under `parent`, is a linking ID: `x14:id` in a conditional format's `ext`, pointing at its `x14:cfRule`. */
export function officeLinkText(element: string, parent: string | undefined): boolean {
  return element.includes(":") && localName(element) === "id" && parent !== undefined && localName(parent) === "ext";
}
