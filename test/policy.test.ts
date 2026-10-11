import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyError, defaultPolicy, loadPolicy, parsePolicy, renderPolicy } from "../src/policy.ts";

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
    expect(p.sensitive.classes).toEqual(["person", "org", "host", "email", "id", "location"]);
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
