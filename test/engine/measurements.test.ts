// AGT-1843: decimal-comma numbers, Unix timestamps and XLSX date serials are measurements, not
// identifiers: with no rule they pass through unchanged, in the engine and in the profile (whose
// numericId detector would otherwise class them `id`). An explicit rule still blinds them.
// Synthetic data only: invented accessions and values.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristicRule, profileLocations } from "../../src/analyst/heuristic.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { isEpochTimestamp } from "../../src/engine/epoch.ts";
import { columnStats, isIdentifierLike, isMeasure } from "../../src/engine/stats.ts";
import { defaultPolicy } from "../../src/policy.ts";
import { buildProfile } from "../../src/profile/profile.ts";
import { valueStats } from "../../src/profile/stats.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { isDateFormatCode } from "../../src/formats/xlsx.ts";
import { buildWorkbook, workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 53);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const spec = (columns: ColumnRule[] = []): Spec => ({ version: 1, columns, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [] });
const run = (inputs: InputFile[], s: Spec = spec()): ApplyResult => applySpec(inputs, s, { salt: SALT });
const out = (r: ApplyResult, path: string): Uint8Array => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`not written: ${JSON.stringify(r.skipped)}`);
  return o.bytes;
};
const outcomes = (r: ApplyResult, path: string) => Object.fromEntries((r.files.find((f) => f.path === path)?.columns ?? []).map((c) => [c.header, c.outcome]));
const rule = (file: string, header: string, treatment: ColumnRule["treatment"], extra: { class?: ColumnRule["class"]; sheet?: string } = {}): ColumnRule => ({
  file,
  header,
  class: "id",
  treatment,
  confidence: 1,
  source: "human",
  ...extra,
});

describe("decimal comma", () => {
  test.each(["136,1", "4,25", "-0,5", "+12,75", "1.250,75", "1.234.567,5"])("%j is a measure", (v) => expect(isMeasure(v)).toBe(true));

  test("a comma-thousands value of 3 digits is a measure only in a semicolon-delimited file", () => {
    expect(isMeasure("4,250", ";")).toBe(true);
    expect(isMeasure("4,250", ",")).toBe(true); // already a grouped number
    expect(isMeasure("4250,250", ",")).toBe(false);
    expect(isMeasure("4250,250", ";")).toBe(true);
    expect(isMeasure("4250,250")).toBe(false);
  });

  test("things that are not decimals stay not measures", () => {
    for (const v of ["12,345678", "1,2,3", ",5", "4,", "ab,12", "1.25,"] ) expect(isMeasure(v, ";")).toBe(false);
  });

  const LABS = `accession;test;result\nL-1;ALT;41,7\nL-2;GLU;98,2\nL-3;BUN;12,0\nL-4;CRE;0,95\nL-5;TSH;2,31\nL-6;NA;139,4\nL-7;K;4,25\nL-8;CL;102,6\n`;

  test("a semicolon-delimited export passes through unchanged", () => {
    const r = run([{ path: "labs.csv", bytes: enc(LABS) }]);
    expect(outcomes(r, "labs.csv").result).toBe("unknown-kept-not-identifier-like");
    // The accession column is an identifier column and still fails closed.
    expect(outcomes(r, "labs.csv").accession).toBe("unknown-pseudonymised");
    const lines = dec(out(r, "labs.csv")).split("\n");
    expect(lines.slice(1, 9).map((l) => l.split(";")[2])).toEqual(["41,7", "98,2", "12,0", "0,95", "2,31", "139,4", "4,25", "102,6"]);
  });

  test("three-digit decimals pass only under a semicolon delimiter", () => {
    const rows = ["1,250", "2,375", "0,125", "9,001", "4,500"].map((v, i) => `S${i};${v}`);
    const semi = run([{ path: "a.csv", bytes: enc(`id;val\n${rows.join("\n")}\n`) }]);
    expect(outcomes(semi, "a.csv").val).toBe("unknown-kept-not-identifier-like");
    const comma = run([{ path: "b.csv", bytes: enc(`id,val\n${["4250,250", "2375,375", "7125,125", "9001,001", "4500,500"].map((v, i) => `S${i},"${v}"`).join("\n")}\n`) }]);
    expect(outcomes(comma, "b.csv").val).toBe("unknown-pseudonymised");
  });

  test("an explicit rule still blinds the column", () => {
    const r = run([{ path: "labs.csv", bytes: enc(LABS) }], spec([rule("labs.csv", "result", "blind", { class: "id" })]));
    expect(dec(out(r, "labs.csv"))).not.toContain("41,7");
    expect(outcomes(r, "labs.csv").result).toBe("blinded");
  });
});

describe("Unix timestamps", () => {
  test.each([
    ["1700000000", true],
    ["1000000000", true],
    ["946684800", false], // 9 digits: in the range, but only 10- and 13-digit values count
    ["4102444799", true],
    ["1700000000123", true],
    ["946684799", false],
    ["4102444800", false],
    ["170000000", false],
    ["17000000001", false],
    ["1700000000.5", false],
    ["9850000000012", false],
  ])("%j epoch? %j", (v, expected) => expect(isEpochTimestamp(v)).toBe(expected));

  const TS = [1700000000, 1700000060, 1700000121, 1700000300, 1700000999];
  const JSONL = `${TS.map((ts) => JSON.stringify({ ts, event: "sent" })).join("\n")}\n`;

  test("the engine leaves a column of Unix times alone", () => {
    expect(isIdentifierLike(columnStats(TS.map(String)))).toBe(false);
    const r = run([{ path: "events.jsonl", bytes: enc(JSONL) }]);
    expect(dec(out(r, "events.jsonl"))).toBe(JSONL);
  });

  test("a column of 10-digit numbers outside the range, or mostly outside it, is still an identifier", () => {
    expect(isIdentifierLike(columnStats(["5551230001", "5551230002", "5551230003", "5551230004", "5551230005"]))).toBe(true);
    expect(isIdentifierLike(columnStats(["1700000000", "1700000060", "5551230003", "5551230004", "5551230005"]))).toBe(true);
  });

  test("millisecond times in a CSV pass through", () => {
    const csv = `at,note\n${[1700000000123, 1700000060456, 1700000121789, 1700000300012, 1700000999345].join("\n").replace(/(\d+)/g, "$1,fine")}\n`;
    const r = run([{ path: "t.csv", bytes: enc(csv) }]);
    expect(dec(out(r, "t.csv"))).toBe(csv);
  });

  test("the profile's numericId detector skips them, so the heuristic does not class the key `id`", () => {
    const stats = valueStats(TS.map(String), 0);
    expect(stats.detectorRates.numericId).toBe(0);
    const loc = { file: "events.jsonl", jsonPath: "$.ts" };
    expect(heuristicRule(loc, stats, defaultPolicy())).toMatchObject({ class: "unknown", treatment: "value" });
    const ids = valueStats(["5551230001", "5551230002", "5551230003"], 0);
    expect(ids.detectorRates.numericId).toBe(1);
  });

  test("an explicit rule still blinds a timestamp key", () => {
    const r = run([{ path: "events.jsonl", bytes: enc(JSONL) }], spec([{ file: "events.jsonl", jsonPath: "$.ts", class: "id", treatment: "blind", confidence: 1, source: "human" } as unknown as ColumnRule]));
    expect(dec(out(r, "events.jsonl"))).not.toContain("1700000000");
  });
});

describe("XLSX date serials", () => {
  test.each([
    ["yyyy-mm-dd", true],
    ["m/d/yy h:mm", true],
    ["dd\\/mm\\/yyyy", true],
    ["[$-409]d-mmm-yy;@", true],
    ["[h]:mm:ss", true],
    ["General", false],
    ["0.00", false],
    ["#,##0", false],
    ['0.00 "days"', false],
    ["0.00E+00", false],
    ["[Red]0.00", false],
  ])("format %j is a date? %j", (code, expected) => expect(isDateFormatCode(code)).toBe(expected));

  // cellXfs: 0 = General, 1 = built-in 14 (m/d/yyyy), 2 = custom 164 (yyyy-mm-dd), 3 = custom 165 (0.00), 4 = built-in 22.
  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts>' +
    '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/></cellXfs></styleSheet>';
  const SERIALS = [46000, 46012, 46030, 46041, 46099];
  const rows =
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    SERIALS.map(
      (n, i) =>
        `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>4</v></c><c r="B${i + 2}" s="${i % 2 === 0 ? 1 : 2}"><v>${n}</v></c><c r="C${i + 2}" s="3"><v>${n + 0.5}</v></c><c r="D${i + 2}" s="4"><v>${n + 0.25}</v></c></row>`,
    ).join("");
  // Shared strings 0..4 of the fixture: Name, Employee ID, Notes, Status, Robin Example. Reuse them as headers.
  const bytes = buildWorkbook({ staffRows: rows, extra: [{ name: "xl/styles.xml", data: STYLES }] });
  const sheet = (b: Uint8Array) => readZip(b).find((e) => e.name === "xl/worksheets/sheet1.xml")?.text ?? "";
  const cells = (xml: string, col: string) => [...xml.matchAll(new RegExp(`<c r="${col}(?!1")\\d+"[^>]*><v>([^<]*)</v>`, "g"))].map((m) => m[1]);

  test("the profile skips date-formatted cells in the numericId detector", () => {
    const d = mkdtempSync(join(tmpdir(), "blind-dates-"));
    try {
      mkdirSync(join(d, "kit"));
      writeFileSync(join(d, "kit", "book.xlsx"), bytes);
      const p = buildProfile(["kit"], 0, d).profile;
      const t = p.tables.find((x) => x.file.endsWith("book.xlsx") && x.sheet === "Staff");
      const byHeader = Object.fromEntries((t?.columns ?? []).map((c) => [c.header, c.stats.detectorRates.numericId]));
      expect(byHeader["Employee ID"]).toBe(0); // dated (builtin 14 / custom yyyy-mm-dd)
      expect(byHeader.Status).toBe(0); // 22 is a date-time
      const loc = profileLocations(p).find((l) => l.loc.header === "Employee ID");
      expect(heuristicRule(loc?.loc as never, loc?.stats as never, defaultPolicy())).toMatchObject({ class: "unknown" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("the engine leaves date serials alone and never renumbers them", () => {
    const r = run([{ path: "book.xlsx", bytes }]);
    const xml = sheet(out(r, "book.xlsx"));
    expect(cells(xml, "B")).toEqual(SERIALS.map(String));
    expect(cells(xml, "D")).toEqual(SERIALS.map((n) => String(n + 0.25)));
    expect(outcomes(r, "book.xlsx")["Employee ID"]).toBe("unknown-kept-not-identifier-like");
  });

  test("an explicit rule still renumbers a date column", () => {
    const r = run([{ path: "book.xlsx", bytes }], spec([rule("book.xlsx", "Employee ID", "blind", { sheet: "Staff" })]));
    expect(cells(sheet(out(r, "book.xlsx")), "B")).not.toEqual(SERIALS.map(String));
  });

  test("without styles the same serials are plain numbers (identifier-like, left as written)", () => {
    const plain = buildWorkbook({ staffRows: rows });
    const r = run([{ path: "book.xlsx", bytes: plain }]);
    expect(cells(sheet(out(r, "book.xlsx")), "B")).toEqual(SERIALS.map(String));
    expect(workbookEntries().some((e) => e.name === "xl/styles.xml")).toBe(false);
  });
});
