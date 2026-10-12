import { describe, expect, test } from "bun:test";
import { columnStats, isCategoricalColumn, isIdentifierLike, isMeasure, isMeasureColumn, isTitleCaseMultiWord } from "../../src/engine/stats.ts";

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

describe("measures and categoricals are not identifier-like (AGT-1822)", () => {
  test.each([
    "2026-03-14",
    "2026-03-14T09:30:00Z",
    "2026/03/14",
    "03/14/2026",
    "14.03.26",
    "Mar 14, 2026",
    "14 March 2026",
    "Tue 3 Mar",
    "09:30",
    "9:30 pm",
    "38.6",
    "-0.25",
    "1,250",
    "1,250.75",
    "$1,250.00",
    "(£3.20)",
    "USD 40",
    "40.00 EUR",
    "38.6 lb",
    "12%",
    "5 mg",
    "101.2 °F",
    "3 days",
  ])("%j is a measure", (v) => {
    expect(isMeasure(v)).toBe(true);
  });

  test.each(["4417", "985112000123456", "ZX-4471-Q", "192.0.2.10", "801.555.0100", "Avery Quill", "canine", "12 Main", "ACCT-000123", "Jan"])("%j is not a measure", (v) => {
    expect(isMeasure(v)).toBe(false);
  });

  const many = (make: (i: number) => string, n = 10) => Array.from({ length: n }, (_, i) => make(i));

  test("dates, weights, amounts and decimals pass although every value is distinct and digit-heavy", () => {
    for (const values of [
      many((i) => `2026-03-${String(i + 10)}`),
      many((i) => `${30 + i}.${i} lb`),
      many((i) => `$${100 + i * 7}.${10 + i}`),
      many((i) => `${i}.${i + 1}${i}`),
    ]) {
      const s = columnStats(values);
      expect(s.distinctRatio).toBe(1);
      expect(s.digitRatio).toBeGreaterThan(0.3);
      expect(isMeasureColumn(s)).toBe(true);
      expect(isIdentifierLike(s)).toBe(false);
    }
  });

  test("a column under 80% measures is still decided by the fail-closed test", () => {
    const s = columnStats([...many((i) => `${30 + i}.5`, 7), "ZX-4471-Q", "ZX-4472-R", "ZX-4473-S"]);
    expect(s.measureRatio).toBeCloseTo(0.7);
    expect(isIdentifierLike(s)).toBe(true);
  });

  test("a 15-digit chip number is no measure: it stays identifier-like", () => {
    expect(isIdentifierLike(columnStats(many((i) => `98511200012345${i}`)))).toBe(true);
  });

  test("a small repeating set of words not in the dictionary (species) passes at distinct ratio ≥ 0.5", () => {
    const species = ["Canine", "Feline", "Canine", "Equine", "Feline", "Canine"];
    const s = columnStats(species);
    expect(s.distinctRatio).toBeGreaterThanOrEqual(0.5);
    expect(s.dictionaryRatio).toBe(0);
    expect(isCategoricalColumn(s)).toBe(true);
    expect(isIdentifierLike(s)).toBe(false);
    expect(isIdentifierLike(columnStats(["F", "MN", "M", "FS", "F", "MN", "M", "FS"]))).toBe(false);
  });

  test("not a categorical: mostly unique values, codes, Title-Case names, or too few values", () => {
    expect(isIdentifierLike(columnStats(["Canine", "Feline", "Equine", "Ovine", "Canine", "Lapine"]))).toBe(true);
    expect(isIdentifierLike(columnStats(["ZX-401", "ZX-401", "ZX-402", "ZX-402", "ZX-403", "ZX-403"]))).toBe(true);
    expect(isIdentifierLike(columnStats(["Avery Quill", "Robin Example", "Avery Quill", "Robin Example"]))).toBe(true);
    expect(isIdentifierLike(columnStats(["Canine", "Feline", "Canine"]))).toBe(true);
  });
});
