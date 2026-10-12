import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTree } from "../../src/audit/command.ts";
import { OracleMatcher, parseOracle, scanLeaks } from "../../src/bench/score.ts";
import { DEFAULT_SEED, generateKit, writeKit } from "../../src/bench/synth.ts";
import { parseSpec } from "../../src/validate.ts";

// AGT-1828: `blind run --accept-leaks` closes the audit loop with no human and no model. Bench
// case on synthetic kit v2 under privacy.mode = "none" and the heuristic analyst, plus one
// invented fixture that leaks on the first round: a site column whose values are all dictionary
// words, so the column pass pseudonymises them but the recurrence pass leaves them in prose, and
// the audit calls each a leak (a value from the map survives).

const BIN = join(import.meta.dir, "../../bin/blind.js");

function blind(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

const SITES = ["Main Office", "Blue House", "Old School", "New Building", "Back Garden"];

/** Invented: site names made only of dictionary words, cited again in a note. */
function addLeakyFixture(input: string): void {
  mkdirSync(join(input, "sites"));
  const codes = ["K7Q2X9", "M3T8V1", "P9W4R6", "B2N7J5", "H6D1L3"];
  writeFileSync(join(input, "sites", "sites.csv"), `Site,Code\n${SITES.map((s, i) => `${s},${codes[i]}`).join("\n")}\n`);
  writeFileSync(join(input, "sites", "visits.txt"), `Visited ${SITES[0]} and ${SITES[1]} on Monday.\n${SITES[2]} next week.\n`);
}

const statuses = (out: string): string[] => [...out.matchAll(/^status: (\w+) \(\d+ files?; (\d+) leaks?/gm)].map((m) => `${m[1]}:${m[2]}`);

describe("blind run --accept-leaks on synthetic kit v2 (no model)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-accept-leaks-"));
    writeKit(dir, generateKit(DEFAULT_SEED, { version: 2 }));
    expect(blind(dir, "init", "--defaults").code).toBe(0);
    const toml = join(dir, "blind.toml");
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/^mode = .*$/m, 'mode = "none"'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("the kit as generated: one round, no leak, nothing accepted", () => {
    const r = blind(dir, "run", "input", "-o", "out", "--yes", "--accept-leaks");
    expect(statuses(r.out)).toEqual(["candidates:0"]);
    expect(r.out).not.toContain("--accept-leaks: round");
    expect(r.code).toBe(1);
  });

  test("with a fixture that leaks: without the flag the run ends on the leak; with it, 0 leaks in 2 rounds", () => {
    addLeakyFixture(join(dir, "input"));
    const plain = blind(dir, "run", "input", "-o", "out0", "--yes");
    expect(plain.code).toBe(2);
    expect(statuses(plain.out)).toEqual(["leak:3"]);

    const r = blind(dir, "run", "input", "-o", "out", "--yes", "--accept-leaks");
    expect(statuses(r.out)).toEqual(["leak:3", "candidates:0"]);
    expect(r.out).toContain("--accept-leaks: round 1 left leaks");
    expect(r.code).toBe(1);

    // Each leak is a human-sourced entity now, at the fallback class: a map value suggests none.
    const spec = parseSpec(readFileSync(join(dir, ".blind", "spec.json"), "utf8"));
    expect((spec.entities.id ?? []).filter((e) => e.source === "human").map((e) => e.canonical).sort()).toEqual(SITES.slice(0, 3).sort());
    // Semantic candidates stay the human's: nothing went to the vocabulary.
    expect((spec.entities.vocabulary ?? []).filter((e) => e.source === "human")).toEqual([]);

    // Not only the audit's word for it: no site name survives anywhere in the output. (Kit v2's
    // own people and organisations are another matter under the heuristic analyst: the audit
    // raises them as candidates, which --accept-leaks leaves to a human.)
    const oracle = parseOracle(JSON.stringify({ values: SITES.map((value) => ({ value, class: "location" })), decoys: [] }));
    const { leaks, unscored } = scanLeaks(collectTree(join(dir, "out")), new OracleMatcher(oracle));
    expect(leaks).toEqual([]);
    expect(unscored).toEqual([]);
    expect(readFileSync(join(dir, "out", "sites", "visits.txt"), "utf8")).not.toMatch(/Main Office|Blue House|Old School/);
  });

  test("usage: --accept-leaks goes with --from-audit in plan", () => {
    const r = blind(dir, "plan", "input", "--accept-leaks");
    expect(r.code).toBe(2);
    expect(r.err).toContain("go with --from-audit");
  });
});
