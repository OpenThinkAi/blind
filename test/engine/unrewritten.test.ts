import { expect, test } from "bun:test";
import { officeIdAttribute, ooxmlUriAttribute } from "../../src/audit/xml.ts";
import { structuralAttribute } from "../../src/engine/unrewritten.ts";

// The engine keeps its own list of structural attribute positions; it must agree with the audit's.
const POSITIONS: [string, string, string][] = [
  ["word/document.xml", "w:document", "xmlns:w"],
  ["[Content_Types].xml", "Default", "ContentType"],
  ["word/document.xml", "Default", "ContentType"],
  ["word/_rels/document.xml.rels", "Relationship", "Type"],
  ["word/_rels/document.xml.rels", "Relationship", "Target"],
  ["xl/workbook.xml", "workbook", "mc:Ignorable"],
  ["xl/workbook.xml", "x:ext", "uri"],
  ["xl/workbook.xml", "sheet", "uri"],
  ["word/settings.xml", "w:compatSetting", "w:uri"],
  ["docProps/custom.xml", "property", "fmtid"],
  ["docProps/other.xml", "property", "fmtid"],
  ["xl/theme/theme1.xml", "thm15:themeFamily", "id"],
  ["xl/other.xml", "thm15:themeFamily", "vid"],
  ["word/numbering.xml", "w:tmpl", "w:val"],
  ["xl/connections.xml", "dbPr", "connection"],
];

test("structuralAttribute agrees with the audit's exempt positions", () => {
  for (const [member, el, attr] of POSITIONS) {
    expect([member, el, attr, structuralAttribute(member, el, attr)]).toEqual([member, el, attr, ooxmlUriAttribute(member, el, attr) || officeIdAttribute(member, el, attr) === "template"]);
  }
});
