import { describe, expect, test } from "bun:test";
import { auditTree } from "../../src/audit/mechanical.ts";
import { type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import { nameTokens, onNameTokens } from "../../src/engine/names.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";

// Synthetic only: invented names.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 53);

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns: [rule("ledger.csv", "owner", "person", "blind")],
  entities: { person: [{ canonical: "Lee Sample", aliases: [], parts: ["Lee", "Sample"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: true },
  questions: [],
  ...over,
});

const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text, "utf8") });
const LEDGER = file("ledger.csv", "owner\nLee Sample\n");
const paths = (r: ApplyResult): string[] => r.files.map((f) => f.outputPath).sort();
const leak = (s: string) => /sample/i.test(s);

describe("nameTokens (AGT-1845)", () => {
  const words = (n: string) => nameTokens(n).map((t) => n.slice(t.start, t.end));
  test("splits on separators, CamelCase and letter/digit changes", () => {
    expect(words("consult_sample")).toEqual(["consult", "sample"]);
    expect(words("SampleTotal")).toEqual(["Sample", "Total"]);
    expect(words("invoice-lee.sample")).toEqual(["invoice", "lee", "sample"]);
    expect(words("Sample L (overdue)")).toEqual(["Sample", "L", "overdue"]);
    expect(words("Sample2b")).toEqual(["Sample", "2", "b"]);
    expect(words("XMLFile")).toEqual(["XML", "File"]);
  });
  test("onNameTokens is true only on word boundaries", () => {
    expect(onNameTokens("SampleTotal", 0, 6)).toBe(true);
    expect(onNameTokens("Samplers", 0, 6)).toBe(false);
  });
});

describe("people in file names written as identifiers (AGT-1845)", () => {
  test("lowercase, dotted and hyphenated file names and a folder are blinded", () => {
    const r = applySpec(
      [LEDGER, file("calls/consult_sample.srt", "1\n00:00:01,000 --> 00:00:03,000\nLee Sample: hello there\n"), file("invoice-lee.sample.txt", "x\n"), file("sample/notes.txt", "x\n"), file("SampleTotal.txt", "x\n")],
      spec(),
      { salt: SALT },
    );
    for (const p of paths(r)) expect(leak(p)).toBe(false);
    const person = r.map.entries.find((e) => e.value === "Lee Sample")!.pseudonym;
    expect(outputOf(r, "invoice-lee.sample.txt")).toBe(`invoice-${person}.txt`);
    expect(outputOf(r, "SampleTotal.txt")).toMatch(/^Person_[0-9A-F]{4}_Total\.txt$/);
    expect(outputOf(r, "calls/consult_sample.srt")).toMatch(/^calls\/consult_Person_[0-9A-F]{4}\.srt$/);
  });

  test("a dictionary word in a file name is left alone, in any case", () => {
    const s = spec({ entities: { person: [{ canonical: "Chris Value", aliases: [], parts: ["Chris", "Value"] }] } });
    const r = applySpec([file("ledger.csv", "owner\nChris Value\n"), file("report_value_2024.txt", "x\n"), file("ReportValue.txt", "x\n"), file("chris_report.txt", "x\n")], s, { salt: SALT });
    expect(outputOf(r, "report_value_2024.txt")).toBe("report_value_2024.txt");
    expect(outputOf(r, "ReportValue.txt")).toBe("ReportValue.txt");
    expect(outputOf(r, "chris_report.txt")).toMatch(/^Person_[0-9A-F]{4}_report\.txt$/);
  });

  test("a keep term and an honorific are not replaced in another case", () => {
    const r = applySpec([LEDGER, file("dr_notes.txt", "x\n")], spec({ entities: { person: [{ canonical: "Lee Sample", aliases: [], parts: ["Lee", "Sample", "Dr"] }] } }), { salt: SALT });
    expect(outputOf(r, "dr_notes.txt")).toBe("dr_notes.txt");
    const k = applySpec([LEDGER, file("lee_notes.txt", "x\n")], spec(), { salt: SALT, keep: ["lee"] });
    expect(outputOf(k, "lee_notes.txt")).toBe("lee_notes.txt");
  });

  test("a word only partly inside a longer word is not replaced", () => {
    const r = applySpec([LEDGER, file("samplers.txt", "x\n")], spec(), { salt: SALT });
    expect(outputOf(r, "samplers.txt")).toBe("samplers.txt");
  });

  test("the audit flags a file name the engine would have left, and only that", () => {
    const entries = [{ kind: "file" as const, path: "SampleTotal.txt", bytes: Buffer.from("x") }, { kind: "file" as const, path: "samplers.txt", bytes: Buffer.from("x") }];
    const r = applySpec([LEDGER], spec(), { salt: SALT });
    const report = auditTree(entries, spec(), r.map);
    const sev = (p: string) => report.files.find((f) => f.path === p)?.findings.map((f) => f.severity);
    expect(sev("SampleTotal.txt")).toEqual(["leak"]);
    expect(sev("samplers.txt")).toEqual(["candidate"]);
  });
});

const outputOf = (r: ApplyResult, path: string): string => {
  const f = r.files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no report for ${path}`);
  return f.outputPath;
};

describe("people in sheet and defined names (AGT-1845)", () => {
  const FILE = "book.xlsx";
  const entries = workbookEntries({
    extra: [
      {
        name: "xl/workbook.xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
          '<sheet name="Staff" sheetId="1" r:id="rId1"/><sheet name="Sample L (overdue)" sheetId="2" r:id="rId2"/><sheet name="Contents" sheetId="3" r:id="rId3"/>' +
          "</sheets><definedNames><definedName name=\"SampleTotal\">'Sample L (overdue)'!$A$2</definedName></definedNames>" +
          '<pivotCaches><pivotCache cacheId="1" r:id="rId5"/></pivotCaches></workbook>',
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>SUM(B2:B4)+SampleTotal</f><v>1</v></c></row></sheetData></worksheet>',
      },
      { name: "xl/worksheets/_rels/sheet1.xml.rels", data: null as unknown as string },
    ].filter((e) => e.data !== null),
  }).filter((e) => !/comments1|sheet1\.xml\.rels|pivotCache|sharedStrings/.test(e.name) || e.name === "xl/sharedStrings.xml");
  const s = spec({ columns: [], entities: { person: [{ canonical: "Lee Sample", aliases: [], parts: ["Lee", "Sample"] }] } });

  test("a CamelCase defined name and a sheet name are blinded, and formulas follow", () => {
    const r = applySpec([{ path: FILE, bytes: buildZip(entries) }, LEDGER], spec({ entities: s.entities }), { salt: SALT });
    const out = r.outputs.find((o) => o.path === FILE);
    if (out === undefined) throw new Error(`not written: ${JSON.stringify(r.skipped)}`);
    const m = Object.fromEntries(readZip(out.bytes).map((e) => [e.name, e.text]));
    const person = r.map.entries.find((e) => e.value === "Sample")?.pseudonym ?? r.map.entries.find((e) => e.value === "Lee Sample")!.pseudonym;
    expect(m["xl/workbook.xml"]).toContain(`<sheet name="${person} L (overdue)"`);
    expect(m["xl/workbook.xml"]).toMatch(/<definedName name="Person_[0-9A-F]{4}_Total">/);
    const defined = /<definedName name="([^"]+)"/.exec(m["xl/workbook.xml"]!)![1]!;
    expect(m["xl/worksheets/sheet1.xml"]).toContain(`+${defined}</f>`);
    for (const [name, t] of Object.entries(m)) if (/workbook|sheet1/.test(name)) expect(leak(t)).toBe(false);
  });
});
