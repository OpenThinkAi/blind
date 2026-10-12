// AGT-1858: a birth-date column or key that no rule decides is redacted (fail closed), not exempted as a
// date measure: CSV/TSV headers, JSON keys at any depth, XLSX columns (date serials included). A rule
// still wins; visit and invoice dates stay measures; the redacted values never reach the map. The
// audit calls a surviving value in such a column a leak. Synthetic data only: invented people.

import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { renderReport } from "../../src/apply.ts";
import { isBirthDateName, lastKey } from "../../src/engine/birthdate.ts";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { REDACTED_VALUE, type ColumnRule, type Spec } from "../../src/schema.ts";
import { workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const spec = (columns: ColumnRule[] = []): Spec => ({ version: 1, columns, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [] });
const run = (inputs: InputFile[], s: Spec = spec()): ApplyResult => applySpec(inputs, s, { salt: SALT });
const out = (r: ApplyResult, path: string): Uint8Array => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`not written: ${JSON.stringify(r.skipped)}`);
  return o.bytes;
};
const outcomes = (r: ApplyResult, path: string) => Object.fromEntries((r.files.find((f) => f.path === path)?.columns ?? []).map((c) => [c.header || c.jsonPath, c.outcome]));
const rule = (file: string, where: { header?: string; jsonPath?: string; sheet?: string }, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = "id"): ColumnRule =>
  ({ file, ...where, class: cls, treatment, confidence: 1, source: "human" }) as ColumnRule;

describe("which names are birth dates", () => {
  test.each(["dob", "DOB", "d.o.b", "D.O.B.", "Date of Birth", "date_of_birth", "dateOfBirth", "Birth Date", "birthdate", "birthDate", "Birthday", "born", "Bday", "owner_dob", "Owner DOB", "ownerDOB", "dob (mm/dd/yyyy)"])("%j", (n) =>
    expect(isBirthDateName(n)).toBe(true),
  );
  test.each(["Visit Date", "Invoice Date", "Appointment", "birth_weight", "Newborn", "Reborn", "Dobson", "adobe", "Date", "Species", ""])("%j is not", (n) => expect(isBirthDateName(n)).toBe(false));
  test("a JSON key path is read by its last key", () => {
    expect(lastKey("$[*].owner.dob")).toBe("dob");
    expect(lastKey('$[*]["date of birth"]')).toBe("date of birth");
    expect(lastKey("$.dob[*]")).toBe("dob");
    expect(lastKey("$.byId.*~")).toBeUndefined();
    expect(lastKey("$")).toBeUndefined();
  });
});

// Owner is a column of people, so it is pseudonymised whatever happens to the DOB column.
const CSV = "Owner,Visit Date,DOB\nDana Example,2026-01-05,1979-04-12\nSam Sample,2026-01-09,1985-11-30\nPat Placeholder,2026-02-11,1990-02-02\n";
const file = (path: string, bytes: Uint8Array): TreeEntry => ({ path, kind: "file", bytes });
const EMPTY_MAP = { version: 1, entries: [] } as never;

describe("CSV and TSV", () => {
  const input: InputFile = { path: "clients.csv", bytes: enc(CSV) };

  test("an unruled DOB column is redacted, the visit date stays a measure, and the plan report says why", () => {
    const r = run([input]);
    const text = dec(out(r, "clients.csv"));
    expect(text).not.toContain("1979-04-12");
    expect(text).toContain(`,2026-01-05,${REDACTED_VALUE}\n`);
    expect(text).toContain(`,2026-02-11,${REDACTED_VALUE}\n`);
    expect(outcomes(r, "clients.csv")).toMatchObject({ DOB: "unknown-redacted", "Visit Date": "unknown-kept-not-identifier-like" });
    expect(renderReport(r)).toContain("redacted (birth-date header, no rule)");
  });

  test("redacted values never enter the map", () => {
    const r = run([input]);
    expect(JSON.stringify(r.map)).not.toContain("1979");
    expect(JSON.stringify(r.map)).not.toContain("1985-11-30");
  });

  test("the scan default does not exempt it either", () => {
    const r = applySpec([input], spec(), { salt: SALT, unruledColumns: "scan" } as never);
    expect(dec(out(r, "clients.csv"))).not.toContain("1979-04-12");
  });

  test("a keep rule wins", () => {
    const r = run([input], spec([rule("clients.csv", { header: "DOB" }, "keep")]));
    const text = dec(out(r, "clients.csv"));
    for (const dob of ["1979-04-12", "1985-11-30", "1990-02-02"]) expect(text).toContain(dob);
  });

  test("an unknown/value rule (the heuristic's) does not decide it", () => {
    const r = run([input], spec([{ ...rule("clients.csv", { header: "DOB" }, "value", "unknown"), source: "heuristic" }]));
    expect(dec(out(r, "clients.csv"))).not.toContain("1979-04-12");
  });

  test("a TSV header with dots", () => {
    const r = run([{ path: "c.tsv", bytes: enc("Owner\td.o.b\nDana Example\t04/12/1979\nSam Sample\t11/30/1985\n") }]);
    expect(dec(out(r, "c.tsv"))).toMatch(new RegExp(`\\t${REDACTED_VALUE}\\n.*\\t${REDACTED_VALUE}\\n$`));
    expect(dec(out(r, "c.tsv"))).not.toContain("1979");
  });

  test("the audit calls a surviving value a leak, and a redacted or ruled column clean", () => {
    const birth = (r: ReturnType<typeof auditTree>) => r.files.flatMap((f) => f.findings).filter((f) => f.reason.includes("birth-date column"));
    const leaked = auditTree([file("clients.csv", enc(CSV))], spec(), EMPTY_MAP);
    expect(birth(leaked).map((f) => f.severity)).toEqual(["leak"]);
    expect(leaked.status).toBe("leak");
    expect(birth(auditTree([file("clients.csv", out(run([input]), "clients.csv"))], spec(), EMPTY_MAP))).toEqual([]);
    const keep = spec([rule("clients.csv", { header: "DOB" }, "keep")]);
    expect(birth(auditTree([file("clients.csv", enc(CSV))], keep, EMPTY_MAP))).toEqual([]);
  });
});

const JSON_IN = '[{"owner":{"name":"Dana Example","dob":"1979-04-12"},"pet":{"name":"Rex","dob":"2019-06-01"},"visit":{"date":"2026-01-05"}}]';

describe("JSON", () => {
  const input: InputFile = { path: "clients.json", bytes: enc(JSON_IN) };

  test("the repro: only pet.dob ruled keep, owner.dob is redacted", () => {
    const r = run([input], spec([rule("clients.json", { jsonPath: "$[*].pet.dob" }, "keep")]));
    const text = dec(out(r, "clients.json"));
    expect(text).toContain('"dob":"2019-06-01"');
    expect(text).not.toContain("1979-04-12");
    expect(text).toContain(`"dob":"${REDACTED_VALUE}"`);
    expect(text).toContain('"date":"2026-01-05"');
    expect(outcomes(r, "clients.json")["$[*].owner.dob"]).toBe("unknown-redacted");
    expect(JSON.stringify(r.map)).not.toContain("1979");
  });

  test("a key at any depth, a quoted key, and a number", () => {
    const r = run([{ path: "d.json", bytes: enc('{"a":{"b":[{"Date of Birth":"1979-04-12","dateOfBirth":"1980-01-01"}]}}') }]);
    const text = dec(out(r, "d.json"));
    expect(text).not.toContain("1979");
    expect(text).not.toContain("1980");
  });

  test("an owner.* blind rule blinds it", () => {
    const r = run([input], spec([rule("clients.json", { jsonPath: "$[*].owner.dob" }, "blind")]));
    const text = dec(out(r, "clients.json"));
    expect(text).not.toContain("1979-04-12");
    expect(text).not.toContain(`"dob":"${REDACTED_VALUE}","x`);
  });
});

describe("XLSX", () => {
  // cellXfs: 0 = General, 1 = built-in 14 (m/d/yyyy).
  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
  const inline = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
  const rows =
    `<row r="1">${inline("A1", "Owner")}${inline("B1", "Visit Date")}${inline("C1", "Date of Birth")}${inline("D1", "DOB text")}</row>` +
    [0, 1, 2, 3, 4]
      .map((i) => `<row r="${i + 2}">${inline(`A${i + 2}`, `Owner ${i}`)}<c r="B${i + 2}" s="1"><v>${46000 + i}</v></c><c r="C${i + 2}" s="1"><v>${28000 + i * 31}</v></c>${inline(`D${i + 2}`, `1979-04-1${i}`)}</row>`)
      .join("");
  // The fixture's pivot cache would refuse any workbook with a redacted column (it repeats cell values); drop it.
  const bytes = buildZip(
    workbookEntries({ staffRows: rows, extra: [{ name: "xl/styles.xml", data: STYLES }] })
      .filter((e) => !e.name.includes("pivotCache"))
      .map((e) => (typeof e.data === "string" ? { ...e, data: e.data.replace(/<pivotCaches>.*?<\/pivotCaches>/, "").replace(/<Relationship Id="rId5"[^>]*pivotCacheDefinition[^>]*\/>/, "").replace(/<Override PartName="\/xl\/pivotCache[^>]*\/>/g, "") } : e)),
  );
  const sheet = (b: Uint8Array) => readZip(b).find((e) => e.name === "xl/worksheets/sheet1.xml")?.text ?? "";
  const cells = (xml: string, col: string) => [...xml.matchAll(new RegExp(`<c r="${col}(?!1")\\d+"[^>]*>(?:<v>([^<]*)</v>|<is><t>([^<]*)</t></is>)`, "g"))].map((m) => m[1] ?? m[2]);

  test("an unruled birth-date column is redacted, date serials included; the visit date serials stay", () => {
    const r = run([{ path: "book.xlsx", bytes }]);
    const xml = sheet(out(r, "book.xlsx"));
    expect(cells(xml, "B")).toEqual(["46000", "46001", "46002", "46003", "46004"]);
    expect(cells(xml, "C")).toEqual(["0", "0", "0", "0", "0"]);
    expect(cells(xml, "D")).toEqual(Array(5).fill(REDACTED_VALUE));
    const o = outcomes(r, "book.xlsx");
    expect(o["Date of Birth"]).toBe("unknown-redacted");
    expect(o["DOB text"]).toBe("unknown-redacted");
    expect(o["Visit Date"]).toBe("unknown-kept-not-identifier-like");
    expect(JSON.stringify(r.map)).not.toContain("1979");
  });

  test("a keep rule keeps the serials", () => {
    const r = run([{ path: "book.xlsx", bytes }], spec([rule("book.xlsx", { header: "Date of Birth", sheet: "Staff" }, "keep")]));
    expect(cells(sheet(out(r, "book.xlsx")), "C")).toEqual(["28000", "28031", "28062", "28093", "28124"]);
  });
});
