// AGT-2738: profileInputs and proposeSpec in the library entry. The profile and the spec proposed from
// bytes held in memory and a policy object are the ones `blind plan --no-model` writes for the same files
// and blind.toml; an invalid policy object is refused by blind.toml's own rules, naming the field. The CLI
// is run here, in the test, never by the library. Synthetic data only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { runPlan } from "../src/analyst/plan.ts";
import { generateKit, kitFileBytes } from "../src/bench/synth.ts";
import { applySpec, type BlindPolicy, InputError, type InputFile, PolicyError, profileInputs, proposeSpec, SchemaError, validateSpec } from "../src/lib.ts";
import { parsePolicy, POLICY_FILE } from "../src/policy.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-libplan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const kit = generateKit(undefined, { version: 2 });
const kitFiles = (): InputFile[] => kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) }));

/** Writes the inputs and blind.toml, runs `blind plan --no-model in`, and returns what it wrote. */
async function cliPlan(files: readonly InputFile[], toml: string): Promise<{ code: number; spec: unknown; profile: unknown }> {
  for (const f of files) {
    const p = join(dir, "in", ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  writeFileSync(join(dir, POLICY_FILE), toml);
  const out = new PassThrough();
  const err = new PassThrough();
  out.resume();
  err.resume();
  const code = await runPlan(["in", "--no-model", "--json"], { out, err, cwd: dir });
  const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, ".blind", name), "utf8"));
  return { code, spec: read("spec.json"), profile: read("profile.json") };
}

const MODELS = '[models.analyst]\nbackend = "openai-compatible"\nurl = ""\nmodel = ""\nkey_env = ""\n';

/** A blind.toml and the same policy as the library's plain object. */
const CASES: { name: string; toml: string; policy: BlindPolicy }[] = [
  {
    name: "the classes `blind init` writes, nothing else",
    toml: `[sensitive]\nclasses = ["person", "org", "host", "email", "id", "location", "secret"]\ndescription = "d"\nexamples = []\n[keep]\nterms = []\n${MODELS}[profile]\n[privacy]\nmode = "local-only"\n`,
    policy: {},
  },
  {
    name: "column rules, keep terms, classes, defaults and patterns",
    toml:
      `[sensitive]\nclasses = ["person", "email", "id", "secret"]\ndescription = "d"\nexamples = []\n` +
      `[keep]\nterms = ["Status", "example.test"]\n${MODELS}[profile]\nsamples = 3\n[privacy]\nmode = "none"\n` +
      `[patterns]\nphone = true\nhost = false\n[defaults]\ncolumns = "scan"\n` +
      `[[columns]]\nheader = ["amount*", "opened"]\ntreatment = "keep"\n` +
      `[[columns]]\nheader = "Counterparty*"\ntreatment = "blind"\nclass = "org"\n` +
      `[[columns]]\npath = "**.owner"\ntreatment = "redact"\n`,
    policy: {
      sensitive: { classes: ["person", "email", "id", "secret"] },
      keep: { terms: ["Status", "example.test"] },
      profile: { samples: 3 },
      privacy: { mode: "none" },
      patterns: { phone: true, host: false },
      defaults: { columns: "scan" },
      columns: [
        { header: ["amount*", "opened"], treatment: "keep" },
        { header: "Counterparty*", treatment: "blind", class: "org" },
        { path: "**.owner", treatment: "redact" },
      ],
    },
  },
  {
    name: "profile-only: no samples, outlines or speakers in the profile",
    toml: `[sensitive]\nclasses = ["person", "host"]\ndescription = "d"\nexamples = []\n[keep]\nterms = []\n${MODELS}[profile]\n[privacy]\nmode = "profile-only"\n`,
    policy: { sensitive: { classes: ["person", "host"] }, privacy: { mode: "profile-only" } },
  },
];

describe("proposeSpec equals `blind plan --no-model` for the synthetic kit and the same policy", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const cli = await cliPlan(kitFiles(), c.toml);
      expect(cli.code).toBe(0);
      const { profile, skipped } = profileInputs(kitFiles(), { policy: c.policy });
      expect(skipped).toEqual([]);
      expect(profile).toEqual(cli.profile as typeof profile);
      const spec = proposeSpec(profile, c.policy);
      expect(spec).toEqual(cli.spec as typeof spec);
      expect(validateSpec(spec).ok).toBe(true);
    });
  }

  test("the rules and the keep term decide their columns, by source policy", () => {
    const c = CASES[1] as (typeof CASES)[number];
    const spec = proposeSpec(profileInputs(kitFiles(), { policy: c.policy }).profile, c.policy);
    const rule = (header: string) => spec.columns.find((r) => r.file === "accounts.csv" && r.header === header);
    expect(rule("Amount")).toMatchObject({ treatment: "keep", source: "policy" });
    expect(rule("Status")).toMatchObject({ treatment: "keep", source: "policy" });
    expect(rule("Counterparty Label")).toMatchObject({ treatment: "blind", class: "org", source: "policy" });
  });

  test("a parsed blind.toml and the plain object are the same policy", () => {
    const c = CASES[1] as (typeof CASES)[number];
    const parsed = parsePolicy(c.toml);
    const profile = profileInputs(kitFiles(), { samples: parsed.profile.samples }).profile;
    const fromToml = proposeSpec(profile, { sensitive: parsed.sensitive, keep: parsed.keep, patterns: parsed.patterns, defaults: parsed.defaults, columns: parsed.columns });
    expect(proposeSpec(profile, c.policy)).toEqual(fromToml);
  });

  test("the proposed spec applies", () => {
    const policy: BlindPolicy = { columns: [{ header: "Region", treatment: "keep" }], keep: { terms: ["Status"] } };
    const files = kitFiles().filter((f) => f.path.endsWith(".csv") || f.path.endsWith(".json"));
    const spec = proposeSpec(profileInputs(files, { policy }).profile, policy);
    const r = applySpec(files, spec, { salt: new Uint8Array(32).fill(7), policy });
    expect(r.skipped).toEqual([]);
    expect(r.outputs.map((o) => o.path).sort()).toEqual(["accounts.csv", "exports/scopes.json"]);
  });
});

describe("profileInputs", () => {
  test("inputs are profiled in path order whatever order they come in", () => {
    const files = kitFiles();
    expect(profileInputs([...files].reverse())).toEqual(profileInputs(files));
  });

  test("an unsupported or undecodable file is skipped with the reason", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const r = profileInputs([
      { path: "a.csv", bytes: enc("name,team\nAvery Quill,North\n") },
      { path: "b.bin", bytes: enc("x") },
      { path: "c.txt", bytes: Uint8Array.from([0x66, 0xe9, 0x0a]) },
    ]);
    expect(r.profile.files.map((f) => f.path)).toEqual(["a.csv"]);
    expect(r.skipped.map((s) => s.path)).toEqual(["b.bin", "c.txt"]);
    expect(r.skipped[0]?.reason).toBe("unsupported file type .bin");
  });

  test("two inputs with one path are refused", () => {
    const f = { path: "a.csv", bytes: new TextEncoder().encode("a\n1\n") };
    expect(() => profileInputs([f, f])).toThrow(InputError);
  });

  test("samples: the option, else the policy, else 5", () => {
    const files = kitFiles().slice(0, 1);
    expect(profileInputs(files).profile.sampleCount).toBe(5);
    expect(profileInputs(files, { policy: { profile: { samples: 2 } } }).profile.sampleCount).toBe(2);
    expect(profileInputs(files, { samples: 1, policy: { profile: { samples: 2 } } }).profile.sampleCount).toBe(1);
    expect(() => profileInputs(files, { samples: -1 })).toThrow(RangeError);
  });
});

describe("the policy object is validated by blind.toml's rules", () => {
  const profile = profileInputs(kitFiles().slice(0, 1)).profile;
  const refused: [string, unknown, string][] = [
    ["an unknown table", { colums: [] }, "policy: unknown key colums"],
    ["an unknown key", { keep: { term: [] } }, "policy: unknown key keep.term"],
    ["a class that is not one", { sensitive: { classes: ["persons"] } }, 'policy: sensitive.classes must contain only "person"'],
    ["keep terms that are not strings", { keep: { terms: [1] } }, "policy: keep.terms must be an array of strings"],
    ["a rule treatment that is not one", { columns: [{ header: "a", treatment: "hide" }] }, "policy: columns[0].treatment must be one of"],
    ["a rule with neither header nor path", { columns: [{ treatment: "keep" }] }, "policy: columns[0].header must be set"],
    ["a rule with path and sheet", { columns: [{ path: "a.b", sheet: "S", treatment: "drop" }] }, "policy: columns[0]: path (JSON keys) and sheet"],
    ["an unknown class kept", { columns: [{ header: "a", treatment: "keep", class: "unknown" }] }, 'policy: columns[0]: class "unknown" cannot use treatment "keep"'],
    ["a pattern that is not a boolean", { patterns: { ip: "yes" } }, "policy: patterns.ip must be true or false"],
    ["a default that is not one", { defaults: { columns: "all" } }, "policy: defaults.columns must be one of"],
    ["samples under profile-only", { privacy: { mode: "profile-only" }, profile: { samples: 3 } }, "policy: profile.samples must be 0"],
    ["keepDates that is not a boolean", { metadata: { keepDates: "no" } }, "policy: metadata.keepDates must be true or false"],
    ["keep_dates spelled as in blind.toml", { metadata: { keep_dates: true } }, "policy: unknown key metadata.keep_dates (expected one of: keepDates)"],
    ["a style that is not one", { pseudonyms: { style: "short" } }, "policy: pseudonyms.style must be one of"],
    ["not an object", ["keep"], "policy: must be an object (got array)"],
  ];
  for (const [name, policy, message] of refused) {
    test(name, () => {
      expect(() => proposeSpec(profile, policy as BlindPolicy)).toThrow(PolicyError);
      expect(() => proposeSpec(profile, policy as BlindPolicy)).toThrow(message);
      expect(() => profileInputs([], { policy: policy as BlindPolicy })).toThrow(message);
    });
  }

  test("the message is blind.toml's for the same mistake", () => {
    const toml = `[sensitive]\nclasses = ["persons"]\ndescription = ""\nexamples = []\n[keep]\nterms = []\n${MODELS}[profile]\n[privacy]\nmode = "local-only"\n`;
    let fromToml = "";
    try {
      parsePolicy(toml, "policy");
    } catch (e) {
      fromToml = (e as Error).message;
    }
    expect(fromToml).not.toBe("");
    expect(() => proposeSpec(profile, { sensitive: { classes: ["persons" as "person"] } })).toThrow(fromToml);
  });

  test("a profile that is not one is a SchemaError", () => {
    expect(() => proposeSpec({ version: 1 } as unknown as typeof profile)).toThrow(SchemaError);
  });
});
