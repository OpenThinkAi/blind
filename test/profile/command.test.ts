import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../../src/cli.ts";
import { runProfile } from "../../src/profile/command.ts";
import { buildProfile, InputError } from "../../src/profile/profile.ts";
import { defaultPolicy, renderPolicy } from "../../src/policy.ts";
import { MAX_EXCERPT, type Profile } from "../../src/schema.ts";
import { parseProfile, validateProfile } from "../../src/validate.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-profile-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, content: string | Uint8Array): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

function policy(samples: number): void {
  const p = defaultPolicy();
  p.profile.samples = samples;
  put("blind.toml", renderPolicy(p));
}

/** A synthetic corpus: invented names, example.com hosts, RFC 5737 addresses. */
function corpus(): void {
  put(
    "kit/staff.csv",
    [
      "Staff export",
      "Name,Email,Server IP,Employee ID,Status",
      "Avery Quill,avery@example.com,192.0.2.10,EMP-004417,active",
      "Robin Example,robin@example.org,198.51.100.7,EMP-004418,inactive",
      `Sam Placeholder,sam@example.com,203.0.113.5,EMP-004419,"${"note ".repeat(60)}"`,
      "",
    ].join("\r\n"),
  );
  put("kit/sub/assets.tsv", "owner\thost\nAvery Quill\tdb01.example.com\nRobin Example\tweb02.example.org\nCasey Sample\tdb01.example.com\n");
  put("kit/notes.md", `# Weekly notes\n\nAvery Quill will migrate db01.example.com on Friday. ${"Long ".repeat(50)}sentence.\n`);
}

interface Run {
  code: number;
  out: string;
  err: string;
}

async function profile(...args: string[]): Promise<Run> {
  const output = new PassThrough();
  const err = new PassThrough();
  let out = "";
  let errText = "";
  output.on("data", (d) => (out += d));
  err.on("data", (d) => (errText += d));
  const code = await runProfile(args, { output, err }, dir);
  return { code, out, err: errText };
}

const written = (): Profile => parseProfile(readFileSync(join(dir, ".blind", "profile.json"), "utf8"));

/** Every string and object key anywhere in the profile, the way a model client would see them. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (typeof v === "object" && v !== null) return Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]);
  return [];
}

describe("buildProfile", () => {
  test("files are in sorted order with paths relative to the input directory", () => {
    corpus();
    const { profile, skipped } = buildProfile(["kit"], 5, dir);
    expect(skipped).toEqual([]);
    expect(profile.files.map((f) => [f.path, f.format])).toEqual([
      ["notes.md", "markdown"],
      ["staff.csv", "csv"],
      ["sub/assets.tsv", "tsv"],
    ]);
    expect(validateProfile(profile).ok).toBe(true);
  });

  test("column stats on the synthetic table", () => {
    corpus();
    const { profile } = buildProfile(["kit"], 5, dir);
    const staff = profile.tables.find((t) => t.file === "staff.csv");
    expect(staff?.headerRow).toBe(2);
    const col = (h: string) => staff?.columns.find((c) => c.header === h)?.stats;
    expect(col("Email")?.detectorRates.email).toBe(1);
    expect(col("Server IP")?.detectorRates.ip).toBe(1);
    expect(col("Employee ID")?.detectorRates.numericId).toBe(1);
    expect(col("Name")?.distinctRatio).toBe(1);
    expect(col("Status")?.dictionaryRatio).toBeGreaterThan(0.5);
    expect(col("Status")?.samples.length).toBe(3);
  });

  test("co-occurrence pairs columns whose value sets overlap above 50%", () => {
    corpus();
    put("kit/zz.csv", "Assignee,Mixed\nAvery Quill,Avery Quill\nnobody,Robin Example\n");
    const { profile } = buildProfile(["kit"], 0, dir);
    expect(profile.cooccurrence).toEqual([
      // Name {avery, robin, sam} vs owner {avery, robin, casey}: 2 of 3.
      { a: { file: "staff.csv", header: "Name" }, b: { file: "sub/assets.tsv", header: "owner" }, shared: 2 },
      { a: { file: "staff.csv", header: "Name" }, b: { file: "zz.csv", header: "Mixed" }, shared: 2 },
      { a: { file: "sub/assets.tsv", header: "owner" }, b: { file: "zz.csv", header: "Mixed" }, shared: 2 },
    ]);
    // Exactly 50% (Assignee: 1 of 2 shared with Name) is not above the threshold.
    expect(profile.cooccurrence.some((c) => c.b.header === "Assignee")).toBe(false);
  });

  test("the same corpus gives byte-identical profiles", () => {
    corpus();
    const a = JSON.stringify(buildProfile(["kit"], 5, dir).profile);
    const b = JSON.stringify(buildProfile(["kit"], 5, dir).profile);
    expect(a).toBe(b);
  });

  test("unsupported, hidden, undecodable and unparsable files are reported, not dropped silently", () => {
    put("kit/a.json", "{}");
    put("kit/b.bin", "x");
    put("kit/.hidden.csv", "a\n1\n");
    put("kit/latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    put("kit/broken.csv", 'a,b\n"open\n');
    put("kit/ok.txt", "Fine.");
    symlinkSync(join(dir, "kit", "ok.txt"), join(dir, "kit", "link.txt"));
    const { profile, skipped } = buildProfile(["kit"], 5, dir);
    expect(profile.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(skipped).toEqual([
      { path: ".hidden.csv", reason: "hidden" },
      { path: "a.json", reason: "json is not profiled yet" },
      { path: "b.bin", reason: "unsupported file type .bin" },
      { path: "broken.csv", reason: "cannot parse: unterminated quoted field starting on line 2" },
      { path: "latin1.txt", reason: "not valid UTF-8" },
      { path: "link.txt", reason: "symbolic link (not followed)" },
    ]);
  });

  test("blind's own .blind/ and blind.toml are skipped silently", () => {
    policy(5);
    put(".blind/profile.json", "{}");
    put("data.csv", "Name\nAvery\n");
    const { profile, skipped } = buildProfile(["."], 5, dir);
    expect(profile.files.map((f) => f.path)).toEqual(["data.csv"]);
    expect(skipped).toEqual([]);
  });

  test("a file input uses its name; a missing input or a name clash is an error", () => {
    put("a/x.csv", "N\n1\n");
    put("b/x.csv", "N\n2\n");
    expect(buildProfile(["a/x.csv"], 1, dir).profile.files.map((f) => f.path)).toEqual(["x.csv"]);
    expect(() => buildProfile(["a/x.csv", "b/x.csv"], 1, dir)).toThrow(InputError);
    expect(() => buildProfile(["nope"], 1, dir)).toThrow(InputError);
  });

  test("a path over 120 characters is reported, never truncated or let through", () => {
    const long = `${"d".repeat(70)}/${"f".repeat(60)}.csv`;
    put(`kit/${long}`, "Name\nAvery\n");
    put("kit/ok.csv", "Name\nAvery\n");
    const { profile, skipped } = buildProfile(["kit"], 1, dir);
    expect(profile.files.map((f) => f.path)).toEqual(["ok.csv"]);
    expect(skipped).toEqual([{ path: long, reason: "path is 135 characters, over the 120-character limit" }]);
  });

  test("a header of astral letters is cut by code points, not UTF-16 units", () => {
    put("h.csv", `${"𝐀".repeat(200)}Name,B\nx,y\n`);
    const header = buildProfile(["h.csv"], 1, dir).profile.tables[0]?.columns[0]?.header ?? "";
    expect([...header].length).toBe(MAX_EXCERPT);
  });

  test("a BOM does not end up in the first header", () => {
    put("bom.csv", "﻿Name\nAvery\n");
    expect(buildProfile(["bom.csv"], 1, dir).profile.tables[0]?.columns[0]?.header).toBe("Name");
  });
});

describe("blind profile", () => {
  test("writes .blind/profile.json mode 0600 and prints the table", async () => {
    policy(5);
    corpus();
    const r = await profile("kit");
    expect(r.code).toBe(0);
    expect(statSync(join(dir, ".blind", "profile.json")).mode & 0o777).toBe(0o600);
    expect(r.out).toContain('"staff.csv"  csv');
    expect(r.out).toContain('"Email"');
    expect(r.out).toContain("co-occurrence");
    expect(r.out).toContain("wrote .blind/profile.json (mode 0600)");
    const p = written();
    expect(p.sampleCount).toBe(5);
    for (const e of strings(p)) expect([...e].length).toBeLessThanOrEqual(MAX_EXCERPT);
  });

  test("the sample count comes from blind.toml", async () => {
    policy(1);
    corpus();
    expect((await profile("kit")).code).toBe(0);
    const p = written();
    expect(p.sampleCount).toBe(1);
    for (const t of p.tables) for (const c of t.columns) expect(c.stats.samples.length).toBeLessThanOrEqual(1);
  });

  test("--samples overrides blind.toml; 0 means stats and headers only", async () => {
    policy(5);
    corpus();
    expect((await profile("kit", "--samples", "0")).code).toBe(0);
    const p = written();
    expect(p.sampleCount).toBe(0);
    expect(p.tables.every((t) => t.columns.every((c) => c.stats.samples.length === 0))).toBe(true);
    expect(p.documents.every((d) => d.sampleSentences.length === 0)).toBe(true);
  });

  test("--json prints the same valid profile it writes", async () => {
    policy(5);
    corpus();
    const r = await profile("kit", "--json");
    expect(r.code).toBe(0);
    const printed = parseProfile(r.out);
    expect(printed).toEqual(written());
    expect(r.err).toContain("wrote .blind/profile.json");
  });

  test("not-profiled files are listed and the exit status is 1", async () => {
    policy(5);
    put("kit/a.json", "{}");
    put("kit/b.csv", "Name\nAvery\n");
    const r = await profile("kit");
    expect(r.code).toBe(1);
    expect(r.out).toContain('"a.json": json is not profiled yet');
    expect(r.err).toContain("1 file(s) not profiled");
    expect(written().files.map((f) => f.path)).toEqual(["b.csv"]);
  });

  test("a table with no header row is noted", async () => {
    policy(5);
    put("n.csv", "1,2\n3,4\n");
    const r = await profile("n.csv");
    expect(r.code).toBe(0);
    expect(r.out).toContain("note: n.csv: no header row detected; row 1 used as the header");
  });

  test("without blind.toml it says to run blind init, unless --samples is given", async () => {
    put("a.csv", "Name\nAvery\n");
    const r = await profile("a.csv");
    expect(r.code).toBe(1);
    expect(r.err).toContain("run `blind init` first");
    expect((await profile("a.csv", "--samples", "2")).code).toBe(0);
  });

  test("usage errors exit 2", async () => {
    expect((await profile()).code).toBe(2);
    expect((await profile("a", "--samples", "-1")).code).toBe(2);
    expect((await profile("a", "--samples", "two")).code).toBe(2);
    expect((await profile("a", "--bogus")).code).toBe(2);
  });

  test("a missing input exits 1 with the path", async () => {
    policy(5);
    const r = await profile("missing");
    expect(r.code).toBe(1);
    expect(r.err).toContain("missing: no such file or directory");
  });

  test("is wired into the CLI", async () => {
    expect(await main(["profile", "--help"])).toBe(0);
  });
});
