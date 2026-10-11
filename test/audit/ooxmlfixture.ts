// Synthetic Office packages for audit tests, shaped like what Word and Excel write: the
// namespace declarations, content types, relationship types and mc:Ignorable lists every
// real package carries. Every name is invented; hosts are example.com.

import type { FixtureMember } from "./zipfixture.ts";

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

const W_NS = [
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  `xmlns:r="${REL}"`,
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'mc:Ignorable="w14 w15 wp14"',
].join(" ");

const contentTypes = (overrides: [string, string][]) =>
  `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("") +
  "</Types>";

const rels = (list: [string, string, string, boolean?][]) =>
  `${DECL}<Relationships xmlns="${PKG_REL}">` +
  list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${ext ? ' TargetMode="External"' : ""}/>`).join("") +
  "</Relationships>";

const docProps = (): FixtureMember[] => [
  {
    name: "docProps/core.xml",
    data:
      `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      '<dc:title>Quarterly notes</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>',
  },
  {
    name: "docProps/app.xml",
    data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>writer</Application></Properties>`,
  },
  {
    name: "docProps/custom.xml",
    data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Reviewed"><vt:lpwstr>yes</vt:lpwstr></property></Properties>`,
  },
];

export interface DocxOptions {
  /** Body text of the one paragraph. */
  body: string;
  /** Target of an external hyperlink relationship, when given. */
  hyperlink?: string;
}

/** A DOCX: every part Word writes for a one-paragraph document, with its namespaces and relationships. */
export function docxMembers(o: DocxOptions): FixtureMember[] {
  const docRels: [string, string, string, boolean?][] = [
    ["rId1", `${REL}/styles`, "styles.xml"],
    ["rId2", `${REL}/settings`, "settings.xml"],
  ];
  if (o.hyperlink !== undefined) docRels.push(["rId3", `${REL}/hyperlink`, o.hyperlink, true]);
  const link = o.hyperlink !== undefined ? '<w:hyperlink r:id="rId3"><w:r><w:t xml:space="preserve"> (link)</w:t></w:r></w:hyperlink>' : "";
  return [
    {
      name: "[Content_Types].xml",
      data: contentTypes([
        ["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"],
        ["/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"],
        ["/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"],
        ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
        ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
        ["/docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"],
      ]),
    },
    {
      name: "_rels/.rels",
      data: rels([
        ["rId1", `${REL}/officeDocument`, "word/document.xml"],
        ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
        ["rId3", `${REL}/extended-properties`, "docProps/app.xml"],
        ["rId4", `${REL}/custom-properties`, "docProps/custom.xml"],
      ]),
    },
    { name: "word/_rels/document.xml.rels", data: rels(docRels) },
    {
      name: "word/document.xml",
      data: `${DECL}<w:document ${W_NS}><w:body><w:p w14:paraId="1A2B3C4D" w14:textId="77777777"><w:r><w:t>${o.body}</w:t></w:r>${link}</w:p><w:sectPr/></w:body></w:document>`,
    },
    {
      name: "word/styles.xml",
      data: `${DECL}<w:styles ${W_NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    },
    {
      name: "word/settings.xml",
      data: `${DECL}<w:settings ${W_NS}><w:zoom w:percent="100"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    },
    ...docProps(),
  ];
}

/** An XLSX: workbook, one sheet with an inline string, shared strings, and an optional external hyperlink. */
export function xlsxMembers(o: DocxOptions): FixtureMember[] {
  const S_NS =
    'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' +
    REL +
    '" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"';
  const sheetRels: [string, string, string, boolean?][] = o.hyperlink !== undefined ? [["rId1", `${REL}/hyperlink`, o.hyperlink, true]] : [];
  const link = o.hyperlink !== undefined ? '<hyperlinks><hyperlink ref="A2" r:id="rId1"/></hyperlinks>' : "";
  return [
    {
      name: "[Content_Types].xml",
      data: contentTypes([
        ["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
        ["/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"],
        ["/xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"],
        ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
        ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
        ["/docProps/custom.xml", "application/vnd.openxmlformats-officedocument.custom-properties+xml"],
      ]),
    },
    {
      name: "_rels/.rels",
      data: rels([
        ["rId1", `${REL}/officeDocument`, "xl/workbook.xml"],
        ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
        ["rId3", `${REL}/extended-properties`, "docProps/app.xml"],
        ["rId4", `${REL}/custom-properties`, "docProps/custom.xml"],
      ]),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels([
        ["rId1", `${REL}/worksheet`, "worksheets/sheet1.xml"],
        ["rId2", `${REL}/sharedStrings`, "sharedStrings.xml"],
      ]),
    },
    {
      name: "xl/workbook.xml",
      data: `${DECL}<workbook ${S_NS}><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    ...(sheetRels.length > 0 ? [{ name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels(sheetRels) }] : []),
    {
      name: "xl/worksheets/sheet1.xml",
      data:
        `${DECL}<worksheet ${S_NS}><sheetData>` +
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>${o.body}</t></is></c></row>` +
        `</sheetData>${link}</worksheet>`,
    },
    {
      name: "xl/sharedStrings.xml",
      data: `${DECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Status</t></si></sst>`,
    },
    ...docProps(),
  ];
}
