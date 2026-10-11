import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headersLookLikeValues, isTokenPath, restoreSpec, tokeniseProfile, untokenised } from "../../src/profile/tokens.ts";
import type { Profile, Spec, ValueStats } from "../../src/schema.ts";
import { validateProfile } from "../../src/validate.ts";

// Profile-only tokens (AGT-1782). Synthetic names only.

const stats = (): ValueStats => ({
  count: 2,
  distinctRatio: 1,
  digitRatio: 0,
  dictionaryRatio: 0,
  meanLength: 5,
  detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0 },
  samples: [],
});

/** Invented names in folder, file and sheet names, JSON keys and a value-like header row. */
function profile(): Profile {
  return {
    version: 1,
    sampleCount: 0,
    files: [
      { path: "clients/Avery Quill/review.csv", format: "csv", size: 10 },
      { path: "clients/Avery Quill/team.json", format: "json", size: 10 },
      { path: "Marlo Fenwick.xlsx", format: "xlsx", size: 10 },
      { path: "notes.md", format: "markdown", size: 10 },
    ],
    tables: [
      { file: "clients/Avery Quill/review.csv", headerRow: 1, columns: [{ header: "Owner", stats: stats() }, { header: "Status", stats: stats() }] },
      { file: "Marlo Fenwick.xlsx", sheet: "Quorrin Labs", headerRow: 1, columns: [{ header: "Tessaly Brook", stats: stats() }, { header: "Pell Varrick", stats: stats() }] },
    ],
    jsonKeys: [
      { file: "clients/Avery Quill/team.json", path: '$["Hollin Dray"].role', stats: stats() },
      { file: "clients/Avery Quill/team.json", path: "$.items[*].owner", stats: stats() },
      { file: "clients/Avery Quill/team.json", path: "$.byId.*.name", stats: stats() },
      { file: "clients/Avery Quill/team.json", path: '$["srv01.example.com"]', stats: stats() },
    ],
    documents: [{ file: "notes.md", outline: [], sampleSentences: [] }],
    transcripts: [],
    cooccurrence: [
      {
        a: { file: "Marlo Fenwick.xlsx", sheet: "Quorrin Labs", header: "Tessaly Brook" },
        b: { file: "clients/Avery Quill/team.json", jsonPath: '$["Hollin Dray"].role' },
        shared: 2,
      },
    ],
  };
}

const NAMES = ["Avery Quill", "clients", "review", "team", "Marlo Fenwick", "Quorrin Labs", "Tessaly Brook", "Pell Varrick", "Hollin Dray", "srv01", "notes"];

describe("tokeniseProfile", () => {
  test("replaces every path, sheet, flagged key and value-like header with a counter token", () => {
    const t = tokeniseProfile(profile());
    const sent = JSON.stringify(t.profile);
    for (const name of NAMES) expect(sent).not.toContain(name);
    expect(validateProfile(t.profile).ok).toBe(true);
    expect(untokenised(t.profile)).toEqual([]);
    // Code-unit sorted: "Marlo..." < "clients/..." < "notes.md".
    expect(t.profile.files.map((f) => f.path)).toEqual(["dir_1/dir_2/file_2", "dir_1/dir_2/file_3", "file_1", "file_4"]);
    expect(t.profile.tables.map((x) => [x.file, x.sheet, x.columns.map((c) => c.header)])).toEqual([
      ["dir_1/dir_2/file_2", undefined, ["Owner", "Status"]],
      ["file_1", "sheet_1", ["col_1", "col_2"]],
    ]);
    expect(t.profile.jsonKeys.map((j) => j.path)).toEqual(['$["key_1"].role', "$.items[*].owner", "$.byId.*.name", '$["key_2"]']);
    expect(t.profile.cooccurrence[0]).toEqual({
      a: { file: "file_1", sheet: "sheet_1", header: "col_1" },
      b: { file: "dir_1/dir_2/file_3", jsonPath: '$["key_1"].role' },
      shared: 2,
    });
    expect(t.counts).toEqual({ paths: 4, sheets: 1, tables: 1, keys: 2 });
  });

  test("is deterministic", () => {
    expect(JSON.stringify(tokeniseProfile(profile()).profile)).toBe(JSON.stringify(tokeniseProfile(profile()).profile));
  });

  test("the untokenised profile is flagged everywhere it names something", () => {
    expect(untokenised(profile())).toEqual([
      "$.profile.files[0].path",
      "$.profile.files[1].path",
      "$.profile.files[2].path",
      "$.profile.files[3].path",
      "$.profile.tables[0].file",
      "$.profile.tables[1].file",
      "$.profile.tables[1].sheet",
      "$.profile.tables[1].columns[*].header",
      "$.profile.jsonKeys[0].file",
      "$.profile.jsonKeys[0].path",
      "$.profile.jsonKeys[1].file",
      "$.profile.jsonKeys[2].file",
      "$.profile.jsonKeys[3].file",
      "$.profile.jsonKeys[3].path",
      "$.profile.documents[0].file",
      "$.profile.cooccurrence[0].a.file",
      "$.profile.cooccurrence[0].a.sheet",
      "$.profile.cooccurrence[0].b.file",
      "$.profile.cooccurrence[0].b.jsonPath",
    ]);
  });

  test("a co-occurrence header that is not in the payload's tables is flagged", () => {
    const t = tokeniseProfile(profile()).profile;
    t.cooccurrence = [{ a: { file: "file_1", sheet: "sheet_1", header: "Tessaly Brook" }, b: { file: "file_1", sheet: "sheet_1", header: "col_2" }, shared: 1 }];
    expect(untokenised(t)).toEqual(["$.profile.cooccurrence[0].a.header"]);
  });

  test("the bundled fixture tokenises to a valid, sendable profile", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "profile.valid.json"), "utf8")) as Profile;
    const t = tokeniseProfile(fixture).profile;
    expect(validateProfile(t).ok).toBe(true);
    expect(untokenised(t)).toEqual([]);
  });
});

describe("headersLookLikeValues", () => {
  test.each([
    ["field names", ["Owner", "contact_addr", "box", "Status", "Vendor"], false],
    ["mixed field names with one two-word header", ["Owner", "Region", "Status", "Vendor Name"], false],
    ["a numeric row (the row-1 fallback)", ["1001", "42", "17"], true],
    ["a half-empty row", ["Owner", "", "", ""], true],
    ["an email", ["Owner", "avery.quill@example.com", "Status"], true],
    ["a host", ["srv01.example.com", "Owner", "Status"], true],
    ["an IP", ["192.0.2.10", "Owner", "Status"], true],
    ["mostly people and organisations", ["Marlo Fenwick", "Quorrin Labs", "lead"], true],
    ["names with apostrophes and hyphens", ["Jean-Luc O'Brien", "Tessaly McAllister", "x"], true],
    ["tokens", ["col_1", "col_2"], false],
    ["no columns", [], false],
  ])("%s", (_name, headers, flagged) => {
    expect(headersLookLikeValues(headers)).toBe(flagged);
  });
});

test("isTokenPath", () => {
  expect(isTokenPath("file_1")).toBe(true);
  expect(isTokenPath("dir_1/dir_12/file_3")).toBe(true);
  expect(isTokenPath("dir_1")).toBe(false);
  expect(isTokenPath("file_0")).toBe(false);
  expect(isTokenPath("file_1.csv")).toBe(false);
  expect(isTokenPath("notes/file_1")).toBe(false);
});

describe("restoreSpec", () => {
  const reply = (t: ReturnType<typeof tokeniseProfile>): Spec => ({
    version: 1,
    columns: [
      { file: "file_1", sheet: "sheet_1", header: "col_1", class: "person", treatment: "blind", confidence: 0.9, source: "analyst" },
      { file: t.profile.jsonKeys[0]?.file ?? "", jsonPath: '$["key_1"].role', class: "vocabulary", treatment: "keep", confidence: 0.9, source: "analyst" },
    ],
    entities: {},
    patterns: { ip: true, email: true, host: true, guid: true, mac: false },
    questions: [{ id: "q1", text: "Is sheet_1 of file_1 a client list? (see file_10)", options: ["blind", "keep"], answer: null, about: { file: "file_1", sheet: "sheet_1", header: "col_2" } }],
  });

  test("maps every location and question text back to the real names", () => {
    const t = tokeniseProfile(profile());
    const { spec, issues } = restoreSpec(reply(t), t);
    expect(issues).toEqual([]);
    expect(spec.columns.map((c) => [c.file, c.sheet, c.header, c.jsonPath, c.class])).toEqual([
      ["Marlo Fenwick.xlsx", "Quorrin Labs", "Tessaly Brook", undefined, "person"],
      ["clients/Avery Quill/team.json", undefined, undefined, '$["Hollin Dray"].role', "vocabulary"],
    ]);
    expect(spec.questions[0]?.about).toEqual({ file: "Marlo Fenwick.xlsx", sheet: "Quorrin Labs", header: "Pell Varrick" });
    // file_10 is not a token of this profile, so it stays as written.
    expect(spec.questions[0]?.text).toBe('Is "Quorrin Labs" of "Marlo Fenwick.xlsx" a client list? (see file_10)');
  });

  test("a location that was not sent is an issue, never guessed at", () => {
    const t = tokeniseProfile(profile());
    const bad = reply(t);
    bad.columns.push({ file: "Marlo Fenwick.xlsx", sheet: "Quorrin Labs", header: "Tessaly Brook", class: "person", treatment: "blind", confidence: 1, source: "analyst" });
    bad.questions.push({ id: "q2", text: "?", options: ["blind", "keep"], answer: null, about: { file: "file_9", header: "col_1" } });
    expect(restoreSpec(bad, t).issues.map((i) => i.path)).toEqual(["$.columns[2]", "$.questions[1].about"]);
  });
});
