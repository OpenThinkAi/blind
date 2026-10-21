// The value shapes of OOXML format-structure attributes (AGT-1999). The engine (src/engine/unrewritten.ts,
// structuralAttribute) and the audit (src/audit/xml.ts, ooxmlUriAttribute and officeIdAttribute
// "template") each decide by position which attributes hold format structure: namespace and
// relationship-type URIs, content types, extension URIs, format and template ids, worksheet
// addressing. A position alone is not enough: a crafted package can put an email address or a name
// in one (`<row r="1" spans="jane@corp.com">`, `xmlns:x="mailto:jane@corp.com"`,
// `xmlns:x="http://db01.corp.example.com/ns"`). Both sides exempt
// such a position only when its value also has the shape the position holds, using this one
// function, so the engine refuses and the audit reads exactly the same values. Anything else falls
// through to the normal scan. Pure, no I/O; it never decides the position itself.

const localName = (qname: string): string => qname.slice(qname.indexOf(":") + 1);

/** A namespace, relationship-type or schema URI: http(s) or urn, no `@`, `&` or whitespace. */
const URI = /^(?:https?:\/\/|urn:)[A-Za-z0-9._~:/?#[\]!$'()*+,;=%-]*$/;

/**
 * The hosts of the namespace, relationship-type and extension URIs that real Office packages use
 * (AGT-2009): ECMA-376 transitional (`schemas.openxmlformats.org`) and strict (`purl.oclc.org/ooxml`),
 * Microsoft's extensions (`schemas.microsoft.com`: w14, x14ac, mc compat, SharePoint metadata), W3C
 * (`xml`, `xsi`, `xmldsig`), Dublin Core in core properties (`purl.org/dc`), and the one namespace
 * Google Docs writes into every export (`customooxmlschemas.google.com`). Compared whole and
 * case-insensitively, with no port and no subdomains. A URI on any other host
 * (`http://db01.corp.example.com/ns`) is not structure: it is scanned and audited like any value.
 */
const NAMESPACE_HOSTS = new Set(["schemas.openxmlformats.org", "purl.oclc.org", "schemas.microsoft.com", "www.w3.org", "purl.org", "customooxmlschemas.google.com"]);
/** The urn namespaces Office writes (VML and its Office, Word, Excel and PowerPoint extensions): colon-separated words, no dots, so no host fits. */
const OFFICE_URN = /^urn:schemas-microsoft-com(?::[A-Za-z0-9-]+)+$/;

/** A URI Office writes at a namespace, relationship-type or extension position: an allowlisted http(s) host or an Office urn. */
function officeUri(value: string): boolean {
  if (!URI.test(value)) return false;
  if (value.startsWith("urn:")) return OFFICE_URN.test(value);
  const host = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
  return NAMESPACE_HOSTS.has(host.toLowerCase());
}
/** A GUID, with or without braces. */
const GUID = /^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$/;
/** A short hex code (`w:tmpl`'s list template code is 8 hex digits). */
const HEX = /^[0-9A-Fa-f]{1,16}$/;
/** A MIME content type: `type/subtype`, no `@`. */
const CONTENT_TYPE = /^[A-Za-z0-9][\w.+-]*\/[\w.+-]+$/;
/** Markup-compatibility prefixes: space-separated XML prefixes without dots (`w14 wp14 x14ac`). */
const PREFIXES = /^[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*$/;

// Worksheet addressing: a cell (`B12`, `$B$12`) or row (`12`) on its own, or a range of cells, rows
// or columns (`A1:C3`, `1:5`, `A:A`), separated by spaces in a list (`sqref`, `spans`).
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d+`;
const ROW = String.raw`\$?\d+`;
const ANY = String.raw`(?:${CELL}|${ROW}|\$?[A-Za-z]{1,3})`;
const RANGE = String.raw`(?:${ANY}:${ANY}|${CELL}|${ROW})`;
const CELL_REFS = new RegExp(String.raw`^${RANGE}(?: ${RANGE})*$`);
/** Worksheet attributes that hold cell references, rows or spans. */
const REF_ATTRIBUTES = new Set(["r", "ref", "sqref", "spans", "topLeftCell", "activeCell"]);
/** `t` on a cell (`b`, `d`, `e`, `inlineStr`, `n`, `s`, `str`) or a formula (`shared`, `array`, `dataTable`, `normal`). */
const TYPES = new Set(["b", "d", "e", "inlineStr", "n", "s", "str", "shared", "array", "dataTable", "normal"]);
/** Every other worksheet addressing attribute: a number (index, size, count) or a boolean. */
const NUMBER_OR_BOOLEAN = /^(?:-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|true|false)$/;

/**
 * True when `value` has the shape that `attr` on `element` holds at a format-structure position.
 * The caller has already matched the position (structuralAttribute in the engine, ooxmlUriAttribute
 * or officeIdAttribute "template" in the audit); this only checks the value:
 * - `xmlns`, `xmlns:*`, a relationship's `Type`: an http(s) URI with no `@` on one of the
 *   NAMESPACE_HOSTS, or an Office `urn:schemas-microsoft-com:` urn;
 * - `uri` / `*:uri` (extension lists, compatibility settings, graphic data, schema references): such a URI, or a GUID;
 * - `ContentType`: a MIME type; `*:Ignorable`: a list of XML prefixes;
 * - `fmtid`, a theme family's `id` and `vid`: a GUID; `w:tmpl`'s `val`: a hex code;
 * - worksheet addressing: cell references, rows and spans for `r`, `ref`, `sqref`, `spans`,
 *   `topLeftCell` and `activeCell`; a cell or formula type for `t`; a number or boolean for the rest.
 */
export function structuralShape(element: string, attr: string, value: string): boolean {
  const el = localName(element);
  const at = localName(attr);
  if (attr === "xmlns" || attr.startsWith("xmlns:") || attr === "Type") return officeUri(value);
  if (attr === "ContentType") return CONTENT_TYPE.test(value);
  if (attr.includes(":") && at === "Ignorable") return PREFIXES.test(value);
  if (at === "uri") return officeUri(value) || GUID.test(value);
  if (attr === "fmtid" || el === "themeFamily") return GUID.test(value);
  if (el === "tmpl" && at === "val") return HEX.test(value);
  if (REF_ATTRIBUTES.has(at)) return CELL_REFS.test(value);
  if (at === "t") return TYPES.has(value);
  return NUMBER_OR_BOOLEAN.test(value);
}
