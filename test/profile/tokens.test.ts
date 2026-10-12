import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTokenPath, restoreSpec, tokeniseProfile, untokenised } from "../../src/profile/tokens.ts";
import { assertProfilePayload, ModelRefusal, profilePayload } from "../../src/model.ts";
import type { Profile, ProfileJsonKey, ProfileTable, Spec, ValueStats } from "../../src/schema.ts";
import { validateProfile } from "../../src/validate.ts";

// Profile-only tokens (AGT-1782, AGT-1832: every header and key). Synthetic names only.

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

const NAMES = ["Avery Quill", "clients", "review", "team", "Marlo Fenwick", "Quorrin Labs", "Tessaly Brook", "Pell Varrick", "Hollin Dray", "srv01", "notes", "Owner", "Status", "role", "items", "owner", "byId"];

describe("tokeniseProfile", () => {
  test("replaces every path, sheet, header and key with a counter token", () => {
    const t = tokeniseProfile(profile());
    const sent = JSON.stringify(t.profile);
    for (const name of NAMES) expect(sent).not.toContain(name);
    expect(validateProfile(t.profile).ok).toBe(true);
    expect(untokenised(t.profile)).toEqual([]);
    // Code-unit sorted: "Marlo..." < "clients/..." < "notes.md".
    expect(t.profile.files.map((f) => f.path)).toEqual(["dir_1/dir_2/file_2", "dir_1/dir_2/file_3", "file_1", "file_4"]);
    expect(t.profile.tables.map((x) => [x.file, x.sheet, x.columns.map((c) => c.header)])).toEqual([
      ["dir_1/dir_2/file_2", undefined, ["col_1", "col_2"]],
      ["file_1", "sheet_1", ["col_1", "col_2"]],
    ]);
    // Keys in code-unit order: "Hollin Dray" < byId < items < name < owner < role < srv01.example.com.
    expect(t.profile.jsonKeys.map((j) => j.path)).toEqual(['$["key_1"]["key_6"]', '$["key_3"][*]["key_5"]', '$["key_2"].*["key_4"]', '$["key_7"]']);
    expect(t.profile.cooccurrence[0]).toEqual({
      a: { file: "file_1", sheet: "sheet_1", header: "col_1" },
      b: { file: "dir_1/dir_2/file_3", jsonPath: '$["key_1"]["key_6"]' },
      shared: 2,
    });
    expect(t.counts).toEqual({ paths: 4, sheets: 1, tables: 2, headers: 4, keys: 7 });
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
      "$.profile.tables[0].columns[0].header",
      "$.profile.tables[0].columns[1].header",
      "$.profile.tables[1].file",
      "$.profile.tables[1].sheet",
      "$.profile.tables[1].columns[0].header",
      "$.profile.tables[1].columns[1].header",
      "$.profile.jsonKeys[0].file",
      "$.profile.jsonKeys[0].path",
      "$.profile.jsonKeys[1].file",
      "$.profile.jsonKeys[1].path",
      "$.profile.jsonKeys[2].file",
      "$.profile.jsonKeys[2].path",
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
      { file: t.profile.jsonKeys[0]?.file ?? "", jsonPath: '$["key_1"]["key_6"]', class: "vocabulary", treatment: "keep", confidence: 0.9, source: "analyst" },
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

describe("every header and key goes as a token (AGT-1832)", () => {
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

  test.each([
    ["dictionary words", ["Species", "Weight", "Visit Date"]],
    ["a name", ["Avery", "Status", "Amount"]],
    ["a value taken as the header", ["Marlo Fenwick", "801-555-0100", "avery.quill@example.com"]],
    ["a real header shaped like a token", ["col_3", "key_1", "Status"]],
  ])("%s: each header becomes col_N for its own column, and maps back", (_name, headers) => {
    const t = tokeniseProfile(base(headers, []));
    expect(sentHeaders(t)).toEqual(headers.map((_, i) => `col_${i + 1}`));
    expect(untokenised(t.profile)).toEqual([]);
    headers.forEach((header, i) => expect(t.restore({ file: "file_1", header: `col_${i + 1}` })).toEqual({ file: "a.csv", header }));
    expect(untokenised(base(headers, []))).toEqual(["$.profile.files[0].path", "$.profile.files[1].path", "$.profile.tables[0].file", ...headers.map((_, i) => `$.profile.tables[0].columns[${i}].header`)]);
  });

  test("every key segment becomes key_N; only [*], .* and .*~ stay as written", () => {
    const p = base([], ["$.users.avery_q.role", "$.users.user_id", "$.created_at", "$.byId.*~", '$.visits[*]["visit date"]']);
    const t = tokeniseProfile(p);
    expect(t.profile.jsonKeys.map((j) => j.path)).toEqual([
      '$["key_6"]["key_1"]["key_4"]',
      '$["key_6"]["key_5"]',
      '$["key_3"]',
      '$["key_2"].*~',
      '$["key_8"][*]["key_7"]',
    ]);
    for (const word of ["users", "avery", "role", "user_id", "created", "byId", "visit"]) expect(JSON.stringify(t.profile)).not.toContain(word);
    expect(untokenised(t.profile)).toEqual([]);
    expect(untokenised(p)).toEqual(["$.profile.files[0].path", "$.profile.files[1].path", "$.profile.tables[0].file", ...p.jsonKeys.flatMap((_, i) => [`$.profile.jsonKeys[${i}].file`, `$.profile.jsonKeys[${i}].path`])]);
    expect(t.restore({ file: "file_2", jsonPath: '$["key_8"][*]["key_7"]' })).toEqual({ file: "b.json", jsonPath: '$.visits[*]["visit date"]' });
  });

  test("a token in the wrong column is refused", () => {
    const t = tokeniseProfile(base(["Avery", "Status", "Amount"], []));
    const moved = structuredClone(t.profile);
    (moved.tables[0]?.columns[1] as { header: string }).header = "col_1";
    expect(untokenised(moved)).toEqual(["$.profile.tables[0].columns[1].header"]);
  });

  test("is deterministic", () => {
    const p = base(["Avery", "Status", "Amount"], ["$.users.avery_q.role", "$.users.bo_x.role"]);
    expect(JSON.stringify(tokeniseProfile(p).profile)).toBe(JSON.stringify(tokeniseProfile(structuredClone(p)).profile));
  });
});

describe("assertProfilePayload refuses anything but statistics and tokens (AGT-1832)", () => {
  const p = (): Profile => ({
    version: 1,
    sampleCount: 0,
    files: [
      { path: "a.csv", format: "csv", size: 10 },
      { path: "b.json", format: "json", size: 10 },
      { path: "c.md", format: "markdown", size: 10 },
      { path: "d.vtt", format: "vtt", size: 10 },
    ],
    tables: [{ file: "a.csv", headerRow: 1, columns: ["Species", "Status"].map((header) => ({ header, stats: stats() })) }],
    jsonKeys: [{ file: "b.json", path: "$.owner.name", stats: stats() }],
    documents: [{ file: "c.md", outline: [], sampleSentences: [] }],
    transcripts: [{ file: "d.vtt", speakers: [], sampleLines: [] }],
    cooccurrence: [],
  });
  const policy = { sensitive: { classes: ["person" as const], description: "", examples: [] }, keep: { terms: ["Species"] } };
  const send = (x: Profile) => () => assertProfilePayload(profilePayload(x, policy));

  test("tokenised and value-free, it passes; a real header or key is refused, naming each", () => {
    expect(send(tokeniseProfile(p()).profile)).not.toThrow();
    const real = tokeniseProfile(p()).profile;
    real.tables[0] = { ...(real.tables[0] as ProfileTable), columns: p().tables[0]?.columns ?? [] };
    real.jsonKeys[0] = { ...(real.jsonKeys[0] as ProfileJsonKey), path: "$.owner.name" };
    expect(send(real)).toThrow(ModelRefusal);
    // A keep term is no exception: the header is still document text.
    expect(send(real)).toThrow("$.profile.tables[0].columns[0].header, $.profile.tables[0].columns[1].header, $.profile.jsonKeys[0].path");
  });

  test.each([
    ["a sample count", (x: Profile) => void (x.sampleCount = 1), "$.profile.sampleCount"],
    ["a column sample", (x: Profile) => void ((x.sampleCount = 1), x.tables[0]?.columns[0]?.stats.samples.push("canine")), "$.profile.tables[0].columns[0].stats.samples"],
    ["a key sample", (x: Profile) => void ((x.sampleCount = 1), x.jsonKeys[0]?.stats.samples.push("Avery Quill")), "$.profile.jsonKeys[0].stats.samples"],
    ["a sample sentence", (x: Profile) => void ((x.sampleCount = 1), x.documents[0]?.sampleSentences.push("Avery called.")), "$.profile.documents[0].sampleSentences"],
    ["an outline", (x: Profile) => void x.documents[0]?.outline.push("# Avery Quill"), "$.profile.documents[0].outline"],
    ["a sample line", (x: Profile) => void ((x.sampleCount = 1), x.transcripts[0]?.sampleLines.push("speaker_1: hello")), "$.profile.transcripts[0].sampleLines"],
    ["a speaker", (x: Profile) => void x.transcripts[0]?.speakers.push("Avery Quill"), "$.profile.transcripts[0].speakers"],
  ])("%s is refused before any send", (_name, plant, path) => {
    const x = tokeniseProfile(p()).profile;
    plant(x);
    expect(send(x)).toThrow(ModelRefusal);
    expect(send(x)).toThrow(path);
  });
});
