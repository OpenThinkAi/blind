// AGT-2784: inputs well past the engines' stack limits for one-argument-per-row spreads (V8 threw at
// about 125,000 rows, JavaScriptCore somewhere above 131,000). A 500,000-row CSV is blinded through the
// library entry and the browser entry, and a 500,000-record JSONL file through the library, under Bun;
// a 300,000-row CSV with a dropped and a blinded column too. V8's stack is the smaller, so the 500,000-row
// CSV and JSONL also go through the built dist/ (both entries) under plain `node`. It needs `node` on
// PATH and fails (it does not skip) when it is missing. Synthetic data only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applySpec } from "../src/lib.ts";
import type { ColumnRule, Spec } from "../src/schema.ts";

const ROOT = resolve(import.meta.dir, "..");
const NODE = Bun.which("node");
if (NODE === null) throw new Error("test/large-input.test.ts needs node on PATH: it blinds the large inputs under Node's smaller stack");

const scratch = mkdtempSync(join(tmpdir(), "blind-large-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ROWS = 500_000;
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
const enc = new TextEncoder();
const dec = new TextDecoder();

const rule = (file: string, at: { header: string } | { jsonPath: string }, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule =>
  ({ file, ...at, class: cls, treatment, confidence: 1, source: "human" }) as ColumnRule;
const spec = (columns: ColumnRule[]): Spec => ({ version: 1, columns, entities: {}, patterns: { ip: false, email: false, host: false, guid: false, mac: false }, questions: [] });

const SALES = `Date,Net Sales\n${"2026-01-05,4.50\n".repeat(ROWS)}`;
const SALES_SPEC = spec([rule("sales.csv", { header: "Date" }, "unknown", "keep"), rule("sales.csv", { header: "Net Sales" }, "unknown", "keep")]);
const JSONL = '{"date":"2026-01-05","net":4.5}\n'.repeat(ROWS);
const JSONL_SPEC = spec([rule("sales.jsonl", { jsonPath: "$.date" }, "unknown", "keep"), rule("sales.jsonl", { jsonPath: "$.net" }, "unknown", "keep")]);

/** The one output's text, after checking nothing was skipped. */
function only(r: { outputs: readonly { path: string; bytes: Uint8Array }[]; skipped: readonly unknown[] }): string {
  expect(r.skipped).toEqual([]);
  expect(r.outputs.length).toBe(1);
  return dec.decode((r.outputs[0] as { bytes: Uint8Array }).bytes);
}

describe("large inputs blind without overflowing the stack (AGT-2784)", () => {
  test(`a ${ROWS}-row two-column CSV through the library entry`, () => {
    expect(only(applySpec([{ path: "sales.csv", bytes: enc.encode(SALES) }], SALES_SPEC, { salt: SALT }))).toBe(SALES);
  }, 60_000);

  test(`a ${ROWS}-row two-column CSV through the browser entry`, async () => {
    const outfile = join(scratch, "blind.browser.js");
    const r = Bun.spawnSync([process.execPath, "build", "src/browser.ts", "--target=browser", "--outfile", outfile], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`bun build src/browser.ts failed:\n${r.stderr.toString()}`);
    const browser = (await import(pathToFileURL(outfile).href)) as typeof import("../src/browser.ts");
    expect(only(browser.applySpec([{ path: "sales.csv", bytes: enc.encode(SALES) }], SALES_SPEC, { salt: SALT }))).toBe(SALES);
  }, 60_000);

  test(`a ${ROWS}-record JSONL file through the library entry`, () => {
    expect(only(applySpec([{ path: "sales.jsonl", bytes: enc.encode(JSONL) }], JSONL_SPEC, { salt: SALT }))).toBe(JSONL);
  }, 60_000);

  test("a 300000-row CSV with one dropped and one blinded column", () => {
    const n = 300_000;
    let csv = "Date,Net Sales,Note,Team\n";
    for (let i = 0; i < n; i++) csv += `2026-01-05,4.50,call back ${i % 13},Crew ${String.fromCharCode(65 + (i % 7))}\n`;
    const s = spec([
      rule("crews.csv", { header: "Date" }, "unknown", "keep"),
      rule("crews.csv", { header: "Net Sales" }, "unknown", "keep"),
      rule("crews.csv", { header: "Note" }, "unknown", "drop"),
      rule("crews.csv", { header: "Team" }, "org", "blind"),
    ]);
    const r = applySpec([{ path: "crews.csv", bytes: enc.encode(csv) }], s, { salt: SALT });
    const lines = only(r).split("\n");
    expect(lines.length).toBe(n + 2);
    expect(lines[0]).toBe("Date,Net Sales,Team");
    expect(lines.slice(1, -1).every((l) => l.startsWith("2026-01-05,4.50,") && !l.includes("Crew") && !l.includes("call back"))).toBe(true);
    expect(r.map.entries.length).toBe(7);
  }, 60_000);

  test(`under node, the built dist/ blinds the ${ROWS}-row CSV through both entries and the JSONL file`, () => {
    const build = Bun.spawnSync([process.execPath, "scripts/build.ts"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`scripts/build.ts failed:\n${build.stderr.toString()}${build.stdout.toString()}`);
    const script = join(scratch, "large.mjs");
    writeFileSync(
      script,
      `const salt = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
const enc = new TextEncoder();
const dec = new TextDecoder();
const run = (lib, path, text, spec) => {
  const r = lib.applySpec([{ path, bytes: enc.encode(text) }], spec, { salt });
  return r.skipped.length === 0 && r.outputs.length === 1 && dec.decode(r.outputs[0].bytes) === text;
};
const lib = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "lib.js")).href)});
const browser = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist", "browser.js")).href)});
const sales = ${JSON.stringify("2026-01-05,4.50\n")}.repeat(${ROWS});
const jsonl = ${JSON.stringify('{"date":"2026-01-05","net":4.5}\n')}.repeat(${ROWS});
console.log(JSON.stringify({
  runtime: typeof Bun === "undefined" ? "node" : "bun",
  lib: run(lib, "sales.csv", "Date,Net Sales\\n" + sales, ${JSON.stringify(SALES_SPEC)}),
  browser: run(browser, "sales.csv", "Date,Net Sales\\n" + sales, ${JSON.stringify(SALES_SPEC)}),
  jsonl: run(lib, "sales.jsonl", jsonl, ${JSON.stringify(JSONL_SPEC)}),
}));
`,
    );
    const r = Bun.spawnSync([NODE, script], { cwd: scratch, stdout: "pipe", stderr: "pipe", timeout: 55_000 });
    if (r.exitCode !== 0) throw new Error(`node ${script} failed (exit ${r.exitCode ?? `signal ${r.signalCode}`}):\n${r.stderr.toString()}`);
    expect(JSON.parse(r.stdout.toString())).toEqual({ runtime: "node", lib: true, browser: true, jsonl: true });
  }, 60_000);
});
