import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ACCOUNTS_CSV, generateKit, writeKit } from "../src/bench/synth.ts";
import { defaultPolicy, renderPolicy } from "../src/policy.ts";
import { type RunIO, runRun } from "../src/run.ts";
import { helpText } from "../src/cli.ts";

// Synthetic corpora only: kit v1 from src/bench/synth.ts, and a small invented CSV.

const BIN = join(import.meta.dir, "../bin/blind.js");

function blind(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("blind run on synthetic kit v1", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-run-kit-"));
    writeKit(dir, generateKit());
    expect(blind(dir, "init", "--defaults").code).toBe(0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a first run stops for review (exit 3, nothing applied); the second run does not stop", () => {
    const first = blind(dir, "run", "input", "-o", "out", "--no-model");
    expect(first.code).toBe(3);
    expect(first.out).toContain("stopped for review");
    expect(first.out).toContain("questions:");
    expect(existsSync(join(dir, "out"))).toBe(false);
    expect(existsSync(join(dir, ".blind", "map.json"))).toBe(false);

    const second = blind(dir, "run", "input", "-o", "out", "--no-model");
    expect(second.out).not.toContain("stopped for review");
    expect(second.out).toContain("reused unchanged");
    // The audit's verdict is run's: kit v1 under the heuristic spec has declared unknowns.
    expect(second.out).toContain("status: candidates");
    expect(second.code).toBe(1);
    expect(existsSync(join(dir, "out", ACCOUNTS_CSV))).toBe(true);
    const audit = blind(dir, "audit", "out");
    expect(audit.code).toBe(second.code);
  });

  test("a new column stops it, with what changed; --yes applies anyway", () => {
    expect(blind(dir, "run", "input", "-o", "out", "--no-model", "--yes").code).toBe(1);
    const csv = join(dir, "input", ACCOUNTS_CSV);
    const lines = readFileSync(csv, "utf8").split("\n");
    writeFileSync(csv, lines.map((l, i) => (l === "" ? l : `${l},${i === 0 ? "Desk Code" : `D-${1000 + i}`}`)).join("\n"));

    const stopped = blind(dir, "run", "input", "-o", "out2", "--no-model");
    expect(stopped.code).toBe(3);
    expect(stopped.out).toContain("changes to the saved spec:");
    expect(stopped.out).toContain('added column "accounts.csv" "Desk Code"');
    expect(existsSync(join(dir, "out2"))).toBe(false);

    const yes = blind(dir, "run", "input", "-o", "out3", "--no-model", "--yes");
    expect(yes.code).toBe(1);
    expect(existsSync(join(dir, "out3", ACCOUNTS_CSV))).toBe(true);
  });
});

describe("blind run, in process", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-run-"));
    mkdirSync(join(dir, ".blind"), { mode: 0o700 });
    writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 5)), { mode: 0o600 });
    const p = defaultPolicy();
    p.models.analyst = { backend: "openai-compatible", url: "http://127.0.0.1:9/v1", model: "fake-analyst", key_env: "" };
    writeFileSync(join(dir, "blind.toml"), renderPolicy(p));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "hosts.csv"), "Box,Status\n192.0.2.10,open\n192.0.2.11,closed\n198.51.100.7,open\n203.0.113.9,closed\n192.0.2.12,open\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(argv: string[], model?: RunIO["model"]) {
    const out = new PassThrough();
    const err = new PassThrough();
    let o = "";
    let e = "";
    out.on("data", (d) => (o += d));
    err.on("data", (d) => (e += d));
    const code = await runRun(argv, { out, err, cwd: dir, model });
    return { code, out: o, err: e };
  }

  test("a corpus the saved spec covers makes no model call", async () => {
    expect((await run(["in", "-o", "out", "--no-model", "--yes"])).code).toBeLessThan(3);
    let calls = 0;
    const fetch = (async () => {
      calls++;
      throw new Error("no model in tests");
    }) as unknown as typeof globalThis.fetch;
    const r = await run(["in", "-o", "out2"], { fetch });
    expect(calls).toBe(0);
    expect(r.out).toContain("so no model was called");
    expect(r.out).toContain("reused unchanged");
    expect(r.code).toBeLessThan(3);
  });

  test("a step that refuses gives 3, never the audit's 2", async () => {
    // Output inside the input: apply refuses.
    expect((await run(["in", "-o", "out", "--no-model", "--yes"])).code).toBeLessThan(3);
    const r = await run(["in", "-o", "in/out", "--no-model"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("apply refused");
    // A missing input: plan refuses.
    const p = await run(["missing", "-o", "out3", "--no-model"]);
    expect(p.code).toBe(3);
    expect(p.err).toContain("plan refused");
  });

  test("usage errors exit 3", async () => {
    expect((await run([])).code).toBe(3);
    expect((await run(["in"])).code).toBe(3);
    expect((await run(["--help"])).code).toBe(0);
  });

  test("run and reveal are wired into the CLI", () => {
    for (const name of ["run", "reveal"]) {
      const line = helpText().split("\n").find((l) => l.trimStart().startsWith(`${name} `));
      expect(line).not.toContain("not implemented");
    }
  });
});
