import { describe, expect, test } from "bun:test";
import type { BlindMap } from "../../src/engine/map.ts";
import { isPseudonym, Pseudonymizer } from "../../src/engine/pseudonym.ts";

// A shape alone is not a pseudonym when there is a map to ask (AGT-2452). Synthetic values only.

const SALT = new Uint8Array(32).fill(7);

describe("isPseudonym asks the map", () => {
  test("shapes the map did not issue are real values", () => {
    const empty: BlindMap = { version: 1, entries: [] };
    for (const s of ["Person_1A2B", "[Client A #1A2B]", "host-1a2b.net", "user_1a2b@host-3c4d.com", "203.0.113.9"]) {
      expect(isPseudonym(s, empty)).toBe(false);
      expect(isPseudonym(s)).toBe(true);
    }
  });

  test("a host or email built from issued labels and local parts counts", () => {
    const map: BlindMap = {
      version: 1,
      entries: [
        { kind: "host-label", canonical: "db01", value: "db01", pseudonym: "host-1a2b" },
        { kind: "host-label", canonical: "corp", value: "corp", pseudonym: "host-3c4d" },
        { kind: "email-local", canonical: "dana", value: "dana", pseudonym: "user_5e6f" },
      ],
    };
    expect(isPseudonym("host-1a2b.host-3c4d.example", map)).toBe(true);
    expect(isPseudonym("host-3c4d.net", map)).toBe(true);
    expect(isPseudonym("user_5e6f@host-3c4d.com", map)).toBe(true);
    expect(isPseudonym("host-1a2b.host-9999.example", map)).toBe(false);
    expect(isPseudonym("user_0000@host-3c4d.com", map)).toBe(false);
  });

  test("an earlier map's pseudonyms are carried into the next map, so they stay recognised", () => {
    const first = new Pseudonymizer({ salt: SALT });
    const p = first.pseudonym("person", "Avery Quill");
    const h = first.pseudonym("host", "db01.corp.example.com");
    const second = new Pseudonymizer({ salt: SALT, map: first.toMap() });
    second.pseudonym("org", "Example Widgets");
    const map = second.toMap();
    expect(isPseudonym(p, map)).toBe(true);
    expect(isPseudonym(h, map)).toBe(true);
  });
});
