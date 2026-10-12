// The address pattern (AGT-1849), end to end on synthetic fixtures: a street address written only in
// prose (a text file, a table cell kept as text, a transcript, a DOCX paragraph) or in a JSON value
// under an uninformative key is replaced whole, with one pseudonym and no house number or suffix left
// beside it; a column of street lines under an uninformative header is classed `location`; the audit
// calls a surviving address a leak; and dosing lines, times, room numbers and honorifics are left
// alone. Every value is invented.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTree, type AuditReport } from "../../src/audit/mechanical.ts";
import { heuristicPatterns, heuristicSpec } from "../../src/analyst/heuristic.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { defaultPolicy, parsePolicy, renderPolicy } from "../../src/policy.ts";
import { buildProfile } from "../../src/profile/profile.ts";
import type { Spec } from "../../src/schema.ts";
import { docxMembers } from "../audit/ooxmlfixture.ts";
import { makeZip } from "../audit/zipfixture.ts";
import { readZip } from "../../src/audit/zip.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const HANDOFF = "Daughter will collect him from 77 Example Rd, Springfield UT 84000 after 5pm.\n";
// None of these is an address.
const DECOYS =
  "Hit by a car on Example Rd. Give 2 Tabs Daily; take 3 doses daily; 10 Days of Units. 5 Units Court.\n" +
  "Suite of tests ran at 10:30 Sample Way. Room 12 Oak Way is free; Suite 300 Example Way too. Dr Sample saw him.\n" +
  "Dose: 5 Mg Dr Sample reviewed. Seen by Dr. Sample at 4 pm.\n";
const NOTES = `${HANDOFF}${DECOYS}`;
const CSV = "Ticket,Memo\nT-1,pick up at 2200 Sample Blvd Apt 4 before noon,\nT-2,2 Tabs Daily with food\n".replace(",\n", "\n");
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Speaker 1>She lives at 9071 S Rowan Pkwy, Shelbyville UT 84001-1234, near the park.</v>\n";
const JSON_DOC = `${JSON.stringify({ profile: { address: { line1: "12 Sample Lane", city: "Shelbyville" } } })}\n`;
const DOCX = makeZip(docxMembers({ body: "Deliver to 410B Oak Hollow Court, Springfield, UT 84000 on Friday." }));

const INPUTS: InputFile[] = [
  { path: "handoff.txt", bytes: enc(NOTES) },
  { path: "tickets.csv", bytes: enc(CSV) },
  { path: "call.vtt", bytes: enc(VTT) },
  { path: "u.json", bytes: enc(JSON_DOC) },
  { path: "form.docx", bytes: DOCX },
];
const ADDRESSES = ["77 Example Rd", "2200 Sample Blvd", "9071 S Rowan Pkwy", "12 Sample Lane", "410B Oak Hollow Court"];

const OFF = { ip: false, email: false, host: false, guid: false, mac: false, phone: false };
const specWith = (patterns: Spec["patterns"]): Spec => ({ version: 1, columns: [], entities: {}, patterns, questions: [] });
const out = (r: ApplyResult, path: string) => (r.outputs.find((o) => o.path === path) as InputFile).bytes;
const text = (r: ApplyResult, path: string) => dec(out(r, path));
const docxText = (bytes: Uint8Array) => dec((readZip(bytes).find((m) => m.name === "word/document.xml")?.bytes as Uint8Array) ?? new Uint8Array());
const LOC = "Loc_[0-9A-F]{4}";

describe("address pattern", () => {
  const r = applySpec(INPUTS, specWith({ ...OFF, address: true }), { salt: SALT, columns: "scan" });

  test("addresses in prose, a cell, a transcript, a JSON value and a DOCX paragraph are replaced whole", () => {
    expect(r.skipped).toEqual([]);
    for (const a of ADDRESSES) for (const p of ["handoff.txt", "tickets.csv", "call.vtt", "u.json"]) expect(text(r, p)).not.toContain(a);
    expect(docxText(out(r, "form.docx"))).not.toContain("Oak Hollow");
    expect(text(r, "handoff.txt")).toMatch(new RegExp(`^Daughter will collect him from ${LOC} after 5pm\\.\\n`));
    expect(text(r, "tickets.csv")).toMatch(new RegExp(`,pick up at ${LOC} before noon\\n`));
    expect(text(r, "call.vtt")).toMatch(new RegExp(`She lives at ${LOC}, near the park\\.`));
    expect(text(r, "u.json")).toMatch(new RegExp(`"line1":"${LOC}","city":"Shelbyville"`));
    expect(docxText(out(r, "form.docx"))).toMatch(new RegExp(`Deliver to ${LOC} on Friday`));
  });

  test("no house number, suffix, unit, city or ZIP is left beside a token", () => {
    const all = ["handoff.txt", "tickets.csv", "call.vtt", "u.json"].map((p) => text(r, p)).join("\n");
    for (const left of ["Springfield UT", "84000", "Shelbyville UT", "84001", "Apt 4", /\d Loc_/, /Loc_[0-9A-F]{4} (Rd|Blvd|Pkwy|Lane)/] as const) {
      if (typeof left === "string") expect(all).not.toContain(left);
      else expect(all).not.toMatch(left);
    }
  });

  test("dosing lines, times, room numbers, honorifics and a street without a house number are untouched", () => {
    // (Prose names such as "Dr Sample" are pseudonymised by the name finder, not by this pattern.)
    const decoys = text(r, "handoff.txt").split("\n").slice(1).join("\n");
    expect(decoys).not.toMatch(new RegExp(LOC));
    for (const keep of ["Hit by a car on Example Rd.", "Give 2 Tabs Daily; take 3 doses daily; 10 Days of Units. 5 Units Court.", "Suite of tests ran at 10:30", "Room 12 Oak Way is free; Suite 300 Example Way too.", "Dose: 5 Mg Dr"]) expect(decoys).toContain(keep);
    expect(text(r, "tickets.csv")).toContain("2 Tabs Daily with food");
  });

  test("a repeated address shares a pseudonym; two addresses do not", () => {
    const two = applySpec([{ path: "a.txt", bytes: enc("From 77 Example Rd, then 12 Sample Lane, then 77 Example Rd again.\n") }], specWith({ ...OFF, address: true }), { salt: SALT });
    const ids = [...text(two, "a.txt").matchAll(new RegExp(LOC, "g"))].map((m) => m[0]);
    expect(ids.length).toBe(3);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(two.map.entries.map((e) => e.kind)).toEqual(["location", "location"]);
  });

  test("with the switch off, or in a spec without the field, nothing is replaced", () => {
    const off = applySpec(INPUTS, specWith({ ...OFF, address: false }), { salt: SALT, columns: "scan" });
    expect(text(off, "handoff.txt")).not.toMatch(new RegExp(LOC));
    expect(text(off, "handoff.txt")).toContain("77 Example Rd, Springfield UT 84000");
    const old = applySpec(INPUTS, specWith(OFF), { salt: SALT, columns: "scan" });
    expect(text(old, "handoff.txt")).toContain("77 Example Rd, Springfield UT 84000");
  });
});

describe("heuristic patterns", () => {
  test("address follows the location class", () => {
    expect(heuristicPatterns(defaultPolicy()).address).toBe(true);
    const p = defaultPolicy();
    p.sensitive.classes = ["person", "host"];
    expect(heuristicPatterns(p).address).toBe(false);
  });

  test("[patterns] address in blind.toml round-trips", () => {
    const p = defaultPolicy();
    p.patterns = { ...p.patterns, address: false };
    expect(parsePolicy(renderPolicy(p)).patterns.address).toBe(false);
  });
});

describe("a column of street lines under an uninformative header", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-address-"));
    writeFileSync(join(dir, "people.csv"), "id,line1,city\nR1,12 Sample Lane,Shelbyville\nR2,400 Example Ct Apt 2,Springfield\nR3,9071 S Rowan Pkwy,Shelbyville\nR4,5 Maple Way,Springfield\n");
    writeFileSync(join(dir, "doses.csv"), "id,sig\nR1,2 Tabs Daily\nR2,3 doses daily\nR3,5 Units Per Day\nR4,10 Days\n");
    writeFileSync(join(dir, "u.json"), JSON_DOC);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("it is classed location and blinded; a column of doses is not", () => {
    const { profile } = buildProfile([dir], 5, dir);
    const spec = heuristicSpec(profile, defaultPolicy());
    const rule = (file: string, header: string) => spec.columns.find((c) => c.file === file && c.header === header);
    expect(rule("people.csv", "line1")).toMatchObject({ class: "location", treatment: "blind" });
    expect(rule("doses.csv", "sig")).not.toMatchObject({ class: "location" });
    expect(spec.columns.find((c) => c.jsonPath === "$.profile.address.line1")).toMatchObject({ class: "location", treatment: "blind" });
    const inputs = ["people.csv", "doses.csv"].map((p) => ({ path: p, bytes: enc(require("node:fs").readFileSync(join(dir, p), "utf8")) }));
    const r = applySpec(inputs, spec, { salt: SALT });
    const people = text(r, "people.csv");
    for (const a of ["Sample Lane", "Example Ct", "Rowan", "Maple Way"]) expect(people).not.toContain(a);
    expect(text(r, "doses.csv")).toMatch(/,2 Tabs Daily\n.*,3 doses daily\n.*,5 Units Per Day\n.*,10 Days\n/);
  });

  test("a policy that does not call location sensitive keeps the column", () => {
    const { profile } = buildProfile([dir], 5, dir);
    const p = defaultPolicy();
    p.sensitive.classes = ["person"];
    const rule = heuristicSpec(profile, p).columns.find((c) => c.file === "people.csv" && c.header === "line1");
    expect(rule).toMatchObject({ class: "location", treatment: "keep" });
  });
});

describe("the audit", () => {
  const spec = specWith({ ...OFF, address: true });
  const emptyMap = { version: 1 as const, entries: [] };
  const leaks = (rep: AuditReport) => rep.files.flatMap((f) => f.findings.filter((x) => x.class === "pattern:address").map((x) => `${f.path}:${x.severity}`));
  const tree = (inputs: readonly InputFile[]) => inputs.map((i) => ({ path: i.path, kind: "file" as const, bytes: i.bytes }));

  test("a surviving address is a leak, whole; the blinded output has none", () => {
    expect(leaks(auditTree(tree(INPUTS), spec, emptyMap as never))).toEqual([
      "call.vtt:leak",
      "form.docx:leak",
      "handoff.txt:leak",
      "tickets.csv:leak",
      "u.json:leak",
    ]);
    const r = applySpec(INPUTS, spec, { salt: SALT });
    expect(leaks(auditTree(tree(r.outputs), spec, r.map))).toEqual([]);
  });

  test("a house number and suffix left beside a pseudonym token is a leak", () => {
    const partial = [{ path: "a.txt", bytes: enc("Lives at 9071 S Person_A1B2 Pkwy.\n") }];
    expect(leaks(auditTree(tree(partial), spec, emptyMap as never))).toEqual(["a.txt:leak"]);
  });

  test("the audit is off when the pattern is, and decoys are no leak", () => {
    expect(leaks(auditTree(tree(INPUTS), specWith({ ...OFF, address: false }), emptyMap as never))).toEqual([]);
    expect(leaks(auditTree(tree([{ path: "d.txt", bytes: enc(DECOYS) }]), spec, emptyMap as never))).toEqual([]);
  });
});
