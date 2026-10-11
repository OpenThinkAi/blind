// A synthetic workbook for tests, generated as XML and zipped with the independent fixture zip
// builder. Every name, host and number is invented (RFC 5737 addresses, example.com hosts).

import { buildZip, type FixtureEntry } from "./zipfixture.ts";

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const T = (s: string) => `${REL}/${s}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Shared strings. Index 10 and 11 are orphans: no cell refers to them. Index 9 is rich text in two runs. */
export const STRINGS = [
  "Name", // 0
  "Employee ID", // 1
  "Notes", // 2
  "Status", // 3
  "Robin Example", // 4
  "active", // 5
  "Sam Placeholder", // 6
  "Dana Pell", // 7
  "inactive", // 8
  ["Lee ", "Orbit"], // 9
  "Old address of Robin Example: 192.0.2.10", // 10 (orphan)
  "Avery Quill", // 11 (orphan)
  "Sheet", // 12
  "Staff", // 13
  "Link", // 14
  "Amount", // 15
] as const;

export interface WorkbookOptions {
  /** Extra XML members, or replacements for the generated ones. */
  extra?: FixtureEntry[];
  /** Replace sheet 1's sheetData content. */
  staffRows?: string;
}

const si = (s: string | readonly string[]): string =>
  typeof s === "string" ? `<si><t xml:space="preserve">${esc(s)}</t></si>` : `<si>${s.map((r, i) => `<r>${i === 0 ? "" : "<rPr><b/></rPr>"}<t xml:space="preserve">${esc(r)}</t></r>`).join("")}</si>`;

export const STAFF_ROWS = [
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>',
  '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>4417</v></c><c r="C2" t="inlineStr"><is><t>met avery@example.com</t></is></c><c r="D2" t="s"><v>5</v></c></row>',
  `<row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3"><v>4418</v></c><c r="C3" t="inlineStr"><is><r><t xml:space="preserve">ask </t></r><r><rPr><i/></rPr><t>Avery</t></r><r><t xml:space="preserve"> Quill</t></r></is></c><c r="D3" t="s"><v>5</v></c></row>`,
  `<row r="4"><c r="A4" t="s"><v>7</v></c><c r="B4"><v>4419</v></c><c r="C4" t="str"><f>"see "&amp;'Avery Quill'!A1</f><v>see Amount</v></c><c r="D4" t="s"><v>8</v></c></row>`,
  '<row r="5"><c r="A5" t="s"><v>9</v></c><c r="B5"><v>4420</v></c><c r="C5"><f>SUM(B2:B4)+Avery_Total</f><v>13266.5</v></c><c r="D5" t="s"><v>5</v></c></row>',
].join("");

export function workbookEntries(opts: WorkbookOptions = {}): FixtureEntry[] {
  const sheet = (rows: string, rels = "") =>
    `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><dimension ref="A1"/><sheetData>${rows}</sheetData>${rels}</worksheet>`;
  const entries: FixtureEntry[] = [
    {
      name: "[Content_Types].xml",
      data:
        `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        [1, 2, 3].map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>' +
        '<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>' +
        '<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        `${DECL}<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${T("officeDocument")}" Target="xl/workbook.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        `<Relationship Id="rId3" Type="${T("extended-properties")}" Target="docProps/app.xml"/>` +
        `<Relationship Id="rId4" Type="${T("custom-properties")}" Target="docProps/custom.xml"/>` +
        "</Relationships>",
    },
    {
      name: "docProps/core.xml",
      data:
        `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        "<dc:title>Staff list</dc:title><dc:creator>Avery Quill</dc:creator><cp:lastModifiedBy>Robin Example</cp:lastModifiedBy>" +
        '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created></cp:coreProperties>',
    },
    {
      name: "docProps/app.xml",
      data:
        `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        "<Application>Example Sheets</Application><TitlesOfParts><vt:vector size=\"4\" baseType=\"lpstr\"><vt:lpstr>Staff</vt:lpstr><vt:lpstr>Avery Quill</vt:lpstr><vt:lpstr>Contents</vt:lpstr><vt:lpstr>Avery_Total</vt:lpstr></vt:vector></TitlesOfParts>" +
        "<Company>Example Widgets</Company></Properties>",
    },
    {
      name: "docProps/custom.xml",
      data:
        `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Reviewer"><vt:lpwstr>Dana Pell</vt:lpwstr></property></Properties>',
    },
    {
      name: "xl/workbook.xml",
      data:
        `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        '<sheet name="Staff" sheetId="1" r:id="rId1"/><sheet name="Avery Quill" sheetId="2" r:id="rId2"/><sheet name="Contents" sheetId="3" r:id="rId3"/>' +
        "</sheets><definedNames><definedName name=\"Avery_Total\">'Avery Quill'!$A$2</definedName></definedNames>" +
        '<pivotCaches><pivotCache cacheId="1" r:id="rId5"/></pivotCaches></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `${DECL}<Relationships xmlns="${PKG_REL}">` +
        [1, 2, 3].map((n) => `<Relationship Id="rId${n}" Type="${T("worksheet")}" Target="worksheets/sheet${n}.xml"/>`).join("") +
        `<Relationship Id="rId4" Type="${T("sharedStrings")}" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId5" Type="${T("pivotCacheDefinition")}" Target="pivotCache/pivotCacheDefinition1.xml"/>` +
        "</Relationships>",
    },
    {
      name: "xl/sharedStrings.xml",
      data: `${DECL}<sst xmlns="${MAIN}" count="${STRINGS.length}" uniqueCount="${STRINGS.length}">${STRINGS.map(si).join("")}</sst>`,
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet(opts.staffRows ?? STAFF_ROWS) },
    { name: "xl/worksheets/_rels/sheet1.xml.rels", data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${T("comments")}" Target="../comments1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet2.xml", data: sheet('<row r="1"><c r="A1" t="s"><v>15</v></c></row><row r="2"><c r="A2"><v>12.5</v></c></row>') },
    {
      name: "xl/worksheets/sheet3.xml",
      data: sheet(
        '<row r="1"><c r="A1" t="s"><v>12</v></c><c r="B1" t="s"><v>14</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>13</v></c><c r="B2" t="str"><f>HYPERLINK("#Staff!A1","Staff")</f><v>Staff</v></c></row>' +
          `<row r="3"><c r="A3" t="inlineStr"><is><t>Avery Quill</t></is></c><c r="B3" t="str"><f>HYPERLINK("#'Avery Quill'!A1","Avery Quill")</f><v>Avery Quill</v></c></row>`,
        `<hyperlinks><hyperlink ref="A3" location="'Avery Quill'!A1" display="Avery Quill"/></hyperlinks>`,
      ),
    },
    {
      name: "xl/comments1.xml",
      data: `${DECL}<comments xmlns="${MAIN}"><authors><author>Avery Quill</author></authors><commentList><comment ref="A2" authorId="0"><text><r><t>Ask Sam Placeholder</t></r></text></comment></commentList></comments>`,
    },
    {
      name: "xl/pivotCache/pivotCacheDefinition1.xml",
      data:
        `${DECL}<pivotCacheDefinition xmlns="${MAIN}" xmlns:r="${REL}" r:id="rId1" recordCount="2">` +
        '<cacheSource type="worksheet"><worksheetSource ref="A1:B5" sheet="Staff"/></cacheSource><cacheFields count="2">' +
        '<cacheField name="Name" numFmtId="0"><sharedItems count="1"><s v="Robin Example"/></sharedItems></cacheField>' +
        '<cacheField name="Employee ID" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" containsInteger="1" minValue="4417" maxValue="4418"/></cacheField>' +
        "</cacheFields></pivotCacheDefinition>",
    },
    { name: "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels", data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${T("pivotCacheRecords")}" Target="pivotCacheRecords1.xml"/></Relationships>` },
    {
      name: "xl/pivotCache/pivotCacheRecords1.xml",
      data: `${DECL}<pivotCacheRecords xmlns="${MAIN}" count="2"><r><x v="0"/><n v="4417"/></r><r><s v="Sam Placeholder"/><n v="4418"/></r></pivotCacheRecords>`,
    },
  ];
  for (const e of opts.extra ?? []) {
    const i = entries.findIndex((x) => x.name === e.name);
    if (i >= 0) entries[i] = e;
    else entries.push(e);
  }
  return entries;
}

export const buildWorkbook = (opts: WorkbookOptions = {}): Uint8Array => buildZip(workbookEntries(opts));
