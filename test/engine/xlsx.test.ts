import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditTree } from "../../src/audit/mechanical.ts";
import { ApplyError, type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import { NameError } from "../../src/engine/names.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { buildWorkbook, STAFF_ROWS, workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";

// Synthetic salt and data only: invented names, example.com, RFC 5737 addresses, obviously fake IDs.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 29);
const FILE = "staff.xlsx";

const rule = (header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"], sheet = "Staff"): ColumnRule => ({
  file: FILE,
  sheet,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const SPEC: Spec = {
  version: 1,
  columns: [rule("Name", "person", "blind"), rule("Employee ID", "id", "blind"), rule("Notes", "unknown", "value"), rule("Status", "vocabulary", "keep")],
  entities: {
    person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }],
    org: [{ canonical: "Example Widgets", aliases: [], parts: [] }],
  },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const run = (bytes: Uint8Array = buildWorkbook(), spec: Spec = SPEC): ApplyResult => applySpec([{ path: FILE, bytes }], spec, { salt: SALT });

function members(r: ApplyResult): Record<string, string> {
  const o = r.outputs.find((x) => x.path === FILE);
  if (o === undefined) throw new Error(`not written: ${JSON.stringify(r.skipped)}`);
  return Object.fromEntries(readZip(o.bytes).map((e) => [e.name, e.text]));
}

const pseudo = (r: ApplyResult, value: string): string => {
  const e = r.map.entries.find((x) => x.value === value);
  if (e === undefined) throw new Error(`no pseudonym for ${value}`);
  return e.pseudonym;
};

/** Every original value the spec or the map names; none may survive anywhere in the output. */
const ORIGINALS = ["Avery", "Quill", "Robin Example", "Sam Placeholder", "Dana Pell", "Lee", "Orbit", "Example Widgets", "avery@example.com", "192.0.2.10", "4417", "4418", "4419", "4420"];

describe("XLSX apply: cells and shared strings", () => {
  const r = run();
  const m = members(r);

  test("the workbook is written and every column reported against its sheet", () => {
    expect(r.skipped).toEqual([]);
    const f = r.files[0]!;
    expect(f.format).toBe("xlsx");
    expect(f.columns.map((c) => `${c.sheet}/${c.header}:${c.outcome}`)).toEqual([
      "Staff/Name:blinded",
      "Staff/Employee ID:blinded",
      "Staff/Notes:unknown-kept-not-identifier-like",
      "Staff/Status:kept",
      "Avery Quill/Amount:unknown-pseudonymised",
      "Contents/Sheet:unknown-kept-not-identifier-like",
      "Contents/Link:unknown-kept-not-identifier-like",
    ]);
  });

  test("no original value survives in any member", () => {
    for (const [name, text] of Object.entries(m)) {
      for (const v of ORIGINALS) expect(`${name}: ${text}`).not.toMatch(new RegExp(`\\b${v}\\b`));
    }
  });

  test("shared strings referenced by a blinded column become pseudonyms; kept and header strings stay", () => {
    const sst = m["xl/sharedStrings.xml"]!;
    expect(sst).toContain(`<t xml:space="preserve">${pseudo(r, "Robin Example")}</t>`);
    expect(sst).toContain('<t xml:space="preserve">active</t>');
    expect(sst).toContain('<t xml:space="preserve">Employee ID</t>');
  });

  test("orphaned shared strings, which no cell uses, are rewritten too", () => {
    const sst = m["xl/sharedStrings.xml"]!;
    // Index 10: a column value and an address; index 11: a spec entity.
    expect(sst).toMatch(new RegExp(`Old address of ${pseudo(r, "Robin Example")}: (192\\.0\\.2|198\\.51\\.100|203\\.0\\.113)\\.\\d+</t>`));
    expect(sst).toContain(`<si><t xml:space="preserve">${pseudo(r, "Avery Quill")}</t></si>`);
  });

  test("rich text: a pseudonym replaces the whole string in its first run, the other runs are emptied", () => {
    expect(m["xl/sharedStrings.xml"]).toContain(`<si><r><t xml:space="preserve">${pseudo(r, "Lee Orbit")}</t></r><r><rPr><b/></rPr><t xml:space="preserve"></t></r></si>`);
  });

  test("inline strings and formula-string results in free columns get entities and patterns replaced", () => {
    const s1 = m["xl/worksheets/sheet1.xml"]!;
    expect(s1).toMatch(/<is><t>met user_[0-9a-f]{4}@host-[0-9a-f]{4}\.com<\/t><\/is>/);
    // A name split across runs is still found; the new text goes into the first run.
    expect(s1).toContain(`<is><r><t xml:space="preserve">ask ${pseudo(r, "Avery Quill")}</t></r><r><rPr><i/></rPr><t></t></r><r><t xml:space="preserve"></t></r></is>`);
  });

  test("a kept column keeps its words but not a value another column pseudonymised", () => {
    const rows = STAFF_ROWS.replace('<c r="D3" t="s"><v>5</v></c>', '<c r="D3" t="inlineStr"><is><t>for Robin Example</t></is></c>');
    const k = run(buildWorkbook({ staffRows: rows }));
    expect(members(k)["xl/worksheets/sheet1.xml"]).toContain(`<c r="D3" t="inlineStr"><is><t>for ${pseudo(k, "Robin Example")}</t></is></c>`);
    expect(k.files[0]?.columns.find((c) => c.header === "Status")?.changed).toBe(1);
    expect(k.files[0]?.mappedReplacements).toBeGreaterThan(0);
  });

  test("numeric cells in an id column are renumbered with numbers of the same length", () => {
    const s1 = m["xl/worksheets/sheet1.xml"]!;
    for (const [ref, v] of [["B2", "4417"], ["B3", "4418"], ["B4", "4419"], ["B5", "4420"]] as const) {
      const got = new RegExp(`<c r="${ref}"><v>(\\d+)</v></c>`).exec(s1)?.[1];
      expect(got).toMatch(/^[1-9]\d{3}$/);
      expect(got).not.toBe(v);
      expect(got).toBe(pseudo(r, v));
    }
  });

  test("a pseudonymised decimal stays a number with its decimal point", () => {
    expect(m["xl/worksheets/sheet2.xml"]).toMatch(/<c r="A2"><v>\d\d\.\d<\/v><\/c>/);
  });

  test("a no-op spec on a workbook with nothing to replace copies it byte for byte", () => {
    // One sheet of words that match nothing: a status column, low cardinality, kept by the heuristic.
    const entries = workbookEntries({ staffRows: '<row r="1"><c r="A1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>5</v></c></row><row r="3"><c r="A3" t="s"><v>5</v></c></row>' })
      .filter((e) => !/pivot|comments|docProps|sheet[23]|sheet1\.xml\.rels/.test(e.name))
      .map((e) => (e.name === "xl/workbook.xml" ? { ...e, data: (e.data as string).replace(/<sheet name="Avery.*<\/workbook>/, "</sheets></workbook>") } : e))
      .map((e) => (e.name === "xl/sharedStrings.xml" ? { ...e, data: '<sst xmlns="x"><si><t>a</t></si><si><t>b</t></si><si><t>c</t></si><si><t>Status</t></si><si><t>d</t></si><si><t>active</t></si></sst>' } : e));
    const bytes = buildZip(entries);
    const plain = applySpec([{ path: FILE, bytes }], { ...SPEC, columns: [], entities: {} }, { salt: SALT });
    expect(plain.files[0]?.changed).toBe(false);
    expect(Buffer.from(plain.outputs[0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  test("the same inputs, spec and salt give byte-identical output", () => {
    expect(Buffer.from(run().outputs[0]!.bytes).equals(Buffer.from(r.outputs[0]!.bytes))).toBe(true);
  });
});

describe("XLSX apply: names, formulas, metadata, comments and pivot caches", () => {
  const r = run();
  const m = members(r);
  const avery = pseudo(r, "Avery Quill");

  test("a sheet name holding a spec value is renamed through the name hook and reported", () => {
    expect(m["xl/workbook.xml"]).toContain(`<sheet name="${avery}" sheetId="2" r:id="rId2"/>`);
    expect(m["xl/workbook.xml"]).toContain('<sheet name="Staff" sheetId="1"');
    expect(r.files[0]?.sheets?.map((s) => [s.name, s.outputName])).toEqual([
      ["Staff", "Staff"],
      ["Avery Quill", avery],
      ["Contents", "Contents"],
    ]);
  });

  test("formulas that reference a renamed sheet or defined name follow the rename", () => {
    const s1 = m["xl/worksheets/sheet1.xml"]!;
    expect(s1).toContain(`<f>"see "&amp;'${avery}'!A1</f>`);
    expect(s1).toContain(`<f>SUM(B2:B4)+${avery}_Total</f>`);
    expect(m["xl/workbook.xml"]).toContain(`<definedName name="${avery}_Total">'${avery}'!$A$2</definedName>`);
  });

  test("contents-style cells, hyperlinks and the sheet list in docProps/app.xml follow the renamed sheet", () => {
    const s3 = m["xl/worksheets/sheet3.xml"]!;
    expect(s3).toContain(`<c r="A3" t="inlineStr"><is><t>${avery}</t></is></c>`);
    expect(s3).toContain(`<f>HYPERLINK("#'${avery}'!A1","${avery}")</f><v>${avery}</v>`);
    expect(s3).toContain(`<hyperlink ref="A3" location="&apos;${avery}&apos;!A1" display="${avery}"/>`);
    expect(s3).toContain('<f>HYPERLINK("#Staff!A1","Staff")</f><v>Staff</v>');
    expect(m["docProps/app.xml"]).toContain(`<vt:lpstr>Staff</vt:lpstr><vt:lpstr>${avery}</vt:lpstr><vt:lpstr>Contents</vt:lpstr><vt:lpstr>${avery}_Total</vt:lpstr>`);
  });

  test("docProps core, app and custom metadata are rewritten; dates are not", () => {
    expect(m["docProps/core.xml"]).toContain(`<dc:creator>${avery}</dc:creator><cp:lastModifiedBy>${pseudo(r, "Robin Example")}</cp:lastModifiedBy>`);
    expect(m["docProps/core.xml"]).toContain("2026-01-02T03:04:05Z");
    expect(m["docProps/app.xml"]).toMatch(/<Company>Org_[0-9A-F]{4}<\/Company>/);
    expect(m["docProps/custom.xml"]).toContain(`<vt:lpwstr>${pseudo(r, "Dana Pell")}</vt:lpwstr>`);
  });

  test("comment authors and comment text are rewritten", () => {
    expect(m["xl/comments1.xml"]).toContain(`<author>${avery}</author>`);
    expect(m["xl/comments1.xml"]).toContain(`<t>Ask ${pseudo(r, "Sam Placeholder")}</t>`);
  });

  test("pivot cache records and definitions repeat the cells' pseudonyms and renumbered IDs", () => {
    const rec = m["xl/pivotCache/pivotCacheRecords1.xml"]!;
    expect(rec).toContain(`<r><x v="0"/><n v="${pseudo(r, "4417")}"/></r><r><s v="${pseudo(r, "Sam Placeholder")}"/><n v="${pseudo(r, "4418")}"/></r>`);
    const def = m["xl/pivotCache/pivotCacheDefinition1.xml"]!;
    expect(def).toContain(`<s v="${pseudo(r, "Robin Example")}"/>`);
    expect(def).toContain(`minValue="${pseudo(r, "4417")}" maxValue="${pseudo(r, "4418")}"`);
    expect(def).toContain('<worksheetSource ref="A1:B5" sheet="Staff"/>');
  });

  test("a pivot source on a renamed sheet follows the rename", () => {
    const entries = workbookEntries();
    const def = entries.find((e) => e.name === "xl/pivotCache/pivotCacheDefinition1.xml")!;
    def.data = (def.data as string).replace('sheet="Staff"', 'sheet="Avery Quill"');
    const out = members(run(buildZip(entries)));
    expect(out["xl/pivotCache/pivotCacheDefinition1.xml"]).toContain(`sheet="${avery}"`);
  });

  test("the mechanical audit finds no spec entity or mapped original in the output", () => {
    // Pattern findings are left out: the audit reads OOXML namespace URIs as hosts, which is not document data.
    const report = auditTree([{ path: FILE, kind: "file", bytes: r.outputs[0]!.bytes }], SPEC, r.map);
    const findings = report.files.flatMap((f) => f.findings);
    expect(findings.filter((x) => x.severity === "leak" && (x.source === "entity" || x.source === "map"))).toEqual([]);
  });
});

/** An independent look at the structure: rows, cells and formulas per sheet. */
function shape(text: string): { rows: number; cells: number; maxCol: string; formulas: string[] } {
  const refs = [...text.matchAll(/<c r="([A-Z]+)\d+"/g)].map((x) => x[1] as string);
  return {
    rows: (text.match(/<row /g) ?? []).length,
    cells: refs.length,
    maxCol: refs.sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).pop() ?? "",
    formulas: [...text.matchAll(/<f>([^<]*)<\/f>/g)].map((x) => x[1] as string),
  };
}

describe("XLSX apply: round trip", () => {
  const input = buildWorkbook();
  const r = run(input);
  const before = Object.fromEntries(readZip(input).map((e) => [e.name, e.text]));
  const after = members(r);

  test("members, row counts, column counts and formula counts are unchanged; formulas only follow renames", () => {
    expect(Object.keys(after)).toEqual(Object.keys(before));
    const avery = pseudo(r, "Avery Quill");
    for (const n of [1, 2, 3]) {
      const a = shape(before[`xl/worksheets/sheet${n}.xml`]!);
      const b = shape(after[`xl/worksheets/sheet${n}.xml`]!);
      expect([b.rows, b.cells, b.maxCol, b.formulas.length]).toEqual([a.rows, a.cells, a.maxCol, a.formulas.length]);
      expect(b.formulas).toEqual(a.formulas.map((f) => f.replace(/Avery Quill|Avery(?=_Total)/g, avery)));
    }
  });

  // A real spreadsheet library, where one is installed (openpyxl). The structural check above always runs.
  const py = spawnSync("python3", ["-P", "-c", "import openpyxl"], { encoding: "utf8" });
  test.skipIf(py.status !== 0)("opens with openpyxl, with the same sheets, dimensions and formulas", () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-xlsx-"));
    try {
      const dump = (bytes: Uint8Array) => {
        const path = join(dir, "book.xlsx");
        writeFileSync(path, bytes);
        const script =
          "import sys, json, openpyxl\n" +
          "wb = openpyxl.load_workbook(sys.argv[1])\n" +
          "print(json.dumps([[ws.title, ws.max_row, ws.max_column, [c.value for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith('=')]] for ws in wb.worksheets]))\n";
        const res = spawnSync("python3", ["-P", "-c", script, path], { encoding: "utf8" });
        expect(res.stderr).toBe("");
        return JSON.parse(res.stdout) as [string, number, number, string[]][];
      };
      const a = dump(input);
      const b = dump(r.outputs[0]!.bytes);
      const avery = pseudo(r, "Avery Quill");
      expect(b.map((s) => [s[1], s[2], s[3].length])).toEqual(a.map((s) => [s[1], s[2], s[3].length]));
      expect(b.map((s) => s[0])).toEqual(["Staff", avery, "Contents"]);
      expect(b[0]![3]).toContain(`=SUM(B2:B4)+${avery}_Total`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("XLSX apply: fail closed", () => {
  test("a spec value in a part blind does not rewrite stops the file", () => {
    const bytes = buildWorkbook({ extra: [{ name: "customXml/item1.xml", data: "<root><owner>Avery Quill</owner></root>" }] });
    const r = run(bytes);
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/customXml\/item1\.xml <owner> text/);
    expect(r.skipped[0]?.reason).not.toContain("Avery");
  });

  test("...and a column value in an attribute blind does not rewrite, too", () => {
    const bytes = buildWorkbook({ extra: [{ name: "customXml/item1.xml", data: '<root owner="Sam Placeholder"/>' }] });
    expect(run(bytes).skipped[0]?.reason).toMatch(/attribute owner/);
  });

  test("text there without spec values does not stop it", () => {
    const bytes = buildWorkbook({ extra: [{ name: "customXml/item1.xml", data: "<root><v>quarterly</v></root>" }] });
    expect(run(bytes).skipped).toEqual([]);
  });

  test("a member that cannot be parsed means the workbook is not written", () => {
    const r = run(buildWorkbook({ staffRows: `${STAFF_ROWS}<row r="9"><c r="A9"><v>1</v></row>` }));
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/^cannot read the workbook: member xl\/worksheets\/sheet1\.xml/);
  });

  test("a number that cannot be renumbered in place stops the file, without echoing it", () => {
    const r = run(buildWorkbook({ staffRows: STAFF_ROWS.replace("<v>4418</v>", "<v>.4418</v>") }));
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/cell B3: a number in a form that cannot be renumbered in place/);
    expect(r.skipped[0]?.reason).not.toContain("4418");
  });

  test("a file that is not a zip is reported, not written", () => {
    const r = applySpec([{ path: FILE, bytes: Buffer.from("not a workbook") }], SPEC, { salt: SALT });
    expect(r.skipped[0]?.reason).toMatch(/^cannot read the workbook: not a zip file/);
  });

  test("non-XML members are copied and listed as unread", () => {
    const r = run(buildWorkbook({ extra: [{ name: "xl/printerSettings/printerSettings1.bin", data: new Uint8Array([1, 2, 3]) }] }));
    expect(r.files[0]?.unread).toEqual(["xl/printerSettings/printerSettings1.bin"]);
  });

  test("spec rules must name an existing sheet and header", () => {
    const { sheet: _, ...noSheet } = rule("Name", "person", "blind");
    expect(() => run(buildWorkbook(), { ...SPEC, columns: [noSheet as ColumnRule] })).toThrow(/has no sheet/);
    expect(() => run(buildWorkbook(), { ...SPEC, columns: [rule("Name", "person", "blind", "Missing")] })).toThrow(ApplyError);
    expect(() => run(buildWorkbook(), { ...SPEC, columns: [rule("Owner", "person", "blind")] })).toThrow(/not in its header row/);
  });

  test("two sheets whose blinded names coincide are refused", () => {
    const entries = workbookEntries();
    const wb = entries.find((e) => e.name === "xl/workbook.xml")!;
    wb.data = (wb.data as string).replace('name="Contents"', 'name="Quill"');
    const spec: Spec = { ...SPEC, entities: { person: [{ canonical: "Avery Quill", aliases: ["Quill"], parts: [] }] } };
    expect(() => run(buildZip(entries), spec)).toThrow(/two worksheet names the same name/);
  });

  test("a blinded sheet name that breaks the naming rules is a NameError", () => {
    const entries = workbookEntries();
    const wb = entries.find((e) => e.name === "xl/workbook.xml")!;
    wb.data = (wb.data as string).replace('name="Contents"', 'name="Avery Quill, Avery Quill, Avery"');
    expect(() => run(buildZip(entries))).toThrow(NameError);
  });
});
