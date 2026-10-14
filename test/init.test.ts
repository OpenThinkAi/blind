import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { type InitIO, runInit } from "../src/init.ts";
import { defaultPolicy, loadPolicy, renderPolicy } from "../src/policy.ts";

interface Captured {
  io: InitIO;
  out: () => string;
  err: () => string;
}

function capture(isTTY: boolean, answers: string[] = []): Captured {
  const output = new PassThrough();
  const err = new PassThrough();
  let out = "";
  let errText = "";
  output.on("data", (d) => (out += d));
  err.on("data", (d) => (errText += d));
  const input = Readable.from(answers.length === 0 ? [] : [answers.map((a) => `${a}\n`).join("")]);
  return { io: { input, output, err, isTTY }, out: () => out, err: () => errText };
}

const mode = (path: string): number => statSync(path).mode & 0o777;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-init-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const saltPath = () => join(dir, ".blind", "salt");

describe("blind init --defaults", () => {
  test("writes a valid default blind.toml and a 32-byte salt", async () => {
    const c = capture(true);
    expect(await runInit([dir, "--defaults"], c.io)).toBe(0);
    expect(loadPolicy(dir)).toEqual(defaultPolicy());
    expect(readFileSync(saltPath()).length).toBe(32);
    expect(c.out()).toContain("wrote");
  });

  test("the salt is created mode 0600 and .blind/ mode 0700", async () => {
    expect(await runInit([dir, "--defaults"], capture(false).io)).toBe(0);
    expect(mode(saltPath())).toBe(0o600);
    expect(mode(join(dir, ".blind"))).toBe(0o700);
  });

  test("the salt is random and never printed", async () => {
    const c = capture(false);
    await runInit([dir, "--defaults"], c.io);
    const salt = readFileSync(saltPath());
    const other = mkdtempSync(join(tmpdir(), "blind-init-"));
    try {
      await runInit([other, "--defaults"], capture(false).io);
      expect(readFileSync(join(other, ".blind", "salt")).equals(salt)).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    for (const enc of ["hex", "base64"] as const) {
      expect(c.out() + c.err()).not.toContain(salt.toString(enc));
    }
  });

  test("creates the target directory when missing", async () => {
    const nested = join(dir, "a", "b");
    expect(await runInit([nested, "--defaults"], capture(false).io)).toBe(0);
    expect(existsSync(join(nested, "blind.toml"))).toBe(true);
  });

  test("does not prompt even on a terminal", async () => {
    const c = capture(true);
    await runInit([dir, "--defaults"], c.io);
    expect(c.out()).not.toContain("[");
  });
});

describe("existing files", () => {
  test("refuses to overwrite an existing salt without --force and writes nothing", async () => {
    await runInit([dir, "--defaults"], capture(false).io);
    const salt = readFileSync(saltPath());
    rmSync(join(dir, "blind.toml"));
    const c = capture(false);
    expect(await runInit([dir, "--defaults"], c.io)).toBe(1);
    expect(c.err()).toContain("--force");
    expect(readFileSync(saltPath()).equals(salt)).toBe(true);
    expect(existsSync(join(dir, "blind.toml"))).toBe(false);
  });

  test("--force replaces the salt, still mode 0600", async () => {
    await runInit([dir, "--defaults"], capture(false).io);
    const salt = readFileSync(saltPath());
    expect(await runInit([dir, "--defaults", "--force"], capture(false).io)).toBe(0);
    expect(readFileSync(saltPath()).equals(salt)).toBe(false);
    expect(mode(saltPath())).toBe(0o600);
    expect(existsSync(`${saltPath()}.tmp`)).toBe(false);
  });

  test("--force replaces a salt that was left world-readable with a 0600 one", async () => {
    mkdirSync(join(dir, ".blind"));
    writeFileSync(saltPath(), "old", { mode: 0o644 });
    expect(await runInit([dir, "--defaults", "--force"], capture(false).io)).toBe(0);
    expect(mode(saltPath())).toBe(0o600);
  });

  test("an existing blind.toml is kept without --force", async () => {
    writeFileSync(join(dir, "blind.toml"), "# mine\n");
    const c = capture(true, ["profile-only"]);
    expect(await runInit([dir], c.io)).toBe(0);
    expect(readFileSync(join(dir, "blind.toml"), "utf8")).toBe("# mine\n");
    expect(c.out()).toContain("kept existing");
    expect(mode(saltPath())).toBe(0o600);
  });

  test("--force overwrites an existing blind.toml", async () => {
    writeFileSync(join(dir, "blind.toml"), "# mine\n");
    expect(await runInit([dir, "--defaults", "--force"], capture(false).io)).toBe(0);
    expect(loadPolicy(dir)).toEqual(defaultPolicy());
  });
});

describe("interactive prompts", () => {
  test("Enter on every prompt writes the defaults", async () => {
    const c = capture(true, Array(20).fill(""));
    expect(await runInit([dir], c.io)).toBe(0);
    expect(loadPolicy(dir)).toEqual(defaultPolicy());
    expect(c.out()).toContain("Privacy mode");
  });

  test("answers land in blind.toml; invalid answers are asked again", async () => {
    const answers = [
      "remote", // invalid privacy mode, asked again
      "profile-only",
      "anthropic", // analyst backend: no URL prompt
      "example-model-a",
      "", // key env default ANTHROPIC_API_KEY
      "openai-compatible", // auditor
      "http://127.0.0.1:8000/v1",
      "example-model-b",
      "", // profile-only asks no sample count: a model there never sees a value
      "person, org,person",
      "Widget, Gizmo",
    ];
    const c = capture(true, answers);
    expect(await runInit([dir], c.io)).toBe(0);
    const p = loadPolicy(dir);
    expect(p.privacy.mode).toBe("profile-only");
    expect(p.models.analyst).toEqual({ backend: "anthropic", url: "", model: "example-model-a", key_env: "ANTHROPIC_API_KEY" });
    expect(p.models.auditor).toEqual({
      backend: "openai-compatible",
      url: "http://127.0.0.1:8000/v1",
      model: "example-model-b",
      key_env: "",
    });
    expect(p.profile.samples).toBe(0);
    expect(p.sensitive.classes).toEqual(["person", "org"]);
    expect(p.keep.terms).toEqual(["Widget", "Gizmo"]);
    expect(c.out()).toContain("expected one of");
    expect(c.out()).not.toContain("Sample values");
    expect(renderPolicy(p)).toContain("# samples = 0");
  });

  test("privacy mode none skips the model prompts", async () => {
    const c = capture(true, ["none", "many", "3", "", ""]);
    expect(await runInit([dir], c.io)).toBe(0);
    const p = loadPolicy(dir);
    expect(p.privacy.mode).toBe("none");
    expect(p.profile.samples).toBe(3);
    expect(c.out()).not.toContain("Analyst");
    expect(c.out()).toContain("expected a whole number");
  });

  test("an unknown class is asked again", async () => {
    const c = capture(true, ["none", "", "person,animal", "email", ""]);
    expect(await runInit([dir], c.io)).toBe(0);
    expect(loadPolicy(dir).sensitive.classes).toEqual(["email"]);
    expect(c.out()).toContain('unknown class "animal"');
  });

  test("end of input cancels and writes nothing", async () => {
    const c = capture(true, ["profile-only"]);
    expect(await runInit([dir], c.io)).toBe(1);
    expect(c.err()).toContain("nothing written");
    expect(existsSync(join(dir, "blind.toml"))).toBe(false);
    expect(existsSync(join(dir, ".blind"))).toBe(false);
  });

  test("without a terminal it writes the defaults and says so", async () => {
    const c = capture(false);
    expect(await runInit([dir], c.io)).toBe(0);
    expect(loadPolicy(dir)).toEqual(defaultPolicy());
    expect(c.err()).toContain("not a terminal");
  });
});

describe("arguments", () => {
  test("an unknown flag is a usage error", async () => {
    const c = capture(false);
    expect(await runInit([dir, "--nope"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage: blind init");
    expect(existsSync(join(dir, "blind.toml"))).toBe(false);
  });

  test("two directories is a usage error", async () => {
    expect(await runInit([dir, dir, "--defaults"], capture(false).io)).toBe(2);
  });

  test("--help prints usage and writes nothing", async () => {
    const c = capture(false);
    expect(await runInit([dir, "--help"], c.io)).toBe(0);
    expect(c.out()).toContain("--defaults");
    expect(existsSync(join(dir, "blind.toml"))).toBe(false);
  });
});

describe("blind init pseudonym style", () => {
  test("writes [pseudonyms] style = readable and it loads as readable", async () => {
    const c = capture(true);
    expect(await runInit([dir, "--defaults"], c.io)).toBe(0);
    expect(readFileSync(join(dir, "blind.toml"), "utf8")).toContain('[pseudonyms]\nstyle = "readable"');
    expect(loadPolicy(dir).pseudonyms).toEqual({ style: "readable" });
  });

  test("renderPolicy of the default policy contains the readable table", () => {
    expect(renderPolicy(defaultPolicy())).toContain('[pseudonyms]\nstyle = "readable"');
  });
});
