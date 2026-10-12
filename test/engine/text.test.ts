import { describe, expect, test } from "bun:test";
import type { Entities, PatternName, Patterns } from "../../src/schema.ts";
import { EntityMatcher, findPatternSpans, findSpans } from "../../src/engine/text.ts";

const ALL: Record<PatternName, boolean> = { ip: true, email: true, host: true, guid: true, mac: true, phone: true };
const NONE: Record<PatternName, boolean> = { ip: false, email: false, host: false, guid: false, mac: false, phone: false };

const matched = (text: string, patterns: Patterns = ALL) => findPatternSpans(text, patterns).map((s) => [s.value, s.cls]);

describe("patterns", () => {
  test.each([
    ["mail avery.quill@example.com today", "avery.quill@example.com", "email"],
    ["at 192.0.2.10.", "192.0.2.10", "host"],
    ["v6 2001:db8::1 here", "2001:db8::1", "host"],
    ["full 2001:0db8:0000:0000:0000:0000:0000:0001 ok", "2001:0db8:0000:0000:0000:0000:0000:0001", "host"],
    ["nic 00:00:5e:00:53:01 up", "00:00:5e:00:53:01", "id"],
    ["nic 00-00-5E-00-53-01 up", "00-00-5E-00-53-01", "id"],
    ["id 123e4567-e89b-12d3-a456-426614174000.", "123e4567-e89b-12d3-a456-426614174000", "id"],
    ["see db01.example.com.", "db01.example.com", "host"],
    ["see example.org now", "example.org", "host"],
  ])("%j finds %j", (text, value, cls) => {
    expect(matched(text)).toEqual([[value, cls]]);
  });

  test.each([
    ["notes.txt and report.md and Node.js"],
    ["the time is 10:30:45"],
    ["version 1.2.3.4.5"],
    ["999.1.1.1"],
    ["e.g. and i.e."],
    ["std::vector and a :: b"],
    ["not@an email"],
  ])("%j finds nothing", (text) => {
    expect(matched(text)).toEqual([]);
  });

  test.each([
    ["call (801) 555-0100 today", "(801) 555-0100"],
    ["call (801)555-0100.", "(801)555-0100"],
    ["call 801-555-0100, then", "801-555-0100"],
    ["call 801.555.0100;", "801.555.0100"],
    ["call 801 555 0100 now", "801 555 0100"],
    ["call +1 801 555 0100 now", "+1 801 555 0100"],
    ["call 1-801-555-0100 now", "1-801-555-0100"],
    ["call +1 (801) 555-0100 now", "+1 (801) 555-0100"],
    ["call +44 20 7946 0958 now", "+44 20 7946 0958"],
    ["call +442079460958 now", "+442079460958"],
  ])("phone: %j finds %j", (text, value) => {
    expect(matched(text)).toEqual([[value, "id"]]);
  });

  test.each([
    ["on 2026-10-12 at 10:30"],
    ["paid 1,234,567.89 and 12.50"],
    ["order 8015550100 shipped"],
    ["id ACCT-000123 and 1234567"],
    ["ssn-like 801-55-0100"],
    ["serial 801-555-0100-77"],
    ["ref 3801-555-0100"],
    ["short +1 2"],
    ["version 12.345.6789"],
  ])("phone: %j finds nothing", (text) => {
    expect(matched(text)).toEqual([]);
  });

  test("phone follows its switch, and is on when the spec predates it", () => {
    expect(matched("call 801-555-0100", { ...ALL, phone: false })).toEqual([]);
    // A spec written before the pattern existed has no `phone`: absent means on.
    expect(matched("call 801-555-0100", { ip: true, email: true, host: true, guid: true, mac: true })).toEqual([["801-555-0100", "id"]]);
  });

  test("an email is one span, not a name and a host", () => {
    expect(matched("avery@db01.example.com")).toEqual([["avery@db01.example.com", "email"]]);
  });

  test("a disabled pattern finds nothing; the others still run", () => {
    expect(matched("192.0.2.10 db01.example.com", { ...NONE, host: true })).toEqual([["db01.example.com", "host"]]);
    expect(matched("192.0.2.10", NONE)).toEqual([]);
  });

  test("MAC detection is off when the spec says so", () => {
    expect(matched("nic 00:00:5e:00:53:01", { ...ALL, mac: false })).toEqual([]);
  });
});

const ENTITIES: Entities = {
  person: [
    { canonical: "Avery Quill", aliases: ["Quill, Avery", "A. Quill", "aves"], parts: ["Avery", "Quill"] },
    { canonical: "May Example", aliases: [], parts: ["May"] },
  ],
  org: [{ canonical: "Example Widgets", aliases: ["Example Widgets Ltd", "EXW"], parts: [] }],
  vocabulary: [{ canonical: "Quill Pen", aliases: [], parts: [] }],
};

const find = (text: string, entities: Entities = ENTITIES) =>
  new EntityMatcher(entities).find(text).map((s) => [text.slice(s.start, s.end), s.cls, s.value]);

describe("entity matching", () => {
  test("longest form first", () => {
    expect(find("Example Widgets Ltd signed")).toEqual([["Example Widgets Ltd", "org", "Example Widgets Ltd"]]);
    expect(find("Avery Quill and Quill, Avery")).toEqual([
      ["Avery Quill", "person", "Avery Quill"],
      ["Quill, Avery", "person", "Quill, Avery"],
    ]);
  });

  test("whole tokens only", () => {
    expect(find("Averyville and McQuill and Quills")).toEqual([]);
    expect(find("Avery's desk, (Quill)")).toEqual([
      ["Avery", "person", "Avery"],
      ["Quill", "person", "Quill"],
    ]);
  });

  test("acronyms match exactly", () => {
    expect(find("EXW and exw and Exw")).toEqual([["EXW", "org", "EXW"]]);
  });

  test("a capitalised single word matches only where the text is capitalised", () => {
    expect(find("May said we may meet in MAY")).toEqual([
      ["May", "person", "May"],
      ["MAY", "person", "May"],
    ]);
  });

  test("a vocabulary form wins a length tie against a person part", () => {
    const e: Entities = {
      person: [{ canonical: "Sam Rowe", aliases: [], parts: ["Sam"] }],
      vocabulary: [{ canonical: "SAM", aliases: [], parts: [] }],
    };
    expect(find("SAM and Sam", e)).toEqual([
      ["SAM", null, "SAM"],
      ["Sam", "person", "Sam"],
    ]);
  });

  test("multi-word and lowercase forms fold case", () => {
    expect(find("AVERY QUILL, avery quill, Aves")).toEqual([
      ["AVERY QUILL", "person", "Avery Quill"],
      ["avery quill", "person", "Avery Quill"],
      ["Aves", "person", "aves"],
    ]);
  });

  test("whitespace inside a multi-word form is flexible", () => {
    expect(find("Avery\n  Quill")).toEqual([["Avery\n  Quill", "person", "Avery Quill"]]);
  });

  test("a vocabulary form shields its words", () => {
    expect(find("a Quill Pen, not Quill")).toEqual([
      ["Quill Pen", null, "Quill Pen"],
      ["Quill", "person", "Quill"],
    ]);
  });

  test("the result does not depend on the order of the spec lists", () => {
    const reversed: Entities = {
      person: [...(ENTITIES.person ?? [])].reverse(),
      org: ENTITIES.org,
      vocabulary: ENTITIES.vocabulary,
    };
    const text = "Avery Quill, May, EXW, Quill Pen, A. Quill";
    expect(find(text, reversed)).toEqual(find(text));
  });

  test("pattern spans are atomic; entities fill the gaps", () => {
    const text = "Avery <Avery@example.com> on db01.example.com";
    const spans = findSpans(text, new EntityMatcher(ENTITIES), ALL);
    expect(spans.map((s) => [text.slice(s.start, s.end), s.source])).toEqual([
      ["Avery", "entity"],
      ["Avery@example.com", "pattern"],
      ["db01.example.com", "pattern"],
    ]);
  });

  test("no entities, no spans", () => {
    expect(new EntityMatcher({}).find("Avery Quill")).toEqual([]);
  });
});
