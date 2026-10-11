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
import { ooxmlUriAttribute, walkXml } from "../../src/audit/xml.ts";
import { readZip } from "../../src/audit/zip.ts";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import type { Spec } from "../../src/schema.ts";
import { docxMembers, xlsxMembers } from "./ooxmlfixture.ts";
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
