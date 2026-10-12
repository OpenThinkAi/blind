// The `drop` and `redact` column treatments (AGT-1827), through the engine, the audit, reveal and
// the bench scorer. Synthetic data only: invented owners, codes and chip numbers.

import { describe, expect, test } from "bun:test";
import { auditTree } from "../../src/audit/mechanical.ts";
import { buildWorkbook, type Workbook } from "../../src/bench/office.ts";
import { OracleMatcher, parseOracle, scoreDamage } from "../../src/bench/score.ts";
import { ApplyError, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { jsonCuts, scanJson } from "../../src/engine/json.ts";
import { Revealer, revealFile } from "../../src/engine/reveal.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { type ColumnRule, REDACTED_VALUE, type Spec } from "../../src/schema.ts";

const SALT = new Uint8Array(32).fill(7);
const PATTERNS_OFF = { ip: false, email: false, host: false, guid: false, mac: false };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const rule = (file: string, where: { header: string } | { jsonPath: string } | { sheet: string; header: string }, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = treatment === "keep" ? "vocabulary" : "unknown"): ColumnRule =>
  ({ file, ...where, class: cls, treatment, confidence: 1, source: "policy" }) as ColumnRule;
const spec = (columns: ColumnRule[]): Spec => ({ version: 1, columns, entities: {}, patterns: PATTERNS_OFF, questions: [] });
const apply = (files: Record<string, string | Uint8Array>, columns: ColumnRule[]) =>
  applySpec(Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: typeof v === "string" ? enc(v) : v })), spec(columns), { salt: SALT });
const out = (r: ReturnType<typeof apply>, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);

const VISITS = "Report: spring clinic\nOwner,Species,Gate Code,Notes\nAda Example,canine,4471,follow up\nBo Sample,feline,,owner called back\n";

describe("drop and redact in CSV", () => {
  test("drop removes the column from the header down; a preamble row is left alone; redact writes the placeholder", () => {
    const r = apply({ "visits.csv": VISITS }, [
      rule("visits.csv", { header: "Owner" }, "blind", "person"),
      rule("visits.csv", { header: "Species" }, "keep"),
      rule("visits.csv", { header: "Gate Code" }, "redact"),
      rule("visits.csv", { header: "Notes" }, "drop"),
    ]);
    const text = out(r, "visits.csv");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Report: spring clinic");
    expect(lines[1]).toBe("Owner,Species,Gate Code");
    expect(lines[2]).toMatch(/^Person_[0-9A-F]+,canine,REDACTED$/);
    // An empty cell stays empty: nothing to redact.
    expect(lines[3]).toMatch(/^Person_[0-9A-F]+,feline,$/);
    expect(text).not.toContain("follow up");
    expect(text).not.toContain("4471");
    const cols = (r.files[0] as (typeof r.files)[number]).columns;
    expect(cols.map((c) => [c.header, c.outcome, c.changed])).toEqual([
      ["Owner", "blinded", 2],
      ["Species", "kept", 0],
      ["Gate Code", "redacted", 1],
      ["Notes", "dropped", 2],
    ]);
    // Neither treatment is reversible: nothing of theirs is in the map.
    expect(JSON.stringify(r.map)).not.toContain("4471");
    expect(JSON.stringify(r.map)).not.toContain("follow up");
  });

  test("a dropped value is not scanned or rewritten anywhere, and a quoted cell drops cleanly", () => {
    const r = apply({ "a.csv": 'Id,Note\n1,"has, comma"\n2,plain\n' }, [rule("a.csv", { header: "Id" }, "keep"), rule("a.csv", { header: "Note" }, "drop")]);
    expect(out(r, "a.csv")).toBe("Id\n1\n2\n");
  });
});

describe("drop and redact in JSON", () => {
  const PETS = `{
  "pets": [
    {"name": "Rex", "ssn": "000-00-0001", "chip": 985141000123456},
    {"ssn": null, "name": "Tom", "code": 4471}
  ],
  "owner": {"ssn": "000-00-0003"}
}
`;

  const KEEP_PETS = ["name", "chip", "code"].map((k) => rule("pets.json", { jsonPath: `$.pets[*].${k}` }, "keep"));

  test("drop cuts each member with one comma, wherever it sits; the result is valid JSON with its layout", () => {
    const r = apply({ "pets.json": PETS }, [...KEEP_PETS, rule("pets.json", { jsonPath: "$.pets[*].ssn" }, "drop"), rule("pets.json", { jsonPath: "$.owner.ssn" }, "drop")]);
    const text = out(r, "pets.json");
    expect(text).toBe(`{
  "pets": [
    {"name": "Rex", "chip": 985141000123456},
    {"name": "Tom", "code": 4471}
  ],
  "owner": {}
}
`);
    expect(() => JSON.parse(text)).not.toThrow();
    const ssn = (r.files[0] as (typeof r.files)[number]).columns.find((c) => c.jsonPath === "$.pets[*].ssn");
    expect(ssn).toMatchObject({ outcome: "dropped", changed: 2 });
  });

  test("redact writes the placeholder as a string, a number included", () => {
    const r = apply({ "pets.json": PETS }, [
      rule("pets.json", { jsonPath: "$.pets[*].name" }, "keep"),
      rule("pets.json", { jsonPath: "$.pets[*].code" }, "redact"),
      rule("pets.json", { jsonPath: "$.pets[*].chip" }, "redact"),
    ]);
    const doc = JSON.parse(out(r, "pets.json")) as { pets: Record<string, unknown>[] };
    expect(doc.pets[0]?.chip).toBe(REDACTED_VALUE);
    expect(doc.pets[1]?.code).toBe(REDACTED_VALUE);
    expect(doc.pets[1]?.name).toBe("Tom");
  });

  test("jsonCuts: adjacent members go as one run, so no comma is taken twice", () => {
    const text = '{"a": 1, "b": 2, "c": 3}';
    const toks = scanJson(text);
    const at = (k: string) => toks.findIndex((t) => t.kind !== "key" && t.column === `$.${k}`);
    const cutOut = (keys: string[]) => {
      let s = "";
      let pos = 0;
      for (const [a, b] of jsonCuts(text, toks, keys.map(at)).ranges) {
        s += text.slice(pos, a);
        pos = b;
      }
      return s + text.slice(pos);
    };
    expect(cutOut(["a"])).toBe('{"b": 2, "c": 3}');
    expect(cutOut(["b"])).toBe('{"a": 1, "c": 3}');
    expect(cutOut(["c"])).toBe('{"a": 1, "b": 2}');
    expect(cutOut(["b", "c"])).toBe('{"a": 1}');
    expect(cutOut(["a", "c"])).toBe('{"b": 2}');
    expect(cutOut(["a", "b", "c"])).toBe("{}");
    expect(cutOut(["a", "b"])).toBe('{"c": 3}');
  });

  test("drop or redact of the root or of record-ID keys is refused", () => {
    expect(() => apply({ "r.json": '{"u-10010": {"x": 1}}' }, [rule("r.json", { jsonPath: "$.*~" }, "redact")])).toThrow(ApplyError);
    expect(() => apply({ "r.jsonl": '"a"\n"b"\n' }, [rule("r.jsonl", { jsonPath: "$" }, "drop")])).toThrow(ApplyError);
  });
});

describe("drop and redact in XLSX", () => {
  const book = (rows: (string | number)[][], extra: Partial<Workbook> = {}): Uint8Array =>
    buildWorkbook({ sheets: [{ name: "Visits", rows }], orphans: [], definedNames: [], core: { title: "", creator: "", modifiedBy: "" }, ...extra });

  test("data cells are emptied (drop) or overwritten (redact) in place; the header and layout stay", () => {
    const bytes = book([
      ["Owner", "Gate Code", "Notes", "Species"],
      ["Ada Example", "4471", "follow up", "canine"],
      ["Bo Sample", "8812", "canine", "feline"],
    ]);
    const r = apply({ "v.xlsx": bytes }, [
      rule("v.xlsx", { sheet: "Visits", header: "Gate Code" }, "redact"),
      rule("v.xlsx", { sheet: "Visits", header: "Notes" }, "drop"),
      rule("v.xlsx", { sheet: "Visits", header: "Species" }, "keep"),
    ]);
    expect(r.skipped).toEqual([]);
    const wb = readWorkbook((r.outputs[0] as InputFile).bytes);
    const rows = sheetRows(wb.sheets[0] as (typeof wb.sheets)[number], wb.sharedStrings);
    expect(rows[0]).toEqual(["Owner", "Gate Code", "Notes", "Species"]);
    // "canine" is one shared string, used by a dropped cell (row 3) and a kept one (row 2): the
    // stricter treatment wins, as a pseudonym does over keep.
    expect(rows[1]?.slice(1)).toEqual([REDACTED_VALUE, "", ""]);
    expect(rows[2]?.slice(1)).toEqual([REDACTED_VALUE, "", "feline"]);
    // Owner has no rule and holds people's names: pseudonymised as person (AGT-1830).
    expect(r.files[0]?.columns.map((c) => c.outcome)).toEqual(["unknown-person", "redacted", "dropped", "kept"]);
  });

  test("a number cell in a dropped or redacted column refuses the workbook rather than leaving the value", () => {
    const r = apply({ "v.xlsx": book([["Owner", "Chip"], ["Ada Example", 985141000123456]]) }, [rule("v.xlsx", { sheet: "Visits", header: "Chip" }, "drop")]);
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toContain("is not text");
  });

  test("a pivot cache, which repeats cell values, refuses the workbook", () => {
    const pivot = { sheet: "Visits", ref: "A1:B2", fields: [{ name: "Owner", items: ["Ada Example"] }, { name: "Code", items: ["4471"] }], records: [[0, 0]] };
    const r = apply({ "v.xlsx": book([["Owner", "Code"], ["Ada Example", "4471"]], { pivot }) }, [rule("v.xlsx", { sheet: "Visits", header: "Code" }, "redact")]);
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toContain("caches cell values");
  });
});

describe("audit, reveal and bench", () => {
  test("the audit flags a dropped column still present and a redacted column with values left, and never calls them unknown", () => {
    const rules = [rule("v.csv", { header: "Notes" }, "drop"), rule("v.csv", { header: "Code" }, "redact")];
    const report = auditTree([{ path: "v.csv", kind: "file", bytes: enc("Code,Notes\nREDACTED,ok\n4471,fine\n") }], spec(rules), { version: 1, entries: [] } as never);
    const reasons = report.files.flatMap((f) => f.findings).map((f) => `${f.severity}: ${f.reason}`);
    expect(reasons.some((x) => x.startsWith("leak: the spec drops column"))).toBe(true);
    expect(reasons.some((x) => x.startsWith("leak: the spec redacts column") && x.includes("1 cell(s)"))).toBe(true);
    expect(reasons.some((x) => x.includes("as unknown"))).toBe(false);

    const clean = auditTree([{ path: "v.csv", kind: "file", bytes: enc("Code\nREDACTED\n\n") }], spec(rules), { version: 1, entries: [] } as never);
    expect(clean.files.flatMap((f) => f.findings).filter((f) => f.severity === "leak")).toEqual([]);
  });

  test("reveal restores pseudonyms and leaves the placeholder and the dropped column as they are", () => {
    const r = apply({ "visits.csv": VISITS }, [
      rule("visits.csv", { header: "Owner" }, "blind", "person"),
      rule("visits.csv", { header: "Species" }, "keep"),
      rule("visits.csv", { header: "Gate Code" }, "redact"),
      rule("visits.csv", { header: "Notes" }, "drop"),
    ]);
    const back = dec(revealFile("visits.csv", (r.outputs[0] as InputFile).bytes, new Revealer(r.map)).bytes);
    expect(back).toBe("Report: spring clinic\nOwner,Species,Gate Code\nAda Example,canine,REDACTED\nBo Sample,feline,\n");
  });

  test("bench damage: a dropped column or key and a redacted one are not damage, and the rest lines up", () => {
    const csvIn = "Owner,Notes,Species\nAda Example,follow up,canine\n";
    const jsonIn = '{"a": "x", "ssn": "000-00-0001", "b": "y"}';
    const r = apply({ "v.csv": csvIn, "p.json": jsonIn }, [
      rule("v.csv", { header: "Notes" }, "drop"),
      rule("v.csv", { header: "Owner" }, "redact"),
      rule("v.csv", { header: "Species" }, "keep"),
      rule("p.json", { jsonPath: "$.ssn" }, "drop"),
      rule("p.json", { jsonPath: "$.a" }, "keep"),
      rule("p.json", { jsonPath: "$.b" }, "keep"),
    ]);
    const oracle = parseOracle(JSON.stringify({ version: 1, seed: 1, rows: 1, columns: [], values: [{ value: "Zed Nobody", class: "person" }], decoys: [] }));
    const files = r.files.map((report) => ({ report, input: enc(report.path === "v.csv" ? csvIn : jsonIn), output: (r.outputs.find((o) => o.path === report.outputPath) as InputFile).bytes }));
    expect(scoreDamage(files, oracle, new OracleMatcher(oracle)).damage).toEqual([]);
  });
});
