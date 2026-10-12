// One person, one token (AGT-1842): name parts written in another arrangement, honorific and
// initialled forms, and a pet and an owner sharing a name. Everything here is invented: made-up
// names, example.com, no real data.

import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { canonicalize } from "../../src/engine/canonical.ts";
import { personAliases } from "../../src/engine/identity.ts";
import { mayShare, Pseudonymizer } from "../../src/engine/pseudonym.ts";
import { EntityMatcher, type ExtraForm } from "../../src/engine/text.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => Buffer.from((r.outputs.find((o) => o.path === path) as InputFile).bytes).toString("utf8");
const rule = (f: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file: f,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "policy",
});
const spec = (columns: ColumnRule[]): Spec => ({ version: 1, columns, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [] });
const tokens = (s: string): string[] => s.match(/(?:Person|Value)_[0-9A-F]{4}/g) ?? [];

describe("person canonical form", () => {
  test("leading honorifics go when two or more words are left; initials and titles lose their dot", () => {
    expect(canonicalize("person", "Dr. Jo Marwick")).toBe("jo marwick");
    expect(canonicalize("person", "Marwick, Jo")).toBe("jo marwick");
    expect(canonicalize("person", "Dr. J. Marwick")).toBe("j marwick");
    expect(canonicalize("person", "J Marwick")).toBe("j marwick");
    expect(canonicalize("person", "Dr. Marwick")).toBe("dr marwick");
    expect(canonicalize("person", "Front Desk")).toBe("front desk");
  });
});

describe("personAliases", () => {
  test("an initial resolves to the one full name with that surname and initial", () => {
    const a = personAliases(["Jo Thornby", "J. Thornby"]);
    expect(a.get("j thornby")).toEqual({ key: "jo thornby", display: "Jo Thornby" });
  });

  test("another known Thornby with a different initial keeps the initial form apart", () => {
    expect(personAliases(["Jo Thornby", "Rex Thornby", "J. Thornby"]).has("j thornby")).toBe(false);
    // Two full names with the same initial are ambiguous too.
    expect(personAliases(["Jo Thornby", "Jan Thornby", "J. Thornby"]).has("j thornby")).toBe(false);
  });

  test("a title and one name resolves to the one person with that name", () => {
    expect(personAliases(["Jo Thornby", "Dr. Thornby"]).get("dr thornby")?.key).toBe("jo thornby");
  });

  test("with two Thornbys, the one ever written with a title wins; with none or two titled, nothing resolves", () => {
    const people = ["Rex Thornby", "J. Thornby", "Dr. Thornby"];
    expect(personAliases(people, new Set(["j thornby"])).get("dr thornby")?.key).toBe("j thornby");
    expect(personAliases(people).has("dr thornby")).toBe(false);
    expect(personAliases(people, new Set(["j thornby", "rex thornby"])).has("dr thornby")).toBe(false);
  });

  test("a lone name without a title and a full name are never aliased", () => {
    expect([...personAliases(["Thornby", "Jo Thornby", "Rex"]).keys()]).toEqual([]);
  });

  test("the result does not depend on input order", () => {
    const people = ["Rex Thornby", "J. Thornby", "Dr. Thornby", "Jo Quill", "J Quill"];
    expect([...personAliases(people, new Set(["j thornby"]))].sort()).toEqual([...personAliases([...people].reverse(), new Set(["j thornby"]))].sort());
  });
});

describe("adjacent parts of one person are one span", () => {
  const forms: ExtraForm[] = [
    { cls: "person", value: "Dana Marwick", form: "Dana Marwick" },
    { cls: "person", value: "Dana Marwick", form: "Dana" },
    { cls: "person", value: "Dana Marwick", form: "Marwick" },
    { cls: "person", value: "Bea Quill", form: "Bea" },
  ];
  const m = new EntityMatcher({}, forms);
  const spans = (t: string) => m.find(t).map((s) => t.slice(s.start, s.end));

  test.each([
    ["GET /search?q=Dana+Marwick 200", "Dana+Marwick"],
    ["Marwick, Dana - schedule", "Marwick, Dana"],
    ["Marwick.Dana", "Marwick.Dana"],
    ["Dana_Marwick", "Dana_Marwick"],
    ["Dana-Marwick", "Dana-Marwick"],
    ["q=Dana%20Marwick&x=1", "Dana%20Marwick"],
    ["Marwick%2C%20Dana", "Marwick%2C%20Dana"],
    ["Marwick Dana", "Marwick Dana"],
    ["signed by Marwick D. today", "Marwick D."],
    ["signed by D. Marwick today", "D. Marwick"],
  ])("%s", (text, span) => {
    expect(spans(text)).toEqual([span]);
  });

  test("different people, a repeated word, and an initial that is not the person's stay apart", () => {
    expect(spans("Dana, Bea")).toEqual(["Dana", "Bea"]);
    expect(spans("Marwick Marwick")).toEqual(["Marwick", "Marwick"]);
    expect(spans("Dana Marwick, Dana")).toEqual(["Dana Marwick", "Dana"]);
    expect(spans("Marwick Q. said")).toEqual(["Marwick"]);
    expect(spans("Dana. Marwick")).toEqual(["Dana", "Marwick"]);
  });
});

describe("cross-class reuse", () => {
  test("a one-word value and a one-word person are two entities; a full name is one", () => {
    expect(mayShare("value", "person", "Rex")).toBe(false);
    expect(mayShare("person", "value", "Rex")).toBe(false);
    expect(mayShare("value", "person", "Avery Quill")).toBe(true);
    expect(mayShare("value", "person", "Quill, Avery")).toBe(true);
    expect(mayShare("value", "id", "Rex")).toBe(true);
    const p = new Pseudonymizer({ salt: SALT });
    const pet = p.pseudonym("value", "Rex");
    expect(p.pseudonym("person", "Rex")).not.toBe(pet);
    const person = p.pseudonym("person", "Avery Quill");
    expect(p.pseudonym("value", "Avery Quill")).toBe(person);
  });

  test("an alias gets the person's pseudonym and the person's surface in the map", () => {
    const aliases = personAliases(["Jo Thornby", "J. Thornby"]);
    const p = new Pseudonymizer({ salt: SALT, personAliases: aliases });
    expect(p.pseudonym("person", "J. Thornby")).toBe(p.pseudonym("person", "Jo Thornby"));
    expect(p.toMap().entries).toEqual([expect.objectContaining({ canonical: "jo thornby", value: "Jo Thornby" })]);
  });

  test("a map written before titles were stripped still pins the person", () => {
    const old = new Pseudonymizer({ salt: SALT });
    const pinned = old.pseudonym("person", "Dr. Jo Thornby");
    const map = { ...old.toMap(), entries: old.toMap().entries.map((e) => ({ ...e, canonical: "dr. jo thornby" })) };
    const p = new Pseudonymizer({ map });
    expect(p.pseudonym("person", "Jo Thornby")).toBe(pinned);
  });
});

describe("the repro (AGT-1842)", () => {
  const inputs = [
    file("owners.csv", "owner,pet\nDana Marwick,Rex\nRex Thornby,Biscuit\n"),
    file("log.txt", "GET /search?q=Dana+Marwick 200\nREX: calling about Biscuit\n"),
    file("letter.txt", "To: Dr. J. Thornby\n\nDear Dr. Thornby,\nThanks for seeing Biscuit.\n"),
    file("ledger.csv", 'title,amount\n"Marwick, Dana - schedule",12\n'),
    file("call.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Rex>Hi, calling about Biscuit.\n"),
  ];
  const r = applySpec(
    inputs,
    spec([rule("owners.csv", "owner", "person", "blind"), rule("owners.csv", "pet", "unknown", "blind"), rule("ledger.csv", "amount", "vocabulary", "keep")]),
    { salt: SALT },
  );
  const [dana, , rexThornby, biscuit] = tokens(out(r, "owners.csv"));
  const pet = tokens(out(r, "owners.csv"))[1] as string;

  test("one token per person in every arrangement", () => {
    expect(r.skipped).toEqual([]);
    expect(out(r, "log.txt")).toStartWith(`GET /search?q=${dana} 200\n`);
    expect(out(r, "ledger.csv")).toBe(`title,amount\n"${dana} - schedule",12\n`);
    expect(rexThornby).not.toBe(dana as string);
  });

  test("the doctor is one person: Dr. J. Thornby and Dr. Thornby share a token, the owner Rex Thornby does not", () => {
    const letter = out(r, "letter.txt");
    const [to, dear] = tokens(letter);
    expect(letter).toBe(`To: Dr. ${to}\n\nDear Dr. ${to},\nThanks for seeing ${biscuit}.\n`);
    expect(dear).toBe(to as string);
    expect(to).not.toBe(rexThornby as string);
  });

  test("the owner or speaker Rex is never shown as the pet Rex", () => {
    const [rex] = tokens(out(r, "log.txt").split("\n")[1] as string);
    expect(rex).toMatch(/^Person_/);
    expect(rex).not.toBe(pet);
    const [speaker] = tokens(out(r, "call.vtt"));
    expect(speaker).not.toBe(pet);
    expect(pet).toMatch(/^Value_/);
  });
});

describe("a named value cell", () => {
  test("contributes name parts like a person column, keeping its Value_ token", () => {
    const r = applySpec(
      [file("a.csv", "client\nAvery Quill\nDana Thornby\n"), file("n.txt", "Quill called; Avery Quill paid; Thornby, Dana too.\n")],
      spec([rule("a.csv", "client", "unknown", "blind")]),
      { salt: SALT },
    );
    const [avery, dana] = tokens(out(r, "a.csv"));
    expect(avery).toMatch(/^Value_/);
    expect(out(r, "n.txt")).toBe(`${avery} called; ${avery} paid; ${dana} too.\n`);
  });
});
