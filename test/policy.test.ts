import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyError, defaultPolicy, loadPolicy, parsePolicy, renderPolicy, withPolicyPatterns } from "../src/policy.ts";
import type { Spec } from "../src/schema.ts";

const valid = () => renderPolicy(defaultPolicy());
/** The default policy with `[profile] samples = 5` written out rather than left to the mode. */
const explicit = () => renderPolicy({ ...defaultPolicy(), profile: { samples: 5, samplesExplicit: true } });

function errorOf(text: string): string {
  try {
    parsePolicy(text);
  } catch (e) {
    expect(e).toBeInstanceOf(PolicyError);
    return (e as Error).message;
  }
  throw new Error("expected a PolicyError");
}

describe("defaults", () => {
  test("the rendered default policy parses back to the defaults", () => {
    expect(parsePolicy(valid())).toEqual(defaultPolicy());
  });

  test("defaults blind every class, show 5 samples and stay local", () => {
    const p = defaultPolicy();
    expect(p.sensitive.classes).toEqual(["person", "org", "host", "email", "id", "location", "secret"]);
    expect(p.profile.samples).toBe(5);
    expect(p.privacy.mode).toBe("local-only");
    expect(new URL(p.models.analyst.url).hostname).toBe("127.0.0.1");
    expect(new URL(p.models.auditor.url).hostname).toBe("127.0.0.1");
  });

  test("render round-trips quotes, backslashes and non-ASCII", () => {
    const p = defaultPolicy();
    p.keep.terms = ['say "hi"', "C:\\path", "Café Example"];
    p.sensitive.description = "line with # and = signs";
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
  });
});

describe("validation names the key and the expected type", () => {
  const cases: Array<[string, (t: string) => string, string]> = [
    ["samples as a string", (t) => t.replace("samples = 5", 'samples = "5"'), "profile.samples must be a non-negative integer (got string)"],
    ["negative samples", (t) => t.replace("samples = 5", "samples = -1"), "profile.samples must be a non-negative integer (got -1)"],
    ["fractional samples", (t) => t.replace("samples = 5", "samples = 2.5"), "profile.samples must be a non-negative integer (got 2.5)"],
    ["unknown privacy mode", (t) => t.replace('mode = "local-only"', 'mode = "remote"'), 'privacy.mode must be one of "local-only", "profile-only", "none" (got "remote")'],
    ["unknown backend", (t) => t.replace('backend = "openai-compatible"', 'backend = "magic"'), "models.analyst.backend must be one of"],
    ["model as a number", (t) => t.replace('model = ""', "model = 7"), "models.analyst.model must be a string (got 7)"],
    ["unknown class", (t) => t.replace('classes = ["person"', 'classes = ["animal"'), 'sensitive.classes must contain only'],
    ["keep terms not strings", (t) => t.replace("terms = []", "terms = [1, 2]"), "keep.terms must be an array of strings (got array)"],
    ["section replaced by a value", (t) => t.replace("[keep]\n", "keep = 3\n[unused]\n").replace("terms = []\n", ""), "unknown key unused"],
  ];
  for (const [name, edit, message] of cases) {
    test(name, () => expect(errorOf(edit(explicit()))).toContain(message));
  }

  test("a missing key is reported as missing", () => {
    expect(errorOf(valid().replace(/^key_env = .*$/m, ""))).toBe(
      "blind.toml: models.analyst.key_env must be a string (missing)",
    );
  });

  test("a missing section is reported as a missing table", () => {
    expect(errorOf(valid().replace("[privacy]\n", "").replace(/^mode = .*$/m, ""))).toBe(
      "blind.toml: privacy must be a table (missing)",
    );
  });

  test("a misspelt key is rejected, not ignored", () => {
    expect(errorOf(explicit().replace("samples = 5", "samples = 5\nsampels = 3"))).toBe(
      "blind.toml: unknown key profile.sampels (expected one of: samples)",
    );
  });

  test("invalid TOML is a PolicyError", () => {
    expect(errorOf("samples = = 1\n")).toContain("blind.toml: not valid TOML");
  });
});

describe("loadPolicy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-policy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing file gives a one-line 'run blind init'", () => {
    let message = "";
    try {
      loadPolicy(dir);
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError);
      message = (e as Error).message;
    }
    expect(message).toContain("run `blind init`");
    expect(message).not.toContain("\n");
  });

  test("errors name the file path", () => {
    writeFileSync(join(dir, "blind.toml"), explicit().replace("samples = 5", "samples = true"));
    expect(() => loadPolicy(dir)).toThrow(`${join(dir, "blind.toml")}: profile.samples must be a non-negative integer (got boolean)`);
  });

  test("loads a valid file", () => {
    writeFileSync(join(dir, "blind.toml"), valid());
    expect(loadPolicy(dir)).toEqual(defaultPolicy());
  });
});

describe("[patterns]", () => {
  // Synthetic: the spec's own switches, all off, so every blind.toml switch shows.
  const spec = (): Spec => ({ version: 1, columns: [], entities: {}, patterns: { ip: false, email: false, host: false, guid: false, mac: false }, questions: [] });

  test("the init template turns ip, host and secret on and leaves the rest to the spec", () => {
    expect(defaultPolicy().patterns).toEqual({ ip: true, host: true, secret: true });
    const text = valid();
    expect(text).toMatch(/^\[patterns\]$/m);
    expect(text).toMatch(/^ip = true /m);
    expect(text).toMatch(/^host = true /m);
    expect(text).toMatch(/^secret = true /m);
    for (const name of ["email", "guid", "mac", "phone"]) expect(text).toMatch(new RegExp(`^# ${name} = true `, "m"));
  });

  test("each pattern can be set on or off; an unset one is left out", () => {
    const text = valid().replace(/^# email = true .*$/m, "email = false").replace(/^ip = true .*$/m, "ip = false").replace(/^# mac = true .*$/m, "mac = true");
    expect(parsePolicy(text).patterns).toEqual({ ip: false, host: true, email: false, mac: true, secret: true });
  });

  test("phone can be switched in blind.toml and wins over the spec", () => {
    const text = valid().replace(/^# phone = true .*$/m, "phone = false");
    expect(parsePolicy(text).patterns).toEqual({ ip: true, host: true, phone: false, secret: true });
    expect(withPolicyPatterns(spec(), { phone: true }).patterns.phone).toBe(true);
    expect(withPolicyPatterns({ ...spec(), patterns: { ...spec().patterns, phone: true } }, { phone: false }).patterns.phone).toBe(false);
  });

  test("the table is optional: a blind.toml without it leaves every pattern to the spec", () => {
    const text = valid().replace(/\[patterns\][\s\S]*$/, "");
    expect(text).not.toContain("[patterns]");
    expect(parsePolicy(text).patterns).toEqual({});
  });

  test("a non-boolean or unknown key is rejected, naming it", () => {
    expect(errorOf(valid().replace(/^ip = true .*$/m, 'ip = "yes"'))).toBe("blind.toml: patterns.ip must be true or false (got string)");
    expect(errorOf(valid().replace(/^ip = true .*$/m, "ipv4 = true"))).toBe(
      "blind.toml: unknown key patterns.ipv4 (expected one of: ip, email, host, guid, mac, phone, address, secret)",
    );
    expect(errorOf(`patterns = 1\n${valid().replace(/\[patterns\][\s\S]*$/, "")}`)).toBe("blind.toml: patterns must be a table (got 1)");
  });

  test("render round-trips every combination it writes", () => {
    const p = defaultPolicy();
    p.patterns = { ip: false, email: true, mac: false };
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
  });

  test("withPolicyPatterns lays blind.toml over the spec, both ways, and leaves unset ones alone", () => {
    const s = { ...spec(), patterns: { ...spec().patterns, email: true } };
    expect(withPolicyPatterns(s, { ip: true, host: true, email: false }).patterns).toEqual({ ip: true, email: false, host: true, guid: false, mac: false });
    expect(withPolicyPatterns(s, {})).toBe(s);
    expect(withPolicyPatterns(s, { email: true })).toBe(s);
    expect(s.patterns.ip).toBe(false);
  });
});
