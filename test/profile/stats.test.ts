import { describe, expect, test } from "bun:test";
import { MAX_EXCERPT } from "../../src/schema.ts";
import { DETECTORS, excerpt, pick, valueStats } from "../../src/profile/stats.ts";

describe("excerpt", () => {
  test("short text is kept, whitespace collapsed", () => {
    expect(excerpt("  Avery\n\tQuill  ")).toBe("Avery Quill");
  });

  test("long text is cut to 120 code points ending in an ellipsis", () => {
    const e = excerpt("é".repeat(500));
    expect([...e].length).toBe(MAX_EXCERPT);
    expect(e.endsWith("…")).toBe(true);
  });

  test("exactly 120 code points is not cut", () => {
    expect(excerpt("a".repeat(120))).toBe("a".repeat(120));
  });

  test("astral characters count as one code point", () => {
    expect([...excerpt("😀".repeat(200))].length).toBe(MAX_EXCERPT);
  });
});

describe("pick", () => {
  test("returns everything when there are k or fewer", () => {
    expect(pick(["a", "b"], 5)).toEqual(["a", "b"]);
  });

  test("spreads k picks evenly and is deterministic", () => {
    const items = Array.from({ length: 10 }, (_, i) => `v${i}`);
    expect(pick(items, 3)).toEqual(["v0", "v3", "v6"]);
    expect(pick(items, 3)).toEqual(pick(items, 3));
  });

  test("k = 0 picks nothing", () => {
    expect(pick(["a"], 0)).toEqual([]);
  });
});

describe("detectors", () => {
  const cases: [keyof typeof DETECTORS, string[], string[]][] = [
    ["ip", ["192.0.2.10", "from 198.51.100.7 at noon"], ["999.1.1.1", "1.2.3", "1.2.3.4.5", "v192.0.2"]],
    ["email", ["ada@example.com", "mail <robin.q+x@sub.example.org>"], ["ada@", "@example.com", "ada at example dot com"]],
    ["host", ["db01.example.com", "see web02.example.org."], ["ada@example.com", "v1.2", "e.g. this", "plain"]],
    ["guid", ["3f2504e0-4f89-11d3-9a0c-0305e82c3301", "{3F2504E0-4F89-11D3-9A0C-0305E82C3301}"], ["3f2504e0-4f89-11d3-9a0c", "zf2504e0-4f89-11d3-9a0c-0305e82c3301x"]],
    ["mac", ["00:00:5e:00:53:01", "nic 00-00-5E-00-53-AF"], ["00:00:5e:00:53", "00:00-5e:00:53:01"]],
    ["address", ["12 Sample Lane", "77 Example Rd, Springfield UT 84000", "lives at 2200 Sample Blvd Apt 4"], ["2 Tabs Daily", "3 doses daily", "Dr Sample", "Room 12 Oak Way", "Example Rd", "10 Days"]],
    ["numericId", ["004417", "EMP-004417", "ACCT#000123", "id_12345"], ["123", "12.50", "1,200", "EMP-12", "Avery 2024", "TOOLONGPREFIX-1234"]],
  ];
  for (const [name, hits, misses] of cases) {
    test(`${name} matches its shape`, () => {
      for (const v of hits) expect(DETECTORS[name].test(v), v).toBe(true);
    });
    test(`${name} rejects look-alikes`, () => {
      for (const v of misses) expect(DETECTORS[name].test(v), v).toBe(false);
    });
  }
});

describe("valueStats", () => {
  test("counts non-empty values and computes the ratios", () => {
    const s = valueStats(["Avery Quill", "Avery Quill", "", "  ", "Robin Example", "open ticket"], 5);
    expect(s.count).toBe(4);
    expect(s.distinctRatio).toBe(0.75);
    expect(s.digitRatio).toBe(0);
    // words: avery quill avery quill robin example open ticket -> example, open, ticket are dictionary words
    expect(s.dictionaryRatio).toBe(0.375);
    expect(s.meanLength).toBe(11.5);
    expect(s.samples).toEqual(["Avery Quill", "Robin Example", "open ticket"]);
  });

  test("digit ratio counts digit characters over all characters", () => {
    expect(valueStats(["ab12", "3456"], 0).digitRatio).toBe(0.75);
  });

  test("detector rates are shares of values", () => {
    const s = valueStats(["192.0.2.1", "ada@example.com", "plain", "EMP-004417"], 0);
    expect(s.detectorRates).toEqual({ address: 0, email: 0.25, guid: 0, host: 0, ip: 0.25, mac: 0, numericId: 0.25 });
  });

  test("an empty column is all zeros", () => {
    const s = valueStats(["", " "], 3);
    expect(s).toEqual({
      count: 0, distinctRatio: 0, digitRatio: 0, dictionaryRatio: 0, meanLength: 0,
      detectorRates: { address: 0, email: 0, guid: 0, host: 0, ip: 0, mac: 0, numericId: 0 }, samples: [],
    });
  });

  test("samples are distinct, at most k, and cut to 120 characters", () => {
    const values = Array.from({ length: 50 }, (_, i) => `${"z".repeat(300)}${i}`);
    const s = valueStats(values, 4);
    expect(s.samples.length).toBe(4);
    for (const v of s.samples) expect([...v].length).toBeLessThanOrEqual(MAX_EXCERPT);
    expect(valueStats(values, 0).samples).toEqual([]);
  });
});

test("the email detector is linear on a long run with no @, and still finds an email anywhere", () => {
  const run = "a.".repeat(100_000);
  const t0 = performance.now();
  expect(DETECTORS.email.test(run)).toBe(false);
  expect(performance.now() - t0).toBeLessThan(250);
  expect(DETECTORS.email.test("contact: avery.quill+ops@mail.example.com.")).toBe(true);
  expect(DETECTORS.email.test("x-avery@example.org")).toBe(true);
});
