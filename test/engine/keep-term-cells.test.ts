// A cell whose whole value is a `[keep]` term is kept in a column blinded whole (AGT-2767): by a
// rule, by the fail-closed fallback or by a classified detector. A cell that only contains a keep
// term among other text is still replaced whole, and an explicit rule (a spec entity, the redact
// list, a dropped or redacted value) wins over the term. Synthetic data only: invented payees.

import { describe, expect, test } from "bun:test";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { buildWorkbook } from "../../src/bench/office.ts";
import { applySpec, type ApplyOptions, type InputFile } from "../../src/engine/apply.ts";
import { redactEntry } from "../../src/engine/redactlist.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = new Uint8Array(32).fill(7);
const PATTERNS = { ip: false, email: true, host: true, guid: false, mac: false, phone: true };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const rule = (file: string, header: string, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = "unknown"): ColumnRule =>
  ({ file, header, class: cls, treatment, confidence: 1, source: "policy" }) as ColumnRule;
const jsonRule = (file: string, jsonPath: string, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = "unknown"): ColumnRule =>
  ({ file, jsonPath, class: cls, treatment, confidence: 1, source: "policy" }) as ColumnRule;
const spec = (columns: ColumnRule[], entities: Spec["entities"] = {}, extra: Partial<Spec> = {}): Spec => ({ version: 1, columns, entities, patterns: PATTERNS, questions: [], ...extra });
const apply = (files: Record<string, string | Uint8Array>, s: Spec, opts: Partial<ApplyOptions> = {}) =>
  applySpec(Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: typeof v === "string" ? enc(v) : v })), s, { salt: SALT, ...opts });
const out = (r: ReturnType<typeof apply>, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);
const lines = (r: ReturnType<typeof apply>, path: string) => out(r, path).split("\n");
const book = (rows: (string | number)[][]): Uint8Array =>
  buildWorkbook({ sheets: [{ name: "Payments", rows }], orphans: [], definedNames: [], core: { title: "", creator: "", modifiedBy: "" } });
const xlsxRows = (bytes: Uint8Array): string[][] => {
  const wb = readWorkbook(bytes);
  return sheetRows(wb.sheets[0] as (typeof wb.sheets)[number], wb.sharedStrings);
};
const mapValues = (r: ReturnType<typeof apply>) => r.map.entries.map((e) => e.value);

// The payee column has no rule and is identifier-like, so the fail-closed fallback blinds it whole.
const PAYMENTS = "payee,amount\nStripe,12.50\nOrchard Lane Bakery,8.00\n  stripe ,3.10\nHollis Garden Supply,41.00\nPay via Stripe Ltd,9.99\nQuarry Hill Florist,22.00\n";
const KEEP = ["Stripe"];

describe("a cell that is a keep term, in a column blinded whole", () => {
  test("repro: the fallback column keeps the keep-term cells and replaces the rest", () => {
    const r = apply({ "pay.csv": PAYMENTS }, spec([]), { keep: KEEP });
    const rows = lines(r, "pay.csv");
    expect(r.files[0]?.columns[0]?.outcome).toBe("unknown-pseudonymised");
    expect(rows[1]).toBe("Stripe,12.50");
    // Case and spacing folded the way keep terms are compared; the cell is written as it was.
    expect(rows[3]).toBe("  stripe ,3.10");
    expect(rows[2]).not.toContain("Orchard");
    expect(rows[4]).not.toContain("Hollis");
    expect(rows[6]).not.toContain("Quarry");
    // Contains a keep term among other text: replaced whole, never kept in part.
    expect(rows[5]).not.toContain("Stripe");
    expect(rows[5]).not.toContain("Pay via");
    expect(r.files[0]?.columns[0]?.keptTerms).toBe(2);
  });

  test("without the keep term the cell is replaced, as before", () => {
    const r = apply({ "pay.csv": PAYMENTS }, spec([]));
    expect(out(r, "pay.csv")).not.toContain("Stripe");
    expect(r.files[0]?.columns[0]?.keptTerms).toBeUndefined();
  });

  test("a blind rule's column keeps it too, with any class", () => {
    for (const cls of ["unknown", "org", "person"] as const) {
      const r = apply({ "pay.csv": PAYMENTS }, spec([rule("pay.csv", "payee", "blind", cls)]), { keep: KEEP });
      const rows = lines(r, "pay.csv");
      expect([rows[1], rows[3]]).toEqual(["Stripe,12.50", "  stripe ,3.10"]);
      expect(rows[2]).not.toContain("Orchard");
      expect(rows[5]).not.toContain("Stripe");
    }
  });

  test("a classified detector's column (a phone column) keeps a keep-term cell", () => {
    const csv = "contact\n801-555-0101\n801-555-0102\nFront Desk\n";
    const r = apply({ "c.csv": csv }, spec([rule("c.csv", "contact", "blind", "id")]), { keep: ["Front Desk"] });
    const rows = lines(r, "c.csv");
    expect(rows[3]).toBe("Front Desk");
    expect(rows[1]).not.toBe("801-555-0101");
  });

  test("JSON: a string value under a blinded key", () => {
    const json = JSON.stringify(["Stripe", "Orchard Lane Bakery", "Hollis Garden Supply", "Quarry Hill Florist", "Stripe Ltd"].map((payee) => ({ payee })));
    const r = apply({ "pay.json": json }, spec([]), { keep: KEEP });
    const o = out(r, "pay.json");
    expect(o).toContain('{"payee":"Stripe"}');
    expect(o).not.toContain("Orchard");
    expect(o).not.toContain("Stripe Ltd");
    const ruled = apply({ "pay.json": json }, spec([jsonRule("pay.json", "$[*].payee", "blind")]), { keep: KEEP });
    expect(out(ruled, "pay.json")).toContain('{"payee":"Stripe"}');
    expect(out(ruled, "pay.json")).not.toContain("Orchard");
    expect(out(ruled, "pay.json")).not.toContain("Stripe Ltd");
  });

  test("a value blinded elsewhere whose form is the keep term still replaces it (an explicit rule wins)", () => {
    // Under an org rule "Stripe Ltd" is the org "Stripe": its pseudonym recurs in the kept cell, as a
    // blinded value recurs inside any kept cell, so the kept cell cannot name the blinded org.
    const json = JSON.stringify(["Stripe", "Orchard Lane Bakery", "Stripe Ltd"].map((payee) => ({ payee })));
    const r = apply({ "pay.json": json }, spec([jsonRule("pay.json", "$[*].payee", "blind", "org")]), { keep: KEEP });
    expect(out(r, "pay.json")).not.toContain("Stripe");
  });

  test("XLSX: a worksheet cell", () => {
    const x = apply({ "pay.xlsx": book([["payee"], ["Stripe"], ["Orchard Lane Bakery"], ["Hollis Garden Supply"], ["Quarry Hill Florist"]]) }, spec([]), { keep: KEEP });
    const rows = xlsxRows((x.outputs[0] as InputFile).bytes);
    expect(rows[1]).toEqual(["Stripe"]);
    expect(rows[2]?.[0]).not.toBe("Orchard Lane Bakery");
    expect(x.files[0]?.columns[0]?.keptTerms).toBe(1);
  });

  test("drop and redact columns are unaffected", () => {
    const d = apply({ "pay.csv": PAYMENTS }, spec([rule("pay.csv", "payee", "drop")]), { keep: KEEP });
    expect(lines(d, "pay.csv")[1]).toBe("12.50");
    const x = apply({ "pay.csv": PAYMENTS }, spec([rule("pay.csv", "payee", "redact")]), { keep: KEEP });
    expect(lines(x, "pay.csv")[1]).toBe("REDACTED,12.50");
    // A secret-class blind rule writes REDACTED too.
    const s = apply({ "pay.csv": PAYMENTS }, spec([rule("pay.csv", "payee", "blind", "secret")]), { keep: KEEP });
    expect(lines(s, "pay.csv")[1]).toBe("REDACTED,12.50");
  });

  test("the kept value is not written to the map", () => {
    const r = apply({ "pay.csv": PAYMENTS }, spec([]), { keep: KEEP });
    expect(mapValues(r).some((v) => v.trim().toLowerCase() === "stripe")).toBe(false);
    expect(mapValues(r)).toContain("Orchard Lane Bakery");
  });

  test("an explicit rule wins: a spec entity, the redact list, a dropped or redacted value", () => {
    const entity = apply({ "pay.csv": PAYMENTS }, spec([], { org: [{ canonical: "Stripe", aliases: [], parts: [] }] as never }), { keep: KEEP });
    expect(lines(entity, "pay.csv")[1]).not.toContain("Stripe");
    // A vocabulary entity is not a blinding rule: the cell stays kept.
    const vocab = apply({ "pay.csv": PAYMENTS }, spec([], { vocabulary: [{ canonical: "Stripe", aliases: [], parts: [] }] as never }), { keep: KEEP });
    expect(lines(vocab, "pay.csv")[1]).toBe("Stripe,12.50");
    const listed = apply({ "pay.csv": PAYMENTS }, spec([], {}, { redact: [redactEntry(SALT, "Stripe")] }), { keep: KEEP });
    expect(lines(listed, "pay.csv")[1]).toBe("REDACTED,12.50");
    expect(mapValues(listed)).not.toContain("Stripe");
    const OTHER = "vendor,note\nStripe,a\nAcme Paper,b\n";
    const dropped = apply({ "pay.csv": PAYMENTS, "other.csv": OTHER }, spec([rule("other.csv", "vendor", "drop")]), { keep: KEEP });
    expect(lines(dropped, "pay.csv")[1]).toBe("REDACTED,12.50");
    expect(mapValues(dropped)).not.toContain("Stripe");
  });

  test("the audit does not report the kept cell", () => {
    const r = apply({ "pay.csv": PAYMENTS }, spec([]), { keep: KEEP });
    const tree: TreeEntry[] = r.outputs.map((o) => ({ path: o.path, kind: "file", bytes: Buffer.from(o.bytes) }));
    const findings = auditTree(tree, spec([]), r.map, KEEP).files.flatMap((f) => f.findings);
    expect(findings.filter((f) => /stripe/i.test(JSON.stringify(f)))).toEqual([]);
  });
});
