// AGT-2740: the package as npm ships it. The library build (scripts/build.ts) is run, the package is
// packed with `npm pack`, and the tarball is installed into a temporary project. There, under plain Node
// (not Bun), `@openthink/blind` blinds and reveals a CSV; a TypeScript consumer of both entries
// typechecks against the packed declarations with no Node or Bun types; `@openthink/blind/browser` is
// bundled for the browser and the bundle holds no Node-only code; `blind --help` runs from the
// tarball's bin on Bun; and every JavaScript example in the README's "Use as a library" section runs
// under Node and prints what the README says it prints. Synthetic data only.
//
// It needs `node` and `npm` on PATH, and fails (it does not skip) when either is missing. Nothing is
// fetched: the package has no runtime dependency, so the install is offline.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nodeOnly } from "./nodeonly.ts";

const ROOT = resolve(import.meta.dir, "..");
const STEP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 60_000;

const NODE = Bun.which("node");
const NPM = Bun.which("npm");
if (NODE === null || NPM === null) {
  throw new Error(
    `test/pack.test.ts needs node and npm on PATH (node: ${NODE ?? "not found"}, npm: ${NPM ?? "not found"}); ` +
      "it installs the packed package and runs it under Node",
  );
}

const scratch = mkdtempSync(join(tmpdir(), "blind-pack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs a command to completion, with a timeout; returns stdout, throws with stderr on a non-zero exit. */
function run(args: string[], cwd: string): string {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", timeout: STEP_TIMEOUT_MS, env: { ...process.env, npm_config_update_notifier: "false" } });
  if (r.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (exit ${r.exitCode ?? `signal ${r.signalCode}`}):\n${r.stderr.toString()}${r.stdout.toString()}`);
  }
  return r.stdout.toString();
}

// Build, pack, install: once for the file.
run([process.execPath, "scripts/build.ts"], ROOT);
const packed = JSON.parse(run([NPM, "pack", "--json", "--pack-destination", scratch], ROOT)) as { filename: string; files: { path: string }[] }[];
const pack = packed[0];
if (pack === undefined) throw new Error("npm pack printed no package");
const tarball = join(scratch, pack.filename);
const project = join(scratch, "consumer");
mkdirSync(project);
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
run([NPM, "install", tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], project);
const installed = join(project, "node_modules", "@openthink", "blind");

const node = (file: string): string => run([NODE, file], project);

describe("npm pack", () => {
  test("the tarball holds the build, the CLI's source and the docs, and no tests or scripts", () => {
    const paths = pack.files.map((f) => f.path);
    for (const p of ["dist/lib.js", "dist/browser.js", "dist/types/lib.d.ts", "dist/types/browser.d.ts", "bin/blind.js", "src/cli.ts", "schema/spec.schema.json", "LICENSE", "README.md", "package.json"]) {
      expect(paths).toContain(p);
    }
    expect(paths.filter((p) => /^(test|scripts|docs)\//.test(p))).toEqual([]);
    expect(paths.filter((p) => p.endsWith(".map.json") || p.startsWith(".blind/"))).toEqual([]);
  });
});

describe("@openthink/blind under plain Node", () => {
  test(
    "blinds a CSV and reveals it byte-exact",
    () => {
      writeFileSync(
        join(project, "roundtrip.mjs"),
        `
import { applySpec, newSalt, parseMap, revealFile, Revealer, serializeMap } from "@openthink/blind";
if (typeof Bun !== "undefined") throw new Error("expected Node, not Bun");
const csv = "name,email,team\\nAvery Quill,avery.quill@example.com,North\\nRowan Pike,rowan.pike@example.com,South\\n";
const spec = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "name", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "email", class: "email", treatment: "blind", confidence: 1, source: "human" },
  ],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const r = applySpec([{ path: "staff.csv", bytes: new TextEncoder().encode(csv) }], spec, { salt: newSalt() });
const out = r.outputs[0];
const blinded = new TextDecoder().decode(out.bytes);
const back = revealFile(out.path, out.bytes, new Revealer(parseMap(serializeMap(r.map))));
console.log(JSON.stringify({ runtime: process.release.name, blinded, revealed: new TextDecoder().decode(back.bytes) === csv }));
`,
      );
      const result = JSON.parse(node("roundtrip.mjs")) as { runtime: string; blinded: string; revealed: boolean };
      expect(result.runtime).toBe("node");
      expect(result.blinded).not.toContain("Avery");
      expect(result.blinded).not.toContain("example.com");
      expect(result.blinded.split("\n")[0]).toBe("name,email,team");
      expect(result.revealed).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the browser entry also loads under Node, and neither entry installs a zip codec",
    () => {
      writeFileSync(
        join(project, "codec.mjs"),
        `
import * as lib from "@openthink/blind";
import * as browser from "@openthink/blind/browser";
console.log(JSON.stringify({ lib: lib.zipCodec() === null, browser: browser.zipCodec() === null, same: Object.keys(lib).sort().join() === Object.keys(browser).sort().join() }));
`,
      );
      expect(JSON.parse(node("codec.mjs"))).toEqual({ lib: true, browser: true, same: true });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the packed declarations", () => {
  test(
    "a TypeScript consumer of both entries typechecks with no Node or Bun types",
    () => {
      writeFileSync(
        join(project, "consumer.ts"),
        `
import { applySpec, type BlindPolicy, explainProposal, newSalt, profileInputs, type Proposal, revealText, type Spec } from "@openthink/blind";
import { NO_ZIP_CODEC_REASON, auditOutputs, type AuditReport } from "@openthink/blind/browser";
const policy: BlindPolicy = { pseudonyms: { style: "letters" }, columns: [{ header: "team", treatment: "keep" }] };
const inputs = [{ path: "a.csv", bytes: new TextEncoder().encode("name\\nAvery Quill\\n") }];
const proposal: Proposal = explainProposal(profileInputs(inputs, { policy }).profile, policy);
const spec: Spec = proposal.spec;
const salt = newSalt();
const r = applySpec(inputs, spec, { salt, policy });
const report: AuditReport = auditOutputs(r.outputs, spec, r.map, { policy, salt });
const s: string = revealText("x", r.map) + NO_ZIP_CODEC_REASON + report.status;
// @ts-expect-error: a style the engine does not have
const bad: BlindPolicy = { pseudonyms: { style: "emoji" } };
export { s, bad };
`,
      );
      for (const resolution of ["nodenext", "bundler"]) {
        writeFileSync(
          join(project, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              target: "ES2022",
              lib: ["ES2022", "DOM"],
              types: [],
              module: resolution === "nodenext" ? "nodenext" : "esnext",
              moduleResolution: resolution,
            },
            files: ["consumer.ts"],
          }),
        );
        run([process.execPath, join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], project);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test("no declaration keeps a .ts import specifier", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const leaks = walk(join(installed, "dist", "types")).filter((f) => /(?:from|import)\s*\(?\s*["']\.\.?\/[^"']*\.ts["']/.test(readFileSync(f, "utf8")));
    expect(leaks).toEqual([]);
  });
});

describe("@openthink/blind/browser bundled for the browser", () => {
  test(
    "the bundle resolves the package's browser build and holds no node:/bun: module, require, Buffer or process",
    () => {
      writeFileSync(join(project, "page.js"), 'import { applySpec, revealText } from "@openthink/blind/browser";\nwindow.blind = { applySpec, revealText };\n');
      const outfile = join(project, "page.bundle.js");
      run([process.execPath, "build", "page.js", "--target=browser", "--outfile", outfile], project);
      const code = readFileSync(outfile, "utf8");
      expect(code).toContain("applySpec");
      expect(code).not.toMatch(/["'](?:node|bun):/);
      expect(nodeOnly(code)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the CLI from the tarball", () => {
  test(
    "blind --help runs on Bun from the installed bin",
    () => {
      const out = run([process.execPath, join(project, "node_modules", ".bin", "blind"), "--help"], project);
      expect(out).toContain("blind");
      expect(out).toMatch(/apply/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('README "Use as a library"', () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const section = readme.split("\n## Use as a library\n")[1]?.split("\n## ")[0] ?? "";
  // Each ```js block, and the ```text block that follows it after "It prints:", when there is one.
  const examples = [...section.matchAll(/```js\n([\s\S]*?)```(?:\s*It prints:\s*```text\n([\s\S]*?)```)?/g)].map((m) => ({ code: m[1] ?? "", prints: m[2] }));

  test("the section exists and has examples", () => {
    expect(section).not.toBe("");
    expect(examples.length).toBeGreaterThanOrEqual(4);
    expect(section.match(/```js\n/g)?.length).toBe(examples.length);
  });

  examples.forEach((ex, i) => {
    test(
      `example ${i + 1} runs under Node${ex.prints === undefined ? "" : " and prints what the README shows"}`,
      () => {
        const file = `readme-${i + 1}.mjs`;
        writeFileSync(join(project, file), ex.code);
        const out = node(file);
        if (ex.prints !== undefined) expect(out).toBe(ex.prints);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
