// One entity, one pseudonym (AGT-1824), end to end on a synthetic fixture. With no model a column of
// client names is classed `unknown` and treated `value`, while some of the same people are transcript
// speakers (class person): before the fix each got a `Value_` and a `Person_` pseudonym. One phone
// number written two ways got two `Value_` pseudonyms. Reveal must still restore every file.
// Everything here is invented: example names and 555-01xx numbers.

import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { parseCsv } from "../../src/engine/csv.ts";
import { parseMap, serializeMap } from "../../src/engine/map.ts";
import { Revealer, revealFile } from "../../src/engine/reveal.ts";
import type { Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const CSV = "Client,Phone\nAvery Quill,(801) 555-0100\nRobin Example,801-555-0142\nJo Sample,801-555-0100\nKit Example,(801) 555-0142\n";
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Avery Quill>Morning all.</v>\n\n00:00:05.000 --> 00:00:09.000\n<v Robin Example>Morning, let us start.</v>\n";
const INPUTS: InputFile[] = [
  { path: "clients.csv", bytes: enc(CSV) },
  { path: "call.vtt", bytes: enc(VTT) },
];

/** What a `none`-mode run hands the engine: no entities, both columns unknown and value-treated. */
const SPEC: Spec = {
  version: 1,
  columns: ["Client", "Phone"].map((header) => ({ file: "clients.csv", header, class: "unknown", treatment: "value", confidence: 0, source: "heuristic" })),
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: true },
  questions: [],
};

const out = (r: ApplyResult, path: string) => (r.outputs.find((o) => o.path === path) as InputFile).bytes;
const cells = (r: ApplyResult) => parseCsv(dec(out(r, "clients.csv")), ",").slice(1).map((row) => row.cells.map((c) => c.value));
const speakers = (r: ApplyResult) => [...dec(out(r, "call.vtt")).matchAll(/<v ([^>]+)>/g)].map((m) => m[1] as string);

describe("one entity, one pseudonym (B8)", () => {
  const r = applySpec(INPUTS, SPEC, { salt: SALT });

  test("a name in a value column and as a transcript speaker gets one pseudonym", () => {
    expect(r.skipped).toEqual([]);
    const [avery, robin] = speakers(r);
    expect(avery).toMatch(/^Person_[0-9A-F]{4}$/);
    // The Client column reads as people's names, so every cell is a Person_ pseudonym (AGT-1830).
    expect(cells(r).map((row) => row[0])).toEqual([avery, robin, expect.stringMatching(/^Person_/), expect.stringMatching(/^Person_/)]);
  });

  test("one phone written two ways gets one pseudonym; another number gets another", () => {
    const phones = cells(r).map((row) => row[1] as string);
    expect(phones[0]).toBe(phones[2] as string);
    expect(phones[1]).toBe(phones[3] as string);
    expect(phones[0]).not.toBe(phones[1] as string);
  });

  test("the map has one entry per entity and stays valid", () => {
    expect(r.map.entries.map((e) => `${e.kind}:${e.canonical}`)).toEqual([
      "person:avery quill",
      "person:jo sample",
      "person:kit example",
      "person:robin example",
      "value:8015550100",
      "value:8015550142",
    ]);
    expect(parseMap(serializeMap(r.map))).toEqual(r.map);
  });

  test("reveal restores the transcript byte for byte, and each phone as the form the map records", () => {
    const rv = new Revealer(r.map);
    expect(dec(revealFile("call.vtt", out(r, "call.vtt"), rv).bytes)).toBe(VTT);
    // Variants of one value come back as its smallest recorded surface, as case variants always have.
    expect(dec(revealFile("clients.csv", out(r, "clients.csv"), rv).bytes)).toBe(
      "Client,Phone\nAvery Quill,(801) 555-0100\nRobin Example,(801) 555-0142\nJo Sample,(801) 555-0100\nKit Example,(801) 555-0142\n",
    );
  });

  test("a second run with the first run's map gives the same output", () => {
    const again = applySpec(INPUTS, SPEC, { salt: SALT, map: r.map });
    for (const i of INPUTS) expect(dec(out(again, i.path))).toBe(dec(out(r, i.path)));
    expect(again.map).toEqual(r.map);
  });
});
