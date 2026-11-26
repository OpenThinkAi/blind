import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { runAudit } from "../src/audit/command.ts";
import { parseCsv } from "../src/engine/csv.ts";
import { applySpec, auditOutputs, revealText, type Spec } from "../src/lib.ts";

// AGT-1779 end to end: a value blinded in one column that recurs in a text file and in a kept
// column is replaced there too, and the audit finds nothing. Synthetic corpus only.
const SPEC = {
  version: 1,
  columns: [
    { file: "projects.csv", header: "Project", class: "id", treatment: "blind", confidence: 1, source: "human" },
    { file: "projects.csv", header: "Phase", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
    { file: "projects.csv", header: "Summary", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
  ],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-recur-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 9)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
  mkdirSync(join(dir, "in"));
  writeFileSync(
    join(dir, "in", "projects.csv"),
    "Project,Phase,Summary\nPRJ-7731,build,depends on Larkspur Ridge\nLarkspur Ridge,design,follows PRJ-7731\n",
  );
  writeFileSync(join(dir, "in", "status.txt"), "PRJ-7731 is late; Larkspur Ridge is on time.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sink(): [PassThrough, () => string] {
  const s = new PassThrough();
  let text = "";
  s.on("data", (d) => (text += d));
  return [s, () => text];
}

describe("a blinded column value recurring elsewhere (AGT-1779)", () => {
  test("blind apply replaces it in the text file and the kept column; blind audit is clean", async () => {
    const [out, outText] = sink();
    const [err] = sink();
    expect(await runApply(["in", "-o", "out"], { out, err, cwd: dir })).toBe(0);
    expect(outText()).toContain("values blinded in a column or in Office metadata replaced again where they recur outside it");

    const csv = readFileSync(join(dir, "out", "projects.csv"), "utf8");
    const txt = readFileSync(join(dir, "out", "status.txt"), "utf8");
    for (const t of [csv, txt]) {
      expect(t).not.toContain("PRJ-7731");
      expect(t).not.toContain("Larkspur");
    }
    const [, a, b] = csv.trimEnd().split("\n").map((l) => l.split(","));
    // The kept Summary cells carry the same pseudonyms as the blinded Project cells.
    expect(a?.[2]).toBe(`depends on ${b?.[0]}`);
    expect(b?.[2]).toBe(`follows ${a?.[0]}`);
    expect(txt).toBe(`${a?.[0]} is late; ${b?.[0]} is on time.\n`);

    const [aout, aoutText] = sink();
    const [aerr] = sink();
    expect(await runAudit(["out", "--no-model"], { out: aout, err: aerr, cwd: dir })).toBe(0);
    expect(aoutText()).toContain("status: clean");
  });
});

// AGT-2783: a digits-only value from a dropped, redacted or blinded column (or an earlier map) is never
// written into a longer number, nor into a kept cell that reads whole as a number, amount or date.
// Names, ids with letters and kept free text still take recurrences. Library entry, in memory;
// synthetic data only.
describe("a recurring number never lands inside a kept number or date (AGT-2783)", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
  const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
  const rule = (file: string, header: string, cls: string, treatment: string) => ({ file, header, class: cls, treatment, confidence: 1, source: "human" });
  const specOf = (num: object, extra: object[] = []): Spec =>
    ({
      version: 1,
      columns: [
        rule("ledger.csv", "Date", "vocabulary", "keep"),
        num,
        rule("ledger.csv", "Amount", "vocabulary", "keep"),
        rule("ledger.csv", "Qty", "vocabulary", "keep"),
        rule("ledger.csv", "Notes", "vocabulary", "keep"),
        ...extra,
      ],
      entities: {},
      patterns: { ip: true, email: true, host: true, guid: true, mac: false },
      questions: [],
    }) as unknown as Spec;
  // Every Num value below (2026, 1048, 101, 12, 77) also appears inside a kept figure or date.
  const LEDGER = [
    "Date,Num,Amount,Qty,Notes",
    "2026-01-05,2026,1048,12,see invoice 1048",
    "2026-01-06,1048,2026.50,1048,paid",
    "2027-01-07,12,31048.00,5,ok",
    '2026-01-08,77,"1,048.00",10480,ok',
    "2026-01-09,101,101.07,(1048.93),ok",
    '2026-01-05 09:00,1048,-1048.93,"$1,048.00",ok',
    "",
  ].join("\n");
  const TEXT = "check 1048. total 1048.93 on 3.1048 and 1048, then\n";
  const out = (r: { outputs: { path: string; bytes: Uint8Array }[] }, path: string): string => dec((r.outputs.find((o) => o.path === path) as { bytes: Uint8Array }).bytes);
  const rows = (csv: string): string[][] => parseCsv(csv, ",").map((r) => r.cells.map((c) => c.value));
  const ORIGINAL = rows(LEDGER);
  /** Every kept cell but Notes, as written in the input. */
  const keptFigures = (csv: string, numCol: boolean): void => {
    const got = rows(csv);
    for (let r = 1; r < ORIGINAL.length - 1; r++) {
      const o = ORIGINAL[r] as string[];
      const g = got[r] as string[];
      const [date, amount, qty] = numCol ? [g[0], g[2], g[3]] : [g[0], g[1], g[2]];
      expect([date, amount, qty]).toEqual([o[0], o[2], o[3]]);
    }
  };
  const inputs = () => [
    { path: "ledger.csv", bytes: enc(LEDGER) },
    { path: "note.txt", bytes: enc(TEXT) },
  ];

  test("a dropped number: every kept figure and date comes through; free text and sentence ends still change", () => {
    const r = applySpec(inputs(), specOf(rule("ledger.csv", "Num", "unknown", "drop")), { salt: SALT });
    const csv = out(r, "ledger.csv");
    expect(csv.split("\n")[0]).toBe("Date,Amount,Qty,Notes");
    keptFigures(csv, false);
    // A digits-only value still recurs into a kept cell of free text.
    expect(rows(csv)[1]?.[3]).toBe("see invoice REDACTED");
    expect(out(r, "note.txt")).toBe("check REDACTED. total 1048.93 on 3.1048 and REDACTED, then\n");
  });

  for (const [label, num, policy] of [
    ["blinded (Value)", rule("ledger.csv", "Num", "unknown", "blind"), {}],
    ["blinded, readable stand-ins", rule("ledger.csv", "Num", "unknown", "blind"), { pseudonyms: { style: "readable" as const } }],
    ["blinded with class id", rule("ledger.csv", "Num", "id", "blind"), {}],
  ] as const) {
    test(`a ${label} number: no stand-in inside a kept figure or date; reveal round-trips`, () => {
      const r = applySpec(inputs(), specOf(num), { salt: SALT, policy });
      const csv = out(r, "ledger.csv");
      keptFigures(csv, true);
      const g = rows(csv);
      const stand = g[2]?.[1] as string;
      expect(stand).not.toBe("1048");
      expect(g[1]?.[4]).toBe(`see invoice ${stand}`);
      expect(out(r, "note.txt")).toBe(`check ${stand}. total 1048.93 on 3.1048 and ${stand}, then\n`);
      expect(revealText(csv, r.map)).toBe(LEDGER);
      expect(revealText(out(r, "note.txt"), r.map)).toBe(TEXT);
      // The engine leaves 1048 in kept cells and inside 1048.93: the audit says so, never clean, never a leak.
      const a = auditOutputs(r.outputs, specOf(num), r.map);
      expect(a.status).toBe("candidates");
      const findings = a.files.flatMap((f) => f.findings);
      expect(findings.some((f) => f.file === "ledger.csv" && f.source === "map" && f.reason.includes("kept by rule"))).toBe(true);
      expect(findings.some((f) => f.file === "note.txt" && f.reason.includes("inside a longer number"))).toBe(true);
    });
  }

  test("an earlier map's number is held to the same two rules", () => {
    const first = applySpec([{ path: "ledger.csv", bytes: enc(LEDGER) }], specOf(rule("ledger.csv", "Num", "id", "blind")), { salt: SALT });
    const spec = { ...specOf(rule("ledger.csv", "Num", "id", "blind")), columns: [rule("books.csv", "Total", "vocabulary", "keep"), rule("books.csv", "Memo", "vocabulary", "keep")] } as unknown as Spec;
    const books = "Total,Memo\n1048.93,ref 1048\n1048,ok\n2026-01-05,ok\n";
    const r = applySpec([{ path: "books.csv", bytes: enc(books) }], spec, { salt: SALT, map: first.map });
    const stand = rows(out(first, "ledger.csv"))[2]?.[1] as string;
    expect(out(r, "books.csv")).toBe(`Total,Memo\n1048.93,ref ${stand}\n1048,ok\n2026-01-05,ok\n`);
  });

  test("names, emails and ids with letters still recur into kept cells", () => {
    const people = "Owner,Ref,Notes,Amount\nMarlow Quillfeather,A1048,Marlow Quillfeather called about A1048,1048.00\n";
    const spec = {
      version: 1,
      columns: [rule("people.csv", "Owner", "person", "blind"), rule("people.csv", "Ref", "id", "blind"), rule("people.csv", "Notes", "vocabulary", "keep"), rule("people.csv", "Amount", "vocabulary", "keep")],
      entities: {},
      patterns: { ip: true, email: true, host: true, guid: true, mac: false },
      questions: [],
    } as unknown as Spec;
    const r = applySpec([{ path: "people.csv", bytes: enc(people) }], spec, { salt: SALT });
    const [, row] = rows(out(r, "people.csv"));
    expect(row?.[2]).toBe(`${row?.[0]} called about ${row?.[1]}`);
    expect(row?.[2]).not.toContain("Quillfeather");
    expect(row?.[3]).toBe("1048.00");
  });

  test("a JSON value under a keep path that reads as a number or date is not rewritten", () => {
    const json = '[\n  { "num": 1048, "amount": 1048, "total": -1048.93, "when": "2026-01-05", "note": "see invoice 1048" }\n]\n';
    const spec = {
      version: 1,
      columns: [
        { file: "pay.json", jsonPath: "$[*].num", class: "unknown", treatment: "drop", confidence: 1, source: "human" },
        ...["amount", "total", "when", "note"].map((k) => ({ file: "pay.json", jsonPath: `$[*].${k}`, class: "vocabulary", treatment: "keep", confidence: 1, source: "human" })),
      ],
      entities: {},
      patterns: { ip: true, email: true, host: true, guid: true, mac: false },
      questions: [],
    } as unknown as Spec;
    const r = applySpec([{ path: "pay.json", bytes: enc(json) }], spec, { salt: SALT });
    expect(JSON.parse(out(r, "pay.json"))).toEqual([{ amount: 1048, total: -1048.93, when: "2026-01-05", note: "see invoice REDACTED" }]);
  });
});
