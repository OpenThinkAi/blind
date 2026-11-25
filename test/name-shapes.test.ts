// AGT-2735 (blind-sdk D-28): pins what blind does TODAY, with `blind plan --no-model` defaults, for
// two name shapes a staff and jobs export can have:
//
// - A: a staff list with first and last name in separate columns (staff.csv) next to the full name
//   in another file (payroll.csv `employee`).
// - B: one cell holding several workers (jobs.csv `workers`, "A; B" in some rows and "A, B" in
//   others) next to the same people one per cell in payroll.csv.
//
// The assertions state current behaviour, not desired behaviour: no engine change is made here, and
// any fix is planned after these results (pm project blind-sdk, doc `name-shapes`). If engine work
// changes one of these on purpose, update the assertion and that doc together.
//
// Synthetic data only: the fixture names are invented (common given names, made-up surnames).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runPlan } from "../src/analyst/plan.ts";
import { runApply } from "../src/apply.ts";
import { canonicalize } from "../src/engine/canonical.ts";
import { parseCsv } from "../src/engine/csv.ts";
import type { BlindMap } from "../src/engine/map.ts";
import { splitPeople } from "../src/engine/people.ts";
import { isPersonColumn } from "../src/engine/prose.ts";
import { defaultPolicy, renderPolicy } from "../src/policy.ts";
import type { Spec } from "../src/schema.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "name-shapes");
const FILES = ["staff.csv", "payroll.csv", "jobs.csv"] as const;
const PEOPLE = ["Nora Teasdale", "Owen Brandvik", "Iris Halloway", "Hugo Okonkwo-Lund"];

const sink = () => {
  const s = new PassThrough();
  let text = "";
  s.on("data", (d) => (text += d));
  return { s, text: () => text };
};

let dir: string;
let spec: Spec;
let map: BlindMap;
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
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 27)), { mode: 0o600 });
  writeFileSync(join(dir, "blind.toml"), renderPolicy(defaultPolicy()));

  const p = sink();
  expect(await runPlan(["in", "--no-model"], { out: p.s, err: p.s, cwd: dir, model: { env: {} } })).toBe(0);
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
/** The four-hex tag of a readable stand-in ("[Employee C #CA35]" gives "CA35"). */
const tag = (p: string): string | undefined => /#([0-9A-F]{4})\]$/.exec(p)?.[1];

describe("the fixture and the defaults it runs under", () => {
  test("plan --no-model leaves every column unknown/value: nothing is classed person before apply", () => {
    expect(spec.columns).toHaveLength(9);
    for (const c of spec.columns) expect(c).toMatchObject({ class: "unknown", treatment: "value", source: "heuristic" });
    expect(spec.entities).toEqual({});
  });

  test("at apply time the full-name columns are read as people, the split name columns as plain values", () => {
    // columns.ts decide(): an identifier-like unknown column is `person` when prose.ts isPersonColumn holds.
    expect(applyReport).toMatch(/em\*+8: unknown → pseudonymised as people \(names\)/);
    expect(applyReport).toMatch(/wo\*+7: unknown → pseudonymised as people \(names\)/);
    expect(applyReport).toMatch(/fi\*+10: unknown → pseudonymised, 4 cells changed/);
    expect(applyReport).toMatch(/la\*+9: unknown → pseudonymised, 4 cells changed/);
    // A single word is never a person's name to isPersonColumn (two to four words are needed).
    expect(isPersonColumn(["Nora", "Owen", "Iris", "Hugo"])).toBe(false);
    expect(isPersonColumn(PEOPLE)).toBe(true);
  });

  test("no real name, first name or surname survives in any output file", () => {
    for (const f of FILES) {
      const text = readFileSync(join(dir, "out", f), "utf8");
      for (const w of PEOPLE.flatMap((p) => p.split(" "))) expect(text).not.toContain(w);
    }
  });
});

describe("shape A: first and last name in separate columns vs the full name in payroll", () => {
  test("one person gets three unrelated stand-ins: one for the first name, one for the surname, one for the full name", () => {
    for (const person of PEOPLE) {
      const [first, last] = person.split(" ") as [string, string];
      const firstOut = cell("staff.csv", "first_name", first, "first_name");
      const lastOut = cell("staff.csv", "first_name", first, "last_name");
      const fullOut = cell("payroll.csv", "employee", person, "employee");

      // Each split cell is its own `value` entry; the full name is a `person` entry.
      expect(firstOut).toBe(entry("value", first)?.pseudonym as string);
      expect(lastOut).toBe(entry("value", last)?.pseudonym as string);
      expect(fullOut).toBe(entry("person", person)?.pseudonym as string);

      // Nothing ties them: three different stand-ins with three different tags.
      expect(new Set([firstOut, lastOut, fullOut]).size).toBe(3);
      expect(new Set([tag(firstOut), tag(lastOut), tag(fullOut)]).size).toBe(3);
      expect(firstOut).toMatch(/^\[First Name [A-Z]+ #[0-9A-F]{4}\]$/);
      expect(lastOut).toMatch(/^\[Last Name [A-Z]+ #[0-9A-F]{4}\]$/);

      // The given name and surname are never person entries of their own.
      expect(entry("person", first)).toBeUndefined();
      expect(entry("person", last)).toBeUndefined();
    }
  });
});

describe("shape B: several workers in one cell vs each worker in payroll", () => {
  test("splitPeople splits neither separator: only '&', '+' and ' and ' make a cell several people", () => {
    expect(splitPeople("Nora Teasdale; Owen Brandvik")).toBeNull();
    expect(splitPeople("Iris Halloway, Hugo Okonkwo-Lund")).toBeNull();
    expect(splitPeople("Nora Teasdale & Owen Brandvik")).toEqual(["Nora Teasdale", "Owen Brandvik"]);
  });

  test("a ';' cell is one person entry for the whole cell, matching neither worker's payroll stand-in", () => {
    for (const [job, a, b] of [["J-101", "Nora Teasdale", "Owen Brandvik"], ["J-103", "Owen Brandvik", "Iris Halloway"]] as const) {
      const out = cell("jobs.csv", "job_id", job, "workers");
      const whole = entry("person", `${a}; ${b}`);
      expect(whole?.canonical).toBe(`${a}; ${b}`.toLowerCase());
      expect(out).toBe(whole?.pseudonym as string);
      for (const w of [a, b]) {
        const payroll = cell("payroll.csv", "employee", w, "employee");
        expect(out).not.toContain(payroll);
        expect(tag(out)).not.toBe(tag(payroll));
      }
    }
  });

  test("a ',' cell is read as ONE reversed name ('Surname, Given'), matching neither worker's payroll stand-in", () => {
    for (const [job, a, b] of [["J-102", "Iris Halloway", "Hugo Okonkwo-Lund"], ["J-104", "Nora Teasdale", "Hugo Okonkwo-Lund"]] as const) {
      const out = cell("jobs.csv", "job_id", job, "workers");
      const whole = entry("person", `${a}, ${b}`);
      // canonical.ts reads "X Y, Z W" as surname "X Y", given "Z W": one person called "Z W X Y".
      expect(whole?.canonical).toBe(`${b} ${a}`.toLowerCase());
      expect(canonicalize("person", `${a}, ${b}`)).toBe(`${b} ${a}`.toLowerCase());
      expect(out).toBe(whole?.pseudonym as string);
      for (const w of [a, b]) {
        const payroll = cell("payroll.csv", "employee", w, "employee");
        expect(out).not.toContain(payroll);
        expect(tag(out)).not.toBe(tag(payroll));
      }
    }
  });

  test("control: a cell with one worker, written exactly as in payroll, gets the same stand-in in both files", () => {
    const jobs = cell("jobs.csv", "job_id", "J-105", "workers");
    const payroll = cell("payroll.csv", "employee", "Owen Brandvik", "employee");
    expect(jobs).toBe(payroll);
    expect(jobs).toBe(entry("person", "Owen Brandvik")?.pseudonym as string);
    // The readable label comes from the first file that asks for the person (jobs.csv sorts first).
    expect(jobs).toMatch(/^\[Workers [A-Z]+ #[0-9A-F]{4}\]$/);
  });
});
