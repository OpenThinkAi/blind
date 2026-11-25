import { describe, expect, test } from "bun:test";
import { AUDITOR_SYSTEM_LETTERS, auditorSystemFor } from "../../src/audit/auditor.ts";
import { type AuditReport, auditTree, type Finding, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { fromNameSafe, isPseudonym, LETTERS_ALPHABET, nameSafe, Pseudonymizer } from "../../src/engine/pseudonym.ts";
import { revealFile, Revealer } from "../../src/engine/reveal.ts";
import { hmacSha256, utf8 } from "../../src/engine/sha256.ts";
import { replaceAccounts } from "../../src/formats/paths.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic salts and data only: invented names, example.com.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 71);
const letters = (opts: Partial<ConstructorParameters<typeof Pseudonymizer>[0]> = {}) => new Pseudonymizer({ salt: SALT, style: "letters", ...opts });
const SHAPE = /^([A-Za-z][A-Za-z -]*) ([BCDFGHJKLMNPQRSTVWXZ]{5})$/;
const LETTERS_RUN = (p: string): string => (SHAPE.exec(p) as RegExpExecArray)[2] as string;

/** The letters the engine derives from one HMAC message (the same rejection sampling as letters5). */
function lettersOf(msg: string): string {
  const buf = hmacSha256(SALT, utf8(msg));
  let out = "";
  for (const b of buf) {
    if (out.length === 5) break;
    if (b < 240) out += LETTERS_ALPHABET[b % 20];
  }
  return out;
}

describe("letters form", () => {
  test("renders <Label> <five consonants>, the class word without a label", () => {
    const p = letters();
    expect(p.pseudonym("person", "Ada Lovelace")).toMatch(/^Person [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("org", "Example Widgets, Inc.")).toMatch(/^Org [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("location", "Springfield")).toMatch(/^Place [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("value", "zq-7781")).toMatch(/^Value [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("id", "AB-12x")).toMatch(/^Id [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("host", "printer")).toMatch(/^Host [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("person", "Grace Hopper", "Staff")).toMatch(/^Staff [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
    expect(p.pseudonym("person", "Alan Turing", "Front Desk")).toMatch(/^Front Desk [BCDFGHJKLMNPQRSTVWXZ]{5}$/);
  });

  test("no person, org, location, id or value stand-in contains a digit", () => {
    const p = letters();
    const got: string[] = [];
    for (let n = 0; n < 200; n++) {
      got.push(p.pseudonym("person", `Avery Quill ${n}`), p.pseudonym("org", `Quillworks ${n}`), p.pseudonym("location", `North Example ${n}`));
      got.push(p.pseudonym("id", `AC-${n}x`), p.pseudonym("value", `item ${n}`, "Ledger Ref"));
    }
    // A label with a digit cannot be used: the class word stands in.
    got.push(p.pseudonym("person", "Dana Example", "Team 7"));
    for (const g of got) {
      expect(g).toMatch(SHAPE);
      expect(g).not.toMatch(/\d/);
    }
    expect(new Set(got).size).toBe(got.length);
    expect(got[got.length - 1]).toMatch(/^Person /);
  });

  test("emails, hosts, IPv4, GUIDs and numeric IDs keep their shapes", () => {
    const p = letters();
    expect(p.pseudonym("email", "ada@example.com")).toMatch(/^user_[0-9a-f]{4}@host-[0-9a-f]{4}\.com$/);
    expect(p.pseudonym("host", "app01.corp.example.com")).toMatch(/^host-[0-9a-f]{4}\.host-[0-9a-f]{4}\.host-[0-9a-f]{4}\.com$/);
    expect(p.pseudonym("host", "192.0.2.10")).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
    expect(p.pseudonym("id", "0f8fad5b-d9cb-469f-a165-70867728950e")).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.pseudonym("id", "5550142")).toMatch(/^\d{7}$/);
  });

  test("the same value, salt and label give the same stand-in on every run; the label does not change the letters", () => {
    const run = (label?: string) => ["Ada Lovelace", "Grace Hopper", "Alan Turing"].map((v) => letters().pseudonym("person", v, label));
    expect(run("Staff")).toEqual(run("Staff"));
    expect(run()).toEqual(run());
    expect(run("Staff").map(LETTERS_RUN)).toEqual(run().map(LETTERS_RUN));
    expect(LETTERS_RUN(letters().pseudonym("person", "Ada Lovelace"))).toBe(lettersOf("person\0ada lovelace"));
  });

  test("a forced collision on the five letters takes the next candidate (HMAC with a counter)", () => {
    const first = lettersOf("person\0ada lovelace");
    // An earlier map gave another value the same five letters, under another label.
    const map: BlindMap = { version: 1, entries: [{ kind: "org", canonical: "example widgets", value: "Example Widgets", pseudonym: `Vendor ${first}` }] };
    const p = letters({ map });
    const got = p.pseudonym("person", "Ada Lovelace");
    expect(LETTERS_RUN(got)).not.toBe(first);
    expect(LETTERS_RUN(got)).toBe(lettersOf("person\0ada lovelace\x001"));
    // The earlier map's answer is pinned.
    expect(p.pseudonym("org", "Example Widgets")).toBe(`Vendor ${first}`);
    // The same collision with the same label: still distinct.
    const same = letters({ map: { version: 1, entries: [{ kind: "person", canonical: "grace hopper", value: "Grace Hopper", pseudonym: `Person ${first}` }] } });
    expect(same.pseudonym("person", "Ada Lovelace")).toBe(`Person ${lettersOf("person\0ada lovelace\x001")}`);
  });

  test("name-safe twin and recognition", () => {
    expect(nameSafe("Front Desk KQZTB")).toBe("Front_Desk_KQZTB");
    expect(fromNameSafe("Front_Desk_KQZTB")).toBe("Front Desk KQZTB");
    expect(nameSafe("Person_7F3A")).toBe("Person_7F3A");
    expect(replaceAccounts("/Users/x/f", () => "Front Desk KQZTB")).toBe("/Users/Front_Desk_KQZTB/f");
    const map: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "ada lovelace", value: "Ada Lovelace", pseudonym: "Front Desk KQZTB" }] };
    expect(isPseudonym("Front Desk KQZTB", map)).toBe(true);
    expect(isPseudonym("Front_Desk_KQZTB", map)).toBe(true);
    expect(isPseudonym("Front Desk KQZTC", map)).toBe(false);
    expect(isPseudonym("Person KQZTB")).toBe(true);
  });
});

// ------------------------------------------------------------- apply, reveal, audit

const rule = (file: string, header: string): ColumnRule => ({ file, header, class: "person", treatment: "blind", confidence: 1, source: "human" });
const SPEC: Spec = {
  version: 1,
  columns: [rule("staff.csv", "Staff"), { file: "staff.csv", header: "Note", class: "unknown", treatment: "scan", confidence: 1, source: "human" }],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }, { canonical: "Rowan Pike", aliases: [], parts: [] }], org: [], vocabulary: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const CSV = "Staff,Note\nAvery Quill,met Rowan Pike\nRowan Pike,ok\n";
const PROSE = "Avery Quill's shift ended. Then Rowan Pike, the lead, signed off with Avery Quill.\n";

function made() {
  const r = applySpec(
    [
      { path: "staff.csv", bytes: enc(CSV) },
      { path: "notes/Avery Quill.txt", bytes: enc(PROSE) },
    ],
    SPEC,
    { salt: SALT, pseudonymStyle: "letters" },
  );
  expect(r.skipped).toEqual([]);
  return r;
}

describe("letters style end to end", () => {
  test("applySpec writes letters stand-ins with the header's role label and no digits", () => {
    const r = made();
    const csv = dec((r.outputs.find((o) => o.path === "staff.csv") as { bytes: Uint8Array }).bytes);
    expect(csv).not.toContain("Avery");
    expect(csv).not.toContain("Rowan");
    expect(csv).toMatch(/\nStaff [BCDFGHJKLMNPQRSTVWXZ]{5},/);
    for (const e of r.map.entries) {
      expect(e.pseudonym).toMatch(SHAPE);
      expect(e.pseudonym).not.toMatch(/\d/);
    }
    const txt = r.outputs.find((o) => o.path.startsWith("notes/")) as { path: string; bytes: Uint8Array };
    expect(txt.path).toMatch(/^notes\/Staff_[BCDFGHJKLMNPQRSTVWXZ]{5}\.txt$/);
  });

  test("reveal restores files, file names and prose, including before 's, a comma and a full stop", () => {
    const r = made();
    const rv = new Revealer(r.map);
    for (const o of r.outputs) {
      const back = revealFile(o.path, o.bytes, rv);
      expect(dec(back.bytes)).toBe(o.path === "staff.csv" ? CSV : PROSE);
      expect(rv.path(o.path).text).toBe(o.path === "staff.csv" ? "staff.csv" : "notes/Avery Quill.txt");
    }
    const avery = (r.map.entries.find((e) => e.value === "Avery Quill") as { pseudonym: string }).pseudonym;
    const rowan = (r.map.entries.find((e) => e.value === "Rowan Pike") as { pseudonym: string }).pseudonym;
    const free = `Ask ${avery}'s team. Then ${rowan}, again ${avery}. Last: ${rowan}.`;
    expect(rv.text(free).text).toBe("Ask Avery Quill's team. Then Rowan Pike, again Avery Quill. Last: Rowan Pike.");
    expect(rv.text(`${nameSafe(avery)}_notes`).text).toBe("Avery Quill_notes");
  });

  test("the same input, salt and spec give byte-identical output on every run", () => {
    const a = made();
    const b = made();
    expect(a.outputs.map((o) => [o.path, dec(o.bytes)])).toEqual(b.outputs.map((o) => [o.path, dec(o.bytes)]));
    expect(a.map).toEqual(b.map);
  });

  test("audit treats issued letters stand-ins as pseudonyms, not candidates", () => {
    const r = made();
    const entries: TreeEntry[] = r.outputs.map((o) => ({ path: o.path, kind: "file", bytes: Buffer.from(o.bytes) }));
    const both = (es: TreeEntry[], map: BlindMap): AuditReport => addSemanticLayer(auditTree(es, SPEC, map), es, SPEC, map, { keep: [] });
    const findings = (rep: AuditReport): Finding[] => rep.files.flatMap((f) => f.findings);
    expect(findings(both(entries, r.map))).toEqual([]);
    // A role label that is a capitalised non-dictionary word: only the map says it is part of a pseudonym.
    const map: BlindMap = { ...r.map, entries: [...r.map.entries, { kind: "person", canonical: "dana example", value: "Dana Example", pseudonym: "Quartermaster Brindlewood KQZTB" }] };
    const note = (text: string): TreeEntry[] => [{ path: "memo.txt", kind: "file", bytes: Buffer.from(text, "utf8") }];
    expect(findings(both(note("Quartermaster Brindlewood KQZTB's report, then Quartermaster Brindlewood KQZTB.\n"), map))).toEqual([]);
    expect(findings(both([{ path: "Quartermaster_Brindlewood_KQZTB_report.txt", kind: "file", bytes: Buffer.from("ok\n") }], map))).toEqual([]);
    expect(findings(both(note("Quartermaster Brindlewood KQZTB met Avery Quill.\n"), map)).some((f) => f.severity === "leak")).toBe(true);
  });

  test("the model auditor's examples match the letters style", () => {
    expect(auditorSystemFor("letters")).toBe(AUDITOR_SYSTEM_LETTERS);
    expect(AUDITOR_SYSTEM_LETTERS).toContain("Person KQZTB");
    expect(AUDITOR_SYSTEM_LETTERS).not.toMatch(/Person_1A2B|#1A2B/);
  });
});
