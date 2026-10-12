import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { buildDocument, buildWorkbook } from "../src/bench/office.ts";

// AGT-1847: a value of a `redact`, `drop` or credential (`blind` + `secret`) column is never written to
// map.json, and where it recurs in other files it is the redaction placeholder, not a pseudonym.
// The test reads the written map.json bytes. Synthetic values only.
const CARD = "4000 0000 0000 0002";
const OWNER = "Marlow Quillfeather";
const TOKEN = "TOK-88213";
const KEY = "zx-5518-qq";
const SECRETS = [CARD, "4000000000000002", OWNER, "Marlow", "Quillfeather", TOKEN, KEY];

const col = (file: string, header: string, treatment: string, cls: string, extra: object = {}) => ({ file, header, class: cls, treatment, confidence: 1, source: "human", ...extra });
const SPEC = {
  version: 1,
  columns: [
    col("pay.csv", "pay_card", "blind", "secret"),
    col("pay.csv", "client", "keep", "vocabulary"),
    col("owners.tsv", "owner", "drop", "person"),
    col("owners.tsv", "pet", "keep", "vocabulary"),
    { file: "keys.json", jsonPath: "$.api", class: "secret", treatment: "redact", confidence: 1, source: "human" },
    { file: "keys.json", jsonPath: "$.pet", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
    col("vault.xlsx", "Token", "drop", "id", { sheet: "Vault" }),
    col("vault.xlsx", "Pet", "keep", "vocabulary", { sheet: "Vault" }),
    col("recur.xlsx", "Note", "keep", "vocabulary", { sheet: "Notes" }),
  ],
  entities: {},
  patterns: { ip: false, email: false, host: false, guid: false, mac: false, phone: false },
  questions: [],
};

let dir: string;
const sink = (): [PassThrough, () => string] => {
  const s = new PassThrough();
  let text = "";
  s.on("data", (d) => (text += d));
  return [s, () => text];
};
const read = (...p: string[]) => readFileSync(join(dir, ...p));
const run = async () => {
  const [out, outText] = sink();
  const [err, errText] = sink();
  const code = await runApply(["in", "-o", "out"], { out, err, cwd: dir });
  return { code, out: outText(), err: errText() };
};
const wb = (rows: (string | number)[][], name: string) =>
  buildWorkbook({ sheets: [{ name, rows }], orphans: [], definedNames: [], core: { title: "", creator: "", modifiedBy: "" } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-removed-map-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
  mkdirSync(join(dir, "in"));
  const f = (name: string, data: string | Uint8Array) => writeFileSync(join(dir, "in", name), data);
  f("pay.csv", `client,pay_card\nAcme Pets,${CARD}\n`);
  f("owners.tsv", `owner\tpet\n${OWNER}\tBiscuit\n`);
  f("keys.json", `{"api": "${KEY}", "pet": "Biscuit"}\n`);
  f("vault.xlsx", wb([["Token", "Pet"], [TOKEN, "Biscuit"]], "Vault"));
  f("sync.log", `sync ok card_no=${CARD} owner=${OWNER} surname=Quillfeather token=${TOKEN} key=${KEY}\n`);
  f("notes.json", JSON.stringify({ note: `${OWNER} paid with ${CARD}; badge ${TOKEN}; key ${KEY}`, pet: "Biscuit" }));
  f("recur.xlsx", wb([["Note"], [`${OWNER} used ${CARD} and ${TOKEN}`]], "Notes"));
  f("memo.docx", buildDocument([[`Call ${OWNER} about card ${CARD}, badge ${TOKEN}, key ${KEY}.`]], { title: "", creator: "", modifiedBy: "" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("values of redact/drop/secret columns stay out of map.json (AGT-1847)", () => {
  test("the written map.json bytes hold none of them, and every recurrence is the placeholder", async () => {
    const r = await run();
    expect(r.code).toBe(0);
    const map = read(".blind", "map.json");
    const mapText = text(map);
    const mapFold = mapText.toLowerCase();
    for (const s of SECRETS) {
      expect(mapText).not.toContain(s);
      expect(mapFold).not.toContain(s.toLowerCase());
    }
    // The raw bytes too: no UTF-8 or UTF-16 spelling of a value.
    for (const s of SECRETS) {
      expect(Buffer.from(map).includes(Buffer.from(s, "utf8"))).toBe(false);
      expect(Buffer.from(map).includes(Buffer.from(s, "utf16le"))).toBe(false);
    }
    expect(JSON.parse(mapText).entries.filter((e: { kind: string }) => e.kind === "person")).toEqual([]);
    // Recurrences: written as REDACTED in text, JSON and XLSX (the DOCX is zipped, checked below).
    const log = read("out", "sync.log").toString("utf8");
    expect(log).toContain("card_no=REDACTED");
    for (const s of SECRETS) expect(log).not.toContain(s);
    expect(log).not.toMatch(/(Value|Person|Id)_[0-9A-F]{4}/);
    const notes = read("out", "notes.json").toString("utf8");
    for (const s of SECRETS) expect(notes).not.toContain(s);
    expect(notes).not.toMatch(/(Value|Person|Id)_[0-9A-F]{4}/);
    expect(notes).toContain("REDACTED");
    for (const f of ["memo.docx", "recur.xlsx", "vault.xlsx"]) {
      const b = text(read("out", f));
      for (const s of SECRETS) expect(b).not.toContain(s);
    }
    expect(text(read("out", "memo.docx"))).toContain("REDACTED");
    expect(r.out).toContain("from dropped/redacted columns replaced where");
    expect(r.out).toContain("redaction placeholder");
  });

  test("an unruled cell that is exactly a removed value is redacted, not pseudonymised or mapped", async () => {
    writeFileSync(join(dir, "in", "loose.json"), JSON.stringify({ misc: TOKEN }));
    writeFileSync(join(dir, "in", "loose.csv"), `misc\n${TOKEN}\n`);
    const r = await run();
    expect(r.code).toBe(0);
    for (const f of ["loose.json", "loose.csv"]) {
      const o = read("out", f).toString("utf8");
      expect(o).toContain("REDACTED");
      expect(o).not.toContain(TOKEN);
      expect(o).not.toMatch(/(Id|Value|Person)_[0-9A-F]{4}/);
    }
    expect(read(".blind", "map.json").toString("utf8").toLowerCase()).not.toContain(TOKEN.toLowerCase());
  });

  test("reveal leaves the placeholder in place", async () => {
    await run();
    const [out] = sink();
    const [err] = sink();
    const { runReveal } = await import("../src/reveal.ts");
    expect(await runReveal(["out", "-o", "back"], { out, err, cwd: dir })).toBe(0);
    const log = read("back", "sync.log").toString("utf8");
    expect(log).toContain("card_no=REDACTED");
    expect(log).not.toContain(CARD);
  });

  test("a value a non-secret blind column also pseudonymises keeps its pseudonym (the pseudonym wins)", async () => {
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify({ ...SPEC, columns: [...SPEC.columns, col("ref.csv", "token", "blind", "id")] }));
    writeFileSync(join(dir, "in", "ref.csv"), `token\n${TOKEN}\n`);
    await run();
    const log = read("out", "sync.log").toString("utf8");
    expect(log).toMatch(/token=Id_[0-9A-F]{4}/);
    expect(log).not.toContain(TOKEN);
    expect(readFileSync(join(dir, ".blind", "map.json"), "utf8")).not.toContain(CARD);
  });

  test("an earlier map holding such entries loses them on the next write, with a warning that has no values", async () => {
    const entry = (kind: string, canonical: string, value: string, pseudonym: string) => ({ kind, canonical, value, pseudonym });
    writeFileSync(
      join(dir, ".blind", "map.json"),
      JSON.stringify({ version: 1, entries: [entry("value", CARD, CARD, "Value_C85C"), entry("person", "marlow quillfeather", OWNER, "Person_1A2B"), entry("id", TOKEN.toLowerCase(), TOKEN, "Id_9F00")] }),
      { mode: 0o600 },
    );
    const r = await run();
    expect(r.code).toBe(0);
    const mapText = readFileSync(join(dir, ".blind", "map.json"), "utf8");
    for (const s of SECRETS) expect(mapText.toLowerCase()).not.toContain(s.toLowerCase());
    expect(r.err).toContain("dropped 3 map entries");
    for (const s of SECRETS) expect(r.err).not.toContain(s);
    expect(read("out", "sync.log").toString("utf8")).toContain("card_no=REDACTED");
  });
});
