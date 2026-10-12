// Custom XML data parts of an Office package (customXml/item*.xml). Their root is usually in no
// OOXML namespace (a CRM or line-of-business schema), so no handler knows which values in them are
// document data. Blind rewrites none of them, so the only safe answer is to refuse a part that holds
// any value it cannot confirm is structure. Word and Excel write a few parts of their own, empty or
// with fixed format values; those are allow-listed by root namespace and position. Shared by the
// DOCX and XLSX handlers and the audit. The refusal names the part, never a value.

import { type Frame, localName, rewriteXml, XmlError } from "../formats/ooxml.ts";

/** A custom XML data part by name: `customXml/item1.xml`, not its `itemProps1.xml` or `_rels`. */
export const customDataPart = (member: string): boolean => /^customXml\/item\d*\.xml$/i.test(member);

/** Namespaced attributes that are XML or schema machinery, never data. */
const MACHINERY = new Set(["nil", "type", "schemaLocation", "noNamespaceSchemaLocation", "space", "lang", "Ignorable"]);

interface Profile {
  /** Is the attribute's value structure? Called for the element's local name and the attribute's. */
  attribute(element: string, attr: string): boolean;
  /** May the root have element children? */
  children: boolean;
}

const BIBLIOGRAPHY = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
const COVER_PAGE = "http://schemas.microsoft.com/office/2006/coverPageProps";
const METADATA = "http://schemas.microsoft.com/office/2006/metadata/";
const XSD = "http://www.w3.org/2001/XMLSchema";

/** SharePoint content-type stub attributes: the type's own name, id, version and scope. */
const CONTENT_TYPE = new Set(["_", "contentTypeName", "contentTypeID", "contentTypeVersion", "contentTypeScope", "versionID"]);
/** Schema attributes: names, types and cardinalities; never `default`, `fixed`, `value` or free-text descriptions. */
const SCHEMA = new Set([
  "name", "type", "ref", "base", "use", "minOccurs", "maxOccurs", "id", "version", "namespace", "targetNamespace",
  "elementFormDefault", "attributeFormDefault", "processContents", "schemaLocation", "displayName", "internalName",
  "readOnly", "hidden", "index", "indexed", "percentage", "list", "fieldsID", "showField", "web", "required",
]);

/** What Word and Excel write themselves, by the root's namespace. */
function profileOf(ns: string): Profile | undefined {
  if (ns === BIBLIOGRAPHY) {
    // An empty `b:Sources`: the citation style, and no `b:Source` child.
    return { attribute: (el, at) => ["SelectedStyle", "StyleName", "Version", "URI"].includes(at) && el === "Sources", children: false };
  }
  if (ns === COVER_PAGE) return { attribute: () => false, children: true };
  if (ns.startsWith(METADATA)) return { attribute: (_el, at) => CONTENT_TYPE.has(at), children: true };
  if (ns === XSD) return { attribute: (_el, at) => SCHEMA.has(at), children: true };
  return undefined;
}

function rootNamespace(root: Frame): string {
  const i = root.name.indexOf(":");
  return root.attrs.get(i < 0 ? "xmlns" : `xmlns:${root.name.slice(0, i)}`) ?? "";
}

/**
 * A reason the part must not be written, or null. A part is fine when every attribute value and
 * every run of character data in it is empty or structural: XML machinery (`xmlns`, `xsi:nil`), or a
 * position the application's own part type fixes. Unparseable XML is the caller's concern.
 */
export function customPartRefusal(member: string, xml: string): string | null {
  let profile: Profile | undefined;
  let bad = false;
  const base = (attr: string) => attr === "xmlns" || attr.startsWith("xmlns:") || (attr.includes(":") && MACHINERY.has(localName(attr)));
  try {
    rewriteXml(
      xml,
      (value, ctx) => {
        if (value.trim() === "") return value;
        if (ctx.attribute === undefined) bad = true;
        else if (!base(ctx.attribute) && !(profile?.attribute(localName(ctx.element.name), localName(ctx.attribute)) ?? false)) bad = true;
        return value;
      },
      {
        text: () => false,
        attribute: () => true,
        runs: () => true,
        visit: (el, parents) => {
          if (parents.length === 0) {
            profile = profileOf(rootNamespace(el));
          } else if (profile?.children === false) bad = true;
        },
      },
    );
  } catch (e) {
    if (e instanceof XmlError) return null;
    throw e;
  }
  return bad
    ? `custom XML part ${member} holds data blind cannot confirm it blinded; remove the part or save without it`
    : null;
}
