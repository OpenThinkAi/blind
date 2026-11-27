// AGT-2807: a dropped column holding a different value on every row (a transaction or payment id)
// made blinding quadratic in rows. Each dropped value recurs as a form the scanner looks for in kept
// cells, and every word start in a kept cell tried every form sharing its first character: with ids
// that all start with one letter, every row's kept cells were checked against every row's id.
// EntityMatcher now indexes its forms by first word (src/engine/text.ts candidatesAt).
//
// The growth guard counts EntityMatcher match attempts, not time, so it cannot flake on a busy
// machine. The 131,536-row file is blinded through the library and browser entries and the CLI's
// apply under Bun, and through the built dist/ (both entries) under node; each must finish in under
// 30 s. Synthetic data only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { runApply } from "../src/apply.ts";
import { EntityMatcher } from "../src/engine/text.ts";
import { applySpec } from "../src/lib.ts";
import type { ColumnRule, Spec } from "../src/schema.ts";

const ROOT = resolve(import.meta.dir, "..");
const NODE = Bun.which("node");
if (NODE === null) throw new Error("test/dropped-unique.test.ts needs node on PATH: it blinds the large file under node too");

const scratch = mkdtempSync(join(tmpdir(), "blind-dropped-unique-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ROWS = 131_536;
const LIMIT_MS = 30_000;
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 9);
const enc = new TextEncoder();
const dec = new TextDecoder();

const HEADER = "Date,Time,Net Sales,Tip,Source,Transaction ID,Payment ID";
const KEPT_HEADER = "Date,Time,Net Sales,Tip,Source";
const rule = (header: string, treatment: ColumnRule["treatment"]): ColumnRule =>
  ({ file: "sales.csv", header, class: treatment === "keep" ? "vocabulary" : "unknown", treatment, confidence: 1, source: "human" }) as ColumnRule;
const SPEC: Spec = {
  version: 1,
  columns: [
    rule("Date", "keep"),
    rule("Time", "keep"),
    rule("Net Sales", "keep"),
    rule("Tip", "keep"),
    rule("Source", "keep"),
    rule("Transaction ID", "drop"),
    rule("Payment ID", "drop"),
  ],
  entities: {},
  patterns: { ip: false, email: false, host: false, guid: false, mac: false },
  questions: [],
};

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// The kept Source cells start words with the ids' first letters (t, p): the case that was quadratic.
const SOURCES = ["Terminal", "Point of Sale", "Tap to Pay"];

/** A sales export of `rows` rows: kept date, time, amount and source columns, and two id columns, unique per row. */
function salesCsv(rows: number): { csv: string; kept: string } {
  let seed = 0x2807;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const id = (lead: string): string => {
    let s = lead;
    for (let i = 0; i < 12; i++) s += B62[Math.floor(next() * 62)];
    return s;
  };
  const csv: string[] = [HEADER];
  const kept: string[] = [KEPT_HEADER];
  for (let i = 0; i < rows; i++) {
    // The row number in base 36 makes each id unique whatever the generator gives.
    const keptCells = `2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")},${String(8 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")},${(i % 500) + 0.25},${i % 7}.00,${SOURCES[i % 3]}`;
    csv.push(`${keptCells},${id("t")}${i.toString(36)},${id("p")}${i.toString(36)}`);
    kept.push(keptCells);
  }
  return { csv: `${csv.join("\n")}\n`, kept: `${kept.join("\n")}\n` };
}

const BIG = salesCsv(ROWS);

/** The one output's text, after checking nothing was skipped. */
function only(r: { outputs: readonly { path: string; bytes: Uint8Array }[]; skipped: readonly unknown[] }): string {
  expect(r.skipped).toEqual([]);
  expect(r.outputs.length).toBe(1);
  return dec.decode((r.outputs[0] as { bytes: Uint8Array }).bytes);
}

/** EntityMatcher match attempts made while `fn` runs. */
function matchAttempts(fn: () => void): number {
  const proto = EntityMatcher.prototype as unknown as { matchAt: (...args: unknown[]) => number };
  const original = proto.matchAt;
  let calls = 0;
  proto.matchAt = function (this: unknown, ...args: unknown[]): number {
    calls++;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    proto.matchAt = original;
  }
  return calls;
}

describe("a dropped column unique per row blinds in time linear in rows (AGT-2807)", () => {
  test("doubling the rows at most about doubles the scanner's match attempts", () => {
    const attempts = (rows: number): number => {
      const { csv, kept } = salesCsv(rows);
      return matchAttempts(() => expect(only(applySpec([{ path: "sales.csv", bytes: enc.encode(csv) }], SPEC, { salt: SALT }))).toBe(kept));
    };
    const small = attempts(2_000);
    const large = attempts(4_000);
    // Linear work at most doubles (the index leaves no id to try in these kept cells, so it is 0);
    // trying every id at every matching word start was rows x rows, about 4x and millions of attempts.
    expect(large).toBeLessThanOrEqual(2.5 * small + 4_000);
  }, 30_000);

  test(`a ${ROWS}-row file through the library entry`, () => {
    const t0 = performance.now();
    const out = only(applySpec([{ path: "sales.csv", bytes: enc.encode(BIG.csv) }], SPEC, { salt: SALT }));
    expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
    expect(out).toBe(BIG.kept);
  }, 60_000);

  test(`a ${ROWS}-row file through the browser entry`, async () => {
    const outfile = join(scratch, "blind.browser.js");
    const r = Bun.spawnSync([process.execPath, "build", "src/browser.ts", "--target=browser", "--outfile", outfile], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`bun build src/browser.ts failed:\n${r.stderr.toString()}`);
    const browser = (await import(pathToFileURL(outfile).href)) as typeof import("../src/browser.ts");
    const t0 = performance.now();
    const out = only(browser.applySpec([{ path: "sales.csv", bytes: enc.encode(BIG.csv) }], SPEC, { salt: SALT }));
    expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
    expect(out).toBe(BIG.kept);
  }, 60_000);

  test(`a ${ROWS}-row file through the CLI's apply`, async () => {
    const dir = join(scratch, "cli");
    mkdirSync(join(dir, ".blind"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, ".blind", "salt"), SALT, { mode: 0o600 });
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
    writeFileSync(join(dir, "in", "sales.csv"), BIG.csv);
    const out = new PassThrough();
    const err = new PassThrough();
    let e = "";
    out.resume();
    err.on("data", (d) => (e += d));
    const t0 = performance.now();
    const code = await runApply(["in", "-o", "out"], { out, err, cwd: dir });
    expect(performance.now() - t0).toBeLessThan(LIMIT_MS);
    if (code !== 0) throw new Error(`blind apply exited ${code}:\n${e}`);
    expect(readFileSync(join(dir, "out", "sales.csv"), "utf8")).toBe(BIG.kept);
  }, 60_000);

  test(`under node, the built dist/ blinds the ${ROWS}-row file through both entries`, () => {
    const build = Bun.spawnSync([process.execPath, "scripts/build.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`scripts/build.ts failed:\n${build.stderr.toString()}${build.stdout.toString()}`);
    writeFileSync(join(scratch, "sales.csv"), BIG.csv);
    writeFileSync(join(scratch, "kept.csv"), BIG.kept);
    const script = join(scratch, "dropped.mjs");
    writeFileSync(
      script,
      `import { readFileSync } from "node:fs";
const salt = Uint8Array.from(${JSON.stringify([...SALT])});
const csv = readFileSync(${JSON.stringify(join(scratch, "sales.csv"))});
const kept = readFileSync(${JSON.stringify(join(scratch, "kept.csv"))}, "utf8");
const run = (lib) => {
  const t0 = performance.now();
  const r = lib.applySpec([{ path: "sales.csv", bytes: new Uint8Array(csv) }], ${JSON.stringify(SPEC)}, { salt });
  const ms = performance.now() - t0;
  const ok = r.skipped.length === 0 && r.outputs.length === 1 && new TextDecoder().decode(r.outputs[0].bytes) === kept;
  return { ok, fast: ms < ${LIMIT_MS} };
};
const lib = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "lib.js")).href)});
const browser = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "browser.js")).href)});
console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", lib: run(lib), browser: run(browser) }));
`,
    );
    const r = Bun.spawnSync([NODE, script], { cwd: scratch, stdout: "pipe", stderr: "pipe", timeout: 85_000 });
    if (r.exitCode !== 0) throw new Error(`node ${script} failed (exit ${r.exitCode ?? `signal ${r.signalCode}`}):\n${r.stderr.toString()}`);
    expect(JSON.parse(r.stdout.toString())).toEqual({ runtime: "node", lib: { ok: true, fast: true }, browser: { ok: true, fast: true } });
  }, 90_000);
});
