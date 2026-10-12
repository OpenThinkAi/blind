import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { entityForms, headersLookLikeValues, isTokenPath, restoreSpec, tokeniseProfile, untokenised } from "../../src/profile/tokens.ts";
import { assertProfilePayload, ModelRefusal, profilePayload } from "../../src/model.ts";
import type { Profile, ProfileJsonKey, ProfileTable, Spec, ValueStats } from "../../src/schema.ts";
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
    expect(t.counts).toEqual({ paths: 4, sheets: 1, tables: 1, headers: 2, keys: 2 });
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

test("a long header that fails the title-case test fails fast (no catastrophic backtracking)", () => {
  // A 120-code-point excerpt cut ends in "…", so the match always fails at the end.
  const long = `Ab${"c".repeat(110)}…`;
  const t0 = performance.now();
  expect(headersLookLikeValues([`Avery ${long}`, `Quill ${long}`, "Status"])).toBe(false);
  expect(performance.now() - t0).toBeLessThan(250);
  // The same words still count: capitals inside a word, apostrophes and hyphens.
  expect(headersLookLikeValues(["McAllister Group", "Jean-Luc O'Brien", "x"])).toBe(true);
  expect(headersLookLikeValues(["Ab cd", "Ef gh", "x"])).toBe(false);
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

describe("name-like headers and key segments (AGT-1808)", () => {
  const table = (file: string, headers: string[]) => ({ file, headerRow: 1, columns: headers.map((header) => ({ header, stats: stats() })) });
  const base = (headers: string[], keys: string[]): Profile => ({
    version: 1,
    sampleCount: 0,
    files: [
      { path: "a.csv", format: "csv", size: 10 },
      { path: "b.json", format: "json", size: 10 },
    ],
    tables: [table("a.csv", headers)],
    jsonKeys: keys.map((path) => ({ file: "b.json", path, stats: stats() })),
    documents: [],
    transcripts: [],
    cooccurrence: [],
  });
  const sentHeaders = (t: ReturnType<typeof tokeniseProfile>) => t.profile.tables[0]?.columns.map((c) => c.header);

  test("a single title-case name header is tokenised alone; dictionary headers stay", () => {
    const p = base(["Avery", "Status", "Amount"], []);
    expect(headersLookLikeValues(["Avery", "Status", "Amount"])).toBe(false);
    const t = tokeniseProfile(p);
    expect(sentHeaders(t)).toEqual(["col_1", "Status", "Amount"]);
    expect(t.counts).toMatchObject({ tables: 1, headers: 1 });
    expect(untokenised(t.profile)).toEqual([]);
    expect(untokenised(p)).toContain("$.profile.tables[0].columns[0].header");
    expect(t.restore({ file: "file_1", header: "col_1" })).toEqual({ file: "a.csv", header: "Avery" });
    expect(t.restore({ file: "file_1", header: "Status" })).toEqual({ file: "a.csv", header: "Status" });
  });

  test("an identifier-shaped key segment is tokenised; dictionary snake_case stays", () => {
    const p = base([], ["$.users.avery_q.role", "$.users.user_id", "$.created_at"]);
    const t = tokeniseProfile(p);
    expect(t.profile.jsonKeys.map((j) => j.path)).toEqual(['$.users["key_1"].role', "$.users.user_id", "$.created_at"]);
    expect(JSON.stringify(t.profile)).not.toContain("avery");
    expect(untokenised(t.profile)).toEqual([]);
    expect(untokenised(p)).toContain("$.profile.jsonKeys[0].path");
    expect(t.restore({ file: "file_2", jsonPath: '$.users["key_1"].role' })).toEqual({ file: "b.json", jsonPath: "$.users.avery_q.role" });
  });

  test.each([
    ["a minority of name headers", ["Owner", "Marlo Fenwick", "Status", "Region", "Vendor"], ["Owner", "col_2", "Status", "Region", "Vendor"]],
    ["digits", ["Owner", "srv01", "Q3 Total"], ["Owner", "col_2", "col_3"]],
    ["an identifier-shaped header", ["avery_q", "user_id", "contact_addr"], ["col_1", "user_id", "contact_addr"]],
    ["a token-shaped real header", ["col_3", "Status", "Amount"], ["col_1", "Status", "Amount"]],
    ["a pattern in one cell", ["Owner", "Status", "Amount", "Region", "avery.quill@example.com"], ["col_1", "col_2", "col_3", "col_4", "col_5"]],
    ["plural and tense endings of dictionary words", ["Amounts", "Assigned", "Categories", "Hostname"], ["Amounts", "Assigned", "Categories", "Hostname"]],
  ])("%s", (_name, headers, sent) => {
    const t = tokeniseProfile(base(headers, []));
    expect(sentHeaders(t)).toEqual(sent);
    expect(untokenised(t.profile)).toEqual([]);
  });

  test("a spec entity form is tokenised wherever it appears, in any case or separator", () => {
    const p = base(["Owner", "rowan", "Status"], ["$.rowan_lee.role", "$.byName.rowanLee", "$.team.lead"]);
    expect(sentHeaders(tokeniseProfile(p))).toEqual(["Owner", "rowan", "Status"]);
    const hints = { entities: ["Rowan Lee", "Rowan"] };
    const t = tokeniseProfile(p, hints);
    expect(sentHeaders(t)).toEqual(["Owner", "col_2", "Status"]);
    expect(t.profile.jsonKeys.map((j) => j.path)).toEqual(['$["key_2"].role', '$.byName["key_1"]', "$.team.lead"]);
    expect(JSON.stringify(t.profile).toLowerCase()).not.toContain("rowan");
    expect(untokenised(t.profile, hints)).toEqual([]);
    // Without the hints the lower-case header passes; with them it is refused.
    expect(untokenised(p)).not.toContain("$.profile.tables[0].columns[1].header");
    expect(untokenised(p, hints)).toContain("$.profile.tables[0].columns[1].header");
  });

  test("keep terms are not name-like, but an entity form wins over keep", () => {
    const p = base(["Quorrin", "Status", "Amount"], ["$.quorrin_labs.role"]);
    expect(sentHeaders(tokeniseProfile(p))).toEqual(["col_1", "Status", "Amount"]);
    const keep = { keep: ["Quorrin Labs"] };
    const t = tokeniseProfile(p, keep);
    expect(sentHeaders(t)).toEqual(["Quorrin", "Status", "Amount"]);
    expect(t.profile.jsonKeys[0]?.path).toBe("$.quorrin_labs.role");
    expect(untokenised(t.profile, keep)).toEqual([]);
    expect(sentHeaders(tokeniseProfile(p, { ...keep, entities: ["Quorrin"] }))).toEqual(["col_1", "Status", "Amount"]);
  });

  test("a token in the wrong column is refused", () => {
    const t = tokeniseProfile(base(["Avery", "Status", "Amount"], []));
    const moved = structuredClone(t.profile);
    (moved.tables[0]?.columns[1] as { header: string }).header = "col_1";
    expect(untokenised(moved)).toEqual(["$.profile.tables[0].columns[1].header"]);
  });

  test("entityForms lists canonical forms, aliases and parts, sorted and distinct", () => {
    expect(
      entityForms({
        person: [{ canonical: "Rowan Lee", aliases: ["R. Lee"], parts: ["Rowan", "Lee"] }],
        org: [{ canonical: "Quorrin Labs", aliases: [], parts: ["Lee"] }],
      }),
    ).toEqual(["Lee", "Quorrin Labs", "R. Lee", "Rowan", "Rowan Lee"]);
    expect(entityForms(undefined)).toEqual([]);
  });

  test("is deterministic", () => {
    const p = base(["Avery", "Status", "Amount"], ["$.users.avery_q.role", "$.users.bo_x.role"]);
    expect(JSON.stringify(tokeniseProfile(p).profile)).toBe(JSON.stringify(tokeniseProfile(structuredClone(p)).profile));
  });
});

describe("assertProfilePayload refuses untokenised name-like headers and keys (AGT-1808)", () => {
  const p = (): Profile => ({
    version: 1,
    sampleCount: 0,
    files: [
      { path: "a.csv", format: "csv", size: 10 },
      { path: "b.json", format: "json", size: 10 },
    ],
    tables: [{ file: "a.csv", headerRow: 1, columns: ["Avery", "Status", "rowan"].map((header) => ({ header, stats: stats() })) }],
    jsonKeys: [{ file: "b.json", path: "$.users.avery_q.role", stats: stats() }],
    documents: [],
    transcripts: [],
    cooccurrence: [],
  });
  const policy = { sensitive: { classes: ["person" as const], description: "", examples: [] }, keep: { terms: ["Widgetry"] } };

  test("tokenised with the same hints, it passes; the real names are refused", () => {
    const forms = ["Rowan"];
    expect(() => assertProfilePayload(profilePayload(tokeniseProfile(p(), { keep: policy.keep.terms, entities: forms }).profile, policy), forms)).not.toThrow();
    // Paths are tokenised but the names are not: refused, naming each one.
    const pathsOnly = tokeniseProfile(p()).profile;
    pathsOnly.tables[0] = { ...(pathsOnly.tables[0] as ProfileTable), columns: p().tables[0]?.columns ?? [] };
    pathsOnly.jsonKeys[0] = { ...(pathsOnly.jsonKeys[0] as ProfileJsonKey), path: "$.users.avery_q.role" };
    expect(() => assertProfilePayload(profilePayload(pathsOnly, policy))).toThrow(ModelRefusal);
    expect(() => assertProfilePayload(profilePayload(pathsOnly, policy))).toThrow("$.profile.tables[0].columns[0].header, $.profile.jsonKeys[0].path");
    // The lower-case entity form is caught only when the call names the spec's entities.
    const tokenisedNoForms = tokeniseProfile(p(), { keep: policy.keep.terms }).profile;
    expect(() => assertProfilePayload(profilePayload(tokenisedNoForms, policy))).not.toThrow();
    expect(() => assertProfilePayload(profilePayload(tokenisedNoForms, policy), forms)).toThrow("$.profile.tables[0].columns[2].header");
  });
});
