import { describe, expect, test } from "bun:test";
import { ApplyError, type ApplyResult, applySpec, engineFormat, type InputFile } from "../../src/engine/apply.ts";
import { parseTable, profileTable } from "../../src/profile/table.ts";
import { Pseudonymizer } from "../../src/engine/pseudonym.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic salt and data only: invented names, example.com, RFC 5737 addresses.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 7);

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns: [],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
  ...over,
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const text = (r: ApplyResult, path: string): string => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`no output ${path}`);
  return Buffer.from(o.bytes).toString("utf8");
};
const run = (inputs: InputFile[], s: Spec = spec()) => applySpec(inputs, s, { salt: SALT });
const col = (r: ApplyResult, path: string, header: string) =>
  r.files.find((f) => f.path === path)?.columns.find((c) => c.header === header);
const cells = (csv: string, col: number) => csv.trimEnd().split(/\r?\n/).slice(1).map((l) => l.split(",")[col]);

// 8 rows: high-cardinality codes, a status enum, Title-Case org names under an unhelpful header, prose notes.
const STAFF = [
  "Owner,Status,Ref Code,Tier,Counterparty,Notes",
  "Avery Quill,open,ZX-4471-Q,gold,Quillfeather Holdings,call back later",
  "Robin Example,closed,ZX-4472-R,gold,Brightwater Mills,waiting on the vendor",
  "Sam Placeholder,open,ZX-4473-S,silver,Copperleaf Trading,need more information",
  "Avery Quill,pending,ZX-4474-T,silver,Ironbark Supply,check the report today",
  "Jo Sample,open,ZX-4475-U,gold,Larchmont Freight,send the invoice",
  "Robin Example,closed,ZX-4476-V,gold,Mossgate Partners,talk to Avery about it",
  "Sam Placeholder,open,ZX-4477-W,silver,Fernhollow Analytics,ping 192.0.2.44 first",
  "Jo Sample,open,ZX-4478-X,gold,Thistledown Labs,the meeting moved",
].join("\n") + "\n";

const STAFF_SPEC = spec({
  columns: [rule("staff.csv", "Owner", "person", "blind"), rule("staff.csv", "Status", "vocabulary", "keep")],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }] },
});

describe("column classes (AC2)", () => {
  const r = run([file("staff.csv", STAFF)], STAFF_SPEC);
  const out = text(r, "staff.csv");

  test("every cell of a blind column gets its class pseudonym, consistently", () => {
    const owners = cells(out, 0);
    for (const o of owners) expect(o).toMatch(/^Person_[0-9A-F]{4}$/);
    expect(owners[0]).toBe(owners[3] as string);
    expect(new Set(owners).size).toBe(4);
    expect(col(r, "staff.csv", "Owner")).toMatchObject({ outcome: "blinded", changed: 8 });
  });

  test("a vocabulary/keep column is byte-identical", () => {
    expect(cells(out, 1)).toEqual(cells(STAFF, 1));
    expect(col(r, "staff.csv", "Status")).toMatchObject({ outcome: "kept", changed: 0 });
  });

  test("a keep column of a sensitive class is byte-identical too", () => {
    const keepSpec = spec({ columns: [rule("staff.csv", "Owner", "person", "keep")] });
    expect(cells(text(run([file("staff.csv", STAFF)], keepSpec), "staff.csv"), 0)).toEqual(cells(STAFF, 0));
  });

  test("value treatment and blind-with-unknown give Value_ pseudonyms", () => {
    const s = spec({
      columns: [rule("staff.csv", "Owner", "person", "value"), rule("staff.csv", "Tier", "unknown", "blind")],
    });
    const o = text(run([file("staff.csv", STAFF)], s), "staff.csv");
    for (const v of [...cells(o, 0), ...cells(o, 3)]) expect(v).toMatch(/^Value_[0-9A-F]{4}$/);
  });

  test("the same value in two blind columns gets the same pseudonym (joins survive)", () => {
    const two = "Lead,Backup\nAvery Quill,Robin Example\nRobin Example,Avery Quill\n";
    const s = spec({ columns: [rule("t.csv", "Lead", "person", "blind"), rule("t.csv", "Backup", "person", "blind")] });
    const o = text(run([file("t.csv", two)], s), "t.csv").split("\n");
    const [a, b] = (o[1] as string).split(",");
    expect((o[2] as string).split(",")).toEqual([b as string, a as string]);
  });

  test("empty cells stay empty", () => {
    const s = spec({ columns: [rule("t.csv", "Owner", "person", "blind"), rule("t.csv", "X", "vocabulary", "keep")] });
    expect(text(run([file("t.csv", "Owner,X\n,1\nAvery Quill,2\n")], s), "t.csv").split("\n")[1]).toBe(",1");
  });
});

describe("unknown columns fail closed (AC3)", () => {
  const r = run([file("staff.csv", STAFF)], STAFF_SPEC);
  const out = text(r, "staff.csv");

  test("high-cardinality code column with no rule → Value_ pseudonyms", () => {
    for (const v of cells(out, 2)) expect(v).toMatch(/^Value_[0-9A-F]{4}$/);
    expect(col(r, "staff.csv", "Ref Code")).toMatchObject({ outcome: "unknown-pseudonymised", treatment: null, changed: 8 });
  });

  test("Title-Case multi-word names under an unknown header → Value_ pseudonyms", () => {
    for (const v of cells(out, 4)) expect(v).toMatch(/^Value_[0-9A-F]{4}$/);
    expect(col(r, "staff.csv", "Counterparty")?.outcome).toBe("unknown-pseudonymised");
  });

  test("a low-cardinality enum passes and is reported as such", () => {
    expect(cells(out, 3)).toEqual(cells(STAFF, 3));
    expect(col(r, "staff.csv", "Tier")).toMatchObject({ outcome: "unknown-kept-low-cardinality", changed: 0 });
  });

  test("high-cardinality prose passes, with spec entities and patterns replaced inside it", () => {
    const notes = cells(out, 5);
    expect(notes[0]).toBe("call back later");
    expect(notes[5]).toMatch(/^talk to Person_[0-9A-F]{4} about it$/);
    expect(notes[6]).toMatch(/^ping 203\.0\.113\.\d+ first$|^ping 198\.51\.100\.\d+ first$|^ping 192\.0\.2\.\d+ first$/);
    expect(notes[6]).not.toBe("ping 192.0.2.44 first");
    expect(col(r, "staff.csv", "Notes")).toMatchObject({ outcome: "unknown-kept-not-identifier-like", changed: 2 });
  });

  test("a spec rule `unknown`/`value` runs the same test", () => {
    const s = spec({ columns: [rule("staff.csv", "Ref Code", "unknown", "value"), rule("staff.csv", "Tier", "unknown", "value")] });
    const res = run([file("staff.csv", STAFF)], s);
    expect(col(res, "staff.csv", "Ref Code")).toMatchObject({ outcome: "unknown-pseudonymised", treatment: "value" });
    expect(col(res, "staff.csv", "Tier")).toMatchObject({ outcome: "unknown-kept-low-cardinality", treatment: "value" });
  });

  test("a column with no values is kept and reported empty", () => {
    const res = run([file("t.csv", "A,B\n1,\n2,\n")]);
    expect(col(res, "t.csv", "B")?.outcome).toBe("unknown-kept-empty");
  });

  test("the fail-closed rule is what prevents a leak", () => {
    // A spec that knows the owners but has never heard of the account-number column.
    const ledger = "Owner,Account Number,Status\n" +
      Array.from({ length: 6 }, (_, i) => `Avery Quill,ACCT-00${4100 + i},open`).join("\n") + "\n";
    const s = spec({ columns: [rule("ledger.csv", "Owner", "person", "blind"), rule("ledger.csv", "Status", "vocabulary", "keep")] });
    const o = text(run([file("ledger.csv", ledger)], s), "ledger.csv");
    for (let i = 0; i < 6; i++) expect(o).not.toContain(`ACCT-00${4100 + i}`);
    expect(o).not.toContain("Avery");
    // Without the rule (a pass-through for unmentioned columns) every account number would have survived:
    expect(cells(o, 1).every((v) => /^Value_[0-9A-F]{4}$/.test(v as string))).toBe(true);
  });
});

describe("entities and patterns in free text (AC4)", () => {
  const ENT = spec({
    entities: {
      person: [{ canonical: "Avery Quill", aliases: ["Quill, Avery", "Aves"], parts: ["Avery", "Quill"] }],
      org: [{ canonical: "Example Widgets", aliases: ["Example Widgets Ltd", "EXW"], parts: [] }],
      host: [{ canonical: "db01.example.com", aliases: ["db01"], parts: [] }],
    },
  });
  const note = [
    "# Handover",
    "",
    "Avery Quill (Aves) owns db01; Quill, Avery signed for Example Widgets Ltd.",
    "EXW asked Avery. Reach avery.quill@example.com or 192.0.2.10.",
    "The exw folder and Averyville stay. GUID 123e4567-e89b-12d3-a456-426614174000.",
    "",
  ].join("\n");
  const r = run([file("notes.md", note)], ENT);
  const out = text(r, "notes.md");

  test("every alias and part of one person maps to one pseudonym", () => {
    const people = out.match(/Person_[0-9A-F]{4}/g) ?? [];
    expect(people.length).toBe(4);
    expect(new Set(people).size).toBe(1);
  });

  test("an org's aliases map to one pseudonym, longest alias first", () => {
    const orgs = out.match(/Org_[0-9A-F]{4}/g) ?? [];
    expect(orgs.length).toBe(2);
    expect(new Set(orgs).size).toBe(1);
    expect(out).not.toContain(" Ltd");
  });

  test("a host alias and the host's full name map to the same pseudonym", () => {
    const pz = new Pseudonymizer({ salt: SALT, entities: { host: ENT.entities.host ?? [] } });
    expect(out).toContain(` ${pz.pseudonym("host", "db01.example.com")};`);
  });

  test("patterns: email, IPv4 and GUID are replaced", () => {
    expect(out).not.toContain("avery.quill@example.com");
    expect(out).toMatch(/user_[0-9a-f]{4}@host-[0-9a-f]{4}\.com/);
    expect(out).not.toContain("192.0.2.10");
    expect(out).not.toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  test("case rules and whole tokens: 'exw' and 'Averyville' survive", () => {
    expect(out).toContain("The exw folder and Averyville stay.");
    expect(out.startsWith("# Handover\n\n")).toBe(true);
  });

  test("the report counts replacements", () => {
    const f = r.files[0];
    expect(f?.entityReplacements).toBe(7);
    expect(f?.patternReplacements).toBe(3);
  });

  test("entities are replaced in kept unknown cells and in the header row of a table", () => {
    const csv = "2026,10,11\nTier,Comment for EXW\ngold,EXW said hi\nsilver,ok\ngold,ok\nsilver,ok\ngold,ok\n";
    const res = run([file("t.csv", csv)], ENT);
    expect(res.files[0]?.headerRow).toBe(2);
    expect(text(res, "t.csv")).toMatch(/^2026,10,11\nTier,Comment for Org_[0-9A-F]{4}\ngold,Org_[0-9A-F]{4} said hi\nsilver,ok\n/);
  });

  test("a kept column with spec entities is left alone but flagged", () => {
    const csv = "Status,Comment\nAvery Quill,x\nopen,y\n";
    const s = { ...ENT, columns: [rule("t.csv", "Status", "vocabulary", "keep"), rule("t.csv", "Comment", "vocabulary", "keep")] };
    const res = run([file("t.csv", csv)], s);
    expect(text(res, "t.csv").split("\n")[1]).toBe("Avery Quill,x");
    expect(col(res, "t.csv", "Status")?.flagged).toBe(1);
  });

  test("a pattern that is switched off is not applied", () => {
    const off = { ...ENT, patterns: { ip: false, email: true, host: true, guid: true, mac: false } };
    expect(text(run([file("n.txt", "at 192.0.2.10")], off), "n.txt")).toBe("at 192.0.2.10");
  });
});

describe("header row (the profiler's rule)", () => {
  test("a one-cell title line above the table is free text, not the header", () => {
    const csv = "Prepared by Avery Quill\nOwner,Status\nAvery Quill,open\nRobin Example,open\n";
    const s = spec({
      columns: [rule("t.csv", "Owner", "person", "blind"), rule("t.csv", "Status", "vocabulary", "keep")],
      entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: [] }] },
    });
    const res = run([file("t.csv", csv)], s);
    expect(res.files[0]).toMatchObject({ headerRow: 2, noHeader: false });
    expect(text(res, "t.csv")).toMatch(/^Prepared by Person_[0-9A-F]{4}\nOwner,Status\nPerson_[0-9A-F]{4},open\n/);
  });

  test("with no header-like row, row 1 is used and the file says so", () => {
    const res = run([file("t.csv", "1,2\n3,4\n")]);
    expect(res.files[0]).toMatchObject({ headerRow: 1, noHeader: true });
  });
});

describe("format fidelity (AC5)", () => {
  const OWNER = spec({ columns: [rule("t.csv", "Owner", "person", "blind")] });
  const OWNER_ORT = spec({ columns: [rule("t.csv", "Owner", "person", "blind"), rule("t.csv", "Ort", "location", "keep")] });

  test("CRLF, quoting and untouched cells are preserved", () => {
    const csv = 'Owner,Status\r\n"Avery Quill","open"\r\n"Quill, Avery",closed\r\n';
    const o = text(run([file("t.csv", csv)], spec({ columns: [...OWNER.columns, rule("t.csv", "Status", "vocabulary", "keep")] })), "t.csv");
    expect(o).toMatch(/^Owner,Status\r\n"Person_[0-9A-F]{4}","open"\r\n"Person_[0-9A-F]{4}",closed\r\n$/);
  });

  test("semicolon delimiter is detected and kept", () => {
    const csv = "Owner;Amount\nAvery Quill;1,5\nRobin Example;2,5\n";
    const s = spec({ columns: [rule("t.csv", "Owner", "person", "blind"), rule("t.csv", "Amount", "vocabulary", "keep")] });
    const res = run([file("t.csv", csv)], s);
    expect(text(res, "t.csv")).toMatch(/^Owner;Amount\nPerson_[0-9A-F]{4};1,5\nPerson_[0-9A-F]{4};2,5\n$/);
    expect(res.files[0]?.delimiter).toBe(";");
  });

  test("profiler and engine agree on headers for semicolon CSV, pipe CSV and quoted TSV (AGT-1777)", () => {
    const cases: [string, "csv" | "tsv", string][] = [
      ["s.csv", "csv", "Owner;Note\nAvery Quill;a, b\nRobin Example;c\n"],
      ["p.csv", "csv", "Owner|Note\nAvery Quill|a, b\nRobin Example|c\n"],
      ["q.tsv", "tsv", 'Owner\t"Note, Text"\nAvery Quill\t"x\ty"\nRobin Example\ty\n'],
    ];
    for (const [path, fmt, body] of cases) {
      const profiled = profileTable(path, parseTable(body, fmt), 3).table.columns.map((c) => c.header);
      expect(profiled.length).toBe(2);
      const s = spec({ columns: [rule(path, "Owner", "person", "blind")] });
      const res = run([file(path, body)], s);
      expect(res.files[0]?.columns.map((c) => c.header)).toEqual(profiled);
      expect(text(res, path)).toMatch(/Person_[0-9A-F]{4}/);
    }
  });

  test(".tab and .tsv sniff the delimiter, preferring tab on a tie; profiler and engine agree (AGT-1818)", () => {
    const cases: [string, "csv" | "tsv", string, string][] = [
      ["x.tab", "tsv", "Owner|Note\nAvery Quill|a\nRobin Example|b\n", "|"],
      ["x.tsv", "tsv", "Owner|Note\nAvery Quill|a\nRobin Example|b\n", "|"],
      ["y.tab", "tsv", "Owner\tNote\nAvery Quill\ta\nRobin Example\tb\n", "\t"],
      ["z.tab", "tsv", "Owner\tNote|x\nAvery Quill\ta|c\n", "\t"],
    ];
    for (const [path, fmt, body, delim] of cases) {
      const profiled = profileTable(path, parseTable(body, fmt), 3).table.columns.map((c) => c.header);
      const s = spec({ columns: [rule(path, "Owner", "person", "blind"), rule(path, "Note" + (path === "z.tab" ? "|x" : ""), "vocabulary", "keep")] });
      const res = run([file(path, body)], s);
      expect(res.files[0]?.columns.map((c) => c.header)).toEqual(profiled);
      expect(res.files[0]?.delimiter).toBe(delim);
      expect(profiled.length).toBe(2);
      if (delim === "|") expect(text(res, path)).toMatch(/^Owner\|Note\nPerson_[0-9A-F]{4}\|a\nPerson_[0-9A-F]{4}\|b\n$/);
    }
  });

  test("TSV", () => {
    const tsv = "Owner\tNote\nAvery Quill\tok\n";
    const s = spec({ columns: [rule("t.tsv", "Owner", "person", "blind"), rule("t.tsv", "Note", "vocabulary", "keep")] });
    expect(text(run([file("t.tsv", tsv)], s), "t.tsv")).toMatch(/^Owner\tNote\nPerson_[0-9A-F]{4}\tok\n$/);
  });

  test("UTF-16LE with BOM stays UTF-16LE", () => {
    const csv = "Owner,Ort\r\nAvery Quill,Zürich\r\n";
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
    const res = applySpec([{ path: "t.csv", bytes }], OWNER_ORT, { salt: SALT });
    const out = Buffer.from(res.outputs[0]?.bytes as Uint8Array);
    expect([out[0], out[1]]).toEqual([0xff, 0xfe]);
    expect(out.subarray(2).toString("utf16le")).toMatch(/^Owner,Ort\r\nPerson_[0-9A-F]{4},Zürich\r\n$/);
    expect(res.files[0]?.encoding).toBe("utf16le");
  });

  test("UTF-8 BOM is kept", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Owner\nAvery Quill\n")]);
    const out = Buffer.from(applySpec([{ path: "t.csv", bytes }], OWNER, { salt: SALT }).outputs[0]?.bytes as Uint8Array);
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("Latin-1 bytes outside the replaced spans are untouched", () => {
    const bytes = Buffer.from("Owner,Ort\nAvery Quill,K\xf6ln\n", "latin1");
    const out = Buffer.from(applySpec([{ path: "t.csv", bytes }], OWNER_ORT, { salt: SALT }).outputs[0]?.bytes as Uint8Array);
    expect(out.toString("latin1")).toMatch(/^Owner,Ort\nPerson_[0-9A-F]{4},K\xf6ln\n$/);
  });

  test("a file with nothing to replace is returned byte for byte", () => {
    const bytes = Buffer.from("plain words only\r\nsecond line", "utf8");
    const res = applySpec([{ path: "n.txt", bytes }], spec(), { salt: SALT });
    expect(res.outputs[0]?.bytes).toBe(bytes);
    expect(res.files[0]?.changed).toBe(false);
  });
});

describe("determinism", () => {
  const inputs = () => [
    file("staff.csv", STAFF),
    file("notes.md", "Avery met 192.0.2.7 and 192.0.2.8 at db01.example.com.\n"),
    file("ids.csv", "Ticket,Owner\n1001,Avery Quill\n1002,Robin Example\n"),
  ];
  const s = spec({
    ...STAFF_SPEC,
    columns: [...STAFF_SPEC.columns, rule("ids.csv", "Ticket", "id", "blind"), rule("ids.csv", "Owner", "person", "blind")],
  });
  const snapshot = (r: ApplyResult) => JSON.stringify({ o: r.outputs.map((o) => [o.path, Buffer.from(o.bytes).toString("hex")]), m: r.map, f: r.files });

  test("same inputs, spec and salt → identical outputs, reports and map", () => {
    expect(snapshot(run(inputs(), s))).toBe(snapshot(run(inputs(), s)));
  });

  test("input order does not matter", () => {
    expect(snapshot(run(inputs().reverse(), s))).toBe(snapshot(run(inputs(), s)));
  });

  test("a different salt gives different pseudonyms", () => {
    const other = applySpec(inputs(), s, { salt: Uint8Array.from({ length: 32 }, (_, i) => 200 - i) });
    expect(text(other, "staff.csv")).not.toBe(text(run(inputs(), s), "staff.csv"));
  });

  test("an earlier map pins every pseudonym it holds", () => {
    const first = run([file("a.csv", "Owner\nAvery Quill\n")], spec({ columns: [rule("a.csv", "Owner", "person", "blind")] }));
    const otherSalt = Uint8Array.from({ length: 32 }, (_, i) => 99 + i);
    const second = applySpec([file("a.csv", "Owner\nAvery Quill\n")], spec({ columns: [rule("a.csv", "Owner", "person", "blind")] }), {
      salt: otherSalt,
      map: first.map,
    });
    expect(text(second, "a.csv")).toBe(text(first, "a.csv"));
  });

  test("numeric ID pseudonyms never equal a real value anywhere in the corpus", () => {
    const res = run(inputs(), s);
    const ids = cells(text(res, "ids.csv"), 0);
    for (const id of ids) {
      expect(id).toMatch(/^\d{4}$/);
      expect(["1001", "1002"]).not.toContain(id as string);
    }
  });

  test("the map records every pseudonym used", () => {
    const res = run(inputs(), s);
    const pseudonyms = new Set(res.map.entries.map((e) => e.pseudonym));
    for (const p of text(res, "staff.csv").match(/(?:Person|Value)_[0-9A-F]{4}/g) ?? []) expect(pseudonyms.has(p)).toBe(true);
  });
});

describe("refusals and skips", () => {
  test("unsupported formats are reported and not written", () => {
    const res = run([file("data.pdf", "%PDF"), file("n.txt", "x")]);
    expect(res.outputs.map((o) => o.path)).toEqual(["n.txt"]);
    expect(res.skipped).toEqual([{ path: "data.pdf", reason: expect.stringContaining("not written") }]);
  });

  test("malformed CSV is reported and not written", () => {
    const res = run([file("bad.csv", 'a,b\n1,"open')]);
    expect(res.outputs).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/malformed CSV: unterminated quoted field/);
  });

  test("a rule for a column that is not in the file is an error", () => {
    const s = spec({ columns: [rule("t.csv", "Ownr", "person", "blind")] });
    expect(() => run([file("t.csv", "Owner\nAvery Quill\n")], s)).toThrow(ApplyError);
  });

  test("a jsonPath rule on a CSV file is an error", () => {
    const s = spec({ columns: [{ file: "t.csv", jsonPath: "$.x", class: "person", treatment: "blind", confidence: 1, source: "human" }] });
    expect(() => run([file("t.csv", "Owner\nx\n")], s)).toThrow(/jsonPath/);
  });

  test("a column rule on a text file is an error", () => {
    const s = spec({ columns: [rule("n.txt", "Owner", "person", "blind")] });
    expect(() => run([file("n.txt", "Owner")], s)).toThrow(/text file/);
  });

  test("rules for files that are not among the inputs are ignored", () => {
    const s = spec({ columns: [rule("elsewhere.csv", "Owner", "person", "blind")] });
    expect(run([file("n.txt", "x")], s).outputs).toHaveLength(1);
  });

  test("two inputs with the same path are an error", () => {
    expect(() => run([file("n.txt", "a"), file("n.txt", "b")])).toThrow(/share the path/);
  });
});

describe("engineFormat", () => {
  test.each([
    ["a.csv", "csv"],
    ["dir/A.CSV", "csv"],
    ["a.tsv", "tsv"],
    ["a.txt", "text"],
    ["a.md", "text"],
    ["a.log", "text"],
    ["a.json", "json"],
    ["a.jsonl", "jsonl"],
    ["A.NDJSON", "jsonl"],
    ["a.docx", "docx"],
    ["a.xlsx", "xlsx"],
    ["a.xlsm", null],
    ["Makefile", null],
    [".csv", null],
    ["dir.csv/readme", null],
  ])("%s → %p", (path, want) => {
    expect(engineFormat(path)).toBe(want as ReturnType<typeof engineFormat>);
  });
});
