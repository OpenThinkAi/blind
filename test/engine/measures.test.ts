// AGT-1822: with no rule, measures (dates, weights, amounts) and small categoricals (species) pass
// unchanged, and numeric worksheet cells are never renumbered by the fail-closed fallback. The chip
// column is a numericId: it is blinded only when a rule (or the class the heuristic gives it) says so.
// Synthetic data only: invented values, obviously fake chip numbers.

import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { renderReport } from "../../src/apply.ts";
import { buildWorkbook } from "../../src/bench/office.ts";
import { readZip } from "../formats/zipfixture.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);

const ROWS: [string, string, string, string, string][] = [
  ["2026-01-05", "38.6 lb", "$120.50", "Canine", "985112000100001"],
  ["2026-01-09", "9.2 lb", "$85.00", "Feline", "985112000100002"],
  ["2026-02-11", "41.0 lb", "$1,240.75", "Canine", "985112000100003"],
  ["2026-02-17", "12.4 lb", "$64.20", "Feline", "985112000100004"],
  ["2026-03-02", "1102.5 lb", "$310.00", "Equine", "985112000100005"],
  ["2026-03-20", "55.3 lb", "$97.15", "Lapine", "985112000100006"],
  ["2026-04-01", "7.8 lb", "$42.60", "Lapine", "985112000100007"],
  ["2026-04-14", "1080.0 lb", "$275.40", "Equine", "985112000100008"],
];
// Species: four values, each twice, so the distinct ratio (0.5) alone would not save it.
const HEADERS = ["Visit Date", "Weight", "Amount", "Species", "Chip"];
const CSV = `${[HEADERS.join(","), ...ROWS.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(","))].join("\n")}\n`;

const spec = (columns: ColumnRule[] = []): Spec => ({
  version: 1,
  columns,
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
});
const chip = (file: string, treatment: ColumnRule["treatment"], sheet?: string): ColumnRule => ({
  file,
  ...(sheet === undefined ? {} : { sheet }),
  header: "Chip",
  class: "id",
  treatment,
  confidence: 0.8,
  source: "heuristic",
});
const run = (inputs: InputFile[], s: Spec): ApplyResult => applySpec(inputs, s, { salt: SALT });
const out = (r: ApplyResult, path: string): Uint8Array => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`not written: ${JSON.stringify(r.skipped)}`);
  return o.bytes;
};
const outcomes = (r: ApplyResult, path: string) => Object.fromEntries((r.files.find((f) => f.path === path)?.columns ?? []).map((c) => [c.header, c.outcome]));

describe("CSV: measures and categoricals pass with no rule", () => {
  const input: InputFile = { path: "visits.csv", bytes: Buffer.from(CSV, "utf8") };

  test("the chip kept by its class: the whole file is byte-identical", () => {
    const r = run([input], spec([chip("visits.csv", "keep")]));
    expect(Buffer.from(out(r, "visits.csv")).toString("utf8")).toBe(CSV);
    expect(outcomes(r, "visits.csv")).toEqual({
      "Visit Date": "unknown-kept-not-identifier-like",
      Weight: "unknown-kept-not-identifier-like",
      Amount: "unknown-kept-not-identifier-like",
      Species: "unknown-kept-not-identifier-like",
      Chip: "kept",
    });
  });

  test("the chip blinded by its class: only the chip column changes", () => {
    const r = run([input], spec([chip("visits.csv", "blind")]));
    const lines = Buffer.from(out(r, "visits.csv")).toString("utf8").trimEnd().split("\n");
    const original = CSV.trimEnd().split("\n");
    expect(lines[0]).toBe(original[0]);
    lines.slice(1).forEach((l, i) => {
      const before = original[i + 1] as string;
      expect(l.slice(0, l.lastIndexOf(","))).toBe(before.slice(0, before.lastIndexOf(",")));
      expect(l.slice(l.lastIndexOf(",") + 1)).not.toBe(before.slice(before.lastIndexOf(",") + 1));
    });
    expect(outcomes(r, "visits.csv").Chip).toBe("blinded");
  });

  test("with no rule at all the chip still fails closed (identifier-like), the measures do not", () => {
    const r = run([input], spec());
    const o = outcomes(r, "visits.csv");
    expect(o.Chip).toBe("unknown-pseudonymised");
    expect(o.Amount).toBe("unknown-kept-not-identifier-like");
    expect(o.Species).toBe("unknown-kept-not-identifier-like");
  });
});

describe("XLSX: numeric cells are never renumbered by the fallback", () => {
  const SHEET = "Visits";
  // Number cells for weight, amount and a plain integer count; the chip as a number too.
  const rows = [
    ["Visit Date", "Weight", "Amount", "Count", "Species", "Chip"],
    ...ROWS.map((r, i) => [r[0], Number.parseFloat(r[1]), Number.parseFloat(r[2].replace(/[$,]/g, "")), 1000 + i * 37, r[3], Number(r[4])]),
  ];
  const bytes = buildWorkbook({ sheets: [{ name: SHEET, rows }], orphans: [], definedNames: [], core: { title: "t", creator: "c", modifiedBy: "c" } });
  const sheetXml = (b: Uint8Array): string => readZip(b).find((e) => e.name === "xl/worksheets/sheet1.xml")?.text ?? "";
  const values = (xml: string): string[] => [...xml.matchAll(/<v>([^<]*)<\/v>/g)].map((m) => m[1] as string);

  test("no rule for any column but the chip (kept): every number is written as it was", () => {
    const r = run([{ path: "visits.xlsx", bytes }], spec([chip("visits.xlsx", "keep", SHEET)]));
    const before = values(sheetXml(bytes));
    expect(values(sheetXml(out(r, "visits.xlsx")))).toEqual(before);
    // The integer count column is identifier-like (distinct, all digits): it fails closed, but its
    // number cells are left as written, and the report says so rather than claiming a change.
    const count = r.files[0]?.columns.find((c) => c.header === "Count");
    expect(count).toMatchObject({ outcome: "unknown-pseudonymised", changed: 0, numbersLeft: 8 });
    // Weight and amount too: written as numbers, 41.0 and $85.00 are the integers 41 and 85, so only
    // 6 of 8 values read as decimals and the stats do not call the columns measures. Their numbers
    // are left as written all the same: that is what this rule is for.
    expect(r.files[0]?.columns.filter((c) => c.numbersLeft !== undefined).map((c) => c.header)).toEqual(["Weight", "Amount", "Count"]);
    const report = renderReport(r);
    expect(report).toContain('"Count": unknown → identifier-like, but kept (numbers) (no spec rule)');
    expect(report).toContain("warning: 8 number cells left as written");
  });

  test("a rule that blinds the chip renumbers it, and only it", () => {
    const r = run([{ path: "visits.xlsx", bytes }], spec([chip("visits.xlsx", "blind", SHEET)]));
    const before = values(sheetXml(bytes));
    const after = values(sheetXml(out(r, "visits.xlsx")));
    const chips = new Set(ROWS.map((x) => x[4]));
    after.forEach((v, i) => {
      if (chips.has(before[i] as string)) {
        expect(v).not.toBe(before[i] as string);
        expect(v).toMatch(/^\d{15}$/);
      } else expect(v).toBe(before[i] as string);
    });
  });
});
