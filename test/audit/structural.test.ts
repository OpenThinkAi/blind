import { describe, expect, test } from "bun:test";
import { type AuditReport, auditTree, blankOoxmlUris, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { xmlBaseView } from "../../src/audit/views.ts";
import { officeIdAttribute, ooxmlUriAttribute, structuralValue as auditStructural, walkXml } from "../../src/audit/xml.ts";
import { DEFAULT_SEED, generateKit } from "../../src/bench/synth.ts";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { structuralValue as engineStructural } from "../../src/engine/unrewritten.ts";
import { structuralShape } from "../../src/formats/structural.ts";
import type { Spec } from "../../src/schema.ts";
import { readZip } from "../formats/zipfixture.ts";
import { docxMembers, xlsxMembers } from "./ooxmlfixture.ts";
import { type FixtureMember, makeZip } from "./zipfixture.ts";

// AGT-1999: a structural attribute position is exempt from the engine's refusal scan and the audit
// only when its value has the shape that position holds. Synthetic only: invented names, example hosts.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
const SPEC: Spec = { version: 1, columns: [], entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [] };
const EMPTY_MAP: BlindMap = { version: 1, entries: [] };
const SHEET = "xl/worksheets/sheet1.xml";

/** `members` with one member's XML edited. */
function edit(members: FixtureMember[], name: string, change: (xml: string) => string): FixtureMember[] {
  return members.map((m) => {
    if (m.name !== name) return m;
    const next = change(m.data as string);
    if (next === m.data) throw new Error(`nothing changed in ${name}`);
    return { ...m, data: next };
  });
}

const auditOf = (path: string, bytes: Uint8Array): AuditReport => {
  const entries: TreeEntry[] = [{ path, kind: "file", bytes }];
  return addSemanticLayer(auditTree(entries, SPEC, EMPTY_MAP), entries, SPEC, EMPTY_MAP, { keep: [] });
};
const leaks = (r: AuditReport, cls: string) => r.files.flatMap((f) => f.findings).filter((f) => f.class === cls);
const emailLeaks = (r: AuditReport) => leaks(r, "pattern:email");

describe("structuralShape", () => {
  test("accepts the values Word and Excel write at structural positions", () => {
    const ok: [string, string, string][] = [
      ["w:document", "xmlns:w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"],
      ["xml", "xmlns:v", "urn:schemas-microsoft-com:vml"],
      ["xml", "xmlns:o", "urn:schemas-microsoft-com:office:office"],
      ["w:document", "xmlns:w", "http://purl.oclc.org/ooxml/wordprocessingml/main"],
      ["cp:coreProperties", "xmlns:dc", "http://purl.org/dc/elements/1.1/"],
      ["cp:coreProperties", "xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance"],
      ["w:document", "xmlns:w14", "http://schemas.microsoft.com/office/word/2010/wordml"],
      ["w:document", "xmlns:go", "http://customooxmlschemas.google.com/"],
      ["w:document", "xmlns:W", "http://Schemas.OpenXMLFormats.org/wordprocessingml/2006/main"],
      ["ext", "uri", "http://schemas.microsoft.com/office/drawing/2010/main"],
      ["Default", "ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
      ["Default", "ContentType", "image/png"],
      ["Relationship", "Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"],
      ["worksheet", "mc:Ignorable", "x14ac xr xr2 xr3"],
      ["ext", "uri", "{BBE1A952-AA13-448e-AADC-164F8A28A991}"],
      ["w:compatSetting", "w:uri", "http://schemas.microsoft.com/office/word"],
      ["a:graphicData", "uri", "http://schemas.openxmlformats.org/drawingml/2006/picture"],
      ["property", "fmtid", "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"],
      ["thm15:themeFamily", "id", "{62F939B6-93AF-4DB8-9C6B-D6C7DFDC589F}"],
      ["w:tmpl", "w:val", "6E3A0C1C"],
      ["row", "r", "12"],
      ["row", "spans", "1:5"],
      ["row", "spans", "1:5 7:9"],
      ["c", "r", "$AB$1048576"],
      ["dimension", "ref", "A1:XFD1048576"],
      ["selection", "sqref", "A1 B2:C3 D:D 4:4"],
      ["pane", "topLeftCell", "B2"],
      ["c", "t", "inlineStr"],
      ["f", "t", "shared"],
      ["row", "ht", "15.75"],
      ["row", "x14ac:dyDescent", "0.25"],
      ["col", "width", "8.7109375"],
      ["row", "hidden", "true"],
      ["c", "s", "3"],
    ];
    for (const [el, attr, value] of ok) expect([el, attr, value, structuralShape(el, attr, value)]).toEqual([el, attr, value, true]);
  });

  test("rejects anything else, so it is scanned", () => {
    const bad: [string, string, string][] = [
      ["w:document", "xmlns:x", "mailto:jane@corp.example.com"],
      ["w:document", "xmlns:x", "http://jane@corp.example.com/ns"],
      ["w:document", "xmlns:x", "Jane Quill"],
      ["Relationship", "Type", "http://schemas.example.com/x y"],
      // AGT-2009: a URI is structure only on a host real Office packages use.
      ["w:document", "xmlns:x", "http://db01.corp.example.com/ns"],
      ["w:document", "xmlns:x", "https://intranet.corp.example.com"],
      ["w:document", "xmlns:x", "http://schemas.openxmlformats.org.corp.example.com/ns"],
      ["w:document", "xmlns:x", "http://evil.schemas.microsoft.com/ns"],
      ["w:document", "xmlns:x", "http://schemas.microsoft.com:8080/ns"],
      ["w:document", "xmlns:x", "http://"],
      ["w:document", "xmlns:x", "urn:corp:db01.corp.example.com"],
      ["w:document", "xmlns:x", "urn:schemas-microsoft-com"],
      ["Relationship", "Type", "http://db01.corp.example.com/relationships/x"],
      ["ext", "uri", "http://db01.corp.example.com/ext"],
      ["Default", "ContentType", "jane@corp.example.com"],
      ["worksheet", "mc:Ignorable", "db01.corp.example.com"],
      ["ext", "uri", "Avery Quill"],
      ["property", "fmtid", "jane@corp.example.com"],
      ["thm15:themeFamily", "vid", "Avery"],
      ["w:tmpl", "w:val", "Avery Quill"],
      ["row", "spans", "jane@corp.example.com"],
      ["row", "r", "Avery Quill"],
      ["dimension", "ref", "A1:C3 db01.example.com"],
      ["c", "t", "Avery"],
      ["row", "ht", "192.0.2.10"],
      ["col", "width", "Quill"],
      ["row", "r", "&#49;"],
    ];
    for (const [el, attr, value] of bad) expect([el, attr, value, structuralShape(el, attr, value)]).toEqual([el, attr, value, false]);
  });
});

describe("the engine and the audit exempt exactly the same values", () => {
  test("for every structural position and value in the synthetic Office fixtures, and planted values", () => {
    const members = [...docxMembers({ body: "x", hyperlink: "https://db01.example.com/a", officeIds: true }), ...xlsxMembers({ body: "x", officeIds: true })];
    let exempt = 0;
    for (const m of members) {
      const text = xmlBaseView(Buffer.from(m.data as string, "utf8")).text;
      walkXml(text, {
        attribute(element, attr, start, end) {
          const value = text.slice(start, end);
          const engine = engineStructural(m.name, element, attr, value);
          expect([m.name, element, attr, engine]).toEqual([m.name, element, attr, auditStructural(m.name, element, attr, value)]);
          // Every structural position in a well-formed package keeps its exemption.
          if (ooxmlUriAttribute(m.name, element, attr) || officeIdAttribute(m.name, element, attr) === "template") expect([m.name, element, attr, engine]).toEqual([m.name, element, attr, true]);
          if (engine) exempt++;
        },
      });
    }
    expect(exempt).toBeGreaterThan(20);
    const planted: [string, string, string, string][] = [
      [SHEET, "row", "spans", "jane@corp.example.com"],
      [SHEET, "row", "spans", "1:3"],
      ["word/document.xml", "w:document", "xmlns:x", "mailto:jane@corp.example.com"],
      ["word/theme/theme1.xml", "thm15:themeFamily", "id", "Avery Quill"],
      ["[Content_Types].xml", "Default", "ContentType", "jane@corp.example.com"],
    ];
    for (const [m, el, attr, v] of planted) expect([m, attr, v, engineStructural(m, el, attr, v)]).toEqual([m, attr, v, auditStructural(m, el, attr, v)]);
  });
});

describe("every structural position in the bench's generated Office files keeps its exemption", () => {
  test("kit v1 and kit v2: engine and audit agree, and every namespace, relationship type and uri is exempt", () => {
    let office = 0;
    for (const version of [1, 2] as const) {
      for (const f of generateKit(DEFAULT_SEED, { version }).files) {
        if (!/\.(docx|xlsx)$/i.test(f.path) || f.bytes === undefined) continue;
        office++;
        for (const e of readZip(f.bytes)) {
          if (!/\.(xml|rels|vml)$/i.test(e.name)) continue;
          const text = xmlBaseView(Buffer.from(e.text, "utf8")).text;
          walkXml(text, {
            attribute(element, attr, start, end) {
              const value = text.slice(start, end);
              const engine = engineStructural(e.name, element, attr, value);
              expect([f.path, e.name, element, attr, engine]).toEqual([f.path, e.name, element, attr, auditStructural(e.name, element, attr, value)]);
              if (ooxmlUriAttribute(e.name, element, attr) || officeIdAttribute(e.name, element, attr) === "template") expect([f.path, e.name, attr, value, engine]).toEqual([f.path, e.name, attr, value, true]);
            },
          });
        }
      }
    }
    expect(office).toBeGreaterThan(1);
  });
});

describe("a value that does not fit its structural position is refused by apply and reported by the audit", () => {
  const cases: [string, string, string, FixtureMember[]][] = [
    ["an email in a worksheet row's spans", "book.xlsx", "xl/worksheets/sheet1.xml <row> attribute spans", edit(xlsxMembers({ body: "open" }), SHEET, (x) => x.replace('<row r="1">', '<row r="1" spans="jane@corp.example.com">'))],
    ["an email in a namespace declaration", "memo.docx", "word/document.xml <w:document> attribute xmlns:x", edit(docxMembers({ body: "open" }), "word/document.xml", (x) => x.replace("<w:document ", '<w:document xmlns:x="mailto:jane@corp.example.com" '))],
  ];

  for (const [name, path, where, members] of cases) {
    test(name, () => {
      const bytes = makeZip(members);
      const r = applySpec([{ path, bytes }], SPEC, { salt: SALT });
      expect(r.outputs).toEqual([]);
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0]?.reason).toContain(`appears where blind does not rewrite it (${where})`);
      expect(r.skipped[0]?.reason).not.toContain("jane@");
      // The audit reads it too, instead of blanking the position and calling the file clean.
      expect(emailLeaks(auditOf(path, bytes))).toHaveLength(1);
    });
  }

  test("a namespace on a custom host (AGT-2009)", () => {
    const path = "memo.docx";
    const bytes = makeZip(edit(docxMembers({ body: "open" }), "word/document.xml", (x) => x.replace("<w:document ", '<w:document xmlns:x="http://db01.corp.example.com/ns" ')));
    const r = applySpec([{ path, bytes }], SPEC, { salt: SALT });
    expect(r.outputs).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.reason).toContain("appears where blind does not rewrite it (word/document.xml <w:document> attribute xmlns:x)");
    expect(r.skipped[0]?.reason).not.toContain("db01");
    expect(leaks(auditOf(path, bytes), "pattern:host")).toHaveLength(1);
    // A relationship type on a custom host is refused and read the same way.
    const rels = makeZip(edit(docxMembers({ body: "open" }), "_rels/.rels", (x) => x.replace("</Relationships>", '<Relationship Id="rIdX" Type="http://db01.corp.example.com/rel" Target="docProps/app.xml"/></Relationships>')));
    expect(applySpec([{ path, bytes: rels }], SPEC, { salt: SALT }).skipped).toHaveLength(1);
    expect(leaks(auditOf(path, rels), "pattern:host")).toHaveLength(1);
  });

  test("the same packages with well-shaped values are written, and the audit blanks those values", () => {
    for (const [path, members] of [["book.xlsx", edit(xlsxMembers({ body: "open" }), SHEET, (x) => x.replace('<row r="1">', '<row r="1" spans="1:1">'))], ["memo.docx", docxMembers({ body: "open" })]] as const) {
      const bytes = makeZip(members);
      const r = applySpec([{ path, bytes }], SPEC, { salt: SALT });
      expect([path, r.skipped]).toEqual([path, []]);
      expect(r.outputs).toHaveLength(1);
    }
    const sheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1" spans="jane@corp.example.com"/><row r="2" spans="1:1"/></sheetData></worksheet>';
    const blanked = Buffer.from(blankOoxmlUris(SHEET, Buffer.from(sheet, "utf8"))).toString("utf8");
    expect(blanked).toContain('spans="jane@corp.example.com"');
    expect(blanked).toContain('spans="   "');
    expect(blanked).not.toContain("schemas.openxmlformats.org");
  });
});
