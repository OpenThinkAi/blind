// AGT-2735 / AGT-2787 (blind-sdk D-28): two name shapes a staff and jobs export can have, with
// `blind plan --no-model` defaults:
//
// - A: a staff list with first and last name in separate columns (staff.csv) next to the full name
//   in another file (payroll.csv `employee`). The plan proposes the pair as one person (`joinWith`);
//   each cell gets its part of the person's full-name stand-in, so `first + " " + last` is exactly the
//   stand-in payroll writes for that person.
// - B: one cell holding several workers (jobs.csv `workers`, "A; B" in some rows and "A, B" in
//   others) next to the same people one per cell in payroll.csv. A ";" cell is written one stand-in
//   per person, separator kept; a "," cell is never split, and the plan asks the reviewer about it.
//
// Reveal restores every cell exactly. pm project blind-sdk, doc `name-shapes`, records the design.
//
// Synthetic data only: the fixture names are invented (common given names, made-up surnames).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runPlan } from "../src/analyst/plan.ts";
import { runApply } from "../src/apply.ts";
import { runAudit } from "../src/audit/command.ts";
import { runReveal } from "../src/reveal.ts";
import { canonicalize } from "../src/engine/canonical.ts";
import { parseCsv } from "../src/engine/csv.ts";
import { type BlindMap, parseMap } from "../src/engine/map.ts";
import { commaNames, peopleSegments, splitPeople } from "../src/engine/people.ts";
import { splitStandIn } from "../src/engine/pseudonym.ts";
import { applySpec, explainProposal, profileInputs, revealFile, Revealer, serializeMap } from "../src/lib.ts";
import { defaultPolicy, renderPolicy } from "../src/policy.ts";
import type { Profile, Spec } from "../src/schema.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "name-shapes");
const FILES = ["staff.csv", "payroll.csv", "jobs.csv"] as const;
const PEOPLE = ["Nora Teasdale", "Owen Brandvik", "Iris Halloway", "Hugo Okonkwo-Lund"];
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 27);

const sink = () => {
  const s = new PassThrough();
  let text = "";
  s.on("data", (d) => (text += d));
  return { s, text: () => text };
};

let dir: string;
let spec: Spec;
let map: BlindMap;
let planReport: string;
let applyReport: string;
/** Output rows of each file, header row first, as plain cell values. */
const rows: Record<string, string[][]> = {};
/** Input rows, same shape, for lining output cells up with what they replaced. */
const inputs: Record<string, string[][]> = {};

const table = (text: string): string[][] => parseCsv(text, ",").map((r) => r.cells.map((c) => c.value)).filter((r) => r.some((v) => v !== ""));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "blind-name-shapes-"));
  cpSync(FIXTURE, join(dir, "in"), { recursive: true });
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(SALT), { mode: 0o600 });
  writeFileSync(join(dir, "blind.toml"), renderPolicy(defaultPolicy()));

  const p = sink();
  expect(await runPlan(["in", "--no-model"], { out: p.s, err: p.s, cwd: dir, model: { env: {} } })).toBe(0);
  planReport = p.text();
  spec = JSON.parse(readFileSync(join(dir, ".blind", "spec.json"), "utf8")) as Spec;

  const a = sink();
  expect(await runApply(["in", "-o", "out"], { out: a.s, err: a.s, cwd: dir })).toBe(0);
  applyReport = a.text();
  map = JSON.parse(readFileSync(join(dir, ".blind", "map.json"), "utf8")) as BlindMap;
  for (const f of FILES) {
    rows[f] = table(readFileSync(join(dir, "out", f), "utf8"));
    inputs[f] = table(readFileSync(join(FIXTURE, f), "utf8"));
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The output cell of `file` whose input row has `value` in column `keyCol`, in column `col`. */
function cell(file: string, keyCol: string, value: string, col: string): string {
  const header = inputs[file]?.[0] ?? [];
  const k = header.indexOf(keyCol);
  const c = header.indexOf(col);
  const r = (inputs[file] ?? []).findIndex((row, i) => i > 0 && row[k] === value);
  expect(r).toBeGreaterThan(0);
  return rows[file]?.[r]?.[c] as string;
}

/** The map entry for (kind, value as written), or undefined. */
const entry = (kind: string, value: string) => map.entries.find((e) => e.kind === kind && e.value === value);

describe("the proposal", () => {
  test("plan --no-model proposes the first/last pair as one person and asks about the comma column", () => {
    const rule = (file: string, header: string) => spec.columns.find((c) => c.file === file && c.header === header);
    expect(rule("staff.csv", "first_name")).toMatchObject({ class: "person", treatment: "blind", joinWith: "last_name", source: "heuristic" });
    expect(rule("staff.csv", "last_name")).toMatchObject({ class: "person", treatment: "blind", source: "heuristic" });
    expect(rule("staff.csv", "last_name")?.joinWith).toBeUndefined();
    // Everything else is as before: unknown, decided at apply time.
    for (const c of spec.columns.filter((c) => c.file !== "staff.csv" || c.header === "role")) expect(c).toMatchObject({ class: "unknown", treatment: "value", source: "heuristic" });
    // The "A B, C D" cells are a question for the reviewer, never a silent choice.
    expect(spec.questions).toHaveLength(1);
    expect(spec.questions[0]).toMatchObject({ id: "names-1", options: ["person", "value"], answer: null, about: { file: "jobs.csv", header: "workers" } });
    expect(planReport).toContain("joinWith");
    expect(planReport).toContain("question names-1");
    expect(spec.entities).toEqual({});
  });

  test("the library proposal says the same, with reasons", () => {
    const profile = profileInputs(FILES.map((f) => ({ path: f, bytes: new Uint8Array(readFileSync(join(FIXTURE, f))) }))).profile;
    const proposal = explainProposal(profile, {});
    expect(proposal.spec.columns.find((c) => c.header === "first_name")?.joinWith).toBe("last_name");
    expect(proposal.spec.questions.map((q) => q.about?.header)).toEqual(["workers"]);
    expect(proposal.columns.find((c) => c.header === "first_name")?.reason).toContain("joinWith");
    expect(proposal.columns.find((c) => c.header === "workers")?.reason).toContain("question names-1");
    // A person-free policy proposes no pair.
    expect(explainProposal(profile, { sensitive: { classes: ["email"] } }).spec.columns.some((c) => c.joinWith !== undefined)).toBe(false);
  });

  test("no real name, first name or surname survives in any output file or report", () => {
    for (const f of FILES) {
      const text = readFileSync(join(dir, "out", f), "utf8");
      for (const w of PEOPLE.flatMap((p) => p.split(" "))) expect(text).not.toContain(w);
    }
    for (const w of PEOPLE.flatMap((p) => p.split(" "))) {
      expect(planReport).not.toContain(w);
      expect(applyReport).not.toContain(w);
    }
  });

  test("the audit finds no leak", async () => {
    const o = sink();
    expect(await runAudit(["out", "--no-model", "--json"], { out: o.s, err: o.s, cwd: dir })).not.toBe(2);
    const report = JSON.parse(o.text()) as { status: string };
    expect(report.status).not.toBe("leak");
  });
});

describe("shape A: first and last name in separate columns vs the full name in payroll", () => {
  test("first + ' ' + last is exactly the person's stand-in in payroll", () => {
    for (const person of PEOPLE) {
      const [first, last] = person.split(" ") as [string, string];
      const firstOut = cell("staff.csv", "first_name", first, "first_name");
      const lastOut = cell("staff.csv", "first_name", first, "last_name");
      const fullOut = cell("payroll.csv", "employee", person, "employee");
      expect(`${firstOut} ${lastOut}`).toBe(fullOut);
      expect(fullOut).toBe(entry("person", person)?.pseudonym as string);
      expect(splitStandIn(fullOut)).toEqual({ given: firstOut, family: lastOut, joiner: " " });
      // The map records how the person was split, under the person's own stand-in.
      expect(entry("person-given", first)?.pseudonym).toBe(fullOut);
      expect(entry("person-family", last)?.pseudonym).toBe(fullOut);
      // The given name and surname are never person or value entries of their own.
      for (const k of ["person", "value"]) {
        expect(entry(k, first)).toBeUndefined();
        expect(entry(k, last)).toBeUndefined();
      }
    }
    expect(applyReport).toMatch(/fi\*+10: person\/blind → .*4 cells changed/);
    expect(applyReport).toContain("(joinWith)");
  });
});

describe("shape B: several workers in one cell vs each worker in payroll", () => {
  test("people cells split on ';' and line breaks too, never on ',' or '/'", () => {
    expect(splitPeople("Nora Teasdale; Owen Brandvik")).toEqual(["Nora Teasdale", "Owen Brandvik"]);
    expect(splitPeople("Nora Teasdale\nOwen Brandvik")).toEqual(["Nora Teasdale", "Owen Brandvik"]);
    expect(splitPeople("Iris Halloway, Hugo Okonkwo-Lund")).toBeNull();
    expect(splitPeople("Nora Teasdale & Owen Brandvik")).toEqual(["Nora Teasdale", "Owen Brandvik"]);
    expect(peopleSegments("Nora Teasdale;  Owen Brandvik\r\nIris Halloway")).toEqual({ names: ["Nora Teasdale", "Owen Brandvik", "Iris Halloway"], around: ["", ";  ", "\r\n", ""] });
    expect(peopleSegments("Main / Room 1")).toBeNull();
    expect(peopleSegments("Owen Bellamy, PT")).toBeNull();
    // A borrowed surname keeps the cell whole, so reveal restores it exactly.
    expect(peopleSegments("Dana & Lee Quillfeather")).toBeNull();
    expect(commaNames("Iris Halloway, Hugo Okonkwo-Lund")).toBe(true);
    expect(commaNames("Halloway, Iris")).toBe(false);
    expect(commaNames("Owen Bellamy, PT")).toBe(false);
  });

  test("a ';' cell is one stand-in per worker, each the worker's payroll stand-in, separator kept", () => {
    for (const [job, a, b] of [["J-101", "Nora Teasdale", "Owen Brandvik"], ["J-103", "Owen Brandvik", "Iris Halloway"]] as const) {
      const out = cell("jobs.csv", "job_id", job, "workers");
      expect(out).toBe(`${cell("payroll.csv", "employee", a, "employee")}; ${cell("payroll.csv", "employee", b, "employee")}`);
      expect(entry("person", `${a}; ${b}`)).toBeUndefined();
    }
    expect(applyReport).toContain("2 cells name several people");
  });

  test("a ',' cell is still read as ONE reversed name, and the apply report warns about it", () => {
    for (const [job, a, b] of [["J-102", "Iris Halloway", "Hugo Okonkwo-Lund"], ["J-104", "Nora Teasdale", "Hugo Okonkwo-Lund"]] as const) {
      const out = cell("jobs.csv", "job_id", job, "workers");
      const whole = entry("person", `${a}, ${b}`);
      expect(whole?.canonical).toBe(`${b} ${a}`.toLowerCase());
      expect(canonicalize("person", `${a}, ${b}`)).toBe(`${b} ${a}`.toLowerCase());
      expect(out).toBe(whole?.pseudonym as string);
    }
    expect(applyReport).toMatch(/warning: 2 cells have a full name on each side of a comma/);
  });

  test("control: a cell with one worker, written exactly as in payroll, gets the same stand-in in both files", () => {
    const jobs = cell("jobs.csv", "job_id", "J-105", "workers");
    expect(jobs).toBe(cell("payroll.csv", "employee", "Owen Brandvik", "employee"));
    expect(jobs).toMatch(/^\[Workers [A-Z]+ #[0-9A-F]{4}\]$/);
  });
});

describe("reveal", () => {
  test("blind reveal restores every file byte for byte, separators and split names included", async () => {
    const o = sink();
    expect(await runReveal(["out", "-o", "back"], { out: o.s, err: o.s, cwd: dir })).toBe(0);
    for (const f of FILES) expect(readFileSync(join(dir, "back", f), "utf8")).toBe(readFileSync(join(FIXTURE, f), "utf8"));
  });

  for (const style of ["letters", "readable", "compact"] as const) {
    test(`library, ${style} style: the pair joins to the full name and every cell reveals exactly`, () => {
      const files = FILES.map((f) => ({ path: f, bytes: new Uint8Array(readFileSync(join(FIXTURE, f))) }));
      const r = applySpec(files, spec, { salt: SALT, policy: { pseudonyms: { style } } });
      const out = Object.fromEntries(r.outputs.map((o) => [o.path, table(new TextDecoder().decode(o.bytes))]));
      const joiner = style === "compact" ? "_" : " ";
      for (const [i, person] of PEOPLE.entries()) {
        const staff = out["staff.csv"]?.[i + 1] as string[];
        expect(`${staff[0]}${joiner}${staff[1]}`).toBe(out["payroll.csv"]?.[i + 1]?.[0] as string);
      }
      const rv = new Revealer(parseMap(serializeMap(r.map)));
      for (const o of r.outputs) {
        const back = revealFile(o.path, o.bytes, rv);
        expect("bytes" in back ? new TextDecoder().decode(back.bytes) : "").toBe(readFileSync(join(FIXTURE, o.path), "utf8"));
      }
    });
  }
});

describe("the joinWith rule", () => {
  const files = () => FILES.map((f) => ({ path: f, bytes: new Uint8Array(readFileSync(join(FIXTURE, f))) }));
  const base = (columns: unknown[]): Spec => ({ version: 1, columns, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [] }) as Spec;
  const col = (header: string, extra: Record<string, unknown> = {}) => ({ file: "staff.csv", header, class: "person", treatment: "blind", confidence: 1, source: "human", ...extra });

  test("a policy rule's joinWith (blind.toml join_with) reaches the spec through the library", () => {
    const profile = profileInputs(files()).profile;
    const proposal = explainProposal(profile, { columns: [{ header: "first_name", treatment: "blind", class: "person", joinWith: "Last Name" }] });
    expect(proposal.spec.columns.find((c) => c.header === "first_name")).toMatchObject({ source: "policy", joinWith: "last_name" });
    expect(() => explainProposal(profile, { columns: [{ header: "first_name", treatment: "keep", joinWith: "last_name" }] })).toThrow(/joinWith pairs/);
    const unpaired = explainProposal(profile, { columns: [{ header: "first_name", treatment: "blind", class: "person", joinWith: "maiden_name" }] });
    expect(unpaired.spec.columns.find((c) => c.header === "first_name")?.joinWith).toBeUndefined();
    expect(unpaired.columns.find((c) => c.header === "first_name")?.reason).toContain("join_with matched no other header");
  });

  test("blind.toml join_with parses and renders", async () => {
    const { parsePolicy } = await import("../src/policy.ts");
    const p = parsePolicy(`${renderPolicy(defaultPolicy())}\n[[columns]]\nheader = "first_name"\ntreatment = "blind"\nclass = "person"\njoin_with = "last_name"\n`);
    expect(p.columns[0]?.joinWith).toBe("last_name");
    expect(renderPolicy(p)).toContain('join_with = "last_name"');
  });

  test("an explicit rule is honoured, and a bad one is refused", async () => {
    const { validateSpec } = await import("../src/validate.ts");
    const { ApplyError } = await import("../src/engine/apply.ts");
    expect(validateSpec(base([col("first_name", { joinWith: "last_name" }), col("last_name")])).ok).toBe(true);
    expect(validateSpec(base([col("first_name", { joinWith: "first_name" })])).ok).toBe(false);
    expect(validateSpec(base([col("first_name", { joinWith: "last_name", class: "org" })])).ok).toBe(false);
    expect(validateSpec(base([col("first_name", { joinWith: "last_name" }), col("last_name", { treatment: "keep", class: "vocabulary" })])).ok).toBe(false);
    expect(() => applySpec(files(), base([col("first_name", { joinWith: "surname" })]), { salt: SALT })).toThrow(ApplyError);
    // Only the given-name rule is needed: the surname column follows the pair.
    const r = applySpec(files(), base([col("first_name", { joinWith: "last_name" })]), { salt: SALT, policy: { pseudonyms: { style: "letters" } } });
    const staff = table(new TextDecoder().decode(r.outputs.find((o) => o.path === "staff.csv")?.bytes));
    const payroll = table(new TextDecoder().decode(r.outputs.find((o) => o.path === "payroll.csv")?.bytes));
    expect(`${staff[1]?.[0]} ${staff[1]?.[1]}`).toBe(payroll[1]?.[0] as string);
    expect(payroll[1]?.[0]).toMatch(/^[A-Za-z ]+ [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
  });

  test("a row with only one half blinds that cell whole; reveal restores it", () => {
    const csv = "first_name,last_name\nNora,Teasdale\n Owen ,\n";
    const input = [{ path: "staff.csv", bytes: new TextEncoder().encode(csv) }];
    const r = applySpec(input, base([col("first_name", { joinWith: "last_name" })]), { salt: SALT, policy: { pseudonyms: { style: "readable" } } });
    const out = new TextDecoder().decode(r.outputs[0]?.bytes);
    expect(out).not.toContain("Owen");
    expect(out).not.toContain("Teasdale");
    const back = revealFile("staff.csv", r.outputs[0]?.bytes as Uint8Array, new Revealer(r.map));
    expect(new TextDecoder().decode(back.bytes)).toBe(csv);
  });

  test("the map: a name part must reuse an entry's pseudonym", () => {
    const ok = { version: 1, entries: [
      { kind: "person", canonical: "nora teasdale", value: "Nora Teasdale", pseudonym: "Staff QSPPW" },
      { kind: "person-given", canonical: "nora teasdale", value: "Nora", pseudonym: "Staff QSPPW" },
      { kind: "person-family", canonical: "nora teasdale", value: "Teasdale", pseudonym: "Staff QSPPW" },
    ] };
    expect(parseMap(JSON.stringify(ok)).entries).toHaveLength(3);
    expect(() => parseMap(JSON.stringify({ ...ok, entries: ok.entries.slice(1) }))).toThrow(/reuse the pseudonym/);
  });
});

describe("detecting the shapes (nameshapes.ts)", () => {
  test("nameHalf reads given-name and surname headers, and nothing else", async () => {
    const { nameHalf } = await import("../src/analyst/nameshapes.ts");
    const cases: [string, ReturnType<typeof nameHalf>][] = [
      ["first_name", { half: "given", rest: "" }],
      ["Last Name", { half: "family", rest: "" }],
      ["Given", { half: "given", rest: "" }],
      ["Surname", { half: "family", rest: "" }],
      ["emp_fname", { half: "given", rest: "emp" }],
      ["emp_lname", { half: "family", rest: "emp" }],
      ["EmployeeFirstName", { half: "given", rest: "employee" }],
      ["Forename", { half: "given", rest: "" }],
      ["First", { half: "given", rest: "" }],
      ["first_seen", undefined],
      ["last_seen", undefined],
      ["last visit", undefined],
      ["first last name", undefined],
      ["name", undefined],
      ["employee", undefined],
    ];
    for (const [header, want] of cases) expect([header, nameHalf(header)]).toEqual([header, want]);
  });

  const stats = (samples: string[] = []) => ({ count: 4, distinctRatio: 1, digitRatio: 0, dictionaryRatio: 0, meanLength: 6, detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0 }, samples });
  const profileOf = (headers: string[], samples: Record<string, string[]> = {}): Profile => ({
    version: 1, sampleCount: 5, files: [{ path: "s.csv", format: "csv", size: 1 }], jsonKeys: [], documents: [], transcripts: [], cooccurrence: [],
    tables: [{ file: "s.csv", headerRow: 1, columns: headers.map((header) => ({ header, stats: stats(samples[header]) })) }],
  });
  const undecidedSpec = (headers: string[], over: Record<string, Partial<Spec["columns"][number]>> = {}): Spec => ({
    version: 1, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [],
    columns: headers.map((header) => ({ file: "s.csv", header, class: "unknown", treatment: "value", confidence: 0, source: "heuristic", ...over[header] }) as Spec["columns"][number]),
  });
  const people = { sensitive: { classes: ["person"] } } as never;

  test("proposeNameShapes pairs only an unambiguous pair, never over a human rule", async () => {
    const { proposeNameShapes } = await import("../src/analyst/nameshapes.ts");
    const joined = (headers: string[], over = {}) => proposeNameShapes(undecidedSpec(headers, over), profileOf(headers), people).spec.columns.filter((c) => c.joinWith !== undefined).map((c) => [c.header, c.joinWith]);
    expect(joined(["first_name", "last_name", "role"])).toEqual([["first_name", "last_name"]]);
    expect(joined(["billing_first_name", "shipping_last_name"])).toEqual([]);
    expect(joined(["first_name", "given_name", "last_name"])).toEqual([]);
    expect(joined(["first_seen", "last_seen"])).toEqual([]);
    expect(joined(["first_name", "last_name"], { first_name: { source: "human" } })).toEqual([]);
    expect(joined(["first_name", "last_name"], { last_name: { class: "vocabulary", treatment: "keep", source: "policy" } })).toEqual([]);
    expect(proposeNameShapes(undecidedSpec(["first_name", "last_name"]), profileOf(["first_name", "last_name"]), { sensitive: { classes: ["email"] } } as never).notes).toEqual([]);
  });

  test("proposeNameShapes asks about full names around a comma, once per column", async () => {
    const { proposeNameShapes } = await import("../src/analyst/nameshapes.ts");
    const headers = ["workers", "credentialed"];
    const profile = profileOf(headers, { workers: ["Iris Halloway, Hugo Okonkwo-Lund"], credentialed: ["Owen Bellamy, PT", "Halloway, Iris"] });
    const first = proposeNameShapes(undecidedSpec(headers), profile, people).spec;
    expect(first.questions.map((q) => [q.id, q.about?.header])).toEqual([["names-1", "workers"]]);
    expect(proposeNameShapes(first, profile, people).spec.questions).toHaveLength(1);
  });
});

describe("worksheets and the map", () => {
  test("a joinWith on a worksheet column is refused; person cells there still split and count", async () => {
    const { buildWorkbook } = await import("./formats/xlsxfixture.ts");
    const { ApplyError } = await import("../src/engine/apply.ts");
    const rows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Workers</t></is></c><c r="B1" t="inlineStr"><is><t>Last</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Nora Teasdale; Owen Brandvik</t></is></c><c r="B2" t="inlineStr"><is><t>Teasdale</t></is></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Iris Halloway, Hugo Okonkwo-Lund</t></is></c><c r="B3" t="inlineStr"><is><t>Halloway</t></is></c></row>';
    const book = [{ path: "book.xlsx", bytes: buildWorkbook({ staffRows: rows }) }];
    const rule = (extra: Record<string, unknown>) => ({ version: 1, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [], columns: [{ file: "book.xlsx", sheet: "Staff", header: "Workers", class: "person", treatment: "blind", confidence: 1, source: "human", ...extra }] }) as Spec;
    expect(() => applySpec(book, rule({ joinWith: "Last" }), { salt: SALT })).toThrow(ApplyError);
    const r = applySpec(book, rule({}), { salt: SALT });
    const col = r.files[0]?.columns.find((c) => c.header === "Workers");
    expect(col).toMatchObject({ people: 1, commaNames: 1 });
  });

  test("withoutValues drops a person's name parts with the person, and the map still parses", async () => {
    const { withoutValues } = await import("../src/engine/map.ts");
    const m = parseMap(JSON.stringify({ version: 1, entries: [
      { kind: "person", canonical: "nora teasdale", value: "Nora Teasdale", pseudonym: "Staff QSPPW" },
      { kind: "person-given", canonical: "nora teasdale", value: "Nora", pseudonym: "Staff QSPPW" },
      { kind: "person-family", canonical: "nora teasdale", value: "Teasdale", pseudonym: "Staff QSPPW" },
      { kind: "person", canonical: "owen brandvik", value: "Owen Brandvik", pseudonym: "Staff KQZTB" },
    ] }));
    const pruned = withoutValues(m, ["Nora Teasdale"]);
    expect(pruned.dropped).toBe(3);
    expect(pruned.map.entries.map((e) => e.kind)).toEqual(["person"]);
    expect(parseMap(serializeMap(pruned.map)).entries).toHaveLength(1);
  });
});
