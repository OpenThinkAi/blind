import { describe, expect, test } from "bun:test";
import { findRedactValues, redactEntry } from "../../src/engine/redactlist.ts";
import type { Spec } from "../../src/schema.ts";
import { parseSpec, SchemaError } from "../../src/validate.ts";

// The spec's redact list (AGT-2438). Synthetic values only.

const SALT = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 9));
const SECRET = "Zq7%mPlx92";
const CARD = "4111 1111 1111 1111";

describe("findRedactValues", () => {
  const entries = [redactEntry(SALT, SECRET), redactEntry(SALT, CARD)];

  test("finds a listed value at word edges, in any text, and nothing else", () => {
    expect(findRedactValues(["pw: Zq7%mPlx92.", `card ${CARD} ok`], entries, SALT)).toEqual([CARD, SECRET]);
    expect(findRedactValues(["xZq7%mPlx92", "Zq7%mPlx92y"], entries, SALT)).toEqual([]);
    expect(findRedactValues([SECRET], [], SALT)).toEqual([]);
  });

  test("another salt matches nothing", () => {
    expect(findRedactValues([SECRET], entries, Buffer.from("another salt, sixteen+ bytes"))).toEqual([]);
  });

  test("a letter outside the BMP next to the value is a word edge; an emoji is not", () => {
    expect(findRedactValues([`\u{1D400}${SECRET}`, `${SECRET}\u{1D400}`], entries, SALT)).toEqual([]);
    expect(findRedactValues([`\u{1F600}${SECRET}\u{1F600}`], entries, SALT)).toEqual([SECRET]);
  });
});

describe("the redact field in the spec", () => {
  const base: Spec = { version: 1, columns: [], entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: true }, questions: [] };
  const parse = (redact: string[]) => parseSpec(JSON.stringify({ ...base, redact }));

  test("a well-formed entry loads", () => {
    const entry = redactEntry(SALT, SECRET);
    expect(entry).toMatch(/^10:[0-9a-f]{32}$/);
    expect(parse([entry]).redact).toEqual([entry]);
  });

  test("a malformed entry is refused, quoting the pattern and never the value", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    for (const bad of [`0:${hex}`, `10:${hex.toUpperCase()}`, `10:${hex.slice(1)}`, "hunter2"]) {
      let err: unknown;
      try {
        parse([bad]);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SchemaError);
      const msg = (err as SchemaError).message;
      expect(msg).toContain("$.redact[0]: must match");
      expect(msg).toContain("^[1-9][0-9]{0,3}:[0-9a-f]{32}$");
      expect(msg).not.toContain(bad);
    }
  });
});
