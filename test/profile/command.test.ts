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
import { buildWorkbook } from "../formats/xlsxfixture.ts";

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
    put("kit/a.vtt", "WEBVTT\n");
    put("kit/b.bin", "x");
    put("kit/broken.json", '{"a": ');
    put("kit/.hidden.csv", "a\n1\n");
    put("kit/bad16.txt", new Uint8Array([0xff, 0xfe, 0x41]));
    put("kit/broken.csv", 'a,b\n"open\n');
    put("kit/ok.txt", "Fine.");
    symlinkSync(join(dir, "kit", "ok.txt"), join(dir, "kit", "link.txt"));
    const { profile, skipped } = buildProfile(["kit"], 5, dir);
    expect(profile.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(skipped).toEqual([
      { path: ".hidden.csv", reason: "hidden" },
      { path: "a.vtt", reason: "not a WebVTT transcript (no cue timing found)" },
      { path: "b.bin", reason: "unsupported file type .bin" },
      { path: "bad16.txt", reason: "cannot decode: marked UTF-16LE but has an odd number of bytes" },
      { path: "broken.csv", reason: "cannot parse: unterminated quoted field starting on line 2" },
      { path: "broken.json", reason: "cannot parse: unexpected end of input at line 1, column 7" },
      { path: "link.txt", reason: "symbolic link (not followed)" },
    ]);
  });

  test("a non-UTF-8 text file is profiled through the shared decode, not skipped (AGT-1816)", () => {
    put("kit/cp1252.txt", new Uint8Array(Buffer.from("Contact \xd3scar Example today.\n", "latin1")));
    const { profile, skipped } = buildProfile(["kit"], 5, dir);
    expect(skipped).toEqual([]);
    expect(profile.files.map((f) => f.path)).toEqual(["cp1252.txt"]);
  });

  test("each worksheet of a workbook is a table with its sheet, header row and columns", () => {
    put("kit/staff.xlsx", buildWorkbook());
    put("kit/broken.xlsx", "not a zip");
    const { profile, skipped } = buildProfile(["kit"], 2, dir);
    expect(profile.files).toEqual([{ path: "staff.xlsx", format: "xlsx", size: buildWorkbook().length }]);
    expect(profile.tables.map((t) => [t.file, t.sheet, t.headerRow, t.columns.map((c) => c.header)])).toEqual([
      ["staff.xlsx", "Staff", 1, ["Name", "Employee ID", "Notes", "Status"]],
      ["staff.xlsx", "Avery Quill", 1, ["Amount"]],
      ["staff.xlsx", "Contents", 1, ["Sheet", "Link"]],
    ]);
    const id = profile.tables[0]!.columns[1]!.stats;
    expect([id.count, id.distinctRatio, id.detectorRates.numericId, id.samples]).toEqual([4, 1, 1, ["4417", "4419"]]);
    expect(validateProfile(profile).ok).toBe(true);
    expect(skipped).toEqual([{ path: "broken.xlsx", reason: "cannot read the workbook: not a zip file (no end of central directory record)" }]);
  });

  test("worksheet columns take part in co-occurrence with their sheet named", () => {
    put("kit/staff.xlsx", buildWorkbook());
    put("kit/people.csv", "Person\nRobin Example\nSam Placeholder\nDana Pell\nLee Orbit\n");
    const { profile } = buildProfile(["kit"], 0, dir);
    expect(profile.cooccurrence).toContainEqual({ a: { file: "people.csv", header: "Person" }, b: { file: "staff.xlsx", sheet: "Staff", header: "Name" }, shared: 4 });
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
    put("kit/a.vtt", "WEBVTT\n");
    put("kit/b.csv", "Name\nAvery\n");
    const r = await profile("kit");
    expect(r.code).toBe(1);
    expect(r.out).toContain('"a.vtt": not a WebVTT transcript (no cue timing found)');
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

  test("under profile-only the printed and saved profile has no outlines (AGT-1778) and no samples, even with --samples (AGT-1832); local-only keeps them", async () => {
    put("notes.md", "# Marlo Fenwick weekly\n\n## Quorrin Labs renewal\n\nText about the pier.\n");
    const p = defaultPolicy();
    p.privacy.mode = "profile-only";
    p.profile = { samples: 0, samplesExplicit: false };
    put("blind.toml", renderPolicy(p));
    for (const args of [["notes.md"], ["notes.md", "--samples", "2"], ["notes.md", "--json"]]) {
      const r = await profile(...args);
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain("Marlo Fenwick");
      expect(r.out + r.err).not.toContain("Quorrin Labs");
      expect(r.out + r.err).not.toContain("pier");
      expect(r.out + r.err).toContain("privacy.mode is profile-only: the outline of 1 document(s) is left out");
      const saved = parseProfile(readFileSync(join(dir, ".blind", "profile.json"), "utf8"));
      expect(saved.documents[0]?.outline).toEqual([]);
      expect(saved.documents[0]?.sampleSentences).toEqual([]);
      expect(saved.sampleCount).toBe(0);
    }
    policy(5);
    const local = await profile("notes.md");
    expect(local.out).toContain('outline: "Marlo Fenwick weekly", "Quorrin Labs renewal"');
  });

  test("with --samples, a blind.toml that does not parse is still an error: its mode decides the profile", async () => {
    put("a.csv", "Name\nAvery\n");
    put("blind.toml", "");
    const r = await profile("a.csv", "--samples", "2");
    expect(r.code).toBe(1);
    expect(r.err).toContain("sensitive must be a table");
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
