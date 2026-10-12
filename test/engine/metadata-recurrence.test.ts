import { describe, expect, test } from "bun:test";
import { auditTree } from "../../src/audit/mechanical.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { revealFile, Revealer } from "../../src/engine/reveal.ts";
import type { Spec } from "../../src/schema.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";

// Office identity metadata replaced whole recurs across the corpus (AGT-1812). Synthetic only:
// invented names, no real people or organisations.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 53);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const CORE_NS =
  'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const APP_NS = 'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** No spec entity and no column rule names any of these: only the metadata does. */
const CREATOR = "Marlow Penhaligon";
const EDITOR = "Odile Varganova";
const COMPANY = "Thistlewick Assurance";
const ACCOUNT = "qtrevanion";

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [], org: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
const sheet = (rows: string): string => `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>${rows}</sheetData></worksheet>`;

function workbook(): Uint8Array {
  const entries: FixtureEntry[] = [
    {
      name: "[Content_Types].xml",
      data:
        `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data:
        `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        `<sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="${CREATOR}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        `${DECL}<Relationships xmlns="${PKG_REL}">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: sheet(
        `<row r="1">${inline("A1", "Remark")}</row>` +
          `<row r="2">${inline("A2", `Reviewed by ${CREATOR} on Monday`)}</row>` +
          `<row r="3">${inline("A3", `Filed with ${COMPANY} last quarter`)}</row>` +
          `<row r="4">${inline("A4", "Totals carried over unchanged")}</row>`,
      ),
    },
    { name: "xl/worksheets/sheet2.xml", data: sheet(`<row r="1">${inline("A1", "Totals")}</row><row r="2">${inline("A2", CREATOR)}</row>`) },
    {
      name: "docProps/core.xml",
      data: `${DECL}<cp:coreProperties ${CORE_NS}><dc:title>Quarter review</dc:title><dc:creator>${CREATOR}</dc:creator><cp:lastModifiedBy>${CREATOR}</cp:lastModifiedBy></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `${DECL}<Properties ${APP_NS}><Application>Example Sheets</Application><Company>${COMPANY}</Company><Template>C:\\Users\\${ACCOUNT}\\Templates\\Review.xltx</Template></Properties>`,
    },
  ];
  return buildZip(entries);
}

function document(): Uint8Array {
  return buildZip([
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
    {
      name: "_rels/.rels",
      data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/document.xml",
      data: `${DECL}<w:document ${W}><w:body><w:p><w:r><w:t xml:space="preserve">Signed off by ${EDITOR} after the call.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    },
    {
      name: "docProps/core.xml",
      data: `${DECL}<cp:coreProperties ${CORE_NS}><dc:title>Sign-off</dc:title><dc:creator>${EDITOR}</dc:creator></cp:coreProperties>`,
    },
  ]);
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const INPUTS: InputFile[] = [
  { path: "review.xlsx", bytes: workbook() },
  { path: "signoff.docx", bytes: document() },
  { path: "notes.txt", bytes: enc(`Ask Penhaligon about the totals; Varganova has the sign-off and ${ACCOUNT} the template.\n`) },
  { path: "Penhaligon summary.txt", bytes: enc("Short summary.\n") },
];

/** Every member of a zip, or the text of a text file. */
const textOf = (f: InputFile): string => (/\.(xlsx|docx)$/.test(f.path) ? readZip(f.bytes).map((e) => e.text).join("\n") : dec(f.bytes));

describe("Office metadata replaced whole recurs across the corpus (AGT-1812)", () => {
  const r: ApplyResult = applySpec(INPUTS, SPEC, { salt: SALT });
  const pseudonymOf = (value: string): string => {
    const e = r.map.entries.find((x) => x.value === value);
    if (e === undefined) throw new Error(`no pseudonym for ${value}`);
    return e.pseudonym;
  };
  const out = (input: string): InputFile => {
    const f = r.files.find((x) => x.path === input);
    if (f === undefined) throw new Error(`no report for ${input}`);
    return r.outputs.find((o) => o.path === f.outputPath) as InputFile;
  };

  test("every file is written", () => {
    expect(r.skipped).toEqual([]);
    expect(r.outputs.length).toBe(INPUTS.length);
  });

  test("no surviving occurrence of the creator, editor, company or account, or of their name parts, in content or names", () => {
    const all = r.outputs.map((f) => `${f.path}\n${textOf(f)}`).join("\n");
    for (const v of ["Marlow", "Penhaligon", "Odile", "Varganova", "Thistlewick", ACCOUNT]) expect(all).not.toContain(v);
  });

  test("the same value gets the same pseudonym in metadata, cells, sheet names, other files and file names", () => {
    const creator = pseudonymOf(CREATOR);
    expect(creator).toMatch(/^Person_/);
    expect(pseudonymOf(COMPANY)).toMatch(/^Org_/);
    const xlsx = new Map(readZip(out("review.xlsx").bytes).map((e) => [e.name, e.text]));
    expect(xlsx.get("docProps/core.xml")).toContain(`<dc:creator>${creator}</dc:creator>`);
    expect(xlsx.get("xl/workbook.xml")).toContain(`<sheet name="${creator}"`);
    expect(xlsx.get("xl/worksheets/sheet1.xml")).toContain(`Reviewed by ${creator} on Monday`);
    expect(xlsx.get("xl/worksheets/sheet1.xml")).toContain(`Filed with ${pseudonymOf(COMPANY)} last quarter`);
    expect(xlsx.get("xl/worksheets/sheet2.xml")).toContain(`<t xml:space="preserve">${creator}</t>`);
    const docx = new Map(readZip(out("signoff.docx").bytes).map((e) => [e.name, e.text]));
    expect(docx.get("word/document.xml")).toContain(`Signed off by ${pseudonymOf(EDITOR)} after the call.`);
    // A lone surname is a name part: it carries its person's pseudonym (AGT-1803).
    expect(dec(out("notes.txt").bytes)).toBe(`Ask ${creator} about the totals; ${pseudonymOf(EDITOR)} has the sign-off and ${pseudonymOf(ACCOUNT)} the template.\n`);
    expect(r.files.find((f) => f.path === "Penhaligon summary.txt")?.outputPath).toBe(`${creator} summary.txt`);
    expect(r.files.find((f) => f.path === "notes.txt")?.mappedReplacements).toBe(3);
  });

  test("the audit reports no map leak, nor any other leak", () => {
    const report = auditTree(
      r.outputs.map((f) => ({ path: f.path, kind: "file" as const, bytes: f.bytes })),
      SPEC,
      r.map,
    );
    const findings = report.files.flatMap((f) => f.findings);
    expect(findings.filter((f) => f.source === "map")).toEqual([]);
    expect(findings.filter((f) => f.severity === "leak")).toEqual([]);
  });

  test("reveal restores every occurrence", () => {
    const rv = new Revealer(r.map);
    const xlsx = new Map(readZip(revealFile("review.xlsx", out("review.xlsx").bytes, rv).bytes).map((e) => [e.name, e.text]));
    const orig = new Map(readZip(INPUTS[0]!.bytes).map((e) => [e.name, e.text]));
    for (const name of ["docProps/core.xml", "docProps/app.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
      expect(xlsx.get(name)).toBe(orig.get(name) as string);
    }
    const docx = new Map(readZip(revealFile("signoff.docx", out("signoff.docx").bytes, rv).bytes).map((e) => [e.name, e.text]));
    const origDocx = new Map(readZip(INPUTS[1]!.bytes).map((e) => [e.name, e.text]));
    for (const name of ["word/document.xml", "docProps/core.xml"]) expect(docx.get(name)).toBe(origDocx.get(name) as string);
    // A lone name part comes back as the whole recorded name, as for any part (reveal.ts restoreName).
    expect(dec(revealFile("notes.txt", out("notes.txt").bytes, rv).bytes)).toBe(
      `Ask ${CREATOR} about the totals; ${EDITOR} has the sign-off and ${ACCOUNT} the template.\n`,
    );
    expect(rv.path(r.files.find((f) => f.path === "Penhaligon summary.txt")?.outputPath as string).text).toBe(`${CREATOR} summary.txt`);
  });

  test("the result does not depend on input order", () => {
    const again = applySpec([...INPUTS].reverse(), SPEC, { salt: SALT });
    expect(again.map).toEqual(r.map);
    expect(again.outputs.map((o) => [o.path, [...o.bytes]])).toEqual(r.outputs.map((o) => [o.path, [...o.bytes]]));
  });
});
