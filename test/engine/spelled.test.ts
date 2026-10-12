import { describe, expect, test } from "bun:test";
import type { PatternName } from "../../src/schema.ts";
import { findSpelledDigits, findSpokenEmails } from "../../src/engine/spelled.ts";
import { EntityMatcher, findSpans, findSpelledSpans } from "../../src/engine/text.ts";

const ALL: Record<PatternName, boolean> = { ip: true, email: true, host: true, guid: true, mac: true, phone: true, secret: false };
const NONE: Record<PatternName, boolean> = { ip: false, email: false, host: false, guid: false, mac: false, phone: false, secret: false };
const TLDS = new Set(["com", "example", "org", "net"]);
const tld = (l: string) => TLDS.has(l);

const digits = (text: string) => findSpelledDigits(text).map((s) => [text.slice(s.start, s.end), s.normalised]);
const emails = (text: string) => findSpokenEmails(text, tld).map((s) => [text.slice(s.start, s.end), s.normalised]);

describe("spelled digits", () => {
  test.each([
    ["my cell is eight oh one, five five five, zero one four two.", "eight oh one, five five five, zero one four two", "8015550142"],
    ["the code is four zero one two ok", "four zero one two", "4012"],
    ["Eight-Oh-One-Two", "Eight-Oh-One-Two", "8012"],
    ["call double five, triple oh one", "double five, triple oh one", "550001"],
    ["it's nine nine. Eight eight then", "nine nine. Eight eight", "9988"],
    ["ext one two\nthree four", "one two\nthree four", "1234"],
  ])("%j finds %j", (text, span, value) => {
    expect(digits(text)).toEqual([[span, value]]);
  });

  test.each([
    ["two dogs, one cat"],
    ["one, two, three"],
    ["someone owes me one or two"],
    ["one 555 two 0142 three"],
    ["four zero one"],
    ["one's two three four"],
    ["one two\n\nthree four"],
    ["double double five five"],
  ])("%j finds nothing", (text) => {
    expect(digits(text)).toEqual([]);
  });

  test("two runs apart are two values", () => {
    expect(digits("first one two three four, then the cat, then five six seven eight")).toEqual([
      ["one two three four", "1234"],
      ["five six seven eight", "5678"],
    ]);
  });
});

describe("spoken emails", () => {
  test.each([
    ["send it to avery dot quill at example dot com today", "avery dot quill at example dot com", "avery.quill@example.com"],
    ["Mail Avery Dot Quill AT Example Dot Com.", "Avery Dot Quill AT Example Dot Com", "avery.quill@example.com"],
    ["it's sales at quillfeather dot example", "sales at quillfeather dot example", "sales@quillfeather.example"],
    ["a dot b underscore c at mail dot example dash widgets dot org", "a dot b underscore c at mail dot example dash widgets dot org", "a.b_c@mail.example-widgets.org"],
    ["jane.doe at example.com", "jane.doe at example.com", "jane.doe@example.com"],
    ["reach me at avery dot quill at example dot com", "avery dot quill at example dot com", "avery.quill@example.com"],
  ])("%j finds %j", (text, span, value) => {
    expect(emails(text)).toEqual([[span, value]]);
  });

  test.each([
    ["look at example dot com"],
    ["we met at the cafe"],
    ["she is at this dot point"],
    ["meet at noon dot"],
    ["avery@example.com"],
  ])("%j finds nothing", (text) => {
    expect(emails(text)).toEqual([]);
  });
});

describe("in free text", () => {
  const empty = new EntityMatcher({});

  test("a spelled phone is one id span valued as its digits; a spoken email is an email span", () => {
    const text = "Call eight oh one five five five zero one four two or write avery dot quill at example dot com.";
    expect(findSpans(text, empty, ALL).map((s) => [text.slice(s.start, s.end), s.cls, s.value])).toEqual([
      ["eight oh one five five five zero one four two", "id", "8015550142"],
      ["avery dot quill at example dot com", "email", "avery.quill@example.com"],
    ]);
  });

  test("a spoken email beats the written host inside it", () => {
    const text = "write jane at example.com";
    expect(findSpans(text, empty, ALL).map((s) => [text.slice(s.start, s.end), s.cls])).toEqual([["jane at example.com", "email"]]);
  });

  test("spoken emails follow the email pattern switch; spelled digits do not need one", () => {
    const text = "four zero one two, avery dot quill at example dot com";
    expect(findSpelledSpans(text, NONE).map((s) => s.cls)).toEqual(["id"]);
    expect(findSpelledSpans(text, { ...NONE, email: true }).map((s) => s.cls)).toEqual(["id", "email"]);
  });

  test("prose with number words is left alone", () => {
    expect(findSpans("two dogs, one cat and three hens", empty, ALL)).toEqual([]);
  });

  test("spoken forms shield their words from entity forms", () => {
    const m = new EntityMatcher({ person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }] });
    const text = "Avery said Avery dot Quill at example dot com";
    expect(findSpans(text, m, ALL).map((s) => [text.slice(s.start, s.end), s.cls])).toEqual([
      ["Avery", "person"],
      ["Avery dot Quill at example dot com", "email"],
    ]);
  });
});
