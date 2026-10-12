import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNTS_CSV, COLUMNS, DEFAULT_SEED, generateKit, mulberry32, NOTES_MD, writeKit } from "../../src/bench/synth.ts";
import { parseTable } from "../../src/profile/table.ts";
import { parseSpec } from "../../src/validate.ts";

const digest = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (v: string, flags = "u") => new RegExp(`(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, flags);

describe("synthetic kit v1", () => {
  test("is deterministic for a seed and differs across seeds", () => {
    expect(digest(generateKit(7))).toBe(digest(generateKit(7)));
    expect(digest(generateKit())).toBe(digest(generateKit(DEFAULT_SEED)));
    expect(digest(generateKit(7))).not.toBe(digest(generateKit(8)));
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });

  test("src/bench uses no clock (but the bench timing seam), no Math.random and nothing from the environment", () => {
    const dir = join(import.meta.dir, "../../src/bench");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      // The bench command's one clock read is its timing seam, which feeds only the report's `timing`.
      const allowed = f === "command.ts" ? ["performance.now"] : [];
      expect({ f, bad: [...(src.match(/Math\.random|Date\.now|new Date\(|performance\.now|randomUUID|randomBytes|process\.env/g) ?? [])] }).toEqual({ f, bad: allowed });
    }
  });

  test("every oracle value is written in each file it lists", () => {
    for (const seed of [DEFAULT_SEED, 1, 99]) {
      const kit = generateKit(seed);
      const text = Object.fromEntries(kit.files.map((f) => [f.path, f.text]));
      for (const v of kit.oracle.values) {
        expect(v.files.length).toBeGreaterThan(0);
        for (const f of v.files) expect({ seed, v: v.value, f, found: wholeWord(v.value).test(text[f] as string) }).toEqual({ seed, v: v.value, f, found: true });
      }
    }
  });

  test("the CSV has the shapes the kit exists for, and its kept columns hold no oracle value", () => {
    const kit = generateKit();
    const rows = parseTable(kit.files.find((f) => f.path === ACCOUNTS_CSV)?.text as string, "csv");
    expect(rows[0]).toEqual(COLUMNS.map((c) => c.header));
    expect(rows.length).toBe(kit.oracle.rows + 1);
    const col = (h: string) => rows.slice(1).map((r) => r[COLUMNS.findIndex((c) => c.header === h)] as string);
    expect(col("Acct No").every((v) => /^\d{4}$/.test(v))).toBe(true);
    expect(col("Ledger Ref").every((v) => /^(?=.*\d)(?=.*[a-f])[0-9a-f]{6}$/.test(v))).toBe(true);
    expect(col("Tenant Host").every((v) => v.endsWith(".tenanthub.example"))).toBe(true);
    expect(COLUMNS.some((c) => /^[a-z]+(?:_[a-z]+)+$/.test(c.header))).toBe(true);
    for (const c of COLUMNS.filter((x) => x.class === "vocabulary")) {
      for (const cell of col(c.header)) {
        for (const v of kit.oracle.values) expect({ cell, v: v.value, hit: wholeWord(v.value, "iu").test(cell) }).toEqual({ cell, v: v.value, hit: false });
      }
    }
  });

  test("the decoys are present and the names they resemble never sit in their spot", () => {
    const kit = generateKit();
    const md = kit.files.find((f) => f.path === NOTES_MD)?.text as string;
    expect(kit.oracle.decoys.map((d) => d.text).sort()).toEqual(["Jan.", "SAM"]);
    expect(md).toMatch(/\bSAM\b/);
    expect(md).toMatch(/\bJan\./);
    // The given names appear too, but never written as the decoy is.
    expect(md).toMatch(/\bSam\b/);
    expect(md).toMatch(/\bJan\b(?!\.)/);
    for (const f of kit.files) expect(f.text).not.toMatch(/\bJan\.(?=\s+\p{Lu}\p{Ll})/u);
  });

  test("is synthetic only: .example hosts and email domains, RFC 5737 addresses", () => {
    const kit = generateKit();
    for (const v of kit.oracle.values) {
      if (v.class === "email") expect(v.value).toMatch(/@[a-z]+\.example$/);
      if (v.class === "host") expect(v.value).toMatch(/\.example$|^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/);
    }
    const all = kit.files.map((f) => f.text).join("\n");
    for (const host of all.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/g) ?? []) expect(host).toMatch(/\.example$/);
  });

  test("recurInProse cites column values in the notes; it is off by default", () => {
    const plain = generateKit();
    const recur = generateKit(DEFAULT_SEED, { recurInProse: true });
    expect(plain.oracle.recurInProse).toBe(false);
    expect(plain.oracle.values.filter((v) => v.class === "id" && v.files.includes(NOTES_MD))).toEqual([]);
    expect(recur.oracle.values.filter((v) => v.class === "id" && v.files.includes(NOTES_MD)).length).toBe(6);
  });

  test("rejects a row count too small to place every cast member", () => {
    expect(() => generateKit(1, { rows: 3 })).toThrow(RangeError);
  });

  test("writeKit puts the oracle and the spec outside the input tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-synth-"));
    try {
      const kit = generateKit();
      writeKit(dir, kit);
      expect(readdirSync(dir).sort()).toEqual(["input", "oracle.json", "spec.json"]);
      expect(JSON.parse(readFileSync(join(dir, "oracle.json"), "utf8"))).toEqual(kit.oracle);
      expect(parseSpec(readFileSync(join(dir, "spec.json"), "utf8"))).toEqual(kit.spec);
      for (const f of kit.files) expect(readFileSync(join(dir, "input", ...f.path.split("/")), "utf8")).toBe(f.text as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the command line prints usage for --help and for a bad option, never a stack trace", () => {
    const script = join(import.meta.dir, "../../src/bench/synth.ts");
    const run = (...args: string[]) => {
      const r = Bun.spawnSync([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    for (const flag of ["--help", "-h"]) {
      const r = run(flag);
      expect(r.code).toBe(0);
      expect(r.out).toStartWith("Usage: bun src/bench/synth.ts <dir>");
      expect(r.err).toBe("");
    }
    const bad = run("--bogus");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Unknown option '--bogus'");
    expect(bad.err).toContain("Usage: bun src/bench/synth.ts <dir>");
    expect(bad.err).not.toContain("TypeError");
    const none = run();
    expect(none.code).toBe(2);
    expect(none.err).toStartWith("Usage:");
  });
});
