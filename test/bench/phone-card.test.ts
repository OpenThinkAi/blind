// AGT-1848: phones written with a slash, a "?" (a dash mangled by a lossy 8-bit conversion) or a Unicode
// dash, bare 10-digit phones that the words around them (or their column) vouch for, and payment card
// numbers (card IIN prefix + Luhn) in any grouping, in every format that carries free text. Everything
// here is invented: 555-01xx numbers and test card numbers.

import { describe, expect, test } from "bun:test";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { buildDocument, buildWorkbook } from "../../src/bench/office.ts";
import { phoneDigits } from "../../src/engine/canonical.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { isPhoneColumn } from "../../src/engine/columns.ts";
import { cardDigits, findPatternSpans } from "../../src/engine/text.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { type ColumnRule, patternOn, type Patterns, type Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const SECRET_ON: Patterns = { ip: false, email: false, host: false, guid: false, mac: false, phone: true, secret: true };
const spec = (columns: ColumnRule[] = [], patterns: Patterns = SECRET_ON): Spec => ({ version: 1, columns, entities: {}, patterns, questions: [] });
const run = (files: Record<string, string | Uint8Array>, columns: ColumnRule[] = [], opts: { patterns?: Patterns; unruled?: "scan" | "fallback" } = {}): ApplyResult =>
  applySpec(
    Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: typeof v === "string" ? enc(v) : v })),
    spec(columns, opts.patterns),
    { salt: SALT, columns: opts.unruled ?? "scan" },
  );
const out = (r: ApplyResult, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);
const spans = (text: string, patterns: Patterns = SECRET_ON) => findPatternSpans(text, patterns).map((s) => text.slice(s.start, s.end));

describe("phone separators", () => {
  test("a slash, a ? and the Unicode dashes separate groups, and canonicalise to the same digits", () => {
    for (const p of ["555/555-0101", "555?555?0104", "555‐555–0100", "555‒555―0100", "(555)/555-0100", "1/555/555/0100"]) {
      expect(phoneDigits(p)).toBe(p.startsWith("1/") ? "5555550100" : p.replace(/\D/g, ""));
      expect(spans(`call ${p} now`)).toEqual([p]);
    }
    expect(phoneDigits("555/555-0100")).toBe(phoneDigits("555-555-0100"));
  });

  test("a date, a path and a longer dashed number are not phones", () => {
    expect(spans("on 2026/05/14 at /api/v1/123/456/7890/ and 12-555-555-0100-1")).toEqual([]);
  });
});

describe("bare 10-digit phones", () => {
  test("a phone word within a few tokens, or a parenthetical relation, makes a bare run a phone", () => {
    expect(spans("Home phone: 5555550100.")).toEqual(["5555550100"]);
    expect(spans("tel=15555550100 ok")).toEqual(["15555550100"]);
    expect(spans("Sam Sample (sister) 5555550100")).toEqual(["5555550100"]);
    expect(spans("5555550100 (neighbour) knows")).toEqual(["5555550100"]);
    expect(spans("please call him back on 5555550100")).toEqual(["5555550100"]);
    expect(spans("contact #5555550100")).toEqual(["5555550100"]);
  });

  test("an accession, order or account number without that context is not a phone", () => {
    expect(spans("Accession 5555550100 was filed")).toEqual([]);
    expect(spans("order 8015550100 shipped")).toEqual([]);
    expect(spans("order # 8015550100 shipped, call us")).toEqual([]);
    expect(spans("5555550100")).toEqual([]);
    expect(spans("ref 5555550100 (see note)")).toEqual([]);
  });

  test("a run that is not NANP-valid is not a phone, even beside a phone word", () => {
    expect(spans("phone 1555550100")).toEqual([]); // a leading 1, then an area code starting 5, 8 digits short
    expect(spans("phone 0555550100")).toEqual([]);
    expect(spans("phone 5551550100")).toEqual([]); // exchange starts with 1
    expect(spans("phone 55555501001")).toEqual([]); // eleven digits not starting with 1
  });

  test("a bare phone and the same number with separators share one pseudonym", () => {
    const r = run({ "a.txt": "cell 5555550100 and again 555-555-0100 or 555/555/0100.\n" });
    const ids = [...out(r, "a.txt").matchAll(/Id_[0-9A-F]{4}/g)].map((m) => m[0]);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(1);
  });

  test("a column of phones: the bare number among formatted ones is a phone; a column of bare numbers is not", () => {
    expect(isPhoneColumn(["555-555-0100", "5555550101", ""])).toBe(true);
    expect(isPhoneColumn(["5555550100", "5555550101"])).toBe(false);
    expect(isPhoneColumn(["555-555-0100", "see note"])).toBe(false);
    expect(isPhoneColumn(["555-555-0100"])).toBe(false);
    const csv = "name,mobile,accession\nA,555-555-0100,2345678901\nB,5555550101,2345678902\n";
    const o = out(run({ "p.csv": csv }), "p.csv");
    expect(o).not.toContain("5555550101");
    expect(o).not.toContain("555-555-0100");
    expect(o).toContain("2345678901\n");
  });
});

describe("card pattern", () => {
  test("cards in every grouping, with or without a trigger word", () => {
    // 4-4-4-4, unseparated, 4-6-5 (15 digits), 4-6-4 (14), 4-4-4-4-3 (19), and one of each other card prefix.
    const cards = ["4000-0000-0000-0010", "4000000000000028", "3400 000000 00009", "4000 000000 0010", "4000 0000 0000 0000 006", "378282246310005", "6011000000000004", "5555 5555 5555 4444", "2221000000000009", "3530111333300000"];
    for (const c of cards) {
      expect(cardDigits(c)).toBe(c.replace(/\D/g, ""));
      expect(spans(`ref ${c} end`)).toEqual([c]);
    }
  });

  test("a microchip number, an order number, a Luhn-invalid run and a wrong prefix are not cards", () => {
    expect(spans("chip 985112345678903")).toEqual([]); // 15 digits, no card IIN
    expect(cardDigits("985112345678903")).toBeUndefined();
    expect(spans("order 4000000000000011 shipped")).toEqual([]); // prefix 4, Luhn-invalid
    expect(spans("acct 1234567890123456")).toEqual([]);
    expect(spans("acc 8000000000000008")).toEqual([]);
    expect(spans("id 40000000000000 and 40000000000000000000")).toEqual([]); // 14 unseparated Luhn-invalid; 20 digits
    expect(spans("year 2026 4000-0000-0000")).toEqual([]);
  });

  test("on whenever secret is on, off with it, and settable on its own", () => {
    expect(patternOn(SECRET_ON, "card")).toBe(true);
    expect(patternOn({ ...SECRET_ON, secret: false }, "card")).toBe(false);
    expect(patternOn({ ...SECRET_ON, card: false }, "card")).toBe(false);
    expect(patternOn({ ...SECRET_ON, secret: false, card: true }, "card")).toBe(true);
    expect(spans("pay 4000000000000028", { ...SECRET_ON, card: false })).toEqual([]);
  });

  test("the repro: every phone becomes Id_ and every card REDACTED, and no card is in the map", () => {
    const r = run({
      "n.csv": 'contact,notes\nSam Sample (sister) 5555550100,"Driver left 555/555-0101"\nMax Test 555/555-0102,"Paid 4000-0000-0000-0010; also 3400 000000 00009"\n',
      "s.log": "pay ok card_no=4000000000000028 tel=555?555?0104\n",
    });
    const csv = out(r, "n.csv");
    expect(csv).toMatch(/\(sister\) Id_[0-9A-F]{4},"Driver left Id_[0-9A-F]{4}"/);
    expect(csv).toMatch(/Max Test Id_[0-9A-F]{4},"Paid REDACTED; also REDACTED"/);
    expect(out(r, "s.log")).toMatch(/^pay ok card_no=REDACTED tel=Id_[0-9A-F]{4}\n$/);
    const map = JSON.stringify(r.map);
    for (const n of ["4000", "3400", "0000000"]) expect(map).not.toContain(n);
    expect(r.map.entries.map((e) => e.value).filter((v) => /\d{4}/.test(v) && !v.includes("555"))).toEqual([]);
  });
});

describe("formats", () => {
  test("JSON string values, including card_no and pan keys in nested objects", () => {
    const json = JSON.stringify({ msgs: [{ pan: "4000-0000-0000-0010", body: "ring 555/555-0101 later", nested: { card_no: "4000000000000028", sms: "tel 555?555?0104" } }] });
    const o = out(run({ "m.json": json }), "m.json");
    expect(o).not.toMatch(/4000|555/);
    expect(JSON.parse(o).msgs[0].pan).toBe("REDACTED");
    expect(JSON.parse(o).msgs[0].nested.card_no).toBe("REDACTED");
    expect(o).toMatch(/Id_[0-9A-F]{4}/);
  });

  test("DOCX runs", () => {
    const docx = buildDocument([["Card ", "4000-0000-0000-0010 on file"], ["Call 555/555-0102 ", "or text 5555550100"]], { title: "", creator: "", modifiedBy: "" });
    const r = run({ "d.docx": docx });
    expect(r.skipped).toEqual([]);
    const bytes = (r.outputs.find((o) => o.path === "d.docx") as InputFile).bytes;
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toMatch(/4000-0000|555\/555|5555550100/);
  });

  test("XLSX cells on a visible, hidden and veryHidden sheet", () => {
    const cell = ["note", "Paid 4000-0000-0000-0010, call 555/555-0101", "tel 555?555?0104 cell"];
    const wb = buildWorkbook({
      sheets: [
        { name: "Open", rows: [cell] },
        { name: "Hid", state: "hidden", rows: [cell] },
        { name: "Deep", state: "veryHidden", rows: [cell] },
      ],
      orphans: [],
      definedNames: [],
      core: { title: "", creator: "", modifiedBy: "" },
    });
    const r = run({ "w.xlsx": wb });
    expect(r.skipped).toEqual([]);
    const o = readWorkbook((r.outputs.find((x) => x.path === "w.xlsx") as InputFile).bytes);
    expect(o.sheets.length).toBe(3);
    for (const sheet of o.sheets) {
      const rows = sheetRows(sheet, o.sharedStrings);
      expect(rows[0]?.[1]).toMatch(/^Paid REDACTED, call Id_[0-9A-F]{4}$/);
      expect(rows[0]?.[2]).toMatch(/^tel Id_[0-9A-F]{4} cell$/);
    }
  });
});

describe("audit", () => {
  const entry = (path: string, text: string): TreeEntry => ({ path, kind: "file", bytes: Buffer.from(text, "utf8") });
  const empty = { version: 1 as const, entries: [] };

  test("a card or phone left in any format above is a leak", () => {
    const r = auditTree(
      [entry("a.txt", "pay 4000-0000-0000-0010 and 4000000000000028\nring 555/555-0101 or tel=555?555?0104, mobile 5555550100\n")],
      spec(),
      empty,
    );
    const hits = r.files.flatMap((f) => f.findings).filter((f) => f.source === "pattern");
    expect(hits.map((f) => f.class).sort()).toEqual(["pattern:card", "pattern:card", "pattern:phone", "pattern:phone", "pattern:phone"]);
    expect(hits.every((f) => f.severity === "leak")).toBe(true);
  });

  test("REDACTED and a number without context are not reported", () => {
    const r = auditTree([entry("a.txt", "pay REDACTED, accession 5555550100, order 4000000000000011\n")], spec(), empty);
    expect(r.files.flatMap((f) => f.findings).filter((f) => f.source === "pattern")).toEqual([]);
  });
});

describe("a card in a pseudonymised column", () => {
  test("a blind rule never gives a card a pseudonym or a map entry: it is REDACTED, as a number or a string", () => {
    const rule: ColumnRule = { file: "p.csv", header: "pan", class: "id", treatment: "blind", confidence: 1, source: "heuristic" };
    const r = run({ "p.csv": "name,pan\nA,4000000000000028\nB,4000-0000-0000-0010\nC,ZZ-0001\n", "j.json": '{"card_no": 4000000000000028}' }, [rule], { unruled: "fallback" });
    expect(out(r, "p.csv")).toMatch(/^name,pan\n\w+,REDACTED\n\w+,REDACTED\n\w+,Id_[0-9A-F]{4}\n$/);
    expect(JSON.parse(out(r, "j.json")).card_no).toBe("REDACTED");
    expect(JSON.stringify(r.map)).not.toMatch(/4000/);
  });

  test("with the card pattern off, the column is pseudonymised as before", () => {
    const rule: ColumnRule = { file: "p.csv", header: "pan", class: "id", treatment: "blind", confidence: 1, source: "heuristic" };
    const r = run({ "p.csv": "name,pan\nA,4000000000000028\n" }, [rule], { patterns: { ...SECRET_ON, secret: false } });
    expect(out(r, "p.csv")).not.toContain("REDACTED");
    expect(out(r, "p.csv")).not.toContain("4000000000000028");
  });
});

describe("a numeric XLSX cell", () => {
  test("a phone or card typed as a number is not left in the clear", () => {
    const wb = buildWorkbook({ sheets: [{ name: "S", rows: [["tel", "card"], [5555550100, 4000000000000028]] }], orphans: [], definedNames: [], core: { title: "", creator: "", modifiedBy: "" } });
    const r = run({ "n.xlsx": wb });
    const o = readWorkbook((r.outputs.find((x) => x.path === "n.xlsx") as InputFile).bytes);
    const rows = sheetRows(o.sheets[0] as (typeof o.sheets)[number], o.sharedStrings);
    expect(rows[1]).toBeDefined();
    expect(rows[1]?.join("|")).not.toMatch(/4000000000000028/);
  });
});
