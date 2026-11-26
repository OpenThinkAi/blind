import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { PseudonymError, Pseudonymizer, type PseudonymStyle } from "../../src/engine/pseudonym.ts";
import { revealFile, Revealer } from "../../src/engine/reveal.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { readZip } from "../formats/zipfixture.ts";

// AGT-2786: a numeric ID whose same-width space is full (or crowded) widens instead of failing.
// Synthetic salts and invented data only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const APPLY_SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const STYLES: PseudonymStyle[] = ["compact", "readable", "letters"];

/** Every digit string of one width: with `zeros`, those with a leading zero too. */
const every = (width: number, zeros = width === 1): string[] => {
  const lo = zeros ? 0 : width === 1 ? 1 : 10 ** (width - 1);
  return Array.from({ length: 10 ** width - lo }, (_, i) => String(lo + i).padStart(width, "0"));
};

describe("numeric ids widen when their width is full", () => {
  for (const style of STYLES) {
    for (const width of [1, 2, 3, 4]) {
      test(`${width}-digit ids against a corpus holding every ${width}-digit number (${style})`, () => {
        const real = every(width);
        const avoid = new Set(real);
        const ids = real.slice(0, 5);
        const p = new Pseudonymizer({ salt: SALT, avoid: real, style });
        const out = ids.map((v) => p.pseudonym("id", v));
        expect(new Set(out).size).toBe(ids.length);
        for (const o of out) {
          expect(o).toMatch(new RegExp(`^[1-9]\\d{${width}}$`));
          expect(avoid.has(o)).toBe(false);
        }
        // Deterministic: a fresh pseudonymizer gives the same answers.
        const again = new Pseudonymizer({ salt: SALT, avoid: real, style });
        expect(ids.map((v) => again.pseudonym("id", v))).toEqual(out);
        // The map pairs each wider stand-in with its value, so reveal restores it.
        const rv = new Revealer(p.toMap());
        for (const [i, o] of out.entries()) expect(rv.text(`ref ${o}.`).text).toBe(`ref ${ids[i]}.`);
      });
    }
  }

  test("a width is skipped while it too is full: the next width with a free value is used", () => {
    const real = [...every(1), ...every(2)];
    const out = new Pseudonymizer({ salt: SALT, avoid: real }).pseudonym("id", "7");
    expect(out).toMatch(/^[1-9]\d{2}$/);
  });

  test("a crowded width with one free value uses it before widening", () => {
    const real = every(3).filter((v) => v !== "777");
    const p = new Pseudonymizer({ salt: SALT, avoid: real });
    expect(p.pseudonym("id", "101")).toBe("777");
    // The width is now full: the next id widens.
    expect(p.pseudonym("id", "102")).toMatch(/^[1-9]\d{3}$/);
  });

  test("a mixed column: 3-digit ids widen, 6-digit ids keep their width and their stand-ins", () => {
    const p = new Pseudonymizer({ salt: SALT, avoid: every(3) });
    const short = ["101", "205", "999"].map((v) => p.pseudonym("id", v));
    const long = ["004217", "123456", "987654"].map((v) => p.pseudonym("id", v));
    for (const s of short) expect(s).toMatch(/^[1-9]\d{3}$/);
    for (const l of long) expect(l).toMatch(/^\d{6}$/);
    const plain = new Pseudonymizer({ salt: SALT });
    expect(long).toEqual(["004217", "123456", "987654"].map((v) => plain.pseudonym("id", v)));
  });

  test("a leading-zero id widens to a zero-padded code, never to a plain figure", () => {
    // Every three-character digit string is real, leading zeros included.
    const p = new Pseudonymizer({ salt: SALT, avoid: every(3, true) });
    const out = ["007", "042", "000"].map((v) => p.pseudonym("id", v));
    for (const o of out) expect(o).toMatch(/^0\d{3}$/);
    expect(new Set(out).size).toBe(3);
    // With only the non-zero-led numbers real, 000..099 are still free at width 3: no widening.
    expect(new Pseudonymizer({ salt: SALT, avoid: every(3) }).pseudonym("id", "007")).toMatch(/^0\d{2}$/);
  });

  test("a widened stand-in avoids stand-ins already issued, including an earlier map's", () => {
    const real = every(3);
    const first = new Pseudonymizer({ salt: SALT, avoid: real });
    const earlier = ["101", "102", "103"].map((v) => first.pseudonym("id", v));
    const map = first.toMap();
    const second = new Pseudonymizer({ salt: SALT, avoid: real, map });
    // The earlier map pins its ids; new ids get other wide values.
    expect(["101", "102", "103"].map((v) => second.pseudonym("id", v))).toEqual(earlier);
    const fresh = ["104", "105", "106", "107"].map((v) => second.pseudonym("id", v));
    expect(new Set([...earlier, ...fresh]).size).toBe(7);
    for (const f of fresh) expect(f).toMatch(/^[1-9]\d{3}$/);
  });

  test("a widened stand-in avoids every wider real value too", () => {
    // Every 3-digit number and all but one 4-digit number are real.
    const real = [...every(3), ...every(4).filter((v) => v !== "4321")];
    const p = new Pseudonymizer({ salt: SALT, avoid: real });
    expect(p.pseudonym("id", "101")).toBe("4321");
    expect(p.pseudonym("id", "102")).toMatch(/^[1-9]\d{4}$/);
  });
});

describe("stand-ins that never needed widening are unchanged (captured on 0.4.0-rc.1)", () => {
  const PLAIN: [string, string][] = [
    ["7", "9"],
    ["42", "67"],
    ["101", "850"],
    ["111", "908"],
    ["5150", "6301"],
    ["004217", "139218"],
    ["007", "803"],
    ["98765", "90932"],
    ["1234567890", "4011655247"],
  ];
  for (const style of STYLES) {
    test(`uncrowded ids (${style})`, () => {
      const p = new Pseudonymizer({ salt: SALT, style });
      for (const [v, want] of PLAIN) expect(p.pseudonym("id", v)).toBe(want);
    });
  }

  test("a width 700 of 900 full, where the counter draws still find a free value", () => {
    const real = every(3).filter((_, i) => i % 9 !== 0 && i % 9 !== 4);
    expect(real).toHaveLength(700);
    const p = new Pseudonymizer({ salt: SALT, avoid: real });
    const got = ["101", "102", "250", "333", "998"].map((v) => p.pseudonym("id", v));
    expect(got).toEqual(["982", "856", "154", "289", "298"]);
  });
});

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const SPEC: Spec = {
  version: 1,
  columns: [
    rule("staff.csv", "Employee ID", "id", "blind"),
    rule("staff.csv", "Job Title", "vocabulary", "keep"),
    rule("sales.csv", "Date", "vocabulary", "keep"),
    rule("sales.csv", "Transactions", "vocabulary", "keep"),
  ],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const staffCsv = (n = 11) => `Employee ID,Job Title\n${Array.from({ length: n }, (_, i) => `${101 + i},Server`).join("\n")}\n`;
const salesCsv = (to = 999) => `Date,Transactions\n${Array.from({ length: to - 99 }, (_, i) => `2026-01-05,${100 + i}`).join("\n")}\n`;
const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`no output ${path}`);
  return Buffer.from(o.bytes).toString("utf8");
};
const ids = (csv: string) => csv.trimEnd().split("\n").slice(1).map((l) => l.split(",")[0] as string);

describe("apply: the reported repro (AGT-2786)", () => {
  for (const style of STYLES) {
    test(`three-digit ids beside a kept column of every three-digit number (${style})`, () => {
      const inputs = [file("staff.csv", staffCsv()), file("sales.csv", salesCsv())];
      const r = applySpec(inputs, SPEC, { salt: APPLY_SALT, pseudonymStyle: style });
      expect(r.skipped).toEqual([]);
      expect(r.outputs.map((o) => o.path).sort()).toEqual(["sales.csv", "staff.csv"]);
      const got = ids(out(r, "staff.csv"));
      expect(new Set(got).size).toBe(11);
      // No stand-in equals a number anywhere in the corpus (100..999, and 2026, 01 and 05 in the dates).
      const real = new Set([...every(3), "2026", "01", "05"]);
      for (const g of got) {
        expect(g).toMatch(/^[1-9]\d{3}$/);
        expect(real.has(g)).toBe(false);
      }
      // Reveal restores both files.
      const rv = new Revealer(r.map);
      for (const input of inputs) {
        const blinded = r.outputs.find((o) => o.path === input.path) as InputFile;
        expect(Buffer.from(revealFile(input.path, blinded.bytes, rv).bytes).toString("utf8")).toBe(Buffer.from(input.bytes).toString("utf8"));
      }
    });
  }

  test("the same output whatever order the files arrive in", () => {
    const a = applySpec([file("staff.csv", staffCsv()), file("sales.csv", salesCsv())], SPEC, { salt: APPLY_SALT });
    const b = applySpec([file("sales.csv", salesCsv()), file("staff.csv", staffCsv())], SPEC, { salt: APPLY_SALT });
    expect(out(b, "staff.csv")).toBe(out(a, "staff.csv"));
    expect(out(b, "sales.csv")).toBe(out(a, "sales.csv"));
    expect(b.map).toEqual(a.map);
  });

  test("an earlier map keeps its ids; ids added later widen around them", () => {
    const first = applySpec([file("staff.csv", staffCsv()), file("sales.csv", salesCsv())], SPEC, { salt: APPLY_SALT });
    const before = ids(out(first, "staff.csv"));
    const next = applySpec([file("sales.csv", salesCsv()), file("staff.csv", staffCsv(15))], SPEC, { salt: APPLY_SALT, map: first.map });
    const after = ids(out(next, "staff.csv"));
    expect(after.slice(0, 11)).toEqual(before);
    expect(new Set(after).size).toBe(15);
  });

  test("an uncrowded corpus gives the stand-ins it gave before (captured on 0.4.0-rc.1)", () => {
    const want = ["850", "516", "760", "701", "722", "676", "592", "605", "511", "624", "662"];
    for (const style of STYLES) {
      const r = applySpec([file("staff.csv", staffCsv()), file("sales.csv", salesCsv(499))], SPEC, { salt: APPLY_SALT, pseudonymStyle: style });
      expect(ids(out(r, "staff.csv"))).toEqual(want);
    }
  });

  test("an XLSX decimal id widens in its integer part and reveals", () => {
    // Every two-digit number is real (a kept column); the id 1.5 renumbers as the digits 15.
    const head = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>';
    const rows = every(2).map((v, i) => `<row r="${i + 2}">${i === 0 ? `<c r="B${i + 2}"><v>1.5</v></c>` : ""}<c r="D${i + 2}"><v>${v}</v></c></row>`);
    const bytes = buildWorkbook({ staffRows: head + rows.join("") });
    const spec: Spec = {
      ...SPEC,
      columns: [
        { ...rule("staff.xlsx", "Employee ID", "id", "blind"), sheet: "Staff" },
        { ...rule("staff.xlsx", "Status", "vocabulary", "keep"), sheet: "Staff" },
      ],
    };
    const r = applySpec([{ path: "staff.xlsx", bytes }], spec, { salt: APPLY_SALT });
    expect(r.skipped).toEqual([]);
    const blinded = r.outputs[0] as InputFile;
    const sheet = (b: Uint8Array) => readZip(b).find((e) => e.name === "xl/worksheets/sheet1.xml")?.text ?? "";
    const got = /<c r="B2"><v>([^<]+)<\/v><\/c>/.exec(sheet(blinded.bytes))?.[1];
    expect(got).toMatch(/^[1-9]\d\.\d$/);
    const back = sheet(revealFile("staff.xlsx", blinded.bytes, new Revealer(r.map)).bytes);
    expect(back).toContain('<c r="B2"><v>1.5</v></c>');
  });
});

describe("a failure that remains names where, never the value", () => {
  test("IPv4 stand-ins (762 documentation addresses) still run out: the error names the file and column", () => {
    const rows = Array.from({ length: 763 }, (_, i) => `10.${Math.floor(i / 250)}.${i % 250}.1`);
    const spec: Spec = { ...SPEC, columns: [rule("hosts.csv", "Address", "host", "blind")] };
    let err: unknown;
    try {
      applySpec([file("hosts.csv", `Address\n${rows.join("\n")}\n`)], spec, { salt: APPLY_SALT });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PseudonymError);
    const message = (err as Error).message;
    expect(message).toMatch(/^hosts\.csv, column "Address": no free host pseudonym for an IPv4 address after 10000 attempts: .*blind the column under another class/);
    expect(message).not.toMatch(/10\.\d+\.\d+\.1/);
  });
});
