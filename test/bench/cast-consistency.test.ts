// Consistency on the bench cast (AGT-1842): each invented person of src/bench/cast.ts is written in
// several arrangements across several files (a column, URL queries, "Surname, Given - schedule",
// joined handles, an initial with a title, a title with the surname alone, a transcript speaker).
// Every line names one person, so the pseudonyms on a line are that person's: one person, one
// token, everywhere. Before AGT-1842 the joined forms became one token per part
// ("Person_AAAA+Person_AAAA") and the titled forms got tokens of their own.

import { describe, expect, test } from "bun:test";
import { PEOPLE } from "../../src/bench/cast.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 7) & 0xff);
const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const rule = (f: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file: f,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "policy",
});
const out = (r: ApplyResult, path: string): string => Buffer.from((r.outputs.find((o) => o.path === path) as InputFile).bytes).toString("utf8");
const TOKEN = /Person_[0-9A-F]{4}/g;

const people = PEOPLE.map((p) => ({ ...p, initial: p.given[0] as string }));
const owners = `id,owner\n${people.map((p, i) => `${i + 1},${p.canonical}`).join("\n")}\n`;
const log = people
  .flatMap((p) => [`GET /clients?q=${p.given}+${p.surname} 200`, `user=${p.given}_${p.surname}`, `name=${p.surname}.${p.given}`, `ref=${p.given}%20${p.surname}`])
  .join("\n");
const schedule = `title,slot\n${people.map((p) => `"${p.surname}, ${p.given} - schedule",am`).join("\n")}\n`;
const letters = people.flatMap((p) => [`To: Dr. ${p.initial}. ${p.surname}`, `Dear Dr. ${p.surname},`, `Signed, ${p.surname} ${p.initial}.`]).join("\n");
const call = `WEBVTT\n\n${people.map((p, i) => `00:00:0${i}.000 --> 00:00:0${i}.500\n<v ${p.canonical}>Morning.`).join("\n\n")}\n`;

const SPEC: Spec = {
  version: 1,
  columns: [rule("owners.csv", "id", "vocabulary", "keep"), rule("owners.csv", "owner", "person", "blind"), rule("schedule.csv", "slot", "vocabulary", "keep")],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

/** Per person, the distinct tokens over every line that names them. */
function tokensPerPerson(r: ApplyResult): Map<string, Set<string>> {
  const lines = (path: string, skip: number, per: number): string[][] =>
    people.map((_, i) => out(r, path).split("\n").slice(skip + i * per, skip + (i + 1) * per));
  const byFile = [
    lines("owners.csv", 1, 1),
    lines("log.txt", 0, 4),
    lines("schedule.csv", 1, 1),
    lines("letters.txt", 0, 3),
    people.map((_, i) => [...out(r, "call.vtt").matchAll(/<v ([^>]+)>/g)].map((m) => m[1] as string).slice(i, i + 1)),
  ];
  const result = new Map<string, Set<string>>();
  people.forEach((p, i) => {
    const set = new Set<string>();
    for (const f of byFile) for (const line of f[i] as string[]) for (const t of line.match(TOKEN) ?? []) set.add(t);
    result.set(p.canonical, set);
  });
  return result;
}

describe("bench cast consistency (AGT-1842)", () => {
  const r = applySpec(
    [file("owners.csv", owners), file("log.txt", `${log}\n`), file("schedule.csv", schedule), file("letters.txt", `${letters}\n`), file("call.vtt", call)],
    SPEC,
    { salt: SALT },
  );

  test("every file is written and no name survives", () => {
    expect(r.skipped).toEqual([]);
    const all = r.outputs.map((o) => Buffer.from(o.bytes).toString("utf8")).join("\n");
    for (const p of people) {
      expect(all).not.toContain(p.surname);
      // "Jan" is also a month; it is never left in a person's arrangement here either.
      expect(all).not.toMatch(new RegExp(`\\b${p.given}\\b`));
    }
  });

  test("one person, one token, in every arrangement", () => {
    const per = tokensPerPerson(r);
    const consistent = [...per.values()].filter((s) => s.size === 1).length;
    expect(consistent).toBe(people.length);
    // Different people never share one.
    expect(new Set([...per.values()].flatMap((s) => [...s])).size).toBe(people.length);
  });

  test("each joined arrangement is one token, not one per part", () => {
    for (const line of out(r, "log.txt").trimEnd().split("\n")) expect(line.match(TOKEN)?.length).toBe(1);
    for (const line of out(r, "schedule.csv").trimEnd().split("\n").slice(1)) expect(line).toMatch(/^"Person_[0-9A-F]{4} - schedule",am$/);
    expect(out(r, "letters.txt")).toMatch(/^To: Dr\. Person_[0-9A-F]{4}\nDear Dr\. Person_[0-9A-F]{4},\nSigned, Person_[0-9A-F]{4}\n/);
  });
});
