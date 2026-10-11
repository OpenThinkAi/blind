import { describe, expect, test } from "bun:test";
import { columnStats, isIdentifierLike, isTitleCaseMultiWord } from "../../src/engine/stats.ts";

describe("columnStats", () => {
  test("ratios over non-empty values", () => {
    const s = columnStats(["ab12", "ab12", "cd", "", "  "]);
    expect(s.count).toBe(3);
    expect(s.distinctRatio).toBeCloseTo(2 / 3);
    expect(s.digitRatio).toBeCloseTo(4 / 10);
  });

  test("dictionary ratio counts known words", () => {
    expect(columnStats(["open ticket", "zorvex"]).dictionaryRatio).toBeCloseTo(2 / 3);
    expect(columnStats(["12345"]).dictionaryRatio).toBe(0);
  });

  test("an empty column", () => {
    expect(columnStats(["", " "]).count).toBe(0);
    expect(isIdentifierLike(columnStats([]))).toBe(false);
  });
});

describe("isTitleCaseMultiWord", () => {
  test.each([
    ["Quillfeather Holdings", true],
    ["Bank of Example", true],
    ["Avery J. Quill", true],
    ["Ada McExample", true],
    ["Quillfeather", false],
    ["ACME CORP", false],
    ["call me later", false],
    ["Call me later", false],
  ])("%j → %p", (v, want) => {
    expect(isTitleCaseMultiWord(v)).toBe(want);
  });
});

describe("isIdentifierLike (fail-closed rule)", () => {
  const distinct = (make: (i: number) => string, n = 10) => Array.from({ length: n }, (_, i) => make(i));

  test("high cardinality + digits → identifier-like", () => {
    // Mostly dictionary words, so only the digit ratio triggers.
    expect(isIdentifierLike(columnStats(distinct((i) => `open ${1000 + i}`)))).toBe(true);
  });

  test("high cardinality + few dictionary words → identifier-like", () => {
    expect(isIdentifierLike(columnStats(distinct((i) => `zorv${"abcdefghij"[i]}`)))).toBe(true);
  });

  test("high cardinality + Title-Case multi-word → identifier-like even when the words are in the dictionary", () => {
    const names = ["Green Field", "Blue Water", "Red Bank", "North Point", "South Gate", "East Park", "West Road", "Black Rock", "White Hall", "Brown Hill"];
    const s = columnStats(names);
    expect(s.dictionaryRatio).toBeGreaterThan(0.3);
    expect(s.digitRatio).toBe(0);
    expect(isIdentifierLike(s)).toBe(true);
  });

  test("high cardinality prose → not identifier-like", () => {
    const notes = ["call back later", "waiting on the vendor", "need more information", "check the report today", "send the invoice"];
    expect(isIdentifierLike(columnStats(notes))).toBe(false);
  });

  test("low cardinality → not identifier-like, however code-shaped", () => {
    const codes = distinct((i) => (i % 2 === 0 ? "ZX-1" : "ZX-2"));
    const s = columnStats(codes);
    expect(s.distinctRatio).toBeLessThan(0.5);
    expect(isIdentifierLike(s)).toBe(false);
  });

  test("the distinct-ratio threshold is inclusive at 0.5", () => {
    expect(isIdentifierLike(columnStats(["Q1", "Q1", "Q2", "Q3"]))).toBe(true);
    expect(isIdentifierLike(columnStats(["Q1", "Q1", "Q1", "Q1", "Q3"]))).toBe(false);
  });
});
