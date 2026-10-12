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
      "Avery Quill/Amount:unknown-kept-not-identifier-like", // a decimal: a measure (AGT-1822)
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

  test("a comment's legacy VML drawing is parsed, left inert and scrubbed in <x:ClientData> (AGT-1821)", () => {
    const vml =
      '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">' +
      '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/></v:shapetype>' +
      '<v:shape id="_x0000_s1025" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;width:108pt" fillcolor="#ffffe1" o:insetmode="auto">' +
      '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>' +
      '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:Anchor>1, 15, 1, 10, 3, 15, 5, 4</x:Anchor><x:Row>1</x:Row><x:Column>0</x:Column>' +
      '<x:Note>Ask Sam Placeholder</x:Note></x:ClientData></v:shape></xml>';
    const entries = workbookEntries({ extra: [{ name: "xl/drawings/commentsDrawing1.vml", data: vml }] });
    const out = run(buildZip(entries));
    expect(out.skipped).toEqual([]);
    const m2 = members(out);
    const v = m2["xl/drawings/commentsDrawing1.vml"]!;
    expect(v).toContain(`<x:Note>Ask ${pseudo(out, "Sam Placeholder")}</x:Note>`);
    expect(v).not.toContain("Sam Placeholder");
    // Everything outside <x:ClientData> is byte-identical.
    expect(v.replace(/<x:Note>.*?<\/x:Note>/, "")).toBe(vml.replace(/<x:Note>.*?<\/x:Note>/, ""));
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
    const bytes = buildWorkbook({ extra: [{ name: "xl/notes/extra.xml", data: "<root><owner>Avery Quill</owner></root>" }] });
    const r = run(bytes);
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/xl\/notes\/extra\.xml <owner> text/);
    expect(r.skipped[0]?.reason).not.toContain("Avery");
  });

  test("...and a column value in an attribute blind does not rewrite, too", () => {
    const bytes = buildWorkbook({ extra: [{ name: "xl/notes/extra.xml", data: '<root owner="Sam Placeholder"/>' }] });
    expect(run(bytes).skipped[0]?.reason).toMatch(/attribute owner/);
  });

  test("a DSN with a host and a user email in connections.xml is never written with the values intact (AGT-1810)", () => {
    const conn = '<connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="Warehouse"><dbPr connection="Server=db01.example.com;Database=hr;Uid=pat.doe@example.com;Pwd=x" command="select 1"/></connection></connections>';
    const r = run(buildWorkbook({ extra: [{ name: "xl/connections.xml", data: conn }] }));
    expect(r.outputs).toEqual([]);
    const reason = r.skipped[0]?.reason ?? "";
    expect(reason).toMatch(/xl\/connections\.xml <dbPr> attribute connection/);
    expect(reason).not.toMatch(/db01|pat\.doe|example\.com/);
  });

  test("an external link cache with an address, a GUID or a MAC stops the file, even when that pattern is off in the spec", () => {
    for (const text of ["192.0.2.77", "00:00:5e:00:53:af", "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "files.example.net"]) {
      const link = `<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook><sheetNames><sheetName val="${text}"/></sheetNames></externalBook></externalLink>`;
      const r = run(buildWorkbook({ extra: [{ name: "xl/externalLinks/externalLink1.xml", data: link }] }), { ...SPEC, patterns: { ip: false, email: false, host: false, guid: false, mac: false } });
      expect(r.outputs).toEqual([]);
      expect(r.skipped[0]?.reason).toMatch(/externalLink1\.xml <sheetName> attribute val/);
      expect(r.skipped[0]?.reason).not.toContain(text);
    }
  });

  test("format structure (namespaces, content types, relationship types, template ids) is not a hit", () => {
    const part = '<root xmlns:x="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><ext uri="{3f2504e0-4f89-11d3-9a0c-0305e82c3301}"/></root>';
    expect(run(buildWorkbook({ extra: [{ name: "xl/other.xml", data: part }] })).skipped).toEqual([]);
  });

  test("a custom XML data part with values blind cannot confirm is refused, naming the part and not the value (AGT-1840)", () => {
    const item = '<?xml version="1.0"?><crm><contact name="Dana Example" email="dana@example.com" host="crm01.example.net" acct="AC-55501"/></crm>';
    for (const data of [item, "<root><v>quarterly</v></root>", "<root><![CDATA[note]]></root>"]) {
      const r = run(buildWorkbook({ extra: [{ name: "customXml/item1.xml", data }] }));
      expect(r.outputs).toEqual([]);
      expect(r.skipped[0]?.reason).toBe("custom XML part customXml/item1.xml holds data blind cannot confirm it blinded; remove the part or save without it; not written");
    }
  });

  test("empty and structural custom XML parts do not stop the workbook (AGT-1840)", () => {
    const BIB = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
    const parts = [
      `<?xml version="1.0"?><b:Sources SelectedStyle="\\APA.XSL" StyleName="APA" xmlns:b="${BIB}" xmlns="${BIB}"/>`,
      '<?xml version="1.0"?><crm><contact name="" email=""/><note/></crm>',
      '<?xml version="1.0"?><CoverPageProperties xmlns="http://schemas.microsoft.com/office/2006/coverPageProps"><PublishDate/><Abstract/></CoverPageProperties>',
      '<?xml version="1.0"?><p:properties xmlns:p="http://schemas.microsoft.com/office/2006/metadata/properties" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><documentManagement><Title xsi:nil="true"/></documentManagement></p:properties>',
    ];
    for (const data of parts) expect(run(buildWorkbook({ extra: [{ name: "customXml/item1.xml", data }] })).skipped).toEqual([]);
  });

  test("a bibliography with a source in it is refused (AGT-1840)", () => {
    const BIB = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
    const data = `<b:Sources xmlns:b="${BIB}"><b:Source><b:Tag>x</b:Tag></b:Source></b:Sources>`;
    expect(run(buildWorkbook({ extra: [{ name: "customXml/item1.xml", data }] })).skipped[0]?.reason).toMatch(/^custom XML part customXml\/item1\.xml holds data/);
  });

  test("structural worksheet attributes (row r, cell r, spans) are not a hit when a renumbered id has the same digits", () => {
    const cell = (c: string, n: number, v: string) => `<c r="${c}${n}" t="inlineStr"><is><t>${v}</t></is></c>`;
    const header = '<row r="1" spans="1:2"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>';
    const ids = [123, 124, 125, 126, 127, 128];
    const body = ids.map((id, i) => `<row r="${id}" spans="1:2" ht="15" customHeight="1">${cell("A", id, `Person ${"ABCDEF"[i]}`)}<c r="B${id}"><v>${id}</v></c></row>`).join("");
    const r = run(buildWorkbook({ staffRows: header + body }), { ...SPEC, columns: [rule("Name", "person", "blind"), rule("Employee ID", "id", "blind")] });
    expect(r.skipped).toEqual([]);
    const s1 = members(r)["xl/worksheets/sheet1.xml"]!;
    for (const id of ids) expect(s1).toContain(`<row r="${id}" spans="1:2" ht="15" customHeight="1">`);
    expect(s1).not.toMatch(/<c r="B123"><v>123<\/v>/);
    // The audit reads those row numbers as structure too, not as a surviving id.
    const sp: Spec = { ...SPEC, columns: [rule("Name", "person", "blind"), rule("Employee ID", "id", "blind")] };
    const report = auditTree([{ path: FILE, kind: "file", bytes: r.outputs[0]!.bytes }], sp, r.map);
    expect(report.files.flatMap((f) => f.findings).filter((x) => x.severity === "leak" && x.source === "map")).toEqual([]);
  });

  test("a text-bearing attribute that nothing rewrites is still scanned", () => {
    const rows = `${STAFF_ROWS}`;
    const bytes = buildWorkbook({ staffRows: rows.replace('<row r="2">', '<row r="2" x14ac:note="avery@example.com">') });
    const r = run(bytes);
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]?.reason).toMatch(/where blind does not rewrite it/);
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

  test("an embedded file, macro or ActiveX part stops the workbook, as in a DOCX", () => {
    for (const name of ["xl/embeddings/oleObject1.bin", "xl/embeddings/Microsoft_Excel_Worksheet1.xlsx", "xl/vbaProject.bin", "xl/activeX/activeX1.bin"]) {
      const r = run(buildWorkbook({ extra: [{ name, data: "Avery Quill" }] }));
      expect({ name, outputs: r.outputs.length, reason: r.skipped[0]?.reason }).toEqual({
        name, outputs: 0, reason: `embedded file ${name} cannot be blinded inside an XLSX; not written`,
      });
    }
    const thumb = run(buildWorkbook({ extra: [{ name: "docProps/thumbnail.wmf", data: new Uint8Array([1, 2]) }] }));
    expect(thumb.skipped[0]?.reason).toBe("docProps/thumbnail.wmf is a picture of the original document and cannot be blinded; save the file without a thumbnail; not written");
    const ok = run(buildWorkbook({ extra: [{ name: "xl/media/image1.png", data: new Uint8Array([0x89, 0x50]) }] }));
    expect(ok.skipped).toEqual([]);
    expect(ok.files[0]?.unread).toEqual(["xl/media/image1.png"]);
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
