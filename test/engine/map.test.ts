import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BlindMap, MapError, type MapEntry, parseMap, readMap, serializeMap, writeMap } from "../../src/engine/map.ts";
import { type PseudoClass, PseudonymError, Pseudonymizer } from "../../src/engine/pseudonym.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

const SAMPLE: [PseudoClass, string][] = [
  ["person", "Ada Lovelace"],
  ["person", "Lovelace, Ada"],
  ["org", "Example Widgets, Inc."],
  ["host", "192.0.2.10"],
  ["host", "app01.corp.example.com"],
  ["host", "fileserver01"],
  ["email", "ada.lovelace@example.com"],
  ["id", "{0F8FAD5B-D9CB-469F-A165-70867728950E}"],
  ["id", "004217"],
  ["id", "AB-12x"],
  ["location", "Springfield"],
  ["value", "zq-7781"],
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-map-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function built(): { p: Pseudonymizer; out: string[] } {
  const p = new Pseudonymizer({ salt: SALT });
  return { p, out: SAMPLE.map(([c, v]) => p.pseudonym(c, v)) };
}

describe("writeMap", () => {
  test("creates the file with mode 0600", () => {
    const path = join(dir, "map.json");
    writeMap(path, built().p.toMap());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("replacing a looser existing file leaves it 0600", () => {
    const path = join(dir, "map.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    writeMap(path, built().p.toMap());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("leaves no temp file behind", () => {
    writeMap(join(dir, "map.json"), built().p.toMap());
    expect(readdirSync(dir)).toEqual(["map.json"]);
  });

  test("output is byte-identical for the same pseudonyms", () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeMap(a, built().p.toMap());
    writeMap(b, built().p.toMap());
    expect(readFileSync(a, "utf8")).toBe(readFileSync(b, "utf8"));
  });
});

describe("round trip", () => {
  test("a reloaded map reproduces every pseudonym without the salt", () => {
    const { p, out } = built();
    const path = join(dir, "map.json");
    writeMap(path, p.toMap());
    const reloaded = new Pseudonymizer({ map: readMap(path) });
    expect(SAMPLE.map(([c, v]) => reloaded.pseudonym(c, v))).toEqual(out);
  });

  test("shaped pseudonyms rebuild from recorded components", () => {
    const p = new Pseudonymizer({ salt: SALT });
    const host = p.pseudonym("host", "app01.corp.example.com");
    const reloaded = new Pseudonymizer({ map: p.toMap() });
    // A host never seen whole, built only from labels the map already holds.
    const other = new Pseudonymizer({ salt: SALT });
    other.pseudonym("host", "app01.corp.example.com");
    expect(reloaded.pseudonym("host", "corp.example.com")).toBe(other.pseudonym("host", "corp.example.com"));
    expect(reloaded.pseudonym("host", "app01.corp.example.com")).toBe(host);
  });

  test("a value not in the map, with no salt, throws", () => {
    const reloaded = new Pseudonymizer({ map: built().p.toMap() });
    expect(() => reloaded.pseudonym("person", "Bo Quill")).toThrow(PseudonymError);
  });

  test("with the salt, new values never reuse a mapped pseudonym", () => {
    const { p, out } = built();
    const next = new Pseudonymizer({ salt: SALT, map: p.toMap() });
    const fresh = Array.from({ length: 2000 }, (_, i) => next.pseudonym("person", `Synthetic Person ${i}`));
    for (const o of out) expect(fresh).not.toContain(o);
  });

  test("the map records one surface form for reveal, whichever order they were seen in", () => {
    const want: MapEntry = { kind: "person", canonical: "ada lovelace", value: "Ada Lovelace", pseudonym: "Person_D03F" };
    for (const order of [["Ada Lovelace", "Lovelace, Ada"], ["Lovelace, Ada", "Ada Lovelace"]]) {
      const p = new Pseudonymizer({ salt: SALT });
      for (const v of order) p.pseudonym("person", v);
      expect(p.toMap().entries).toEqual([want]);
    }
  });

  test("entries are sorted by kind then canonical, independent of insertion order", () => {
    const a = new Pseudonymizer({ salt: SALT });
    const b = new Pseudonymizer({ salt: SALT });
    for (const [c, v] of SAMPLE) a.pseudonym(c, v);
    for (const [c, v] of [...SAMPLE].reverse()) b.pseudonym(c, v);
    expect(serializeMap(b.toMap())).toBe(serializeMap(a.toMap()));
    const keys = a.toMap().entries.map((e) => `${e.kind}\0${e.canonical}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("parseMap", () => {
  const good = (): BlindMap => built().p.toMap();
  const reject = (doc: unknown, msg: RegExp) =>
    expect(() => parseMap(typeof doc === "string" ? doc : JSON.stringify(doc))).toThrow(msg);

  test("accepts its own serialisation", () => {
    const map = good();
    expect(parseMap(serializeMap(map))).toEqual(map);
  });

  test("rejects invalid JSON without quoting the content", () => {
    try {
      parseMap('{"version": 1, "entries": [Ada Lovelace]}');
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MapError);
      expect((err as Error).message).not.toContain("Ada");
    }
  });

  test("rejects a non-object top level", () => reject([], /expected an object/));
  test("rejects a wrong version", () => reject({ version: 2, entries: [] }, /version must be 1/));
  test("rejects unknown top-level fields", () => reject({ version: 1, entries: [], salt: "x" }, /unknown field 'salt'/));
  test("rejects non-array entries", () => reject({ version: 1, entries: {} }, /entries must be an array/));

  test("rejects unknown entry fields", () => {
    const map = good();
    reject({ ...map, entries: [{ ...map.entries[0], extra: 1 }] }, /entries\[0\]: unknown field 'extra'/);
  });

  test("rejects a wrong field type", () => {
    const map = good();
    reject({ ...map, entries: [{ ...map.entries[0], pseudonym: 7 }] }, /entries\[0\]\.pseudonym: expected a string/);
  });

  test("rejects an unknown kind", () => {
    const map = good();
    reject({ ...map, entries: [{ ...map.entries[0], kind: "ssn" }] }, /entries\[0\]\.kind/);
  });

  test("rejects an empty pseudonym", () => {
    const map = good();
    reject({ ...map, entries: [{ ...map.entries[0], pseudonym: "" }] }, /must not be empty/);
  });

  test("rejects duplicate keys", () => {
    const e = good().entries[0];
    reject({ version: 1, entries: [e, { ...e, pseudonym: "Person_0000" }] }, /entries\[1\]: duplicate/);
  });

  test("rejects one pseudonym issued to two values", () => {
    const e = good().entries[0];
    reject({ version: 1, entries: [e, { ...e, canonical: "bo quill" }] }, /entries\[1\]\.pseudonym: already used/);
  });

  test("readMap names the file in errors", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{}");
    expect(() => readMap(path)).toThrow(path);
  });
});
