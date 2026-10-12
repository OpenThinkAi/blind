// Column rules in blind.toml (AGT-1827): `[[columns]]` and `[keep].terms` naming a header, parsed,
// matched, written into the spec by `blind plan`, and honoured end to end with no model.
// Synthetic data only: invented owners, weights, amounts and chip numbers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyColumnPolicy, ColumnPolicy, describeMatch, headerGlob, keyName, keySegments, pathGlob, pathGlobSegments, type RuleMatch, rankReason } from "../../src/analyst/policycolumns.ts";
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
    expect(bad('treatment = "drop"')).toThrow(/columns\[0\]\.header must be set \(a rule needs header, path or both\)/);
    expect(bad('header = "x"\ntreatment = "drop"\nsheets = "S"')).toThrow(/unknown key columns\[0\]\.sheets/);
    expect(bad('path = "owner.dob"\nsheet = "S"\ntreatment = "drop"')).toThrow(/path \(JSON keys\) and sheet \(worksheet columns\) cannot both be set/);
    expect(bad('path = " "\ntreatment = "drop"')).toThrow(/columns\[0\]\.path must be a non-empty glob/);
    expect(bad('sheet = "S"\ntreatment = "drop"')).toThrow(/columns\[0\]\.header must be set/);
    expect(bad('header = 3\ntreatment = "drop"')).toThrow(/columns\[0\]\.header must be an array of strings/);
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
      keep: { terms: ["Species", "Notes"], placeholders: true },
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

// AGT-1851: a rule may be scoped to a JSON key path or a worksheet; when several rules match one
// column the most specific wins, and `blind plan` names every disagreement. Invented values only.
describe("path and sheet scopes, precedence, overlap notes", () => {
  const rule = (r: Partial<Policy["columns"][number]> & Pick<Policy["columns"][number], "treatment">): Policy["columns"][number] => ({ class: r.treatment === "keep" ? "vocabulary" : "unknown", ...r });

  test("parses path and sheet, with or without header, and renders them back", () => {
    const p = parsePolicy(
      withColumns(`
[[columns]]
path = "owner.dob"
treatment = "redact"

[[columns]]
header = "dob"
path = "**.profile.*"
treatment = "blind"
class = "id"

[[columns]]
header = "chip*"
sheet = "Pets*"
treatment = "keep"
`),
    );
    expect(p.columns).toEqual([
      { path: "owner.dob", treatment: "redact", class: "unknown" },
      { header: ["dob"], path: "**.profile.*", treatment: "blind", class: "id" },
      { header: ["chip*"], sheet: "Pets*", treatment: "keep", class: "vocabulary" },
    ]);
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
  });

  test("key segments and path globs: [*] ignored, $ optional, * one key, ** any number", () => {
    expect(keySegments("$.users[*].profile.dob")).toEqual(["users", "profile", "dob"]);
    expect(keySegments('$["visit date"]')).toEqual(["visit date"]);
    expect(keySegments("$.clinics.*.phone")).toEqual(["clinics", "*", "phone"]);
    expect(keySegments("$.clinics.*~")).toBeNull();
    expect(pathGlobSegments("users[*].profile.*")).toEqual(["users", "profile", "*"]);
    expect(pathGlobSegments("$.owner.dob")).toEqual(["owner", "dob"]);
    expect(pathGlobSegments('**["visit date"]')).toEqual(["**", "visit date"]);
    const cp = (path: string) => new ColumnPolicy({ columns: [rule({ path, treatment: "drop" })] });
    const at = (jsonPath: string) => ({ file: "u.json", jsonPath });
    expect(cp("owner.dob").ruleFor(at("$.owner.dob"))).toMatchObject({ treatment: "drop" });
    expect(cp("owner.dob").ruleFor(at("$.pet.dob"))).toBeUndefined();
    expect(cp("owner.dob").ruleFor(at("$.x.owner.dob"))).toBeUndefined();
    expect(cp("users[*].profile.*").ruleFor(at("$.users[*].profile.dob"))).toMatchObject({ treatment: "drop" });
    expect(cp("users.profile.*").ruleFor(at("$.users[*].profile.dob"))).toMatchObject({ treatment: "drop" });
    expect(cp("users[*].profile.*").ruleFor(at("$.users[*].profile.address.city"))).toBeUndefined();
    expect(cp("**.profile.dob").ruleFor(at("$.users[*].profile.dob"))).toMatchObject({ treatment: "drop" });
    expect(cp("**.profile.dob").ruleFor(at("$.profile.dob"))).toMatchObject({ treatment: "drop" });
    expect(cp("**").ruleFor(at("$.a.b.c"))).toMatchObject({ treatment: "drop" });
    expect(cp("Owner.DOB").ruleFor(at("$.owner.dob"))).toMatchObject({ treatment: "drop" });
    // A path rule names JSON keys only; a sheet rule worksheet columns only.
    expect(cp("dob").ruleFor({ file: "v.csv", header: "dob" })).toBeUndefined();
    const sheet = new ColumnPolicy({ columns: [rule({ header: ["dob"], sheet: "Pets", treatment: "keep" })] });
    expect(sheet.ruleFor({ file: "w.xlsx", sheet: "pets", header: "DOB" })).toMatchObject({ treatment: "keep" });
    expect(sheet.ruleFor({ file: "w.xlsx", sheet: "Clients", header: "DOB" })).toBeUndefined();
    expect(sheet.ruleFor({ file: "v.csv", header: "DOB" })).toBeUndefined();
    // Built by hand with neither header nor path (parsePolicy refuses it), a rule matches nothing.
    expect(new ColumnPolicy({ columns: [rule({ treatment: "drop" })] }).ruleFor({ file: "v.csv", header: "x" })).toBeUndefined();
  });

  test("the most specific rule wins, whatever the file order; a full tie goes to the first", () => {
    const cp = new ColumnPolicy({
      columns: [
        rule({ header: ["owner*"], treatment: "blind", class: "person" }),
        rule({ header: ["*msg*"], treatment: "drop" }),
        rule({ header: ["owner_city"], treatment: "blind", class: "location" }),
        rule({ header: ["dob", "msg_opt_in"], treatment: "keep" }),
        rule({ header: ["owner_?ity"], treatment: "redact" }),
        rule({ header: ["*own*"], treatment: "drop" }),
        rule({ path: "owner.*", treatment: "blind", class: "person" }),
        rule({ header: ["ab*"], treatment: "drop" }),
        rule({ header: ["*ab"], treatment: "redact" }),
      ],
    });
    const at = (header: string) => ({ file: "v.csv", header });
    expect(cp.ruleFor(at("owner_city"))).toMatchObject({ treatment: "blind", class: "location" }); // exact over glob
    expect(cp.ruleFor(at("msg_opt_in"))).toMatchObject({ treatment: "keep" }); // exact over glob
    expect(cp.ruleFor(at("owner_name"))).toMatchObject({ treatment: "blind", class: "person" }); // more literal text
    expect(cp.ruleFor(at("ab"))).toMatchObject({ treatment: "drop" }); // full tie: first written
    expect(cp.ruleFor({ file: "u.json", jsonPath: "$.owner.dob" })).toMatchObject({ treatment: "blind", class: "person" }); // scoped over exact
    expect(cp.ruleFor({ file: "u.json", jsonPath: "$.pet.dob" })).toMatchObject({ treatment: "keep" });
    const m = cp.matches(at("owner_city"));
    expect(m.map((x) => x.index)).toEqual([2, 4, 0, 5]);
    expect(rankReason(m[0] as RuleMatch, m[1] as RuleMatch)).toBe("an exact name beats a glob");
    expect(rankReason(m[1] as RuleMatch, m[2] as RuleMatch)).toBe("more literal text beats less");
    expect(rankReason(m[2] as RuleMatch, m[3] as RuleMatch)).toBe("fewer wildcards beat more");
    expect(describeMatch(m[0] as RuleMatch)).toBe('columns[2] (header "owner_city", blind/location)');
  });

  test("a file-scoped rule beats an unscoped one, and a rule's most specific matching header is the one ranked", () => {
    const cp = new ColumnPolicy({
      columns: [
        rule({ header: ["notes"], treatment: "redact" }),
        rule({ header: ["note*"], file: "private/*.csv", treatment: "drop" }),
        rule({ header: ["*", "species"], treatment: "redact" }),
        rule({ header: ["spec*"], treatment: "keep" }),
      ],
    });
    expect(cp.ruleFor({ file: "private/a.csv", header: "Notes" })).toMatchObject({ treatment: "drop" });
    expect(cp.ruleFor({ file: "public/a.csv", header: "Notes" })).toMatchObject({ treatment: "redact" });
    expect(cp.matches({ file: "a.csv", header: "Species" })[0]).toMatchObject({ index: 2, globs: ['header "species"'] });
  });

  const stats: ValueStats = { count: 1, distinctRatio: 1, digitRatio: 0, dictionaryRatio: 0, meanLength: 5, detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0 }, samples: [] };
  const profile: Profile = {
    version: 1,
    sampleCount: 0,
    files: [
      { path: "v.csv", format: "csv", size: 10 },
      { path: "u.json", format: "json", size: 10 },
    ],
    tables: [{ file: "v.csv", headerRow: 1, columns: ["owner_name", "owner_city", "msg_opt_in"].map((header) => ({ header, stats })) }],
    jsonKeys: ["$.owner.name", "$.owner.dob", "$.pet.name", "$.pet.dob"].map((path) => ({ file: "u.json", path, stats })),
    documents: [],
    transcripts: [],
    cooccurrence: [],
  };
  const empty: Spec = { version: 1, columns: [], entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: true }, questions: [] };
  const policy = (columns: Policy["columns"]): Pick<Policy, "columns" | "sensitive" | "keep"> => ({ ...defaultPolicy(), columns });

  test("overlaps that disagree are reported with the winner first; agreeing overlaps are not", () => {
    const r = applyColumnPolicy(
      empty,
      profile,
      policy([rule({ header: ["owner*"], treatment: "blind", class: "person" }), rule({ header: ["*msg*"], treatment: "drop" }), rule({ header: ["owner_city"], treatment: "blind", class: "location" }), rule({ header: ["dob", "msg_opt_in", "owner_name"], treatment: "keep" }), rule({ header: ["owner_n*"], treatment: "keep" })]),
    );
    const byHeader = Object.fromEntries(r.overlaps.map((o) => [o.loc.header ?? o.loc.jsonPath, o]));
    expect(Object.keys(byHeader).sort()).toEqual(["msg_opt_in", "owner_city", "owner_name"]);
    expect(byHeader.msg_opt_in?.matches.map((m) => m.index)).toEqual([3, 1]);
    expect(byHeader.msg_opt_in?.reason).toBe("an exact name beats a glob");
    expect(r.shadowedKeeps).toEqual([]);
    const at = (h: string) => r.spec.columns.find((c) => c.header === h);
    expect(at("owner_city")).toMatchObject({ class: "location", treatment: "blind" });
    expect(at("msg_opt_in")).toMatchObject({ treatment: "keep" });
  });

  test("a keep rule that wins nowhere is reported as shadowed", () => {
    const r = applyColumnPolicy(empty, profile, policy([rule({ header: ["dob"], treatment: "keep" }), rule({ path: "**.dob", treatment: "redact" }), rule({ header: ["absent"], treatment: "keep" })]));
    expect(r.shadowedKeeps).toEqual([{ index: 0, rule: { header: ["dob"], treatment: "keep", class: "vocabulary" }, by: [1], locations: 2 }]);
    // A keep rule beaten only by another keep rule of the same class is not shadowed.
    const same = applyColumnPolicy(empty, profile, policy([rule({ header: ["dob"], treatment: "keep" }), rule({ path: "**.dob", treatment: "keep" })]));
    expect(same.shadowedKeeps).toEqual([]);
    expect(same.overlaps).toEqual([]);
  });

  test("back-compat: rules that never overlap decide exactly what first-match did", () => {
    const columns = [rule({ header: ["owner_name"], treatment: "blind", class: "person" }), rule({ header: ["msg*"], treatment: "drop" }), rule({ header: ["dob"], treatment: "keep" }), rule({ header: ["name"], file: "u.json", treatment: "redact" })];
    const r = applyColumnPolicy(empty, profile, policy(columns));
    expect(r.overlaps).toEqual([]);
    expect(r.shadowedKeeps).toEqual([]);
    expect(r.spec.columns.map((c) => [c.header ?? c.jsonPath, c.treatment, c.class])).toEqual([
      ["owner_name", "blind", "person"],
      ["msg_opt_in", "drop", "unknown"],
      ["$.owner.name", "redact", "unknown"],
      ["$.owner.dob", "keep", "vocabulary"],
      ["$.pet.name", "redact", "unknown"],
      ["$.pet.dob", "keep", "vocabulary"],
    ]);
  });
});

describe("AGT-1851 repro, end to end through blind plan", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-policy-overlap-"));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "v.csv"), "owner_name,owner_city,msg_opt_in\nDana Example,Springfield,yes\n");
    writeFileSync(join(dir, "in", "u.json"), '{"owner":{"name":"Dana Example","dob":"1960-01-02"},"pet":{"name":"Biscuit","dob":"2019-05-06"}}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const REPRO = `[[columns]]
header = ["owner*"]
treatment = "blind"
class = "person"
[[columns]]
header = ["*msg*"]
treatment = "drop"
[[columns]]
header = ["owner_city"]
treatment = "blind"
class = "location"
[[columns]]
header = ["dob", "msg_opt_in"]
treatment = "keep"
`;
  const plan = (extra: string) => {
    const p = defaultPolicy();
    p.privacy.mode = "none";
    writeFileSync(join(dir, "blind.toml"), `${renderPolicy(p)}\n${REPRO}${extra}`);
    const r = blind(dir, "plan", "in");
    expect(r.code).toBe(0);
    const spec = JSON.parse(readFileSync(join(dir, ".blind", "spec.json"), "utf8")) as Spec;
    return { out: r.out, at: (k: string) => spec.columns.find((c) => (c.header ?? c.jsonPath) === k) };
  };

  test("owner_city → location, msg_opt_in kept with a note, owner.dob kept until a path rule scopes it", () => {
    const first = plan("");
    expect(first.at("owner_city")).toMatchObject({ class: "location", treatment: "blind", source: "policy" });
    expect(first.at("msg_opt_in")).toMatchObject({ treatment: "keep" });
    expect(first.at("$.owner.dob")).toMatchObject({ treatment: "keep" });
    expect(first.out).toContain(
      'note: "v.csv" "msg_opt_in": 2 blind.toml rules match: columns[3] (header "msg_opt_in", keep/vocabulary); columns[1] (header "*msg*", drop/unknown); columns[3] wins (an exact name beats a glob)',
    );
    expect(first.out).toContain('columns[2] (header "owner_city", blind/location); columns[0] (header "owner*", blind/person); columns[2] wins');
    // Never a cell value in the notes.
    const notes = first.out.split("\n").filter((l) => l.startsWith("note:") || l.startsWith("warning:"));
    for (const v of ["Dana", "Springfield", "1960", "Biscuit", "yes"]) expect(notes.join("\n")).not.toContain(v);

    const second = plan('[[columns]]\npath = "owner.*"\ntreatment = "blind"\nclass = "person"\n');
    expect(second.at("$.owner.dob")).toMatchObject({ treatment: "blind", class: "person" });
    expect(second.at("$.pet.dob")).toMatchObject({ treatment: "keep" });
    expect(second.out).toContain('columns[4] (path "owner.*", blind/person); columns[3] (header "dob", keep/vocabulary); columns[4] wins (a rule scoped by path, sheet or file beats an unscoped one)');
  });

  test("a keep rule shadowed everywhere gets a warning", () => {
    const r = plan('[[columns]]\npath = "**.dob"\ntreatment = "redact"\n[[columns]]\nheader = "msg_opt_in"\nfile = "*.csv"\ntreatment = "drop"\n');
    expect(r.out).toContain('warning: blind.toml columns[3] (header "dob", header "msg_opt_in", keep) decides nothing: at all 3 column(s) and key(s) it matches, columns[4], columns[5] wins instead');
  });
});
