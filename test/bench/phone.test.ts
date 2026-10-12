// The phone pattern (AGT-1825), end to end on a synthetic fixture: phones in prose, in a cell kept
// as text and in a transcript are replaced, one number written several ways gets one pseudonym,
// and dates, amounts and ids that merely contain digits are left alone. Everything here is
// invented: example names and 555-01xx numbers.

import { describe, expect, test } from "bun:test";
import { heuristicPatterns } from "../../src/analyst/heuristic.ts";
import { defaultPolicy } from "../../src/policy.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const NOTES = "Call the office on (801) 555-0100 or 801-555-0100.\nAfter hours: +1 801.555.0142. UK desk +44 20 7946 0958.\nInvoice 2026-10-12, total 1,234,567.89, ref ACCT-000123, order 8015550100.\n";
const CSV = "Ticket,Memo,Date,Amount\nT-1,reach Avery on 801 555 0142 please,2026-10-12,1234.50\nT-2,nothing to report,2026-10-13,99\n";
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Speaker 1>My number is (801) 555-0100, call any time.</v>\n";
const INPUTS: InputFile[] = [
  { path: "notes.txt", bytes: enc(NOTES) },
  { path: "tickets.csv", bytes: enc(CSV) },
  { path: "call.vtt", bytes: enc(VTT) },
];

const specWith = (patterns: Spec["patterns"]): Spec => ({
  version: 1,
  columns: [], // no column rules: the cells are kept as text, with the patterns still applied inside them
  entities: {},
  patterns,
  questions: [],
});
const OFF = { ip: false, email: false, host: false, guid: false, mac: false };
const out = (r: ApplyResult, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);

describe("phone pattern", () => {
  const r = applySpec(INPUTS, specWith({ ...OFF, phone: true }), { salt: SALT });
  const notes = out(r, "notes.txt");

  test("phones in prose, a cell kept as text and a transcript are replaced", () => {
    expect(r.skipped).toEqual([]);
    for (const n of ["555-0100", "555-0142", "555.0142", "555 0142", "7946 0958"]) {
      for (const p of ["notes.txt", "tickets.csv", "call.vtt"]) expect(out(r, p)).not.toContain(n);
    }
    expect(out(r, "tickets.csv")).toMatch(/reach Avery on Id_[0-9A-F]{4} please/);
    expect(out(r, "call.vtt")).toMatch(/My number is Id_[0-9A-F]{4}, call any time/);
  });

  test("one number written two ways shares a pseudonym, in every file", () => {
    const ids = [...notes.matchAll(/Id_[0-9A-F]{4}/g)].map((m) => m[0]);
    expect(ids.length).toBe(4);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(3);
    expect(out(r, "call.vtt")).toContain(ids[0] as string);
    expect(out(r, "tickets.csv")).toContain(ids[2] as string);
  });

  test("dates, amounts and ids that merely contain digits are left alone", () => {
    expect(notes).toContain("Invoice 2026-10-12, total 1,234,567.89, ref ACCT-000123, order 8015550100.");
    expect(out(r, "tickets.csv")).toMatch(/,2026-10-12,\S+\n.*,2026-10-13,\S+\n/);
  });

  test("with the switch off nothing is replaced; a spec without the field has it on", () => {
    const off = applySpec(INPUTS, specWith({ ...OFF, phone: false }), { salt: SALT });
    expect(out(off, "notes.txt")).toBe(NOTES);
    const old = applySpec(INPUTS, specWith(OFF), { salt: SALT });
    expect(out(old, "notes.txt")).toBe(notes);
  });
});

describe("heuristic patterns", () => {
  test("phone is on under the default policy and off when the policy leaves out id", () => {
    expect(heuristicPatterns(defaultPolicy()).phone).toBe(true);
    const p = defaultPolicy();
    p.sensitive.classes = ["person", "host"];
    expect(heuristicPatterns(p).phone).toBe(false);
  });
});

describe("a spelled phone", () => {
  const TXT = "Written: 801-555-0142. Spoken: eight oh one, five five five, zero one four two.\n";
  const r = applySpec([{ path: "say.txt", bytes: enc(TXT) }], specWith({ ...OFF, phone: true }), { salt: SALT });
  const text = out(r, "say.txt");

  test("is classed id like a written phone and shares its pseudonym", () => {
    const ids = [...text.matchAll(/Id_[0-9A-F]{4}|\b\d{10}\b/g)].map((m) => m[0]);
    expect(text).not.toContain("five five five");
    expect(text).not.toContain("555-0142");
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(ids[1]);
    expect(r.map.entries.filter((e) => e.canonical === "8015550142").map((e) => e.kind)).toEqual(["id"]);
  });
});
