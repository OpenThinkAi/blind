// The secret pattern (AGT-1844), end to end on synthetic fixtures: credential-shaped tokens in a
// transcript (named a turn earlier), a list, a cell, a JSON value, a DOCX paragraph and a worksheet cell are written
// as REDACTED with the rest of the line intact and nothing in the map; product codes, versions,
// CamelCase words, doses, pseudonyms, ids and hashes are left alone; `secret` works as a policy
// class and a column class; and the audit calls a surviving match a leak. Every value is invented.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTree, type AuditReport, type TreeEntry } from "../../src/audit/mechanical.ts";
import { checkProposal } from "../../src/analyst/analyst.ts";
import { heuristicPatterns } from "../../src/analyst/heuristic.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { defaultPolicy, parsePolicy, renderPolicy } from "../../src/policy.ts";
import { type ColumnRule, REDACTED_VALUE, type Spec } from "../../src/schema.ts";
import { docxMembers, xlsxMembers } from "../audit/ooxmlfixture.ts";
import { makeZip } from "../audit/zipfixture.ts";
import { readZip } from "../../src/audit/zip.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const BIN = join(import.meta.dir, "../../bin/blind.js");

const MEETING =
  "[10:02:11] Lee: Backup box hasn't had its password rotated yet.\n" +
  "[10:02:30] Sam: Taped under the monitor - Example2031! - rotating it today.\n";
const NOTES =
  "Office setup\n" +
  "wifi: ExampleNet / Tr0ub4dor&3\n" +
  "Deploy key for the build box: q7k2m9x4z8p1w6n3b5c0r2t8\n" +
  "Invoice AB-2026-0001 for v2.10.3 of HelloWorld; Amoxi500mg for Person_1A2B, ref INC0012345.\n" +
  "Commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f809a1b2c3 at 2026-10-12T10:02:11Z, weight 38.6lb, total $1,250.00.\n";
const CSV = "Ticket,Memo\nT-1,router sign-in aB3xY9qL until Friday\nT-2,nothing to report\n";
const JSON_DOC = `${JSON.stringify({ items: [{ memo: "please use P@ssw0rd!9 for the new account this week" }, { memo: "the Windows11 rollout is done for this month" }] }, null, 2)}\n`;
const DOCX = makeZip(docxMembers({ body: "Portal sign-in: Zx9Qw7Lp2 (do not share)." }));
// Mostly ordinary words, so the column pass leaves the cell as free text.
const XLSX = makeZip(xlsxMembers({ body: "please use Kq8vR2mX9tL4wZ7p for the alarm this month" }));
const SECRETS = ["Example2031!", "Tr0ub4dor&3", "q7k2m9x4z8p1w6n3b5c0r2t8", "aB3xY9qL", "P@ssw0rd!9", "Zx9Qw7Lp2", "Kq8vR2mX9tL4wZ7p"];

const INPUTS: InputFile[] = [
  { path: "meeting.txt", bytes: enc(MEETING) },
  { path: "notes.md", bytes: enc(NOTES) },
  { path: "tickets.csv", bytes: enc(CSV) },
  { path: "items.json", bytes: enc(JSON_DOC) },
  { path: "portal.docx", bytes: DOCX },
  { path: "panel.xlsx", bytes: XLSX },
];

const OFF = { ip: false, email: false, host: false, guid: false, mac: false, phone: false };
const specWith = (patterns: Spec["patterns"], columns: ColumnRule[] = []): Spec => ({ version: 1, columns, entities: {}, patterns, questions: [] });
const out = (r: ApplyResult, path: string) => (r.outputs.find((o) => o.path === path) as InputFile).bytes;
const text = (r: ApplyResult, path: string) => dec(out(r, path));
const memberText = (bytes: Uint8Array, name: string) => dec((readZip(bytes).find((m) => m.name === name)?.bytes as Uint8Array) ?? new Uint8Array());
const docxText = (bytes: Uint8Array) => memberText(bytes, "word/document.xml");
const file = (path: string, bytes: Uint8Array): TreeEntry => ({ path, kind: "file", bytes });
const secretLeaks = (r: AuditReport) => r.files.flatMap((f) => f.findings.filter((x) => x.class === "pattern:secret").map((x) => [f.path, x.severity, x.masked]));

describe("secret pattern, end to end", () => {
  const r = applySpec(INPUTS, specWith({ ...OFF, secret: true }), { salt: SALT });

  test("each secret is REDACTED, the rest of its line intact, in every format", () => {
    expect(r.skipped).toEqual([]);
    expect(text(r, "meeting.txt")).toMatch(/^\[10:02:11\] Person_[0-9A-F]{4}: Backup box hasn't had its password rotated yet\.\n/);
    expect(text(r, "meeting.txt")).toMatch(/\[10:02:30\] Person_[0-9A-F]{4}: Taped under the monitor - REDACTED - rotating it today\.\n$/);
    expect(text(r, "notes.md")).toContain("wifi: ExampleNet / REDACTED\n");
    expect(text(r, "notes.md")).toContain("Deploy key for the build box: REDACTED\n");
    // The Ticket column is identifier-like, so the column pass pseudonymises it; Memo is free text.
    expect(text(r, "tickets.csv")).toMatch(/^Ticket,Memo\nValue_[0-9A-F]{4},router sign-in REDACTED until Friday\nValue_[0-9A-F]{4},nothing to report\n$/);
    expect(text(r, "items.json")).toContain('"memo": "please use REDACTED for the new account this week"');
    expect(docxText(out(r, "portal.docx"))).toContain("Portal sign-in: REDACTED (do not share).");
    expect(memberText(out(r, "panel.xlsx"), "xl/worksheets/sheet1.xml")).toContain("<t>please use REDACTED for the alarm this month</t>");
    for (const o of r.outputs) for (const s of SECRETS) expect(dec(o.bytes)).not.toContain(s);
  });

  test("nothing secret reaches the map: REDACTED is not a pseudonym", () => {
    const map = JSON.stringify(r.map);
    for (const s of SECRETS) expect(map).not.toContain(s);
    expect(map).not.toContain(REDACTED_VALUE);
  });

  test("product codes, versions, CamelCase, doses, pseudonyms, ids, hashes, dates and amounts are untouched", () => {
    expect(text(r, "notes.md")).toContain(
      "Invoice AB-2026-0001 for v2.10.3 of HelloWorld; Amoxi500mg for Person_1A2B, ref INC0012345.\n" +
        "Commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f809a1b2c3 at 2026-10-12T10:02:11Z, weight 38.6lb, total $1,250.00.\n",
    );
    expect(text(r, "items.json")).toContain('"memo": "the Windows11 rollout is done for this month"');
  });

  test("off, nothing is redacted", () => {
    const off = applySpec(INPUTS, specWith({ ...OFF, secret: false }), { salt: SALT });
    expect(dec(out(off, "notes.md"))).toBe(NOTES);
    expect(dec(out(off, "tickets.csv"))).toContain("router sign-in aB3xY9qL until Friday");
  });

  test("a spec without the field has it off (older specs keep their output)", () => {
    const old = applySpec(INPUTS, specWith({ ...OFF }), { salt: SALT });
    expect(dec(out(old, "notes.md"))).toBe(NOTES);
  });
});

describe("secret as a class", () => {
  test("[sensitive].classes accepts secret, and the heuristic then turns the pattern on", () => {
    const toml = renderPolicy(defaultPolicy()).replace(/^classes = .*$/m, 'classes = ["person", "secret"]');
    const p = parsePolicy(toml);
    expect(p.sensitive.classes).toEqual(["person", "secret"]);
    expect(heuristicPatterns(p).secret).toBe(true);
    p.sensitive.classes = ["person"];
    expect(heuristicPatterns(p).secret).toBe(false);
  });

  test("a column of class secret under blind is redacted, cell by cell; [[columns]] can say so", () => {
    const toml = `${renderPolicy(defaultPolicy())}\n[[columns]]\nheader = "Memo"\ntreatment = "blind"\nclass = "secret"\n`;
    expect(parsePolicy(toml).columns).toEqual([{ header: ["Memo"], treatment: "blind", class: "secret" }]);
    const rule: ColumnRule = { file: "tickets.csv", header: "Memo", class: "secret", treatment: "blind", confidence: 1, source: "policy" };
    const res = applySpec([{ path: "tickets.csv", bytes: enc(CSV) }], specWith({ ...OFF }, [rule]), { salt: SALT });
    expect(dec(out(res, "tickets.csv"))).toMatch(/^Ticket,Memo\nValue_[0-9A-F]{4},REDACTED\nValue_[0-9A-F]{4},REDACTED\n$/);
    expect(res.map.entries.map((e) => e.value)).toEqual(["T-1", "T-2"]);
  });

  test("the analyst may not redact a column by calling it secret", () => {
    const profile = {
      version: 1 as const, sampleCount: 0, files: [{ path: "a.csv", format: "csv" as const, size: 10 }],
      tables: [{ file: "a.csv", headerRow: 1, columns: [{ header: "pw", stats: { count: 1, distinctRatio: 1, digitRatio: 0, dictionaryRatio: 0, meanLength: 8, detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0 }, samples: [] } }] }],
      jsonKeys: [], documents: [], transcripts: [], cooccurrence: [],
    };
    const proposal = specWith({ ...OFF }, [{ file: "a.csv", header: "pw", class: "secret", treatment: "blind", confidence: 0.9, source: "analyst" }]);
    expect(checkProposal(proposal, profile).map((i) => i.path)).toEqual(["$.columns[0].class"]);
  });
});

describe("the audit and secrets", () => {
  const spec = specWith({ ...OFF, secret: true });
  const emptyMap = { version: 1 as const, entries: [] };

  test("a surviving secret is a leak, in a text file, a table, JSON, a DOCX paragraph and a worksheet cell", () => {
    const raw = INPUTS.map((i) => file(i.path, i.bytes));
    const leaks = secretLeaks(auditTree(raw, spec, emptyMap as never));
    expect(leaks.map(([p, sev]) => `${p}:${sev}`)).toEqual([
      "items.json:leak",
      "meeting.txt:leak",
      "notes.md:leak",
      "notes.md:leak",
      "panel.xlsx:leak",
      "portal.docx:leak",
      "tickets.csv:leak",
    ]);
  });

  test("the blinded output has none, and the audit is off when the pattern is", () => {
    const r = applySpec(INPUTS, spec, { salt: SALT });
    expect(secretLeaks(auditTree(r.outputs.map((o) => file(o.path, o.bytes)), spec, r.map))).toEqual([]);
    const raw = INPUTS.map((i) => file(i.path, i.bytes));
    expect(secretLeaks(auditTree(raw, specWith({ ...OFF, secret: false }), emptyMap as never))).toEqual([]);
  });

  test("Office structure (ids, namespaces, styles, references) and images are never read as secrets", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc("Zq8!xK2#vR9$mT4%wL7&pN3*"), 0, 1, 2, 3]);
    const docx = makeZip([...docxMembers({ body: "Quarterly notes.", officeIds: true }), { name: "word/media/image1.png", data: png }]);
    const xlsx = makeZip(xlsxMembers({ body: "Quarterly notes.", officeIds: true }));
    expect(secretLeaks(auditTree([file("a.docx", docx), file("b.xlsx", xlsx)], spec, emptyMap as never))).toEqual([]);
  });
});

describe("blind run: the ticket's repro", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-secret-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("with the init template, the password said a turn after the trigger is redacted and the audit is clean", () => {
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "meeting.txt"), MEETING);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, BIN, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    expect(run("init", "--defaults").exitCode).toBe(0);
    expect(readFileSync(join(dir, "blind.toml"), "utf8")).toMatch(/^secret = true /m);
    const r = run("run", "in", "-o", "out", "--yes", "--no-model");
    expect(r.stdout.toString()).toMatch(/status: clean/);
    const got = readFileSync(join(dir, "out", "meeting.txt"), "utf8");
    expect(got).toContain("Backup box hasn't had its password rotated yet.\n");
    expect(got).toContain("Taped under the monitor - REDACTED - rotating it today.\n");
    expect(got).not.toContain("Example2031");
  });
});
