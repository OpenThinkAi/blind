import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../../src/apply.ts";
import { runAudit } from "../../src/audit/command.ts";
import { type AuditReport, auditTree, blankOoxmlUris, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer, xmlViews } from "../../src/audit/semantic.ts";
import { xmlBaseView } from "../../src/audit/views.ts";
import { type OfficeIdGroup, officeDisplayName, officeIdAttribute, ooxmlUriAttribute, walkXml } from "../../src/audit/xml.ts";
import { readZip } from "../../src/audit/zip.ts";
import { applySpec } from "../../src/engine/apply.ts";
import { planDocx } from "../../src/engine/docx.ts";
import { officeLinkAttribute } from "../../src/formats/officeids.ts";
import { readWorkbook } from "../../src/formats/xlsx.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import type { Spec } from "../../src/schema.ts";
import { docxMembers, OFFICE_IDS, xlsxMembers } from "./ooxmlfixture.ts";
import { type FixtureMember, makeZip } from "./zipfixture.ts";

// Synthetic only: invented names, example.com hosts.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const EMPTY_MAP: BlindMap = { version: 1, entries: [] };

const file = (path: string, bytes: Uint8Array): TreeEntry => ({ path, kind: "file", bytes });
const findings = (r: AuditReport) => [...r.files.flatMap((f) => f.findings), ...r.general];
const leaks = (r: AuditReport) => findings(r).filter((f) => f.severity === "leak");
const audit = (entries: TreeEntry[], map: BlindMap = EMPTY_MAP) => addSemanticLayer(auditTree(entries, SPEC, map), entries, SPEC, map, { keep: [] });

/** The engine's own blinded DOCX: a person and an external hyperlink, both replaced. */
function blindedDocx(): { bytes: Uint8Array; map: BlindMap } {
  const input = makeZip(docxMembers({ body: "Avery Quill met the team", hyperlink: "https://portal.example.com/a" }));
  const r = applySpec([{ path: "memo.docx", bytes: input }], SPEC, { salt: SALT });
  const out = r.outputs[0];
  if (out === undefined) throw new Error("no DOCX output");
  return { bytes: out.bytes, map: r.map };
}

/** The same archive with one member's text edited (a planted survivor). */
function plant(zip: Uint8Array, member: string, edit: (xml: string) => string): Uint8Array {
  const members: FixtureMember[] = readZip(zip).map((m) => {
    if (m.bytes === undefined) throw new Error(`${m.name}: ${m.error}`);
    const text = Buffer.from(m.bytes).toString("utf8");
    if (m.name !== member) return { name: m.name, data: m.bytes };
    const next = edit(text);
    if (next === text) throw new Error(`nothing planted in ${member}`);
    return { name: m.name, data: next };
  });
  return makeZip(members);
}

describe("OOXML packages: namespace, content-type and relationship-type URIs are structure", () => {
  test("a blinded DOCX from the engine audits clean in both layers", () => {
    const { bytes, map } = blindedDocx();
    const text = readZip(bytes)
      .map((m) => Buffer.from(m.bytes ?? new Uint8Array()).toString("utf8"))
      .join("\n");
    // The URIs are there to be skipped.
    expect(text).toContain('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"');
    expect(text).toContain('ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"');
    expect(text).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"');
    expect(text).toContain('mc:Ignorable="w14 w15 wp14"');
    expect(text).toContain('fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"');
    expect(text).not.toContain("portal.example.com");
    const r = audit([file("memo.docx", bytes)], map);
    expect(findings(r)).toEqual([]);
    expect(r.status).toBe("clean");
  });

  test("a synthetic XLSX audits clean in both layers", () => {
    const r = audit([file("book.xlsx", makeZip(xlsxMembers({ body: "open" })))]);
    expect(findings(r)).toEqual([]);
    expect(r.status).toBe("clean");
  });

  test("a host planted in DOCX body text or an external hyperlink Target is a leak", () => {
    const { bytes, map } = blindedDocx();
    const inText = plant(bytes, "word/document.xml", (x) => x.replace("met the team", "met db01.example.com"));
    const inTarget = plant(bytes, "word/_rels/document.xml.rels", (x) => x.replace(/Target="[^"]*"( TargetMode="External")/, 'Target="https://db01.example.com/a"$1'));
    for (const [zip, part] of [
      [inText, "word/document.xml"],
      [inTarget, "word/_rels/document.xml.rels"],
    ] as const) {
      const r = audit([file("memo.docx", zip)], map);
      expect(r.status).toBe("leak");
      expect(leaks(r).map((f) => [f.part, f.class, f.masked])).toEqual([[part, "pattern:host", "db***16"]]);
    }
  });

  test("a blinded XLSX from the engine audits clean; a host planted in a cell is a leak", () => {
    const input = makeZip(xlsxMembers({ body: "Avery Quill", hyperlink: "https://portal.example.com/a" }));
    const r = applySpec([{ path: "book.xlsx", bytes: input }], SPEC, { salt: SALT });
    const out = r.outputs[0];
    if (out === undefined) throw new Error("no XLSX output");
    const clean = audit([file("book.xlsx", out.bytes)], r.map);
    expect(findings(clean)).toEqual([]);
    expect(clean.status).toBe("clean");
    const planted = plant(out.bytes, "xl/worksheets/sheet1.xml", (x) => x.replace(/(<is><t>)[^<]*/, "$1see db01.example.com"));
    expect(leaks(audit([file("book.xlsx", planted)], r.map)).map((f) => [f.part, f.masked])).toEqual([["xl/worksheets/sheet1.xml", "db***16"]]);
  });

  test("a host planted in XLSX cell text or an external hyperlink Target is a leak", () => {
    for (const [members, part] of [
      [xlsxMembers({ body: "see db01.example.com" }), "xl/worksheets/sheet1.xml"],
      [xlsxMembers({ body: "open", hyperlink: "https://db01.example.com/a" }), "xl/worksheets/_rels/sheet1.xml.rels"],
    ] as const) {
      const r = audit([file("book.xlsx", makeZip(members))]);
      expect(r.status).toBe("leak");
      expect(leaks(r).map((f) => [f.part, f.class, f.masked])).toEqual([[part, "pattern:host", "db***16"]]);
    }
  });

  test("the exemption is by position, not by host: a namespace host in text or another attribute is reported", () => {
    const { bytes, map } = blindedDocx();
    const inText = plant(bytes, "word/document.xml", (x) => x.replace("met the team", "see schemas.openxmlformats.org"));
    const inAttr = plant(bytes, "word/document.xml", (x) => x.replace('w:styleId="Normal"', 'w:styleId="purl.org.example.com"').replace("<w:sectPr/>", '<w:sectPr w:rsidR="00A1" w:name="schemas.microsoft.com"/>'));
    expect(leaks(audit([file("memo.docx", inText)], map)).map((f) => f.masked)).toEqual(["sc***26"]);
    expect(leaks(audit([file("memo.docx", inAttr)], map)).map((f) => f.masked)).toEqual(["sc***21"]);
    // A content type outside [Content_Types].xml, or a relationship Type outside a .rels part, is not structure.
    const misplaced = plant(bytes, "word/document.xml", (x) =>
      x.replace("<w:sectPr/>", '<w:sectPr><Override ContentType="db01.example.com"/><Relationship Type="db02.example.com"/></w:sectPr>'),
    );
    expect(leaks(audit([file("memo.docx", misplaced)], map)).map((f) => f.masked)).toEqual(["db***16", "db***16"]);
  });

  test("a custom property's format id is structure; a GUID in its name or value is not", () => {
    const { bytes, map } = blindedDocx();
    const planted = plant(bytes, "docProps/custom.xml", (x) => x.replace("<vt:lpwstr>yes</vt:lpwstr>", "<vt:lpwstr>{D5CDD505-2E9C-101B-9397-08002B2CF9AE}</vt:lpwstr>"));
    expect(leaks(audit([file("memo.docx", planted)], map)).map((f) => [f.part, f.class])).toEqual([["docProps/custom.xml", "pattern:guid"]]);
  });

  test("a zip that is not an OOXML package gets no exemption", () => {
    const xml = '<?xml version="1.0"?><a xmlns="http://schemas.openxmlformats.org/x"/>';
    const r = audit([file("pack.zip", makeZip([{ name: "a.xml", data: xml }]))]);
    expect(leaks(r).map((f) => f.masked)).toEqual(["sc***26"]);
  });

  test("a member name's extension is read on its own, as a file name's is", () => {
    const r = audit([file("memo.docx", makeZip([...docxMembers({ body: "x" }), { name: "word/db01.example.com.xml.rels", data: "" }]))]);
    expect(leaks(r).map((f) => [f.part, f.in, f.masked])).toEqual([["word/db01.example.com.xml.rels", "name", "db***20"]]);
  });

  test("UTF-16 members are blanked in their own encoding, offsets intact", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="http://schemas.openxmlformats.org/w"><w:t>db01.example.com</w:t></w:document>';
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]);
    const blanked = blankOoxmlUris("word/document.xml", bytes);
    expect(blanked.length).toBe(bytes.length);
    const back = Buffer.from(blanked).subarray(2).toString("utf16le");
    expect(back).toBe(xml.replace("http://schemas.openxmlformats.org/w", " ".repeat(35)));
    const r = audit([file("memo.docx", makeZip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: bytes }]))]);
    const hit = leaks(r);
    expect(hit.map((f) => f.masked)).toEqual(["db***16"]);
    expect(bytes.subarray(hit[0]?.offset ?? 0, (hit[0]?.offset ?? 0) + 4)).toEqual(Buffer.from("db", "utf16le"));
  });

  test("ooxmlUriAttribute names exactly the structural positions", () => {
    const yes: [string, string, string][] = [
      ["word/document.xml", "w:document", "xmlns:w"],
      ["word/document.xml", "Types", "xmlns"],
      ["[Content_Types].xml", "Default", "ContentType"],
      ["[Content_Types].xml", "Override", "ContentType"],
      ["_rels/.rels", "Relationship", "Type"],
      ["word/_rels/document.xml.rels", "Relationship", "Type"],
      ["word/document.xml", "w:document", "mc:Ignorable"],
      ["word/theme/theme1.xml", "a:ext", "uri"],
      ["word/settings.xml", "w:compatSetting", "w:uri"],
      ["word/document.xml", "a:graphicData", "uri"],
      ["docProps/custom.xml", "property", "fmtid"],
    ];
    const no: [string, string, string][] = [
      ["word/_rels/document.xml.rels", "Relationship", "Target"],
      ["word/_rels/document.xml.rels", "Relationship", "TargetMode"],
      ["word/document.xml", "Relationship", "Type"],
      ["word/document.xml", "Override", "ContentType"],
      ["[Content_Types].xml", "Override", "PartName"],
      ["word/document.xml", "w:document", "Ignorable"],
      ["word/document.xml", "w:hyperlink", "uri"],
      ["word/document.xml", "wp:docPr", "descr"],
      ["word/document.xml", "w:p", "xmlnsx"],
      ["docProps/custom.xml", "property", "name"],
      ["word/document.xml", "property", "fmtid"],
    ];
    for (const [m, e, a] of yes) expect([m, e, a, ooxmlUriAttribute(m, e, a)]).toEqual([m, e, a, true]);
    for (const [m, e, a] of no) expect([m, e, a, ooxmlUriAttribute(m, e, a)]).toEqual([m, e, a, false]);
  });

  test("the semantic layer skips every attribute position the mechanical layer skips", () => {
    for (const m of [...docxMembers({ body: "x", hyperlink: "https://db01.example.com/a" }), ...xlsxMembers({ body: "x" })]) {
      const bytes = Buffer.from(m.data as string, "utf8");
      const view = xmlBaseView(bytes);
      const attrs = xmlViews(view, m.name).find((v) => v.encoding.endsWith("+xml-attributes"))?.text ?? "";
      walkXml(view.text, {
        attribute(element, attr, start, end) {
          const value = view.text.slice(start, end);
          if (ooxmlUriAttribute(m.name, element, attr)) expect(attrs.split("\n")).not.toContain(value);
        },
      });
      // And every value the mechanical layer blanks is gone from what it reads; nothing else changed.
      const blanked = Buffer.from(blankOoxmlUris(m.name, bytes)).toString("utf8");
      expect(blanked.length).toBe(view.text.length);
      expect(blanked).not.toContain("schemas.openxmlformats.org");
      for (let i = 0; i < blanked.length; i++) if (blanked[i] !== " ") expect(blanked[i]).toBe(view.text[i] as string);
    }
  });
});

describe("blind audit on a DOCX written by blind apply", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-ooxml-"));
    mkdirSync(join(dir, ".blind"), { mode: 0o700 });
    writeFileSync(join(dir, ".blind", "salt"), Buffer.from(SALT), { mode: 0o600 });
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "memo.docx"), makeZip(docxMembers({ body: "Avery Quill met the team", hyperlink: "https://portal.example.com/a" })));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const io = () => {
    const out = new PassThrough();
    const err = new PassThrough();
    let o = "";
    out.on("data", (d) => (o += d));
    err.on("data", (d) => (o += d));
    return { out, err, text: () => o };
  };

  test("apply, then audit: clean; with a planted body host: leak (exit 2)", async () => {
    const a = io();
    expect(await runApply(["in", "-o", "out"], { out: a.out, err: a.err, cwd: dir })).toBe(0);
    const clean = io();
    expect(await runAudit(["out", "--no-model"], { out: clean.out, err: clean.err, cwd: dir })).toBe(0);
    expect(clean.text()).toContain("status: clean");
    const path = join(dir, "out", "memo.docx");
    writeFileSync(path, plant(readFileSync(path), "word/document.xml", (x) => x.replace("met the team", "met db01.example.com")));
    const leaky = io();
    expect(await runAudit(["out", "--no-model"], { out: leaky.out, err: leaky.err, cwd: dir })).toBe(2);
  });
});

describe("Office structural IDs: template ids are structure, linking ids are rewritten (AGT-1791)", () => {
  const T = OFFICE_IDS.template;
  const L = OFFICE_IDS.linking;
  const texts = (zip: Uint8Array): Map<string, string> =>
    new Map(readZip(zip).map((m) => [m.name, Buffer.from(m.bytes ?? new Uint8Array()).toString("utf8")]));
  const attr = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((m) => m[1] as string);
  const apply = (path: string, members: FixtureMember[]) => {
    const r = applySpec([{ path, bytes: makeZip(members) }], SPEC, { salt: SALT });
    const out = r.outputs[0];
    if (out === undefined) throw new Error(`no output for ${path}`);
    return { bytes: out.bytes, map: r.map };
  };
  const linkingValues = Object.values(L).filter((v) => v !== L.uidLastSave && v !== L.sheetUid);

  test("a DOCX shaped like Word output, through blind apply, audits clean; no linking id survives", () => {
    const { bytes, map } = apply("memo.docx", docxMembers({ body: "Avery Quill met the team", officeIds: true }));
    const out = texts(bytes);
    const all = [...out.values()].join("\n");
    for (const v of linkingValues) expect([v, all.includes(v)]).toEqual([v, false]);
    // Fixed template ids are copied.
    expect(all).toContain(`id="${T.themeId}" vid="${T.themeVid}"`);
    expect(all).toContain(`<w:tmpl w:val="${T.listTemplate}"/>`);
    // Same shapes: hex stays 8 upper-case digits (paragraph ids under 0x80000000), GUIDs keep their braces and case.
    const doc = out.get("word/document.xml") as string;
    for (const v of [...attr(doc, "w14:paraId"), ...attr(doc, "w14:textId"), ...attr(doc, "w:rsidR"), ...attr(doc, "wp14:anchorId")]) {
      expect(v).toMatch(/^[0-9A-F]{8}$/);
    }
    for (const v of attr(doc, "w14:paraId")) expect(Number.parseInt(v, 16)).toBeLessThan(0x80000000);
    const settings = out.get("word/settings.xml") as string;
    expect(attr(settings, "w15:val")[0]).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/);
    // References still resolve: one value, one replacement, across parts.
    expect(attr(doc, "w:storeItemID")).toEqual(attr(out.get("customXml/itemProps1.xml") as string, "ds:itemID"));
    expect(attr(doc, "w:rsidR")[0]).toBe(attr(settings, "w:val").find((_, i) => i === 1) as string);
    expect(new Set(attr(doc, "w14:textId")).size).toBe(1);
    expect(attr(doc, "wp14:anchorId")).toEqual(attr(doc, "wp14:editId"));
    // The package still reads as a DOCX.
    expect(() => planDocx(bytes)).not.toThrow();
    // No leak, no candidate: the theme and style display names ("Office Theme", "Default Paragraph Font") are structure.
    const r = audit([file("memo.docx", bytes)], map);
    expect(findings(r)).toEqual([]);
    expect(r.status).toBe("clean");
  });

  test("an XLSX shaped like Excel output, through blind apply, audits clean; no linking id survives", () => {
    const { bytes, map } = apply("book.xlsx", xlsxMembers({ body: "Avery Quill", officeIds: true }));
    const out = texts(bytes);
    const all = [...out.values()].join("\n");
    for (const v of [...linkingValues, L.sheetUid, L.uidLastSave]) expect([v, all.includes(v)]).toEqual([v, false]);
    expect(all).toContain(`id="${T.themeId}" vid="${T.themeVid}"`);
    const sheet = out.get("xl/worksheets/sheet1.xml") as string;
    const workbook = out.get("xl/workbook.xml") as string;
    const guid = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;
    expect(attr(sheet, "xr:uid")).toHaveLength(2);
    for (const v of attr(sheet, "xr:uid")) expect(v).toMatch(guid);
    // The x14:id text and the x14:cfRule it points at get the same replacement.
    const cfText = /<x14:id>([^<]*)<\/x14:id>/.exec(sheet)?.[1];
    expect(cfText).toMatch(guid);
    expect(attr(sheet, " id")).toEqual([cfText as string]);
    expect(attr(workbook, "documentId")[0]).toMatch(/^8_\{[0-9A-F-]{36}\}$/);
    expect(attr(workbook, "xr10:uidLastSave")[0]).toMatch(guid);
    // Every GUID the engine wrote is a pseudonym in the map.
    for (const v of [...attr(sheet, "xr:uid"), cfText as string]) expect(map.entries.some((e) => `{${e.pseudonym.toUpperCase()}}` === v)).toBe(true);
    expect(readWorkbook(bytes).sheets.map((s) => s.name)).toHaveLength(1);
    const r = audit([file("book.xlsx", bytes)], map);
    expect(findings(r)).toEqual([]);
    expect(r.status).toBe("clean");
  });

  test("before apply, a template id is not reported, but every linking GUID still is a leak", () => {
    for (const [path, members, guids] of [
      ["memo.docx", docxMembers({ body: "open", officeIds: true }), [L.docId15, L.store, L.store, L.creationId]],
      ["book.xlsx", xlsxMembers({ body: "open", officeIds: true }), [L.documentGuid, L.uidLastSave, L.sheetUid, L.cfRule, L.validationUid, L.cfRule]],
    ] as const) {
      const r = audit([file(path, makeZip(members))]);
      const hits = leaks(r);
      expect(hits.every((f) => f.class === "pattern:guid")).toBe(true);
      expect(hits.map((f) => f.masked).sort()).toEqual(guids.map((g) => `${g.slice(1, 3)}***36`).sort());
      expect(hits.some((f) => f.part.includes("theme"))).toBe(false);
    }
  });

  test("a GUID planted in DOCX body text or an XLSX cell is still a leak", () => {
    const docx = apply("memo.docx", docxMembers({ body: "Avery Quill met the team", officeIds: true }));
    const inBody = plant(docx.bytes, "word/document.xml", (x) => x.replace("met the team", `met ${T.themeId}`));
    expect(leaks(audit([file("memo.docx", inBody)], docx.map)).map((f) => [f.part, f.class])).toEqual([["word/document.xml", "pattern:guid"]]);
    const xlsx = apply("book.xlsx", xlsxMembers({ body: "Avery Quill", officeIds: true }));
    const inCell = plant(xlsx.bytes, "xl/worksheets/sheet1.xml", (x) => x.replace(/(<is><t>)[^<]*/, `$1${T.themeVid}`));
    expect(leaks(audit([file("book.xlsx", inCell)], xlsx.map)).map((f) => [f.part, f.class])).toEqual([["xl/worksheets/sheet1.xml", "pattern:guid"]]);
    // An original linking GUID put back where the engine replaced it is a leak too: the map knows it.
    const restored = plant(xlsx.bytes, "xl/worksheets/sheet1.xml", (x) => x.replace(/(<worksheet[^>]* xr:uid=")[^"]*/, `$1${L.sheetUid}`));
    expect(leaks(audit([file("book.xlsx", restored)], xlsx.map)).map((f) => [f.part, f.source])).toEqual([["xl/worksheets/sheet1.xml", "map"]]);
  });

  test("the template exemption is by position: the theme GUID in another attribute or member is reported", () => {
    const { bytes, map } = apply("memo.docx", docxMembers({ body: "open", officeIds: true }));
    const otherAttr = plant(bytes, "word/theme/theme1.xml", (x) => x.replace('name="Office Theme" id=', `name="${T.themeId}" id=`));
    const otherMember = plant(bytes, "word/settings.xml", (x) => x.replace("<w:zoom", `<thm15:themeFamily xmlns:thm15="urn:x" id="${T.themeId}"/><w:zoom`));
    for (const [zip, part] of [
      [otherAttr, "word/theme/theme1.xml"],
      [otherMember, "word/settings.xml"],
    ] as const) {
      expect(leaks(audit([file("memo.docx", zip)], map)).map((f) => [f.part, f.class])).toEqual([[part, "pattern:guid"]]);
    }
  });

  test("theme and style display names are skipped by position; the same words elsewhere are reported", () => {
    const { bytes, map } = apply("memo.docx", docxMembers({ body: "open", officeIds: true }));
    const phrases = (zip: Uint8Array) => findings(audit([file("memo.docx", zip)], map)).map((f) => [f.part, f.class]);
    expect(phrases(bytes)).toEqual([]);
    // A planted name in body text is still reported, even a theme's own name.
    const inBody = plant(bytes, "word/document.xml", (x) => x.replace("<w:t>open</w:t>", "<w:t>Office Theme</w:t>"));
    expect(phrases(inBody)).toEqual([["word/document.xml", "semantic:phrase"]]);
    // So is a planted name in a position that is not a display name: another attribute, another member.
    const otherAttr = plant(bytes, "word/theme/theme1.xml", (x) => x.replace('<a:latin typeface="Calibri Light"', '<a:latin typeface="Calibri Light" other="Planted Name"'));
    expect(phrases(otherAttr)).toEqual([["word/theme/theme1.xml", "semantic:phrase"]]);
    const otherMember = plant(bytes, "docProps/core.xml", (x) => x.replace("Quarterly notes", "Planted Name"));
    expect(phrases(otherMember)).toEqual([["docProps/core.xml", "semantic:phrase"]]);
    const styleText = plant(bytes, "word/styles.xml", (x) => x.replace("</w:styles>", '<w:style w:styleId="X"><w:foo w:val="Planted Name"/></w:style></w:styles>'));
    expect(phrases(styleText)).toEqual([["word/styles.xml", "semantic:phrase"]]);
  });

  test("officeDisplayName names the theme and style display-name positions", () => {
    const cases: [string, string, string, boolean][] = [
      ["word/theme/theme1.xml", "a:theme", "name", true],
      ["xl/theme/theme1.xml", "a:clrScheme", "name", true],
      ["xl/theme/theme1.xml", "a:fontScheme", "name", true],
      ["word/theme/theme1.xml", "thm15:themeFamily", "name", true],
      ["word/styles.xml", "w:name", "w:val", true],
      ["word/styles.xml", "w:basedOn", "w:val", true],
      ["word/styles.xml", "w:lsdException", "w:name", true],
      ["xl/styles.xml", "cellStyle", "name", true],
      ["xl/styles.xml", "tableStyle", "name", true],
      ["xl/styles.xml", "tableStyles", "defaultTableStyle", true],
      // Same attribute, other element or member: not a display name.
      ["word/document.xml", "a:theme", "name", false],
      ["word/theme/theme1.xml", "a:latin", "name", false],
      ["word/styles.xml", "w:foo", "w:val", false],
      ["word/styles.xml", "w:style", "w:styleId", false],
      ["word/document.xml", "w:name", "w:val", false],
      ["xl/workbook.xml", "sheet", "name", false],
      ["xl/workbook.xml", "definedName", "name", false],
    ];
    for (const [member, element, attr, want] of cases) expect([member, element, attr, officeDisplayName(member, element, attr)]).toEqual([member, element, attr, want]);
  });

  test("blind apply is deterministic over Office ids", () => {
    const members = docxMembers({ body: "Avery Quill", officeIds: true });
    expect(apply("memo.docx", members).bytes).toEqual(apply("memo.docx", members).bytes);
    const book = xlsxMembers({ body: "Avery Quill", officeIds: true });
    expect(apply("book.xlsx", book).bytes).toEqual(apply("book.xlsx", book).bytes);
  });

  test("officeIdAttribute names the template and linking positions", () => {
    const cases: [string, string, string, OfficeIdGroup | null][] = [
      ["word/theme/theme1.xml", "thm15:themeFamily", "id", "template"],
      ["xl/theme/theme1.xml", "thm15:themeFamily", "vid", "template"],
      ["word/numbering.xml", "w:tmpl", "w:val", "template"],
      ["word/document.xml", "w:p", "w:rsidR", "linking"],
      ["word/document.xml", "w:tr", "w:rsidTr", "linking"],
      ["word/settings.xml", "w:rsid", "w:val", "linking"],
      ["word/settings.xml", "w:rsidRoot", "w:val", "linking"],
      ["word/document.xml", "w:p", "w14:paraId", "linking"],
      ["word/document.xml", "w:p", "w14:textId", "linking"],
      ["word/commentsExtended.xml", "w15:commentEx", "w15:paraIdParent", "linking"],
      ["word/commentsIds.xml", "w16cid:commentId", "w16cid:durableId", "linking"],
      ["word/document.xml", "wp:anchor", "wp14:editId", "linking"],
      ["word/settings.xml", "w14:docId", "w14:val", "linking"],
      ["word/settings.xml", "w15:docId", "w15:val", "linking"],
      ["word/numbering.xml", "w:nsid", "w:val", "linking"],
      ["word/glossary/document.xml", "w:guid", "w:val", "linking"],
      ["xl/charts/chart1.xml", "c16:uniqueId", "val", "linking"],
      ["xl/worksheets/sheet1.xml", "worksheet", "xr:uid", "linking"],
      ["xl/tables/table1.xml", "tableColumn", "xr3:uid", "linking"],
      ["xl/workbook.xml", "xr:revisionPtr", "documentId", "linking"],
      ["xl/workbook.xml", "xr:revisionPtr", "xr10:uidLastSave", "linking"],
      ["xl/threadedComments/threadedComment1.xml", "threadedComment", "personId", "linking"],
      ["xl/persons/person.xml", "person", "id", "linking"],
      ["xl/worksheets/sheet1.xml", "x14:cfRule", "id", "linking"],
      ["word/document.xml", "a16:creationId", "id", "linking"],
      ["customXml/itemProps1.xml", "ds:datastoreItem", "ds:itemID", "linking"],
      ["word/document.xml", "w:dataBinding", "w:storeItemID", "linking"],
      // Not these.
      ["word/document.xml", "thm15:themeFamily", "id", null],
      ["word/theme/theme1.xml", "thm15:themeFamily", "name", null],
      ["word/document.xml", "w:p", "rsidR", null],
      ["word/document.xml", "w:p", "uid", null],
      ["word/document.xml", "w:t", "w:val", null],
      ["word/document.xml", "wp:docPr", "id", null],
      ["xl/persons/person.xml", "person", "displayName", null],
      ["xl/persons/person.xml", "person", "userId", null],
      ["word/document.xml", "w:dataBinding", "w:xpath", null],
    ];
    for (const [m, e, a, want] of cases) expect([m, e, a, officeIdAttribute(m, e, a)]).toEqual([m, e, a, want]);
    // The engine keeps its own list (the audit does not trust it); the two agree on what is a linking id.
    for (const [m, e, a, want] of cases) expect([e, a, officeLinkAttribute(e, a) !== null]).toEqual([e, a, want === "linking"]);
  });

  test("the semantic layer skips every Office id position, and the mechanical layer blanks only the template ones", () => {
    for (const m of [...docxMembers({ body: "x", officeIds: true }), ...xlsxMembers({ body: "x", officeIds: true })]) {
      const bytes = Buffer.from(m.data as string, "utf8");
      const view = xmlBaseView(bytes);
      const attrs = xmlViews(view, m.name).find((v) => v.encoding.endsWith("+xml-attributes"))?.text.split("\n") ?? [];
      const blanked = Buffer.from(blankOoxmlUris(m.name, bytes)).toString("utf8");
      walkXml(view.text, {
        attribute(element, a, start, end) {
          const group = officeIdAttribute(m.name, element, a);
          if (group === null || end === start) return;
          expect(attrs).not.toContain(view.text.slice(start, end));
          expect(blanked.slice(start, end).trim() === "").toBe(group === "template");
        },
      });
    }
  });
});
