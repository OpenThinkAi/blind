import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import { NameError, rewriteSpans } from "../../src/engine/names.ts";
import { nameSafe, Pseudonymizer } from "../../src/engine/pseudonym.ts";
import { rewriteOfficeId } from "../../src/engine/officeid.ts";
import { replaceAccounts } from "../../src/formats/paths.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";
import { docxMembers } from "../audit/ooxmlfixture.ts";
import { makeZip } from "../audit/zipfixture.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic salt and data only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);
const PATTERNS = { ip: true, email: true, host: true, guid: true, mac: false };
const READABLE = /\[[A-Za-z0-9 -]+ [A-Z]+ #[0-9A-F]{4}\]/;
const SAFE = /[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*_[A-Z]+_[0-9A-F]{4}/;

const spec = (columns: ColumnRule[] = []): Spec => ({
  version: 1,
  columns,
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: [] }] },
  patterns: PATTERNS,
  questions: [],
});
const run = (path: string, bytes: Uint8Array, s: Spec = spec(), style: "readable" | "compact" = "readable"): ApplyResult => {
  const r = applySpec([{ path, bytes }], s, { salt: SALT, pseudonymStyle: style });
  expect(r.skipped).toEqual([]);
  return r;
};
const out = (r: ApplyResult): { path: string; bytes: Uint8Array } => r.outputs[0] as { path: string; bytes: Uint8Array };
const members = (bytes: Uint8Array): Map<string, string> => new Map(readZip(bytes).map((e) => [e.name, e.text]));

describe("name-safe pseudonyms in name slots", () => {
  test("a file name and a folder name get the name-safe form, text keeps the readable form", () => {
    const bytes = new TextEncoder().encode("Avery Quill called.\n");
    const r = run("Avery Quill/notes for Avery Quill.txt", bytes);
    const o = out(r);
    expect(o.path).not.toMatch(/[[\]#]/);
    expect(o.path).toMatch(SAFE);
    expect(new TextDecoder().decode(o.bytes)).toMatch(READABLE);
  });

  test("compact output is unchanged by the name-safe rule", () => {
    const bytes = new TextEncoder().encode("Avery Quill called.\n");
    const r = run("Avery Quill/notes.txt", bytes, spec(), "compact");
    expect(out(r).path).toMatch(/^Person_[0-9A-F]{4}\/notes\.txt$/);
  });

  test("a URL in text gets the name-safe form for a name in its query", () => {
    const text = "see https://example.com/search?q=Avery+Quill for Avery Quill\n";
    const r = run("memo.txt", new TextEncoder().encode(text));
    const body = new TextDecoder().decode(out(r).bytes);
    const url = body.split(" ")[1] as string;
    expect(url).toMatch(/^https:\/\/[^/]+\/search\?q=[A-Za-z0-9-]+_[A-Z]+_[0-9A-F]{4}$/);
    expect(body).toMatch(READABLE);
  });

  test("rewriteSpans leaves non-URL text readable", () => {
    const pz = new Pseudonymizer({ salt: SALT, style: "readable" });
    const value = "Ada Lovelace at https://example.com/?u=Ada+Lovelace";
    const spans = [
      { start: 0, end: 12, cls: "person" as const, value: "Ada Lovelace" },
      { start: 39, end: 51, cls: "person" as const, value: "Ada Lovelace" },
    ];
    const o = rewriteSpans(value, spans as never, pz);
    const p = pz.pseudonym("person", "Ada Lovelace");
    expect(o).toBe(`${p} at https://example.com/?u=${nameSafe(p)}`);
  });

  test("workbook: sheet, defined name and table names carry no readable form; formulas and cells follow", () => {
    const original = buildWorkbook();
    const r = run("staff.xlsx", original, spec([{ file: "staff.xlsx", sheet: "Staff", header: "Name", class: "person", treatment: "blind", confidence: 1, source: "human" }]));
    const m = members(out(r).bytes);
    const wb = m.get("xl/workbook.xml") as string;
    const person = (r.map.entries.find((e) => e.value === "Avery Quill") as { pseudonym: string }).pseudonym;
    expect(person).toMatch(READABLE);
    const safe = nameSafe(person);
    expect(wb).toContain(`<sheet name="${safe}"`);
    for (const [, n] of wb.matchAll(/<(?:sheet|definedName)[^>]*\bname="([^"]*)"/g)) expect(n).not.toMatch(/[[\]# ]/);
    expect(m.get("xl/worksheets/sheet1.xml")).toContain(`'${safe}'!A1`);
    expect(m.get("xl/worksheets/sheet3.xml")).toContain(`'${safe}'!A1`);
    expect(m.get("xl/worksheets/sheet3.xml")).not.toMatch(/location="[^"]*[[#]/);
    // The sheet list in docProps/app.xml names the sheet in its name-safe form too.
    expect(m.get("docProps/app.xml")).toContain(`<vt:lpstr>${safe}</vt:lpstr>`);
  });

  test("a sheet name over 31 characters with the name-safe form is refused by the existing rule", () => {
    const entries = readZip(buildWorkbook()).map((e) => ({ name: e.name, data: e.text, method: e.method as 0 | 8 }));
    const wb = entries.find((e) => e.name === "xl/workbook.xml") as { data: string };
    wb.data = wb.data.replace('name="Contents"', 'name="Avery Quill, Avery Quill, Avery"');
    expect(() => run("book.xlsx", buildZip(entries))).toThrow(NameError);
  });

  test("a docx account path segment gets the name-safe form", () => {
    const bytes = makeZip(docxMembers({ body: "Avery Quill met the team", hyperlink: "file:///C:/Users/avery/Documents/plan.docx" }));
    const r = run("memo.docx", bytes);
    const m = members(out(r).bytes);
    const rels = [...m.entries()].filter(([k]) => k.endsWith(".rels")).map(([, v]) => v).join("\n");
    expect(rels).toContain("file:///C:/Users/");
    expect(rels).not.toContain("avery");
    expect(rels).not.toMatch(/Users\/(?:\[|%5B)/);
    expect(rels).toMatch(/Users\/[A-Za-z0-9-]+_[A-Z]+_[0-9A-F]{4}\//);
  });

  test("replaceAccounts and rewriteOfficeId return name-safe forms", () => {
    for (const p of ["[Account Owner A #19C0]", "[Client AB #7F3A]", "Person_7F3A", "plain"]) {
      expect(replaceAccounts("/Users/x/f", () => p)).toBe(`/Users/${nameSafe(p)}/f`);
    }
    const readable = "[Account Owner A #19C0]";
    expect(replaceAccounts("C:\\Users\\avery\\x.xlsx", () => readable)).toBe("C:\\Users\\Account_Owner_A_19C0\\x.xlsx");
    const pz = { pseudonym: () => "[Id A #00AA]" };
    expect(rewriteOfficeId("id", "not-a-guid-or-hex!", pz, { hex: (v) => v })).toBe("Id_A_00AA");
  });
});
