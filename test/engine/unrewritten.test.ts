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
  ["xl/worksheets/sheet1.xml", "row", "r"],
  ["xl/worksheets/sheet1.xml", "c", "t"],
  ["xl/worksheets/sheet1.xml", "row", "x14ac:dyDescent"],
  ["xl/worksheets/sheet1.xml", "row", "x14ac:note"],
  ["xl/worksheets/sheet1.xml", "hyperlink", "display"],
  ["xl/other.xml", "row", "r"],
];

test("structuralAttribute agrees with the audit's exempt positions", () => {
  for (const [member, el, attr] of POSITIONS) {
    expect([member, el, attr, structuralAttribute(member, el, attr)]).toEqual([member, el, attr, ooxmlUriAttribute(member, el, attr) || officeIdAttribute(member, el, attr) === "template"]);
  }
});

test("worksheet addressing attributes are structural; text-bearing and unknown ones are not", () => {
  const sheet = "xl/worksheets/sheet1.xml";
  for (const [el, attr] of [["row", "r"], ["row", "spans"], ["c", "r"], ["c", "t"], ["dimension", "ref"], ["row", "x14ac:dyDescent"]] as const) expect([el, attr, structuralAttribute(sheet, el, attr)]).toEqual([el, attr, true]);
  for (const [el, attr] of [["row", "x14ac:note"], ["row", "label"], ["hyperlink", "display"], ["sheetPr", "codeName"]] as const) expect([el, attr, structuralAttribute(sheet, el, attr)]).toEqual([el, attr, false]);
  expect(structuralAttribute("xl/connections.xml", "row", "r")).toBe(false);
});
