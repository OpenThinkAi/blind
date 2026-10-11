import { describe, expect, test } from "bun:test";
import { isJsonNumber, isRecordKey, JsonError, keySegment, MAX_DEPTH, scanJson, scanJsonl, stringOffsets } from "../../src/engine/json.ts";

// Synthetic data only: invented names, example.com, RFC 5737 addresses.
const cols = (tokens: ReturnType<typeof scanJson>) => tokens.map((t) => [t.kind, t.column, t.value]);

describe("scanJson key paths", () => {
  test("snake_case keys under an array of records", () => {
    const text = '{"records": [{"client_scope_name": "Example Widgets", "ref_id": 9123}, {"client_scope_name": "Sample Co"}]}';
    expect(cols(scanJson(text))).toEqual([
      ["key", null, "records"],
      ["key", null, "client_scope_name"],
      ["string", "$.records[*].client_scope_name", "Example Widgets"],
      ["key", null, "ref_id"],
      ["number", "$.records[*].ref_id", "9123"],
      ["key", null, "client_scope_name"],
      ["string", "$.records[*].client_scope_name", "Sample Co"],
    ]);
  });

  test("an object keyed by record IDs is one set of columns, its keys the .*~ column", () => {
    const text = '{"users": {"u-1001": {"name": "Avery Quill"}, "u-1002": {"name": "Robin Example"}}}';
    expect(cols(scanJson(text))).toEqual([
      ["key", null, "users"],
      ["key", "$.users.*~", "u-1001"],
      ["key", null, "name"],
      ["string", "$.users.*.name", "Avery Quill"],
      ["key", "$.users.*~", "u-1002"],
      ["key", null, "name"],
      ["string", "$.users.*.name", "Robin Example"],
    ]);
  });

  test("arrays of scalars, nested arrays, a top-level array and odd keys", () => {
    const text = '[{"tags": ["a", "b"], "grid": [[1, 2]], "first name": "Jo", "": true, "*": null}]';
    expect(scanJson(text).filter((t) => t.kind !== "key").map((t) => t.column)).toEqual([
      "$[*].tags[*]",
      "$[*].tags[*]",
      "$[*].grid[*][*]",
      "$[*].grid[*][*]",
      '$[*]["first name"]',
      '$[*][""]',
      '$[*]["*"]',
    ]);
  });

  test("a scalar document is the column $", () => {
    expect(cols(scanJson(' "x" \n'))).toEqual([["string", "$", "x"]]);
  });

  test("spans cover the token as written; escapes are decoded", () => {
    const text = '{"k": "caf\\u00e9 \\"q\\"", "n": -1.5e3}';
    const [, s, , n] = scanJson(text);
    expect(text.slice(s?.start, s?.end)).toBe('"caf\\u00e9 \\"q\\""');
    expect(s?.value).toBe('café "q"');
    expect(text.slice(n?.start, n?.end)).toBe("-1.5e3");
  });

  test("keys are numbered by object", () => {
    const keys = scanJson('{"a": {"b": 1}, "c": 2}').filter((t) => t.kind === "key");
    expect(keys.map((k) => k.object)).toEqual([0, 1, 0]);
  });

  test.each([
    ["trailing text", '{"a": 1} x', /after the JSON value at line 1, column 10/],
    ["trailing comma", '{"a": 1,}', /expected a key/],
    ["single quotes", "{'a': 1}", /expected a key/],
    ["leading zero", "[01]", /expected ',' or ']'/],
    ["bad escape", '["\\x"]', /bad escape/],
    ["raw newline in a string", '["a\nb"]', /control character/],
    ["unterminated string", '["abc', /unterminated string/],
    ["empty input", "  ", /no JSON value/],
    ["NaN", "[NaN]", /unexpected character/],
  ])("%s is rejected", (_, text, message) => {
    expect(() => scanJson(text)).toThrow(JsonError);
    expect(() => scanJson(text)).toThrow(message);
  });

  test("errors give a position, never the content", () => {
    expect(() => scanJson('{"avery.quill@example.com" 1}')).toThrow(/^expected ':' at line 1, column 28$/);
  });

  test("nesting deeper than the limit is refused, not a stack overflow", () => {
    expect(() => scanJson(`${"[".repeat(MAX_DEPTH + 2)}${"]".repeat(MAX_DEPTH + 2)}`)).toThrow(/nested deeper/);
    expect(scanJson(`${"[".repeat(MAX_DEPTH)}1${"]".repeat(MAX_DEPTH)}`)).toHaveLength(1);
  });
});

describe("scanJsonl", () => {
  test("each line is a document rooted at $; blank lines and CRLF are fine", () => {
    const text = '{"id": "a3f9c2e1"}\r\n\n{"id": 7}\r\n';
    const tokens = scanJsonl(text);
    expect(tokens.filter((t) => t.kind !== "key").map((t) => [t.column, t.value])).toEqual([
      ["$.id", "a3f9c2e1"],
      ["$.id", "7"],
    ]);
    expect(tokens.filter((t) => t.kind === "key").map((t) => t.object)).toEqual([0, 1]);
  });

  test("a bad line is reported by line number", () => {
    expect(() => scanJsonl('{"a": 1}\n{"a": \n')).toThrow(/line 2, column 7/);
  });

  test("a record may not span lines", () => {
    expect(() => scanJsonl('{"a":\n1}\n')).toThrow(JsonError);
  });
});

describe("isRecordKey", () => {
  test.each(["1001", "7", "u-1001", "ACCT-000123", "2026-10-11", "a3f9c2", "123e4567-e89b-12d3-a456-426614174000", "avery@example.com", "192.0.2.10"])(
    "%s is a record identifier",
    (k) => expect(isRecordKey(k)).toBe(true),
  );
  test.each(["client_scope_name", "sha256", "line1", "x509", "First Name", "deadbeef", "", "status"])("%p is a field name", (k) =>
    expect(isRecordKey(k)).toBe(false),
  );
});

describe("helpers", () => {
  test("keySegment quotes anything that is not a plain name", () => {
    expect(keySegment("ref_code")).toBe(".ref_code");
    expect(keySegment("ref-code")).toBe('["ref-code"]');
    expect(keySegment('a"b')).toBe('["a\\"b"]');
  });

  test("stringOffsets maps decoded code units back to the literal", () => {
    expect(stringOffsets('"a\\u00e9\\nb"')).toEqual([1, 2, 8, 10, 11]);
    expect(stringOffsets('""')).toEqual([1]);
  });

  test.each([
    ["9123", true],
    ["-0.5e-3", true],
    ["0123", false],
    ["Id_A1B2", false],
    ["", false],
  ])("isJsonNumber(%p) is %p", (s, want) => expect(isJsonNumber(s)).toBe(want));
});
