// AGT-2731 AC4: moving the engine's HMAC from node:crypto to src/engine/sha256.ts changes no byte of
// `blind apply` output. Synthetic kit v2 is applied twice through the real CLI with the same salt
// and spec: once as shipped, once with the old node:crypto implementation preloaded in place of
// the module (test/engine/old-hmac.preload.ts). Output trees and map.json must be identical. The
// spec gains one redact entry so the redact-list fingerprint is exercised too.

import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_SEED, generateKit, writeKit } from "../../src/bench/synth.ts";

const BIN = join(import.meta.dir, "../../bin/blind.js");
const PRELOAD = join(import.meta.dir, "old-hmac.preload.ts");

function blind(cwd: string, args: string[], preload = false): { code: number; err: string } {
  const r = Bun.spawnSync([process.execPath, ...(preload ? ["--preload", PRELOAD] : []), BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, err: r.stderr.toString() };
}

/** Every file under `root`, keyed by relative path. */
function tree(root: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), new Uint8Array(readFileSync(p)));
    }
  };
  walk(root);
  return out;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("blind apply on synthetic kit v2 is byte-identical to the node:crypto HMAC", () => {
  test("output files and map.json match", () => {
    const now = mkdtempSync(join(tmpdir(), "blind-hmac-now-"));
    dirs.push(now);
    const kit = generateKit(DEFAULT_SEED, { version: 2 });
    writeKit(now, kit);
    expect(blind(now, ["init", "--defaults"]).code).toBe(0);
    const salt = readFileSync(join(now, ".blind", "salt"));
    // A redact entry for one planted value, fingerprinted the pre-AGT-2731 way.
    const value = kit.oracle.values.find((v) => v.class === "email")?.value as string;
    const mac = createHmac("sha256", salt).update(`blind-redact\u0000${value}`, "utf8").digest("hex").slice(0, 32);
    writeFileSync(join(now, ".blind", "spec.json"), `${JSON.stringify({ ...kit.spec, redact: [`${value.length}:${mac}`] }, null, 2)}\n`);

    const old = mkdtempSync(join(tmpdir(), "blind-hmac-old-"));
    dirs.push(old);
    cpSync(now, old, { recursive: true });

    const a = blind(now, ["apply", "input", "-o", "out"]);
    const b = blind(old, ["apply", "input", "-o", "out"], true);
    expect({ code: a.code, err: a.err }).toEqual({ code: 0, err: expect.not.stringContaining("old-hmac") });
    expect({ code: b.code, preloaded: b.err.includes("old-hmac: node:crypto in use") }).toEqual({ code: 0, preloaded: true });

    const ta = tree(join(now, "out"));
    const tb = tree(join(old, "out"));
    expect(ta.size).toBe(kit.files.length);
    expect([...ta.keys()]).toEqual([...tb.keys()]);
    for (const [p, bytes] of ta) expect({ p, same: Buffer.from(bytes).equals(Buffer.from(tb.get(p) as Uint8Array)) }).toEqual({ p, same: true });
    const mapA = readFileSync(join(now, ".blind", "map.json"));
    expect(mapA.equals(readFileSync(join(old, ".blind", "map.json")))).toBe(true);
    // The redact entry matched: the value is written as REDACTED, not pseudonymised.
    expect(mapA.toString("utf8")).not.toContain(value);
    expect([...ta.values()].some((bytes) => Buffer.from(bytes).toString("utf8").includes("REDACTED"))).toBe(true);
  }, 60_000);
});
