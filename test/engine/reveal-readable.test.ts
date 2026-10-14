import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { nameSafe } from "../../src/engine/pseudonym.ts";
import { revealFile, Revealer } from "../../src/engine/reveal.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { docxMembers } from "../audit/ooxmlfixture.ts";
import { makeZip } from "../audit/zipfixture.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { readZip } from "../formats/zipfixture.ts";

// Synthetic salt and data only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 53);
const PATTERNS = { ip: true, email: true, host: true, guid: true, mac: false };
const rule = (): ColumnRule => ({ file: "staff.xlsx", sheet: "Staff", header: "Name", class: "person", treatment: "blind", confidence: 1, source: "human" });
const spec = (columns: ColumnRule[] = []): Spec => ({
  version: 1,
  columns,
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: [] }] },
  patterns: PATTERNS,
  questions: [],
});
const blind = (path: string, bytes: Uint8Array, s: Spec): ApplyResult => {
  const r = applySpec([{ path, bytes }], s, { salt: SALT, pseudonymStyle: "readable" });
  expect(r.skipped).toEqual([]);
  return r;
};
const out = (r: ApplyResult): Uint8Array => (r.outputs[0] as { bytes: Uint8Array }).bytes;
const members = (bytes: Uint8Array): Map<string, string> => new Map(readZip(bytes).map((e) => [e.name, e.text]));

describe("reveal restores both forms", () => {
  const map: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "ada lovelace", value: "Ada Lovelace", pseudonym: "[Client A #7F3A]" }] };

  test("the readable form and its name-safe twin both come back", () => {
    const rv = new Revealer(map);
    const r = rv.text("[Client A #7F3A] wrote to Client_A_7F3A at /files/Client_A_7F3A/x");
    expect(r.text).toBe("Ada Lovelace wrote to Ada Lovelace at /files/Ada Lovelace/x");
    expect(r.restored).toBe(3);
    expect(nameSafe("[Client A #7F3A]")).toBe("Client_A_7F3A");
  });

  test("a text file with a URL query containing a name reveals byte-identical", () => {
    const text = "see https://example.com/search?q=Avery Quill&x=1 and Avery Quill\n";
    const bytes = new TextEncoder().encode(text);
    const r = blind("memo.txt", bytes, spec());
    expect(new TextDecoder().decode(out(r))).not.toContain("Avery");
    const back = revealFile("memo.txt", out(r), new Revealer(r.map));
    expect(new TextDecoder().decode(back.bytes)).toBe(text);
  });

  test("an XLSX with a named sheet, defined name, formula and hyperlink location reveals to the input", () => {
    const original = buildWorkbook();
    const r = blind("staff.xlsx", original, spec([rule()]));
    const blinded = members(out(r));
    expect(blinded.get("xl/workbook.xml")).not.toMatch(/name="[^"]*[[#]/);
    const back = members(revealFile("staff.xlsx", out(r), new Revealer(r.map)).bytes);
    const was = members(original);
    for (const [name, text] of was) {
      // The defined name Avery_Total holds the creator's given name; reveal writes the whole recorded
      // form as a valid name (as the existing OOXML reveal tests pin).
      const norm = (t: string): string => t.replace(/Avery Quill_Total|Avery_Total/g, "Avery_Quill_Total");
      // Blinding may move text between the runs of one string; the string's text is what must come back.
      const flat = (t: string): string => norm(t).replace(/&apos;/g, "'").replace(/<\/t><\/r><r>(?:<rPr>.*?<\/rPr>)?<t[^>]*>/g, "");
      expect(flat(back.get(name) ?? "")).toBe(flat(text));
    }
  });

  test("a DOCX with an account path reveals to the input", () => {
    const original = makeZip(docxMembers({ body: "Avery Quill met the team", hyperlink: "file:///C:/Users/avery/Documents/plan.docx" }));
    const r = blind("memo.docx", original, spec());
    const back = members(revealFile("memo.docx", out(r), new Revealer(r.map)).bytes);
    const was = members(original);
    // Word's paragraph and text ids are linking IDs: they are replaced and not restored by design.
    const norm = (t: string): string => t.replace(/ w14:(?:paraId|textId)="[0-9A-F]+"/g, "");
    for (const [name, text] of was) expect(norm(back.get(name) ?? "")).toBe(norm(text));
  });
});
