// Minimal OOXML writers for the synthetic kit: a stored (uncompressed) zip, a
// workbook and a Word document, built from XML strings in code. Nothing is
// copied from a real file. Deterministic: members in the order given, no
// compression (so no zlib version can change a byte), and a fixed DOS
// timestamp (1980-01-01 00:00), never the clock.

import { crc32 } from "../formats/ooxml.ts";

export interface ZipEntry {
  name: string;
  data: string;
}

/** A stored zip of UTF-8 members, in the order given. */
export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = 0x21; // 1980-01-01
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.data);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, data);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** XML text and attribute escaping. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const coreXml = (title: string, creator: string, modifiedBy: string): string =>
  `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  `<dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator><cp:lastModifiedBy>${esc(modifiedBy)}</cp:lastModifiedBy>` +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T09:00:00Z</dcterms:created></cp:coreProperties>';

// ---------------------------------------------------------------- workbook

/** A cell: a string (written as a shared string) or a number (written as `<v>`). */
export type WbCell = string | number;

export interface WbSheet {
  name: string;
  rows: WbCell[][];
  /** Internal hyperlinks: cell reference to a location such as `'Sheet'!A1`, with display text. */
  hyperlinks?: { ref: string; location: string; display: string }[];
}

export interface WbPivot {
  /** The source sheet and range. */
  sheet: string;
  ref: string;
  /** One cache field per source column: its header and its distinct string items. */
  fields: { name: string; items: string[] }[];
  /** One record per source row: the item index of each field. */
  records: number[][];
}

export interface Workbook {
  sheets: WbSheet[];
  /** Shared strings that no cell refers to, appended after the used ones. */
  orphans: string[];
  definedNames: { name: string; formula: string }[];
  pivot?: WbPivot;
  core: { title: string; creator: string; modifiedBy: string };
}

const colName = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function buildWorkbook(wb: Workbook): Uint8Array {
  const strings: string[] = [];
  const index = new Map<string, number>();
  let refs = 0;
  const sst = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const sheetXml = wb.sheets.map((sh) => {
    const rows = sh.rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => {
            const ref = `${colName(c)}${r + 1}`;
            if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
            refs++;
            return `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    const links = sh.hyperlinks?.length ? `<hyperlinks>${sh.hyperlinks.map((h) => `<hyperlink ref="${h.ref}" location="${esc(h.location)}" display="${esc(h.display)}"/>`).join("")}</hyperlinks>` : "";
    return `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>${rows}</sheetData>${links}</worksheet>`;
  });
  for (const o of wb.orphans) {
    if (index.has(o)) throw new Error(`orphan shared string is also used by a cell: ${o}`);
    sst(o);
  }
  const n = wb.sheets.length;
  const pivot = wb.pivot;
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data:
        `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/>` +
        wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`).join("") +
        `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.spreadsheetml.sharedStrings+xml"/>` +
        (pivot
          ? `<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="${CT}.spreadsheetml.pivotCacheDefinition+xml"/>` +
            `<Override PartName="/xl/pivotCache/pivotCacheRecords1.xml" ContentType="${CT}.spreadsheetml.pivotCacheRecords+xml"/>`
          : "") +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        `<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>` +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        `${DECL}<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
        "</Relationships>",
    },
    { name: "docProps/core.xml", data: coreXml(wb.core.title, wb.core.creator, wb.core.modifiedBy) },
    {
      name: "docProps/app.xml",
      data:
        `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        `<Application>Spreadsheet</Application><TitlesOfParts><vt:vector size="${n}" baseType="lpstr">${wb.sheets.map((s) => `<vt:lpstr>${esc(s.name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>` +
        "</Properties>",
    },
    {
      name: "xl/workbook.xml",
      data:
        `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        wb.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets>" +
        (wb.definedNames.length ? `<definedNames>${wb.definedNames.map((d) => `<definedName name="${esc(d.name)}">${esc(d.formula)}</definedName>`).join("")}</definedNames>` : "") +
        (pivot ? `<pivotCaches><pivotCache cacheId="1" r:id="rId${n + 2}"/></pivotCaches>` : "") +
        "</workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `${DECL}<Relationships xmlns="${PKG_REL}">` +
        wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
        `<Relationship Id="rId${n + 1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
        (pivot ? `<Relationship Id="rId${n + 2}" Type="${REL}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>` : "") +
        "</Relationships>",
    },
    {
      name: "xl/sharedStrings.xml",
      data: `${DECL}<sst xmlns="${MAIN}" count="${refs}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`,
    },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
  ];
  if (pivot) {
    entries.push(
      {
        name: "xl/pivotCache/pivotCacheDefinition1.xml",
        data:
          `${DECL}<pivotCacheDefinition xmlns="${MAIN}" xmlns:r="${REL}" r:id="rId1" recordCount="${pivot.records.length}">` +
          `<cacheSource type="worksheet"><worksheetSource ref="${pivot.ref}" sheet="${esc(pivot.sheet)}"/></cacheSource><cacheFields count="${pivot.fields.length}">` +
          pivot.fields
            .map((f) => `<cacheField name="${esc(f.name)}" numFmtId="0"><sharedItems count="${f.items.length}">${f.items.map((s) => `<s v="${esc(s)}"/>`).join("")}</sharedItems></cacheField>`)
            .join("") +
          "</cacheFields></pivotCacheDefinition>",
      },
      {
        name: "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels",
        data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/pivotCacheRecords" Target="pivotCacheRecords1.xml"/></Relationships>`,
      },
      {
        name: "xl/pivotCache/pivotCacheRecords1.xml",
        data: `${DECL}<pivotCacheRecords xmlns="${MAIN}" count="${pivot.records.length}">${pivot.records.map((r) => `<r>${r.map((x) => `<x v="${x}"/>`).join("")}</r>`).join("")}</pivotCacheRecords>`,
      },
    );
  }
  return storedZip(entries);
}

// ---------------------------------------------------------------- document

/**
 * A Word document whose body is the given paragraphs, each one or more runs. A run is a string, or
 * `null` for a line break inside the paragraph.
 */
export function buildDocument(paragraphs: readonly (readonly (string | null)[])[], core: { title: string; creator: string; modifiedBy: string }): Uint8Array {
  const run = (t: string | null): string => (t === null ? "<w:r><w:br/></w:r>" : `<w:r><w:t${/^\s|\s$/.test(t) ? ' xml:space="preserve"' : ""}>${esc(t)}</w:t></w:r>`);
  const body = paragraphs.map((p) => `<w:p>${p.map(run).join("")}</w:p>`).join("");
  return storedZip([
    {
      name: "[Content_Types].xml",
      data:
        `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/word/document.xml" ContentType="${CT}.wordprocessingml.document.main+xml"/>` +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        `${DECL}<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        "</Relationships>",
    },
    { name: "docProps/core.xml", data: coreXml(core.title, core.creator, core.modifiedBy) },
    { name: "word/document.xml", data: `${DECL}<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>` },
    // The bibliography part Word saves into every document: no text, and a schema reference whose uri is the
    // bibliography namespace (a host-shaped value in a position that is format structure).
    { name: "customXml/item1.xml", data: `${DECL}<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" SelectedStyle="\\APA.XSL" StyleName="APA"/>` },
    {
      name: "customXml/itemProps1.xml",
      data:
        `${DECL}<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{B7D3A4E1-2C58-4F09-9A61-5E3D8C7F1B02}">` +
        '<ds:schemaRefs><ds:schemaRef ds:uri="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/></ds:schemaRefs></ds:datastoreItem>',
    },
    {
      name: "customXml/_rels/item1.xml.rels",
      data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/customXmlProps" Target="itemProps1.xml"/></Relationships>`,
    },
  ]);
}
