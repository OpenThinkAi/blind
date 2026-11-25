// AGT-2736: the library entry writes what `blind apply` writes (design rule 3), and reaches no module
// that touches the file system or imports node:/bun. Synthetic data only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { generateKit, kitFileBytes } from "../src/bench/synth.ts";
import { SALT_BYTES as INIT_SALT_BYTES } from "../src/init.ts";
import { applySpec, type BlindPolicy, type InputFile, parseMap, SALT_BYTES, serializeMap, type Spec } from "../src/lib.ts";
import { defaultPolicy, parsePolicy, type Policy, POLICY_FILE, POLICY_PATTERNS, renderPolicy } from "../src/policy.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-lib-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), SALT, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cliApply(): Promise<number> {
  const out = new PassThrough();
  const err = new PassThrough();
  out.resume();
  err.resume();
  return runApply(["in", "-o", "out"], { out, err, cwd: dir });
}

function readTree(root: string): Map<string, Uint8Array<ArrayBufferLike>> {
  const files = new Map<string, Uint8Array<ArrayBufferLike>>();
  const walk = (abs: string): void => {
    for (const n of readdirSync(abs)) {
      const p = join(abs, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(root, p).split("\\").join("/"), new Uint8Array(readFileSync(p)));
    }
  };
  walk(root);
  return files;
}

/** Writes the inputs, spec and policy, runs `blind apply`, runs the library, and compares bytes and map. */
async function compare(files: InputFile[], spec: Spec, policy: Policy | null, priorMap?: string): Promise<void> {
  for (const f of files) {
    const p = join(dir, "in", ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec));
  if (policy !== null) writeFileSync(join(dir, POLICY_FILE), renderPolicy(policy));
  if (priorMap !== undefined) writeFileSync(join(dir, ".blind", "map.json"), priorMap, { mode: 0o600 });

  expect(await cliApply()).toBe(0);
  const cliOut = readTree(join(dir, "out"));
  const cliMap = readFileSync(join(dir, ".blind", "map.json"), "utf8");

  // The policy as blind.toml gives it, passed straight through as the plain object.
  const parsed: BlindPolicy | undefined = policy === null ? undefined : parsePolicy(readFileSync(join(dir, POLICY_FILE), "utf8"));
  const lib = applySpec(files, spec, { salt: SALT, map: priorMap === undefined ? undefined : parseMap(priorMap), policy: parsed });
  expect(lib.skipped).toEqual([]);
  expect(serializeMap(lib.map)).toBe(cliMap);
  expect(new Map<string, Uint8Array<ArrayBufferLike>>(lib.outputs.map((o) => [o.path, new Uint8Array(o.bytes)]))).toEqual(cliOut);
}

const kit = generateKit(undefined, { version: 2 });
const kitFiles = (): InputFile[] => kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) }));

describe("library output equals `blind apply` for the same salt, spec and input", () => {
  test("no blind.toml", async () => {
    await compare(kitFiles(), kit.spec, null);
  });

  test("the default blind.toml", async () => {
    await compare(kitFiles(), kit.spec, defaultPolicy());
  });

  test("a blind.toml that changes style, patterns, defaults, keep, context, images and dates", async () => {
    const p = defaultPolicy();
    const policy: Policy = {
      ...p,
      pseudonyms: { style: "compact" },
      patterns: { ip: false, phone: true },
      defaults: { columns: "scan" },
      keep: { terms: ["example.test"], placeholders: false },
      context: { enabled: true, triggers: ["locker combo", { word: "badge", kind: "number" }] },
      images: { keep: true },
      metadata: { keepDates: true },
    };
    await compare(kitFiles(), kit.spec, policy);
  });

  test("an earlier map is reused the same way", async () => {
    const first = applySpec(kitFiles().slice(0, 2), kit.spec, { salt: SALT });
    await compare(kitFiles(), kit.spec, defaultPolicy(), serializeMap(first.map));
  });

  test("newSalt makes the size `blind init` writes", () => {
    expect(SALT_BYTES).toBe(INIT_SALT_BYTES);
  });

  test("the policy patterns the library switches are every pattern blind.toml can switch", () => {
    // A spec with every switchable pattern off; the policy turns each on: the library must pass each one.
    for (const name of POLICY_PATTERNS) {
      const spec: Spec = { ...kit.spec, patterns: { ip: false, email: false, host: false, guid: false, mac: false, phone: false, card: false, secret: false, address: false } };
      const on = applySpec(kitFiles(), spec, { salt: SALT, policy: { patterns: { [name]: true } } });
      const same = applySpec(kitFiles(), { ...spec, patterns: { ...spec.patterns, [name]: true } }, { salt: SALT });
      expect(on.outputs).toEqual(same.outputs);
    }
  });
});

describe("the library entry's import graph", () => {
  const ROOT = resolve(import.meta.dir, "..");
  const graph = (): { files: string[]; specifiers: string[] } => {
    const seen = new Set<string>();
    const specifiers: string[] = [];
    const stack = [join(ROOT, "src", "lib.ts")];
    while (stack.length > 0) {
      const f = stack.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        const s = (m[1] ?? m[2]) as string;
        if (s.startsWith(".")) stack.push(resolve(dirname(f), s));
        else specifiers.push(s);
      }
    }
    return { files: [...seen].map((f) => relative(ROOT, f)), specifiers };
  };

  test("imports no node:, bun or other package", () => {
    expect(graph().specifiers).toEqual([]);
  });

  test("reaches no CLI or file-system module", () => {
    const { files } = graph();
    for (const banned of ["src/cli.ts", "src/apply.ts", "src/reveal.ts", "src/mapfile.ts", "src/init.ts", "src/policy.ts", "src/nodezip.ts", "src/run.ts"]) {
      expect(files).not.toContain(banned);
    }
    expect(files).toContain("src/engine/apply.ts");
    expect(files).toContain("src/engine/reveal.ts");
  });
});
