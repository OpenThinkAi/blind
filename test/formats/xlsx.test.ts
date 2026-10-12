import { describe, expect, test } from "bun:test";
import type { Frame } from "../../src/formats/ooxml.ts";
import { classify, needsQuotes, parseRef, readWorkbook, sheetRows, tokenizeFormula, XlsxError } from "../../src/formats/xlsx.ts";
import { buildWorkbook, STAFF_ROWS, STRINGS } from "./xlsxfixture.ts";

const frame = (name: string, attrs: Record<string, string> = {}): Frame => ({ name, attrs: new Map(Object.entries(attrs)) });

describe("readWorkbook", () => {
  test("reads sheets in workbook order, cells, shared strings (orphans included), defined names", () => {
    const wb = readWorkbook(buildWorkbook());
    expect(wb.sheets.map((s) => [s.name, s.member])).toEqual([
      ["Staff", "xl/worksheets/sheet1.xml"],
      ["Avery Quill", "xl/worksheets/sheet2.xml"],
      ["Contents", "xl/worksheets/sheet3.xml"],
    ]);
    expect(wb.sharedStrings.map((s) => s.runs.join(""))).toEqual(STRINGS.map((s) => (typeof s === "string" ? s : s.join(""))));
    expect(wb.sharedStrings[9]?.runs).toEqual(["Lee ", "Orbit"]);
    expect(wb.definedNames).toEqual(["Avery_Total"]);
    expect(wb.members.every((m) => m.kind !== "error")).toBe(true);
    expect(sheetRows(wb.sheets[0]!, wb.sharedStrings)).toEqual([
      ["Name", "Employee ID", "Notes", "Status"],
      ["Robin Example", "4417", "met avery@example.com", "active"],
      ["Sam Placeholder", "4418", "ask Avery Quill", "active"],
      ["Dana Pell", "4419", "see Amount", "inactive"],
      ["Lee Orbit", "4420", "13266.5", "active"],
    ]);
  });

  test("gaps in rows and columns become empty cells", () => {
    const wb = readWorkbook(buildWorkbook({ staffRows: '<row r="2"><c r="C2" t="s"><v>0</v></c></row>' }));
    expect(sheetRows(wb.sheets[0]!, wb.sharedStrings)).toEqual([[], ["", "", "Name"]]);
  });

  test("refuses cells without a reference and references to missing shared strings", () => {
    expect(() => readWorkbook(buildWorkbook({ staffRows: '<row r="1"><c t="s"><v>0</v></c></row>' }))).toThrow(XlsxError);
    expect(() => readWorkbook(buildWorkbook({ staffRows: '<row r="1"><c r="A1" t="s"><v>99</v></c></row>' }))).toThrow(/shared string "99"/);
  });

  test("a malformed member is reported as an error, never skipped", () => {
    const wb = readWorkbook(buildWorkbook({ staffRows: `${STAFF_ROWS}<row r="9"><c r="A9"><v>1</v></row>` }));
    expect(wb.members.find((m) => m.name === "xl/worksheets/sheet1.xml")?.kind).toBe("error");
  });

  test("a zip that is not a workbook is refused", () => {
    expect(() => readWorkbook(buildWorkbook({ extra: [{ name: "_rels/.rels", data: '<Relationships xmlns="x"/>' }] }))).toThrow(/no workbook part/);
  });
});

describe("parseRef", () => {
  test("column letters and rows, 0-based", () => {
    expect(parseRef("A1")).toEqual({ row: 0, col: 0 });
    expect(parseRef("$AB$12")).toEqual({ row: 11, col: 27 });
    expect(parseRef("XFD1048576")).toEqual({ row: 1048575, col: 16383 });
    expect(parseRef("XFE1")).toBeNull();
    expect(parseRef("A0")).toBeNull();
  });
});

describe("tokenizeFormula", () => {
  const written = (f: string) =>
    tokenizeFormula(f)
      .map((t) => (t.kind === "string" ? `"${t.text.replace(/"/g, '""')}"` : t.kind === "sheet" ? t.raw : t.text))
      .join("");

  test.each([
    `"see "&'Avery Quill'!A1`,
    "SUM(Staff!B2:B4)+Avery_Total",
    `HYPERLINK("#'It''s'!A1","say ""hi""")`,
    "StaffTable[[#This Row],[Employee ID]]*2",
    "[1]Sheet1!A1+#REF!+Sheet1:Sheet3!B2",
  ])("rebuilds %p exactly", (f) => {
    expect(written(f)).toBe(f);
  });

  test("finds strings, quoted and bare sheet prefixes, names and structured references", () => {
    expect(tokenizeFormula(`"x"&'It''s'!A1+Staff!B2+Avery_Total+SUM(T[Col])`).filter((t) => t.kind !== "other")).toEqual([
      { kind: "string", text: "x" },
      { kind: "sheet", text: "It's", quoted: true, raw: "'It''s'" },
      { kind: "name", text: "A1" },
      { kind: "sheet", text: "Staff", quoted: false, raw: "Staff" },
      { kind: "name", text: "B2" },
      { kind: "name", text: "Avery_Total" },
      { kind: "name", text: "T" },
      { kind: "bracket", text: "[Col]" },
    ]);
  });

  test("sheet names that need quotes", () => {
    expect(needsQuotes("Staff")).toBe(false);
    expect(needsQuotes("Person_7C5E")).toBe(false);
    expect(needsQuotes("Avery Quill")).toBe(true);
    expect(needsQuotes("host-1a2b.example.com")).toBe(true);
    expect(needsQuotes("AB12")).toBe(true);
    expect(needsQuotes("R1C1")).toBe(true);
  });
});

describe("classify", () => {
  const sheet = frame("worksheet");
  test("cells, formulas and inline strings in a worksheet; shared-string indices are cell values the engine leaves alone", () => {
    expect(classify("x.xml", frame("v"), [sheet, frame("sheetData"), frame("row"), frame("c", { t: "s" })])).toBe("cellValue");
    expect(classify("x.xml", frame("f"), [sheet, frame("sheetData"), frame("row"), frame("c")])).toBe("formula");
    expect(classify("x.xml", frame("t"), [sheet, frame("sheetData"), frame("row"), frame("c"), frame("is")])).toBe("inlineRun");
    expect(classify("x.xml", frame("hyperlink"), [sheet], "location")).toBe("location");
    expect(classify("x.xml", frame("hyperlink"), [sheet], "ref")).toBeNull();
    expect(classify("x.xml", frame("pageMargins"), [sheet], "left")).toBeNull();
  });

  test("names, metadata, comments and pivot caches", () => {
    expect(classify("xl/workbook.xml", frame("sheet"), [frame("workbook"), frame("sheets")], "name")).toBe("sheetName");
    expect(classify("xl/workbook.xml", frame("sheet"), [frame("workbook"), frame("sheets")], "r:id")).toBeNull();
    expect(classify("xl/workbook.xml", frame("definedName"), [frame("workbook"), frame("definedNames")], "name")).toBe("definedName");
    expect(classify("docProps/core.xml", frame("dc:creator"), [frame("cp:coreProperties")])).toBe("whole");
    expect(classify("docProps/core.xml", frame("dc:title"), [frame("cp:coreProperties")])).toBe("text");
    expect(classify("docProps/core.xml", frame("dcterms:created"), [frame("cp:coreProperties")])).toBeNull();
    expect(classify("docProps/app.xml", frame("vt:lpstr"), [frame("Properties"), frame("TitlesOfParts"), frame("vt:vector")])).toBe("display");
    expect(classify("docProps/custom.xml", frame("property"), [frame("Properties")], "name")).toBe("text");
    expect(classify("docProps/custom.xml", frame("vt:lpwstr"), [frame("Properties"), frame("property")])).toBe("text");
    expect(classify("xl/comments1.xml", frame("author"), [frame("comments"), frame("authors")])).toBe("whole");
    expect(classify("p.xml", frame("s"), [frame("pivotCacheRecords"), frame("r")], "v")).toBe("text");
    expect(classify("p.xml", frame("n"), [frame("pivotCacheRecords"), frame("r")], "v")).toBe("number");
    expect(classify("p.xml", frame("x"), [frame("pivotCacheRecords"), frame("r")], "v")).toBeNull();
    expect(classify("d.xml", frame("worksheetSource"), [frame("pivotCacheDefinition"), frame("cacheSource")], "sheet")).toBe("sheetRef");
    expect(classify("d.xml", frame("cacheField"), [frame("pivotCacheDefinition"), frame("cacheFields")], "name")).toBe("header");
    expect(classify("r.rels", frame("Relationship", { TargetMode: "External" }), [frame("Relationships")], "Target")).toBe("path");
    expect(classify("r.rels", frame("Relationship"), [frame("Relationships")], "Target")).toBeNull();
    expect(classify("customXml/item1.xml", frame("anything"), [frame("root")])).toBeNull();
  });
});
