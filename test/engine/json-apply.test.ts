import { describe, expect, test } from "bun:test";
import { ApplyError, type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic salt and data only: invented names, example.com, RFC 5737 addresses, obviously fake IDs.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);

const rule = (file: string, jsonPath: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  jsonPath,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns: [],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
  ...over,
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const run = (inputs: InputFile[], s: Spec = spec()) => applySpec(inputs, s, { salt: SALT });
const out = (r: ApplyResult, path: string): string => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`no output ${path}`);
  return Buffer.from(o.bytes).toString("utf8");
};
const col = (r: ApplyResult, path: string, jsonPath: string) => r.files.find((f) => f.path === path)?.columns.find((c) => c.jsonPath === jsonPath);

describe("JSON values honour their key path's class", () => {
  const text = '{"items": [{"id": "9123", "owner": "Avery Quill"}, {"id": 9123, "owner": "Robin Example"}, {"id": 4471, "owner": "Avery Quill"}]}\n';
  const s = spec({ columns: [rule("t.json", "$.items[*].id", "id", "blind"), rule("t.json", "$.items[*].owner", "person", "blind")] });

  test('the string "9123" and the number 9123 get the same numeric pseudonym; types are kept', () => {
    const r = run([file("t.json", text)], s);
    const doc = JSON.parse(out(r, "t.json"));
    const [a, b, c] = doc.items;
    expect(typeof a.id).toBe("string");
    expect(typeof b.id).toBe("number");
    expect(String(b.id)).toBe(a.id);
    expect(a.id).toMatch(/^[1-9]\d{3}$/);
    expect(a.id).not.toBe("9123");
    expect(c.id).not.toBe(b.id);
    expect(a.owner).toMatch(/^Person_[0-9A-F]{4}$/);
    expect(c.owner).toBe(a.owner);
    expect(out(r, "t.json")).not.toMatch(/Avery|Robin|9123|4471/);
    expect(col(r, "t.json", "$.items[*].id")).toMatchObject({ outcome: "blinded", changed: 3 });
  });

  test("a number whose pseudonym is not a number is written as a string", () => {
    const s = spec({ columns: [rule("t.json", "$.score", "id", "blind"), rule("t.json", "$.n", "vocabulary", "keep")] });
    const r = run([file("t.json", '{"score": 12.5, "n": 7}')], s);
    const doc = JSON.parse(out(r, "t.json"));
    expect(doc.score).toMatch(/^Id_[0-9A-F]{4}$/);
    expect(doc.n).toBe(7);
  });

  test("with no rule, a numeric key path fails closed like a numeric CSV column", () => {
    const r = run([file("t.json", '{"n": [101, 102, 103]}')]);
    for (const v of JSON.parse(out(r, "t.json")).n) expect(v).toMatch(/^Value_[0-9A-F]{4}$/);
  });

  test("true, false and null are left alone", () => {
    const r = run([file("t.json", '{"id": null, "x": [true, false]}')], spec({ columns: [rule("t.json", "$.id", "id", "blind")] }));
    expect(out(r, "t.json")).toBe('{"id": null, "x": [true, false]}');
  });
});

describe("record-keyed objects", () => {
  const text = [
    "{",
    '  "users": {',
    '    "u-1001": { "name": "Avery Quill", "manager": "u-1002" },',
    '    "u-1002": { "name": "Robin Example", "manager": null }',
    "  }",
    "}",
    "",
  ].join("\n");

  test("keys that are IDs are rewritten, consistently with the same ID as a value", () => {
    const s = spec({
      columns: [
        rule("u.json", "$.users.*~", "id", "blind"),
        rule("u.json", "$.users.*.manager", "id", "blind"),
        rule("u.json", "$.users.*.name", "person", "blind"),
      ],
    });
    const r = run([file("u.json", text)], s);
    const written = out(r, "u.json");
    expect(written).not.toMatch(/u-1001|u-1002|Avery|Robin/);
    const doc = JSON.parse(written);
    const ids = Object.keys(doc.users);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^Id_[0-9A-F]{4}$/);
    expect(doc.users[ids[0] as string].manager).toBe(ids[1]);
    // Layout untouched: same line count and indentation.
    expect(written.split("\n").map((l) => l.match(/^ */)?.[0].length)).toEqual(text.split("\n").map((l) => l.match(/^ */)?.[0].length));
  });

  test("with no rule, identifier-like keys fail closed to Value_ pseudonyms", () => {
    const r = run([file("u.json", text)]);
    const doc = JSON.parse(out(r, "u.json"));
    for (const id of Object.keys(doc.users)) expect(id).toMatch(/^Value_[0-9A-F]{4}$/);
    expect(col(r, "u.json", "$.users.*~")).toMatchObject({ outcome: "unknown-pseudonymised", treatment: null });
  });

  test("two keys that would become one are refused, not merged", () => {
    const s = spec({ columns: [rule("d.json", "$.*~", "id", "blind")] });
    expect(() => run([file("d.json", '{"U-1001": 1, "u-1001": 2}')], s)).toThrow(/two keys of one object the same name/);
  });
});

describe("unknown key paths fail closed", () => {
  const records = Array.from({ length: 8 }, (_, i) => ({
    ref_code: `${(0xa3f9c2 + i * 977).toString(16)}`,
    status: i % 2 === 0 ? "open" : "closed",
    note: "the box was moved to the back room",
  }));
  const text = `${JSON.stringify({ records }, null, "\t")}\n`;

  test("identifier-like hex IDs become Value_; a status enum and prose are kept", () => {
    const r = run([file("r.json", text)]);
    const doc = JSON.parse(out(r, "r.json"));
    for (const rec of doc.records) expect(rec.ref_code).toMatch(/^Value_[0-9A-F]{4}$/);
    expect(doc.records.map((x: { status: string }) => x.status)).toEqual(records.map((x) => x.status));
    expect(col(r, "r.json", "$.records[*].ref_code")?.outcome).toBe("unknown-pseudonymised");
    expect(col(r, "r.json", "$.records[*].status")?.outcome).toBe("unknown-kept-low-cardinality");
    expect(out(r, "r.json").startsWith('{\n\t"records": [\n\t\t{\n')).toBe(true);
    expect(out(r, "r.json").endsWith("}\n")).toBe(true);
  });

  test("class unknown with treatment value applies the same test", () => {
    const r = run([file("r.json", text)], spec({ columns: [rule("r.json", "$.records[*].status", "unknown", "value")] }));
    expect(col(r, "r.json", "$.records[*].status")).toMatchObject({ outcome: "unknown-kept-low-cardinality", treatment: "value" });
  });
});

describe("free text, keys and kept values", () => {
  const people = { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] };

  test("entities and patterns are replaced in kept-by-heuristic strings, keeping untouched escapes", () => {
    const text = '{"note": "caf\\u00e9 with Avery at 192.0.2.10\\n"}';
    const r = run([file("n.json", text)], spec({ entities: people }));
    const written = out(r, "n.json");
    expect(written).toMatch(/^\{"note": "caf\\u00e9 with Person_[0-9A-F]{4} at \d+\.\d+\.\d+\.\d+\\n"\}$/);
    expect(written).not.toContain("192.0.2.10");
    expect(r.files[0]).toMatchObject({ entityReplacements: 1, patternReplacements: 1 });
  });

  test("field names are free text too", () => {
    const r = run([file("k.json", '{"Avery": {"role": "lead"}}')], spec({ entities: people }));
    expect(out(r, "k.json")).toMatch(/^\{"Person_[0-9A-F]{4}": \{"role": "lead"\}\}$/);
  });

  test("keep leaves values byte-identical and flags spec matches", () => {
    const text = '{"who": ["Avery Quill", "nobody"]}';
    const r = run([file("w.json", text)], spec({ entities: people, columns: [rule("w.json", "$.who[*]", "vocabulary", "keep")] }));
    expect(out(r, "w.json")).toBe(text);
    expect(col(r, "w.json", "$.who[*]")).toMatchObject({ outcome: "kept", flagged: 1 });
    expect(r.files[0]?.changed).toBe(false);
  });
});

describe("output fidelity", () => {
  test("a file with nothing to replace is returned byte for byte", () => {
    const text = '{ "a" :1 ,\r\n  "b":[ true , null ] }';
    const input = file("same.json", text);
    const r = run([input], spec({ columns: [rule("same.json", "$.a", "vocabulary", "keep")] }));
    expect(r.outputs[0]?.bytes).toBe(input.bytes);
  });

  test("JSONL stays one record per line, with its line endings and blank lines", () => {
    const text = '{"email": "avery@example.com", "n": 1}\r\n\r\n{"email": "robin@example.org", "n": 2}\r\n';
    const s = spec({ columns: [rule("e.jsonl", "$.email", "email", "blind"), rule("e.jsonl", "$.n", "vocabulary", "keep")] });
    const r = run([file("e.jsonl", text)], s);
    const written = out(r, "e.jsonl");
    const lines = written.split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe("");
    expect(JSON.parse(lines[0] as string).email).toMatch(/^user_[0-9a-f]{4}@/);
    expect(JSON.parse(lines[2] as string).n).toBe(2);
    expect(written).not.toMatch(/avery|robin/);
    expect(r.files[0]?.format).toBe("jsonl");
  });

  test("the same inputs give the same bytes, in any input order", () => {
    const a = file("a.json", '{"id": "u-1001", "peer": "u-1002"}');
    const b = file("b.jsonl", '{"id": "u-1002"}\n{"id": "u-1003"}\n');
    const s = spec({ columns: [rule("a.json", "$.id", "id", "blind"), rule("a.json", "$.peer", "id", "blind"), rule("b.jsonl", "$.id", "id", "blind")] });
    const one = run([a, b], s);
    const two = run([b, a], s);
    expect(out(two, "a.json")).toBe(out(one, "a.json"));
    expect(out(two, "b.jsonl")).toBe(out(one, "b.jsonl"));
    expect(JSON.parse(out(one, "a.json")).peer).toBe(JSON.parse(out(one, "b.jsonl").split("\n")[0] as string).id);
  });
});

describe("refusals", () => {
  test("a rule for a key path the file does not have is an error", () => {
    const s = spec({ columns: [rule("t.json", "$.items[*].ownr", "person", "blind")] });
    expect(() => run([file("t.json", '{"items": [{"owner": "x"}]}')], s)).toThrow(ApplyError);
    expect(() => run([file("t.json", '{"items": [{"owner": "x"}]}')], s)).toThrow(/key path "\$\.items\[\*\]\.ownr"/);
  });

  test("a key path holding only nulls still exists", () => {
    const s = spec({ columns: [rule("t.json", "$.owner", "person", "blind")] });
    expect(out(run([file("t.json", '{"owner": null}')], s), "t.json")).toBe('{"owner": null}');
  });

  test("a header rule on a JSON file is an error", () => {
    const s = spec({ columns: [{ file: "t.json", header: "owner", class: "person", treatment: "blind", confidence: 1, source: "human" }] });
    expect(() => run([file("t.json", "{}")], s)).toThrow(/jsonPath/);
  });

  test("malformed JSON is reported and not written", () => {
    const r = run([file("bad.json", '{"a": [1, 2}'), file("bad.jsonl", '{"a": 1}\n{"a": \n')]);
    expect(r.outputs).toEqual([]);
    expect(r.skipped).toEqual([
      { path: "bad.json", reason: "malformed JSON: expected ',' or ']' at line 1, column 12; not written" },
      { path: "bad.jsonl", reason: "malformed JSONL: unexpected end of input at line 2, column 7; not written" },
    ]);
  });
});
