import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { type EraseIO, runForget, runPurge } from "../src/forget.ts";
import { runReveal } from "../src/reveal.ts";

// Synthetic corpus only (invented names, example.com, RFC 5737 IPs).
const SPEC = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Box", class: "host", treatment: "blind", confidence: 1, source: "human" },
  ],
  entities: {
    person: [
      { canonical: "Avery Quill", aliases: ["A. Quill"], parts: ["Avery", "Quill"] },
      { canonical: "Robin Quill", aliases: [], parts: ["Robin", "Quill"] },
    ],
  },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const STAFF = "Owner,Box\nAvery Quill,app01.corp.example.com\nRobin Quill,192.0.2.10\n";
const NOTE = "Avery Quill met Robin Quill at app01.corp.example.com. Quill signed.\n";
const PROFILE = {
  version: 1,
  sampleCount: 3,
  files: [
    { path: "staff.csv", format: "csv", size: 60 },
    { path: "note.md", format: "markdown", size: 40 },
  ],
  tables: [
    {
      file: "staff.csv",
      headerRow: 1,
      columns: [
        {
          header: "Owner",
          stats: {
            count: 2, distinctRatio: 1, digitRatio: 0, dictionaryRatio: 0, meanLength: 11,
            detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0 },
            samples: ["Avery Quill", "Robin Quill"],
          },
        },
      ],
    },
  ],
  jsonKeys: [],
  documents: [{ file: "note.md", outline: [], sampleSentences: ["Avery Quill met Robin Quill.", "The demo moved."] }],
  transcripts: [],
  cooccurrence: [],
};

let dir: string;
const blind = (...p: string[]) => join(dir, ".blind", ...p);
const mapValues = () => (JSON.parse(readFileSync(blind("map.json"), "utf8")) as { entries: { value: string }[] }).entries.map((e) => e.value);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "blind-forget-"));
  mkdirSync(blind(), { mode: 0o700 });
  writeFileSync(blind("salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)), { mode: 0o600 });
  writeFileSync(blind("spec.json"), JSON.stringify(SPEC));
  writeFileSync(blind("profile.json"), JSON.stringify(PROFILE));
  mkdirSync(join(dir, "in"));
  writeFileSync(join(dir, "in", "staff.csv"), STAFF);
  writeFileSync(join(dir, "in", "note.md"), NOTE);
  expect(await runApply(["in", "-o", "out"], { out: new PassThrough(), err: new PassThrough(), cwd: dir })).toBe(0);
  expect(await runReveal(["out"], { out: new PassThrough(), err: new PassThrough(), cwd: dir })).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function call(run: (a: string[], io: EraseIO) => Promise<number>, argv: string[], answer?: string | null) {
  const out = new PassThrough();
  const err = new PassThrough();
  let o = "";
  let e = "";
  out.on("data", (d) => (o += d));
  err.on("data", (d) => (e += d));
  const io: EraseIO = { out, err, cwd: dir };
  if (answer !== undefined) io.prompt = async () => answer;
  const code = await run(argv, io);
  return { code, out: o, err: e };
}

const snapshot = () =>
  ["spec.json", "map.json", "profile.json"].map((f) => readFileSync(blind(f), "utf8")).join("\n") + readdirSync(blind("revealed")).join(",");

test("forget removes the subject from map, spec and profile, keeps shared parts, and deletes revealed files", async () => {
  expect(mapValues()).toContain("Avery Quill");
  const r = await call(runForget, ["avery  QUILL", "--yes"]);
  expect(r.code).toBe(0);
  // Nothing printed names the value.
  expect(r.out + r.err).not.toContain("Avery");

  const spec = JSON.parse(readFileSync(blind("spec.json"), "utf8"));
  expect(spec.entities.person.map((e: { canonical: string }) => e.canonical)).toEqual(["Robin Quill"]);
  expect(statSync(blind("spec.json")).mode & 0o777).toBe(0o600);

  const values = mapValues();
  expect(values).not.toContain("Avery Quill");
  expect(values).not.toContain("Avery");
  expect(values).toContain("Robin Quill");
  // "Quill" is still a part of Robin Quill, so its entry stays; "Avery" was only Avery Quill's.
  expect(values).toContain("Quill");
  expect(statSync(blind("map.json")).mode & 0o777).toBe(0o600);

  const profile = JSON.parse(readFileSync(blind("profile.json"), "utf8"));
  expect(profile.tables[0].columns[0].stats.samples).toEqual(["Robin Quill"]);
  expect(profile.documents[0].sampleSentences).toEqual(["The demo moved."]);

  expect(existsSync(blind("revealed"))).toBe(false);
  // Revealing again leaves the forgotten subject pseudonymised and restores the rest.
  expect(await runReveal(["out"], { out: new PassThrough(), err: new PassThrough(), cwd: dir })).toBe(0);
  const note = readFileSync(blind("revealed", "note.md"), "utf8");
  expect(note).toContain("Robin Quill");
  expect(note).not.toContain("Avery");
});

test("the shared part is recorded before forget, so keeping it is a real check", () => {
  expect(mapValues()).toContain("Quill");
});

test("forget by alias removes the whole entity", async () => {
  expect((await call(runForget, ["A. Quill", "-y"])).code).toBe(0);
  expect(JSON.parse(readFileSync(blind("spec.json"), "utf8")).entities.person).toHaveLength(1);
  expect(mapValues()).not.toContain("Avery Quill");
});

test("forget a value that is only in the map (a host)", async () => {
  expect(mapValues()).toContain("app01.corp.example.com");
  expect((await call(runForget, ["app01.corp.example.com", "--yes"])).code).toBe(0);
  expect(mapValues()).not.toContain("app01.corp.example.com");
  expect(JSON.parse(readFileSync(blind("spec.json"), "utf8")).entities.person).toHaveLength(2);
});

test("forget without --yes and no terminal changes nothing (exit 2), and lists what it would remove", async () => {
  const before = snapshot();
  const r = await call(runForget, ["Avery Quill"]);
  expect(r.code).toBe(2);
  expect(r.out).toContain("map.json");
  expect(r.err).toContain("--yes");
  expect(snapshot()).toBe(before);
});

test("forget asks at a terminal: only 'yes' goes ahead", async () => {
  const before = snapshot();
  expect((await call(runForget, ["Avery Quill"], "no")).code).toBe(2);
  expect((await call(runForget, ["Avery Quill"], null)).code).toBe(2);
  expect(snapshot()).toBe(before);
  expect((await call(runForget, ["Avery Quill"], "yes")).code).toBe(0);
  expect(mapValues()).not.toContain("Avery Quill");
});

test("forget a value nothing records: exit 1, nothing changed, revealed files kept", async () => {
  const before = ["spec.json", "map.json", "profile.json"].map((f) => readFileSync(blind(f), "utf8"));
  const r = await call(runForget, ["Sam Placeholder", "--yes"]);
  expect(r.code).toBe(1);
  expect(["spec.json", "map.json", "profile.json"].map((f) => readFileSync(blind(f), "utf8"))).toEqual(before);
  expect(existsSync(blind("revealed"))).toBe(true);
});

test("forget refuses an empty value and an invalid spec without changing anything", async () => {
  expect((await call(runForget, ["  ", "--yes"])).code).toBe(2);
  expect((await call(runForget, ["--yes"])).code).toBe(2);
  writeFileSync(blind("spec.json"), '{"version": 2}');
  const map = readFileSync(blind("map.json"), "utf8");
  const r = await call(runForget, ["Avery Quill", "--yes"]);
  expect(r.code).toBe(2);
  expect(readFileSync(blind("map.json"), "utf8")).toBe(map);
  expect(existsSync(blind("revealed"))).toBe(true);
});

test("forget says when the value is still in spec.json outside the entities (exit 1)", async () => {
  const spec = { ...SPEC, questions: [{ id: "q1", text: "Is Avery Quill a person?", options: ["blind", "keep"], answer: null }] };
  writeFileSync(blind("spec.json"), JSON.stringify(spec));
  const r = await call(runForget, ["Avery Quill", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("still in");
  expect(r.err).not.toContain("Avery");
  expect(mapValues()).not.toContain("Avery Quill");
});

test("forget deletes a profile whose names contain the value, and a run record whose paths do", async () => {
  const profile = { ...PROFILE, files: [...PROFILE.files, { path: "Avery Quill.md", format: "markdown", size: 1 }] };
  writeFileSync(blind("profile.json"), JSON.stringify(profile));
  writeFileSync(blind("run.json"), JSON.stringify({ version: 1, out: "out", rounds: 1, exit: 0, audit: null, inputs: [{ input: "Avery Quill.md", output: "Person_X.md", audit: null }] }));
  expect((await call(runForget, ["Avery Quill", "--yes"])).code).toBe(0);
  expect(existsSync(blind("profile.json"))).toBe(false);
  expect(existsSync(blind("run.json"))).toBe(false);
});

test("purge removes map, profile, run record and revealed files; keeps salt and spec; reveal then refuses", async () => {
  writeFileSync(blind("run.json"), "{}");
  const r = await call(runPurge, ["--yes"]);
  expect(r.code).toBe(0);
  for (const f of ["map.json", "profile.json", "run.json", "revealed"]) expect(existsSync(blind(f))).toBe(false);
  expect(existsSync(blind("salt"))).toBe(true);
  expect(existsSync(blind("spec.json"))).toBe(true);
  const err = new PassThrough();
  let e = "";
  err.on("data", (d) => (e += d));
  expect(await runReveal(["out"], { out: new PassThrough(), err, cwd: dir })).toBe(2);
  expect(e).toContain("not found");
  // Nothing left: purge again is a no-op, exit 0.
  const again = await call(runPurge, []);
  expect(again.code).toBe(0);
  expect(again.out).toContain("nothing to purge");
});

test("purge without confirmation removes nothing", async () => {
  expect((await call(runPurge, [])).code).toBe(2);
  expect((await call(runPurge, [], "nope")).code).toBe(2);
  expect(existsSync(blind("map.json"))).toBe(true);
  expect(existsSync(blind("revealed"))).toBe(true);
  expect((await call(runPurge, [], "yes")).code).toBe(0);
  expect(existsSync(blind("map.json"))).toBe(false);
});

test("purge --map refuses a file that is not a map", async () => {
  writeFileSync(join(dir, "notes.txt"), "keep me");
  const r = await call(runPurge, ["--map", "notes.txt", "--yes"]);
  expect(r.code).toBe(2);
  expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  expect(existsSync(blind("profile.json"))).toBe(true);
});

test("purge refuses positional arguments", async () => {
  expect((await call(runPurge, ["out", "--yes"])).code).toBe(2);
  expect(existsSync(blind("map.json"))).toBe(true);
});

test("a value only in the spec outside entities: forget says it is still there (exit 1), nothing changed", async () => {
  const spec = { ...SPEC, questions: [{ id: "q1", text: "Is Sam Placeholder a person?", options: ["blind", "keep"], answer: null }] };
  writeFileSync(blind("spec.json"), JSON.stringify(spec));
  const before = readFileSync(blind("spec.json"), "utf8");
  const r = await call(runForget, ["Sam Placeholder", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("value 1 is still in");
  expect(r.err).not.toContain("Sam");
  expect(readFileSync(blind("spec.json"), "utf8")).toBe(before);
  expect(existsSync(blind("revealed"))).toBe(true);
});

test("a run.json that is not JSON is searched as text and deleted when it names the value", async () => {
  writeFileSync(blind("run.json"), "{ broken Avery Quill");
  expect((await call(runForget, ["Avery Quill", "--yes"])).code).toBe(0);
  expect(existsSync(blind("run.json"))).toBe(false);
});

test("purge also removes temp copies an interrupted write left, and does not follow a revealed symlink", async () => {
  writeFileSync(blind("map.json.tmp-123"), "{}");
  writeFileSync(blind("profile.json.tmp"), "{}");
  rmSync(blind("revealed"), { recursive: true });
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere", "keep.txt"), "x");
  symlinkSync(join(dir, "elsewhere"), blind("revealed"));
  expect((await call(runPurge, ["--yes"])).code).toBe(0);
  expect(existsSync(blind("map.json.tmp-123"))).toBe(false);
  expect(existsSync(blind("profile.json.tmp"))).toBe(false);
  expect(existsSync(blind("revealed"))).toBe(false);
  expect(readFileSync(join(dir, "elsewhere", "keep.txt"), "utf8")).toBe("x");
});
