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
  /** Add Office's own structural IDs where Word or Excel writes them (see OFFICE_IDS). */
  officeIds?: boolean;
}

/**
 * The structural IDs the officeIds fixtures carry, invented, in the shapes Word and Excel write.
 * `linking` values are per document and must not survive `blind apply`; `template` values are the
 * same for every file made from the template and are copied.
 */
export const OFFICE_IDS = {
  template: {
    themeId: "{5E1D7C3A-0B9F-4E2D-8C61-2F4A9B7D3E10}",
    themeVid: "{A7C3E91B-2D4F-4B8A-9E06-71C5D3F2B8A4}",
    listTemplate: "0409001F",
  },
  linking: {
    rsidRoot: "00A1B2C3",
    rsid2: "00D4E5F6",
    paraId: "1A2B3C4D",
    textId: "77777777",
    paraId2: "3E4F5A6B",
    docId14: "5C1F2A3B",
    docId15: "{3F2504E0-4F89-41D3-9A0C-0305E82C3301}",
    nsid: "6D2E9F14",
    anchorId: "0C9B8A7D",
    store: "{9B2E4C71-6A3D-4F85-B0C2-8E1D7F6A5B93}",
    creationId: "{C4D5E6F7-1A2B-4C3D-8E9F-0A1B2C3D4E5F}",
    sheetUid: "{00000000-0001-0000-0000-000000000000}",
    validationUid: "{2B7F1D3E-5C4A-4E96-8D0B-3A6F9C1E7D42}",
    cfRule: "{6F1E2D3C-4B5A-4978-8695-A4B3C2D1E0F9}",
    documentGuid: "{D8E2A6B4-3C1F-4A5E-9B7D-6E4C2A0F8B13}",
    uidLastSave: "{00000000-0000-0000-0000-000000000000}",
  },
} as const;
const L = OFFICE_IDS.linking;
const T = OFFICE_IDS.template;

const theme = (prefix: string): FixtureMember => ({
  name: `${prefix}/theme/theme1.xml`,
  data:
    `${DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1></a:clrScheme>` +
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/></a:majorFont></a:fontScheme></a:themeElements>' +
    `<a:extLst><a:ext uri="{1C4E9A70-2B3D-4F6E-8A1B-9C0D7E5F3A21}"><thm15:themeFamily xmlns:thm15="http://schemas.microsoft.com/office/thememl/2012/main" name="Office Theme" id="${T.themeId}" vid="${T.themeVid}"/></a:ext></a:extLst></a:theme>`,
});

/** A DOCX: every part Word writes for a one-paragraph document, with its namespaces and relationships. */
export function docxMembers(o: DocxOptions): FixtureMember[] {
  const docRels: [string, string, string, boolean?][] = [
    ["rId1", `${REL}/styles`, "styles.xml"],
    ["rId2", `${REL}/settings`, "settings.xml"],
  ];
  if (o.hyperlink !== undefined) docRels.push(["rId3", `${REL}/hyperlink`, o.hyperlink, true]);
  const link = o.hyperlink !== undefined ? '<w:hyperlink r:id="rId3"><w:r><w:t xml:space="preserve"> (link)</w:t></w:r></w:hyperlink>' : "";
  const ids = o.officeIds === true;
  const pAttrs = ids ? ` w:rsidR="${L.rsidRoot}" w:rsidRDefault="${L.rsid2}" w:rsidP="${L.rsidRoot}"` : "";
  const rAttrs = ids ? ` w:rsidRPr="${L.rsid2}"` : "";
  const extra = ids
    ? `<w:sdt><w:sdtPr><w:dataBinding w:xpath="/root[1]/status[1]" w:storeItemID="${L.store}"/></w:sdtPr><w:sdtContent>` +
      `<w:p w14:paraId="${L.paraId2}" w14:textId="${L.textId}" w:rsidR="${L.rsid2}"><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>open</w:t></w:r></w:p></w:sdtContent></w:sdt>` +
      `<w:p w14:paraId="0D1E2F3A" w14:textId="${L.textId}"><w:r><w:drawing><wp:inline wp14:anchorId="${L.anchorId}" wp14:editId="${L.anchorId}" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing">` +
      `<wp:docPr id="1" name="Shape 1"><a:extLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:ext uri="{3B5D7F91-2C4E-4A6B-8D0F-1E3A5C7B9D20}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="${L.creationId}"/></a:ext></a:extLst></wp:docPr></wp:inline></w:drawing></w:r></w:p>`
    : "";
  const settingsIds = ids
    ? `<w:rsids><w:rsidRoot w:val="${L.rsidRoot}"/><w:rsid w:val="${L.rsidRoot}"/><w:rsid w:val="${L.rsid2}"/></w:rsids><w14:docId w14:val="${L.docId14}"/><w15:docId w15:val="${L.docId15}"/>`
    : "";
  const idMembers: FixtureMember[] = ids
    ? [
        theme("word"),
        {
          name: "word/numbering.xml",
          data: `${DECL}<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:nsid w:val="${L.nsid}"/><w:multiLevelType w:val="hybridMultilevel"/><w:tmpl w:val="${T.listTemplate}"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
        },
        {
          name: "customXml/itemProps1.xml",
          data: `${DECL}<ds:datastoreItem ds:itemID="${L.store}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs/></ds:datastoreItem>`,
        },
      ]
    : [];
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
      data: `${DECL}<w:document ${W_NS}><w:body><w:p w14:paraId="1A2B3C4D" w14:textId="77777777"${pAttrs}><w:r${rAttrs}><w:t>${o.body}</w:t></w:r>${link}</w:p>${extra}<w:sectPr${ids ? ` w:rsidR="${L.rsidRoot}"` : ""}/></w:body></w:document>`,
    },
    {
      name: "word/styles.xml",
      data: `${DECL}<w:styles ${W_NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    },
    {
      name: "word/settings.xml",
      data: `${DECL}<w:settings ${W_NS}><w:zoom w:percent="100"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>${settingsIds}</w:settings>`,
    },
    ...idMembers,
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
  const ids = o.officeIds === true;
  const XR =
    ' xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6" xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10"';
  const X14 = 'xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"';
  const revision = ids ? `<xr:revisionPtr revIDLastSave="0" documentId="8_${L.documentGuid}" xr6:coauthVersionLast="47" xr6:coauthVersionMax="47" xr10:uidLastSave="${L.uidLastSave}"/>` : "";
  const cf = ids
    ? `<conditionalFormatting sqref="A2"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar><extLst><ext uri="{4D6E8F02-3A5C-4B7D-9E1F-2C4A6B8D0E31}" ${X14}><x14:id>${L.cfRule}</x14:id></ext></extLst></cfRule></conditionalFormatting>` +
      `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A2" xr:uid="${L.validationUid}"><formula1>"open,closed"</formula1></dataValidation></dataValidations>`
    : "";
  const cfExt = ids
    ? `<extLst><ext uri="{5E7F9A13-4B6D-4C8E-8F20-3D5B7C9E1F42}" ${X14}><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:cfRule type="dataBar" id="${L.cfRule}"><x14:dataBar minLength="0" maxLength="100"/></x14:cfRule><xm:sqref>A2</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>`
    : "";
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
      data: `${DECL}<workbook ${S_NS}${ids ? XR : ""}>${revision}<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    ...(sheetRels.length > 0 ? [{ name: "xl/worksheets/_rels/sheet1.xml.rels", data: rels(sheetRels) }] : []),
    {
      name: "xl/worksheets/sheet1.xml",
      data:
        `${DECL}<worksheet ${S_NS}${ids ? `${XR} xr:uid="${L.sheetUid}"` : ""}><sheetData>` +
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        `<row r="2"><c r="A2" t="inlineStr"><is><t>${o.body}</t></is></c></row>` +
        `</sheetData>${cf}${link}${cfExt}</worksheet>`,
    },
    ...(ids ? [theme("xl")] : []),
    {
      name: "xl/sharedStrings.xml",
      data: `${DECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Status</t></si></sst>`,
    },
    ...docProps(),
  ];
}
