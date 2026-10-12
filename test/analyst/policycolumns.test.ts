// Column rules in blind.toml (AGT-1827): `[[columns]]` and `[keep].terms` naming a header, parsed,
// matched, written into the spec by `blind plan`, and honoured end to end with no model.
// Synthetic data only: invented owners, weights, amounts and chip numbers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyColumnPolicy, ColumnPolicy, headerGlob, keyName, pathGlob } from "../../src/analyst/policycolumns.ts";
import { type BenchReport, REPORT_FILE, runBench } from "../../src/bench/command.ts";
import { ACCOUNTS_CSV, generateKit, writeKit } from "../../src/bench/synth.ts";
import { defaultPolicy, parsePolicy, type Policy, PolicyError, renderPolicy } from "../../src/policy.ts";
import type { ColumnRule, Profile, Spec, ValueStats } from "../../src/schema.ts";

const BIN = join(import.meta.dir, "../../bin/blind.js");
const blind = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
};
const withColumns = (toml: string) => `${renderPolicy(defaultPolicy())}\n${toml}\n`;

describe("[[columns]] in blind.toml", () => {
  test("parses a header string or list, an optional file glob and class, with defaults per treatment", () => {
    const p = parsePolicy(
      withColumns(`
[[columns]]
header = ["species", "weight*"]
treatment = "keep"

[[columns]]
header = "gate code"
file = "visits/**/*.csv"
treatment = "redact"

[[columns]]
header = "owner"
treatment = "blind"
class = "person"
`),
    );
    expect(p.columns).toEqual([
      { header: ["species", "weight*"], treatment: "keep", class: "vocabulary" },
      { header: ["gate code"], file: "visits/**/*.csv", treatment: "redact", class: "unknown" },
      { header: ["owner"], treatment: "blind", class: "person" },
    ]);
    // Rendered and read back unchanged.
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
    // No rules: the default policy, with a commented example.
    expect(parsePolicy(renderPolicy(defaultPolicy())).columns).toEqual([]);
    expect(renderPolicy(defaultPolicy())).toContain("# [[columns]]");
  });

  test("refuses a bad treatment or class, keep with class unknown, an empty header, an unknown key", () => {
    const bad = (body: string) => () => parsePolicy(withColumns(`[[columns]]\n${body}`));
    expect(bad('header = "x"\ntreatment = "shred"')).toThrow(/columns\[0\]\.treatment must be one of "keep", "scan", "drop", "blind", "value", "redact"/);
    expect(bad('header = "x"\ntreatment = "blind"\nclass = "pet"')).toThrow(/columns\[0\]\.class must be one of/);
    expect(bad('header = "x"\ntreatment = "keep"\nclass = "unknown"')).toThrow(/class "unknown" cannot use treatment "keep"/);
    expect(bad('header = []\ntreatment = "drop"')).toThrow(/columns\[0\]\.header must be a non-empty glob/);
    expect(bad('header = " "\ntreatment = "drop"')).toThrow(/columns\[0\]\.header must be a non-empty glob/);
    expect(bad('treatment = "drop"')).toThrow(/columns\[0\]\.header must be an array of strings/);
    expect(bad('header = "x"\ntreatment = "drop"\nsheet = "S"')).toThrow(/unknown key columns\[0\]\.sheet/);
    expect(() => parsePolicy(withColumns('columns = "keep everything"'))).toThrow(PolicyError);
  });
});

describe("matching", () => {
  test("header globs ignore case and runs of whitespace; path globs keep * inside one folder", () => {
    expect(headerGlob("Visit  Date").test("visit date")).toBe(true);
    expect(headerGlob("weight*").test("weight (lb)")).toBe(true);
    expect(headerGlob("chip?").test("chip1")).toBe(true);
    expect(headerGlob("chip?").test("chip")).toBe(false);
    expect(headerGlob("a.b").test("axb")).toBe(false);
    expect(pathGlob("*.csv").test("visits.csv")).toBe(true);
    expect(pathGlob("*.csv").test("2026/visits.csv")).toBe(false);
    expect(pathGlob("**/*.csv").test("visits.csv")).toBe(true);
    expect(pathGlob("**/*.csv").test("a/b/visits.csv")).toBe(true);
    expect(pathGlob("clinic/**").test("clinic/a/b.json")).toBe(true);
  });

  test("a JSON key path matches by its last key name; the root and record-ID keys never match", () => {
    expect(keyName("$.owner.phone")).toBe("phone");
    expect(keyName("$.visits[*].weight")).toBe("weight");
    expect(keyName('$["visit date"]')).toBe("visit date");
    expect(keyName("$.tags[*]")).toBe("tags");
    expect(keyName("$.*~")).toBeNull();
    expect(keyName("$")).toBeNull();
  });

  test("the first matching rule wins; a header that is a keep term is kept when no rule names it", () => {
    const cp = new ColumnPolicy({
      columns: [
        { header: ["notes"], file: "private/*.csv", treatment: "drop", class: "unknown" },
        { header: ["note*"], treatment: "redact", class: "unknown" },
      ],
      keep: { terms: ["Species", "Notes"] },
    });
    expect(cp.ruleFor({ file: "private/a.csv", header: "Notes" })).toMatchObject({ treatment: "drop", source: "policy" });
    expect(cp.ruleFor({ file: "public/a.csv", header: "Notes" })).toMatchObject({ treatment: "redact" });
    expect(cp.ruleFor({ file: "a.csv", header: " species " })).toMatchObject({ treatment: "keep", class: "vocabulary", source: "policy" });
    expect(cp.ruleFor({ file: "a.json", jsonPath: "$.pets[*].species" })).toMatchObject({ treatment: "keep" });
    expect(cp.ruleFor({ file: "a.csv", header: "Owner" })).toBeUndefined();
  });
});

describe("applyColumnPolicy", () => {
  const stats: ValueStats = { count: 3, distinctRatio: 1, digitRatio: 0, dictionaryRatio: 0, meanLength: 5, detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0 }, samples: [] };
  const profile: Profile = {
    version: 1,
    sampleCount: 0,
    files: [{ path: "v.csv", format: "csv", size: 10 }],
    tables: [{ file: "v.csv", headerRow: 1, columns: ["Owner", "Species", "Notes"].map((header) => ({ header, stats })) }],
    jsonKeys: [],
    documents: [],
    transcripts: [],
    cooccurrence: [],
  };
  const policy = (columns: Policy["columns"]): Pick<Policy, "columns" | "sensitive" | "keep"> => ({ ...defaultPolicy(), columns });
  const saved: Spec = {
    version: 1,
    columns: [
      { file: "v.csv", header: "Owner", class: "person", treatment: "blind", confidence: 0.9, source: "analyst" },
      { file: "v.csv", header: "Species", class: "unknown", treatment: "value", confidence: 0, source: "analyst" },
    ],
    entities: {},
    patterns: { ip: true, email: true, host: true, guid: true, mac: true },
    questions: [{ id: "q1", text: "What is Species?", options: ["keep", "blind"], answer: null, about: { file: "v.csv", header: "Species" } }],
  };

  test("overrides the saved or analyst rule, adds a missing column, and drops the open question it settles", () => {
    const r = applyColumnPolicy(saved, profile, policy([{ header: ["species"], treatment: "keep", class: "vocabulary" }, { header: ["notes"], treatment: "drop", class: "unknown" }]));
    expect(r.spec.columns).toEqual([
      saved.columns[0] as ColumnRule,
      { file: "v.csv", header: "Species", class: "vocabulary", treatment: "keep", confidence: 1, source: "policy" },
      { file: "v.csv", header: "Notes", class: "unknown", treatment: "drop", confidence: 1, source: "policy" },
    ]);
    expect(r.spec.columns[0]).toBe(saved.columns[0] as never);
    expect(r.removedQuestions).toEqual(["q1"]);
    expect(r.spec.questions).toEqual([]);
  });

  test("a human rule in the spec is kept over blind.toml, and reported", () => {
    const human: Spec = { ...saved, columns: [{ ...(saved.columns[0] as ColumnRule), source: "human" }] };
    const r = applyColumnPolicy(human, profile, policy([{ header: ["owner"], treatment: "drop", class: "unknown" }]));
    expect(r.spec).toBe(human);
    expect(r.human).toEqual([{ file: "v.csv", header: "Owner" }]);
  });

  test("with no rules the spec is returned as is; a saved policy rule nothing makes any more goes back to the heuristic", () => {
    expect(applyColumnPolicy(saved, profile, policy([])).spec).toBe(saved);
    const once = applyColumnPolicy(saved, profile, policy([{ header: ["notes"], treatment: "drop", class: "unknown" }])).spec;
    const after = applyColumnPolicy(once, profile, policy([]));
    expect(after.reverted).toEqual([{ file: "v.csv", header: "Notes" }]);
    expect(after.spec.columns[2]).toMatchObject({ header: "Notes", class: "unknown", treatment: "value", source: "heuristic" });
  });
});

describe("end to end, privacy.mode none, no model", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-policy-columns-"));
    mkdirSync(join(dir, "in"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const VISITS = [
    "Visit Date,Owner,Species,Weight,Amount,Microchip,Gate Code,Notes",
    "2026-01-04,Ada Example,canine,38.6 lb,$120.50,985141000123456,4471,follow up in two weeks",
    "2026-01-09,Bo Sample,feline,9.2 lb,$64.00,985141000654321,8812,owner called back",
    "2026-02-11,Cy Invented,canine,51.0 lb,$210.75,985141000777888,1904,nail trim",
    "2026-02-20,Di Madeup,feline,11.4 lb,$45.25,985141000222333,5530,vaccines due",
    "2026-03-02,Ed Fictional,canine,22.8 lb,$98.10,985141000444555,7781,dental next visit",
    "",
  ].join("\n");

  function setup(columnsToml: string, keep: string[] = []) {
    writeFileSync(join(dir, "in", "visits.csv"), VISITS);
    const p = defaultPolicy();
    p.privacy.mode = "none";
    p.keep.terms = keep;
    writeFileSync(join(dir, "blind.toml"), `${renderPolicy(p)}\n${columnsToml}\n`);
    expect(blind(dir, "init", "--defaults").code).toBe(0);
  }
  const column = (text: string, header: string) => {
    const rows = text.trimEnd().split("\n").map((l) => l.split(","));
    const i = (rows[0] as string[]).indexOf(header);
    return i < 0 ? null : rows.map((r) => r[i]);
  };

  test("acceptance: keep species, weight, visit date and microchip, written only in blind.toml, pass through byte-identical", () => {
    setup(`[[columns]]\nheader = ["species", "weight", "visit date", "microchip"]\ntreatment = "keep"\n`);
    const r = blind(dir, "run", "in", "-o", "out", "--yes");
    expect(r.code).toBeLessThan(2);
    expect(r.out).toContain("decided by blind.toml");
    const output = readFileSync(join(dir, "out", "visits.csv"), "utf8");
    for (const h of ["Species", "Weight", "Visit Date", "Microchip"]) expect(column(output, h)).toEqual(column(VISITS, h));
    // The rest still goes through the heuristic: the owners are pseudonymised.
    expect(output).not.toContain("Ada Example");
    const spec = JSON.parse(readFileSync(join(dir, ".blind", "spec.json"), "utf8")) as Spec;
    expect(spec.columns.filter((c) => c.source === "policy").map((c) => c.header).sort()).toEqual(["Microchip", "Species", "Visit Date", "Weight"]);
  });

  test("drop and redact from blind.toml; a [keep] term exempts its column", () => {
    setup(`[[columns]]\nheader = "gate*"\ntreatment = "redact"\n\n[[columns]]\nheader = "notes"\ntreatment = "drop"\n`, ["Amount"]);
    expect(blind(dir, "run", "in", "-o", "out", "--yes").code).toBeLessThan(2);
    const output = readFileSync(join(dir, "out", "visits.csv"), "utf8");
    expect(column(output, "Notes")).toBeNull();
    expect(column(output, "Gate Code")?.slice(1)).toEqual(Array(5).fill("REDACTED"));
    expect(column(output, "Amount")).toEqual(column(VISITS, "Amount"));
    expect(output).not.toContain("4471");
  });
});

test("bench: --plan with [[columns]] keeping the kit's money, dates and enums scores no damage on them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blind-policy-bench-"));
  try {
    writeKit(dir, generateKit());
    rmSync(join(dir, "spec.json"));
    const p = defaultPolicy();
    p.privacy.mode = "none";
    p.columns = [{ header: ["Amount", "Opened", "Status", "Region"], file: ACCOUNTS_CSV, treatment: "keep", class: "vocabulary" }];
    writeFileSync(join(dir, "blind.toml"), renderPolicy(p));
    const sink = { text: "", write(s: string) { this.text += s; return true; } };
    await runBench([dir, "--plan"], { out: sink as unknown as NodeJS.WritableStream, err: sink as unknown as NodeJS.WritableStream, cwd: dir });
    const report = JSON.parse(readFileSync(join(dir, REPORT_FILE), "utf8")) as BenchReport;
    expect(report.spec).toBe("heuristic");
    // The heuristic's own rules (unknown/value) are not damage-scored; the policy's keep rules are,
    // so columns 7-10 of accounts.csv (Status, Region, Amount, Opened) are now checked cell by cell.
    expect(report.damage.items.filter((d) => d.file === ACCOUNTS_CSV && /column (7|8|9|10)$/.test(d.where))).toEqual([]);
    expect(report.damage.count).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
