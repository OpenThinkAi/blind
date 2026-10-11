import { describe, expect, test } from "bun:test";
import { canonicalize, guidCore } from "../../src/engine/canonical.ts";

describe("canonicalize", () => {
  test("case-folds and collapses whitespace for every class", () => {
    expect(canonicalize("value", "  Zq   Alpha\tBeta ")).toBe("zq alpha beta");
    expect(canonicalize("location", "SPRINGFIELD")).toBe("springfield");
  });

  test("case-folding is locale-independent", () => {
    expect(canonicalize("person", "IVY ISLE")).toBe("ivy isle");
  });

  test("strips NUL, the HMAC field separator", () => {
    expect(canonicalize("value", "ab\0cd")).toBe("abcd");
  });

  test("applies NFKC so compatibility forms unify", () => {
    expect(canonicalize("org", "Ｅｘａｍｐｌｅ Widgets")).toBe("example widgets");
  });

  describe("org legal suffixes", () => {
    for (const [input, want] of [
      ["Example Widgets, Inc.", "example widgets"],
      ["EXAMPLE WIDGETS INC", "example widgets"],
      ["Example Widgets LLC", "example widgets"],
      ["Example Widgets L.L.C.", "example widgets"],
      ["Example Widgets Pty Ltd", "example widgets"],
      ["Example Widgets S.A.", "example widgets"],
      ["Example Widgets GmbH", "example widgets"],
      ["Sample & Co.", "sample"],
    ] as const) {
      test(`${input} → ${want}`, () => expect(canonicalize("org", input)).toBe(want));
    }

    test("a suffix word inside the name is kept", () => {
      expect(canonicalize("org", "Inc Example Widgets")).toBe("inc example widgets");
    });

    test("a name that is only a suffix word is not emptied", () => {
      expect(canonicalize("org", "Company")).toBe("company");
    });

    test("suffixes are not stripped for other classes", () => {
      expect(canonicalize("person", "Ada Inc")).toBe("ada inc");
    });
  });

  describe("person order", () => {
    test("'Last, First' unifies with 'First Last'", () => {
      expect(canonicalize("person", "Lovelace, Ada")).toBe(canonicalize("person", "Ada Lovelace"));
      expect(canonicalize("person", "lovelace,ada king")).toBe("ada king lovelace");
    });

    test("more than one comma, or an empty side, is left alone", () => {
      expect(canonicalize("person", "Lovelace, Ada, Jr")).toBe("lovelace, ada, jr");
      expect(canonicalize("person", "Lovelace,")).toBe("lovelace,");
    });

    test("comma reordering does not apply to other classes", () => {
      expect(canonicalize("org", "Widgets, Example")).toBe("widgets, example");
    });
  });

  test("hosts drop a trailing root dot", () => {
    expect(canonicalize("host", "App01.Example.COM.")).toBe("app01.example.com");
  });

  test("GUID ids canonicalise to lowercase without braces", () => {
    expect(canonicalize("id", "{0F8FAD5B-D9CB-469F-A165-70867728950E}")).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
  });
});

describe("guidCore", () => {
  test("accepts bare and braced GUIDs", () => {
    expect(guidCore("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(guidCore("{0F8FAD5B-D9CB-469F-A165-70867728950E}")).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
  });

  test("rejects unbalanced braces and wrong shapes", () => {
    expect(guidCore("{0f8fad5b-d9cb-469f-a165-70867728950e")).toBeUndefined();
    expect(guidCore("0f8fad5bd9cb469fa16570867728950e")).toBeUndefined();
    expect(guidCore("0f8fad5b-d9cb-469f-a165-70867728950g")).toBeUndefined();
  });
});
