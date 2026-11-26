import { describe, expect, test } from "bun:test";
import { renderReport } from "../../src/apply.ts";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { type ApplyOptions, type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { readZip } from "../formats/zipfixture.ts";

// AGT-2785: a header cell names its column, so a lone word of a blinded person's name never
// rewrites it, in the same file or another file of the run; a whole blinded value still does.
// Synthetic salt and data only: invented names and amounts.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"], sheet?: string): ColumnRule => ({
  file,
  ...(sheet === undefined ? {} : { sheet }),
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const spec = (columns: ColumnRule[], over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns,
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
  ...over,
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`no output ${path}: ${JSON.stringify(r.skipped)}`);
  return Buffer.from(o.bytes).toString("utf8");
};
const firstLine = (t: string): string => t.split("\n")[0] as string;
const report = (r: ApplyResult, path: string) => r.files.find((f) => f.path === path);
const pseudo = (r: ApplyResult, value: string): string => {
  const e = r.map.entries.find((x) => x.value === value);
  if (e === undefined) throw new Error(`no pseudonym for ${value}`);
  return e.pseudonym;
};
const audit = (r: ApplyResult, s: Spec) =>
  auditTree(
    r.outputs.map((o): TreeEntry => ({ path: o.path, kind: "file", bytes: o.bytes })),
    s,
    r.map,
  );

const STAFF = "Full Name,Rate\nNora Subtotal,20\nOwen Hours,21\nIvy Bonus,22\nAda Tips,19\nMax Net,18\n";
const PAY = "Date,Subtotal,Hours,Bonus,Tips,Net\n2026-01-02,120.50,2.5,10.00,3.25,99.10\n2026-01-03,80.00,1.5,0.00,4.00,70.00\n2026-01-04,95.00,2.0,5.00,1.75,82.25\n";
const NOTE = "Tips covered the late shift; Subtotal checked the till.\n";
const STAFF_SPEC = spec([rule("staff.csv", "Full Name", "person", "blind"), rule("staff.csv", "Rate", "vocabulary", "keep")]);

describe("a name part never rewrites a detected header cell (AGT-2785)", () => {
  for (const style of ["compact", "readable", "letters"] as const) {
    test(`another file's headers stay as written (${style} style)`, () => {
      const r = applySpec([file("staff.csv", STAFF), file("pay.csv", PAY), file("note.txt", NOTE)], STAFF_SPEC, { salt: SALT, pseudonymStyle: style });
      expect(firstLine(out(r, "pay.csv"))).toBe("Date,Subtotal,Hours,Bonus,Tips,Net");
      expect(out(r, "pay.csv")).toBe(PAY);
      expect(report(r, "pay.csv")?.headerCellsReplaced).toBeUndefined();
      // The same parts in free text are still replaced, with their person's pseudonym.
      const note = out(r, "note.txt");
      expect(note).not.toContain("Tips");
      expect(note).not.toContain("Subtotal");
      expect(note).toContain(pseudo(r, "Ada Tips"));
      expect(note).toContain(pseudo(r, "Nora Subtotal"));
    });

    test(`a header in the person's own file and in another stays as written (${style} style)`, () => {
      const s = spec([rule("bank.csv", "Name", "person", "blind")]);
      const bank = "Date,Name,Amount,Tax\n2026-02-01,PayHarbor Tax Service,120.00,9.60\n2026-02-02,Quinn Larkfield,80.00,6.40\n2026-02-03,Rowan Ashdown,55.00,4.40\n";
      const jobs = "Visit Date,Subtotal,Tax,Total\n2026-02-01,100.00,8.00,108.00\n2026-02-02,50.00,4.00,54.00\n2026-02-03,75.00,6.00,81.00\n";
      const r = applySpec([file("bank.csv", bank), file("jobs.csv", jobs), file("memo.txt", "PayHarbor called about Tax.\n")], s, { salt: SALT, pseudonymStyle: style });
      expect(firstLine(out(r, "bank.csv"))).toBe("Date,Name,Amount,Tax");
      expect(out(r, "jobs.csv")).toBe(jobs);
      expect(out(r, "bank.csv")).not.toContain("PayHarbor");
      expect(out(r, "memo.txt")).not.toMatch(/PayHarbor|Tax/);
      expect(report(r, "bank.csv")?.headerCellsReplaced).toBeUndefined();
      expect(report(r, "jobs.csv")?.headerCellsReplaced).toBeUndefined();
    });
  }

  test("a part two people share (pseudonymised as itself) leaves a header as written, this run and the next", () => {
    const staff = "Full Name,Rate\nNora Subtotal,20\nLee Subtotal,23\nOwen Hours,21\n";
    const first = applySpec([file("staff.csv", staff), file("pay.csv", PAY), file("note.txt", NOTE)], STAFF_SPEC, { salt: SALT });
    expect(firstLine(out(first, "pay.csv"))).toBe("Date,Subtotal,Hours,Bonus,Tips,Net");
    expect(out(first, "note.txt")).toContain(pseudo(first, "Subtotal"));
    expect(first.sharedNameParts).toEqual([pseudo(first, "Subtotal")]);
    // The map records the shared part as a person of its own; it is still a part on the next run.
    const again = applySpec([file("staff.csv", staff), file("pay.csv", PAY), file("note.txt", NOTE)], STAFF_SPEC, { salt: SALT, map: first.map });
    expect(firstLine(out(again, "pay.csv"))).toBe("Date,Subtotal,Hours,Bonus,Tips,Net");
    expect(out(again, "note.txt")).toBe(out(first, "note.txt"));
  });

  test("a whole blinded value still replaces a header cell that is it or holds it, and the report lists it", () => {
    const s = spec([rule("clients.csv", "Client", "org", "blind")]);
    const clients = "Client,Since\nAcme Roofing,2019\nBrightwater Mills,2021\nCopperleaf Trading,2022\n";
    // A pivoted sheet: one column per client, a quarter after the name.
    const pivot = "Month,Acme Roofing Q1,Brightwater Mills,Notes\n2026-01,100.00,90.00,ok\n2026-02,110.00,95.00,ok\n2026-03,120.00,99.00,late\n";
    const r = applySpec([file("clients.csv", clients), file("pivot.csv", pivot)], s, { salt: SALT });
    const head = firstLine(out(r, "pivot.csv"));
    expect(head).toBe(`Month,${pseudo(r, "Acme Roofing")} Q1,${pseudo(r, "Brightwater Mills")},Notes`);
    expect(report(r, "pivot.csv")?.headerCellsReplaced).toEqual([
      { index: 1, header: "Acme Roofing Q1" },
      { index: 2, header: "Brightwater Mills" },
    ]);
    expect(report(r, "clients.csv")?.headerCellsReplaced).toBeUndefined();
  });

  test("a header that is a blinded person's full name is still replaced, and reported", () => {
    const hours = "Week,Nora Subtotal,Owen Hours\n2026-W01,38.5,40.0\n2026-W02,36.0,41.5\n2026-W03,40.0,39.0\n";
    const r = applySpec([file("staff.csv", STAFF), file("hours.csv", hours)], STAFF_SPEC, { salt: SALT });
    expect(firstLine(out(r, "hours.csv"))).toBe(`Week,${pseudo(r, "Nora Subtotal")},${pseudo(r, "Owen Hours")}`);
    expect(report(r, "hours.csv")?.headerCellsReplaced).toEqual([
      { index: 1, header: "Nora Subtotal" },
      { index: 2, header: "Owen Hours" },
    ]);
    // The printed report names them, masked unless values are shown.
    expect(renderReport(r)).toContain("2 header cells changed");
    expect(renderReport(r)).not.toContain("Nora Subtotal");
    expect(renderReport(r, true)).toContain('column 2 "Nora Subtotal", column 3 "Owen Hours"');
  });

  test("a spec entity or a pattern in a header cell is replaced as before", () => {
    const s = spec([], { entities: { person: [{ canonical: "Tamsin Vey", aliases: [], parts: ["Vey"] }] } });
    const t = "Date,Vey,ops@example.com,Amount\n2026-01-02,1.00,2.00,3.00\n2026-01-03,1.50,2.50,3.50\n2026-01-04,1.25,2.25,3.25\n";
    const r = applySpec([file("t.csv", t)], s, { salt: SALT });
    const head = firstLine(out(r, "t.csv"));
    expect(head).not.toContain("Vey");
    expect(head).not.toContain("ops@example.com");
    expect(report(r, "t.csv")?.headerCellsReplaced?.map((h) => h.index)).toEqual([1, 2]);
  });

  test("a preamble row above the header is free text: a name part there is still replaced", () => {
    const pay = `Payroll export prepared by Tips\n${PAY}`;
    const r = applySpec([file("staff.csv", STAFF), file("pay.csv", pay)], STAFF_SPEC, { salt: SALT });
    const lines = out(r, "pay.csv").split("\n");
    expect(lines[0]).toBe(`Payroll export prepared by ${pseudo(r, "Ada Tips")}`);
    expect(lines[1]).toBe("Date,Subtotal,Hours,Bonus,Tips,Net");
    expect(report(r, "pay.csv")?.headerRow).toBe(2);
  });

  test("with no detected header row, row 1 only stands in and is free text as before (it may be data)", () => {
    // Every row is numbers, so no row looks like a header; row 1 is the file's first record.
    const codes = "Tips 4410,1.00,2.00\n4411,1.50,2.50\n4412,1.25,2.25\n";
    const r = applySpec([file("staff.csv", STAFF), file("codes.csv", codes)], STAFF_SPEC, { salt: SALT });
    expect(report(r, "codes.csv")?.noHeader).toBe(true);
    expect(firstLine(out(r, "codes.csv"))).toBe(`${pseudo(r, "Ada Tips")} 4410,1.00,2.00`);
    // Not a detected header, so nothing is listed as a renamed header cell.
    expect(report(r, "codes.csv")?.headerCellsReplaced).toBeUndefined();
  });

  test("a key/value block's paired header value is still pseudonymised (headerPaired)", () => {
    const s = spec([rule("card.csv", "Client", "person", "blind")]);
    const card = "Client,Dana Example\nPhone,555-555-0100\nEmail,dana@example.com\nCard,on file\n";
    const r = applySpec([file("card.csv", card), file("note.txt", "Dana Example called.\n")], s, { salt: SALT });
    const head = firstLine(out(r, "card.csv"));
    expect(head).toBe(`Client,${pseudo(r, "Dana Example")}`);
    expect(out(r, "note.txt")).toBe(`${pseudo(r, "Dana Example")} called.\n`);
    expect(report(r, "card.csv")?.headerCellsReplaced).toEqual([{ index: 1, header: "Dana Example" }]);
  });

  test("JSON structural keys: a name part never rewrites one, a whole value does, and the report lists it", () => {
    const json = JSON.stringify([{ Subtotal: 120.5, Tips: 3.25, "Ada Tips": 1, note: "Tips was late" }]);
    const r = applySpec([file("staff.csv", STAFF), file("pay.json", json)], STAFF_SPEC, { salt: SALT });
    const o = JSON.parse(out(r, "pay.json")) as Record<string, unknown>[];
    const keys = Object.keys(o[0] as object);
    expect(keys.slice(0, 2)).toEqual(["Subtotal", "Tips"]);
    expect(keys[2]).toBe(pseudo(r, "Ada Tips"));
    expect(o[0]?.note).toBe(`${pseudo(r, "Ada Tips")} was late`);
    expect(report(r, "pay.json")?.headerCellsReplaced).toEqual([{ header: "Ada Tips" }]);
  });

  test("XLSX: a worksheet's detected header cells keep their text; data and preamble-free cells do not", () => {
    const is = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
    const rows =
      `<row r="1">${is("A1", "Date")}${is("B1", "Subtotal")}${is("C1", "Tips")}${is("D1", "Notes")}</row>` +
      `<row r="2">${is("A2", "2026-01-02")}<c r="B2"><v>120.5</v></c><c r="C2"><v>3.25</v></c>${is("D2", "Tips was late")}</row>` +
      `<row r="3">${is("A3", "2026-01-03")}<c r="B3"><v>80</v></c><c r="C3"><v>4</v></c>${is("D3", "ok")}</row>` +
      `<row r="4">${is("A4", "2026-01-04")}<c r="B4"><v>95</v></c><c r="C4"><v>1.75</v></c>${is("D4", "ok")}</row>`;
    const s = spec([...STAFF_SPEC.columns, rule("pay.xlsx", "Notes", "vocabulary", "keep", "Staff")]);
    const r = applySpec([file("staff.csv", STAFF), { path: "pay.xlsx", bytes: buildWorkbook({ staffRows: rows }) }], s, { salt: SALT });
    const o = r.outputs.find((x) => x.path === "pay.xlsx");
    if (o === undefined) throw new Error(JSON.stringify(r.skipped));
    const sheet = readZip(o.bytes).find((m) => m.name === "xl/worksheets/sheet1.xml")?.text ?? "";
    for (const h of ["Date", "Subtotal", "Tips", "Notes"]) expect(sheet).toContain(`<t>${h}</t>`);
    expect(sheet).toContain(`<t>${pseudo(r, "Ada Tips")} was late</t>`);
    expect(report(r, "pay.xlsx")?.headerCellsReplaced).toBeUndefined();
    // The audit calls the kept header part a candidate, not a leak.
    const a = audit(r, s);
    const part = a.files.find((f) => f.path === "pay.xlsx")?.findings.filter((f) => f.masked.startsWith("Ti")) ?? [];
    expect(part.length).toBeGreaterThan(0);
    expect(part.every((f) => f.severity === "candidate")).toBe(true);
  });

  test("XLSX: a shared string only header cells use keeps its text; one a data cell shares is free text", () => {
    // Indices 12 to 15 are the fixture's other sheets' strings; 1 is a header only, 2 a header and a preamble cell.
    const strings = ["Date", "Tips", "Bonus", "ok", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "Sheet", "Staff", "Link", "Amount"];
    const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="16" uniqueCount="16">${strings.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`;
    const sc = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
    const rows =
      `<row r="1">${sc("A1", 2)}</row>` +
      `<row r="2">${sc("A2", 0)}${sc("B2", 1)}${sc("C2", 2)}</row>` +
      `<row r="3"><c r="A3" t="inlineStr"><is><t>2026-01-02</t></is></c><c r="B3"><v>3.25</v></c><c r="C3"><v>10</v></c></row>` +
      `<row r="4"><c r="A4" t="inlineStr"><is><t>2026-01-03</t></is></c><c r="B4"><v>4</v></c><c r="C4"><v>0</v></c></row>` +
      `<row r="5"><c r="A5" t="inlineStr"><is><t>2026-01-04</t></is></c><c r="B5"><v>1.75</v></c><c r="C5"><v>5</v></c></row>`;
    const s = STAFF_SPEC;
    const bytes = buildWorkbook({ staffRows: rows, extra: [{ name: "xl/sharedStrings.xml", data: sst }] });
    const r = applySpec([file("staff.csv", STAFF), { path: "pay.xlsx", bytes }], s, { salt: SALT });
    const o = r.outputs.find((x) => x.path === "pay.xlsx");
    if (o === undefined) throw new Error(JSON.stringify(r.skipped));
    const out = readZip(o.bytes).find((m) => m.name === "xl/sharedStrings.xml")?.text ?? "";
    expect(out).toContain("<t>Tips</t>");
    expect(out).not.toContain("Bonus");
    expect(out).toContain(pseudo(r, "Ivy Bonus"));
    expect(report(r, "pay.xlsx")?.sheets?.[0]?.headerRow).toBe(2);
    // The header cell sharing it with the preamble changed with it, and the report says so.
    expect(report(r, "pay.xlsx")?.headerCellsReplaced).toEqual([{ index: 2, sheet: "Staff", header: "Bonus" }]);
  });

  test("XLSX: a whole value in a header cell is replaced and reported with its sheet", () => {
    const is = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
    const rows =
      `<row r="1">${is("A1", "Week")}${is("B1", "Nora Subtotal")}${is("C1", "Tips")}</row>` +
      `<row r="2">${is("A2", "2026-W01")}<c r="B2"><v>38.5</v></c><c r="C2"><v>4</v></c></row>` +
      `<row r="3">${is("A3", "2026-W02")}<c r="B3"><v>36</v></c><c r="C3"><v>5</v></c></row>`;
    const r = applySpec([file("staff.csv", STAFF), { path: "hours.xlsx", bytes: buildWorkbook({ staffRows: rows }) }], STAFF_SPEC, { salt: SALT });
    const o = r.outputs.find((x) => x.path === "hours.xlsx");
    if (o === undefined) throw new Error(JSON.stringify(r.skipped));
    const sheet = readZip(o.bytes).find((m) => m.name === "xl/worksheets/sheet1.xml")?.text ?? "";
    expect(sheet).toContain(`<t>${pseudo(r, "Nora Subtotal")}</t>`);
    expect(sheet).toContain("<t>Tips</t>");
    expect(report(r, "hours.xlsx")?.headerCellsReplaced).toEqual([{ index: 1, sheet: "Staff", header: "Nora Subtotal" }]);
  });
});

describe("the audit and a name part kept in a header (AGT-2785)", () => {
  test("a clean run: the kept header parts are candidates, never leaks", () => {
    const r = applySpec([file("staff.csv", STAFF), file("pay.csv", PAY), file("keys.json", JSON.stringify([{ Subtotal: 1 }]))], STAFF_SPEC, { salt: SALT });
    const a = audit(r, STAFF_SPEC);
    expect(a.summary.leaks).toBe(0);
    expect(a.status).toBe("candidates");
    const header = a.files.flatMap((f) => f.findings).filter((f) => f.reason.includes("in a column header"));
    expect(header.map((f) => `${f.file}:${f.masked}`).sort()).toEqual(["keys.json:Su***8", "pay.csv:Bo***5", "pay.csv:N***3", "pay.csv:Su***8", "pay.csv:Ti***4"]);
  });

  test("the same part surviving outside a header (or in a row that only stands in for one) is still a leak", () => {
    const r = applySpec([file("staff.csv", STAFF), file("pay.csv", PAY)], STAFF_SPEC, { salt: SALT });
    // Planted after apply: a data cell and a headerless file, where blind would have replaced the part.
    const planted = out(r, "pay.csv").replace("2026-01-03,80.00", "Tips,80.00");
    const entries: TreeEntry[] = [
      { path: "pay.csv", kind: "file", bytes: Buffer.from(planted) },
      { path: "codes.csv", kind: "file", bytes: Buffer.from("Tips 4410,1.00\n4411,1.50\n4412,1.25\n") },
    ];
    const a = auditTree(entries, STAFF_SPEC, r.map);
    const leaks = a.files.flatMap((f) => f.findings.filter((x) => x.severity === "leak").map((x) => `${f.path}:${x.line}`));
    expect(leaks.sort()).toEqual(["codes.csv:1", "pay.csv:3"]);
  });
});
