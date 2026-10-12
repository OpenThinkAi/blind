// Values in dropped and redacted columns still recur (AGT-1835): the column leaves, but the same
// names, phones and codes written in prose elsewhere are replaced, as the redaction placeholder, never a
// pseudonym and never a map entry (AGT-1847).
// Synthetic data only: invented owners, numbers and codes. The surname is not a dictionary word:
// a part that is one is never matched alone, for a dropped column as for a blinded one (AGT-1803).

import { describe, expect, test } from "bun:test";
import { buildWorkbook } from "../../src/bench/office.ts";
import { applySpec, type InputFile } from "../../src/engine/apply.ts";
import { Revealer, revealFile } from "../../src/engine/reveal.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { type ColumnRule, type Spec } from "../../src/schema.ts";

const SALT = new Uint8Array(32).fill(5);
const PATTERNS_OFF = { ip: false, email: false, host: false, guid: false, mac: false, phone: false };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const rule = (file: string, where: { header: string } | { jsonPath: string } | { sheet: string; header: string }, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = "unknown"): ColumnRule =>
  ({ file, ...where, class: cls, treatment, confidence: 1, source: "policy" }) as ColumnRule;
const spec = (columns: ColumnRule[]): Spec => ({ version: 1, columns, entities: {}, patterns: PATTERNS_OFF, questions: [] });
const apply = (files: Record<string, string | Uint8Array>, columns: ColumnRule[]) =>
  applySpec(Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: typeof v === "string" ? enc(v) : v })), spec(columns), { salt: SALT });
const out = (r: ReturnType<typeof apply>, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);

const NOTE = "Dana Quillfeather called; Mr. Quillfeather will pick up Biscuit. Reach her on (801) 555-0142.";

describe("a dropped column's values recur", () => {
  test("the repro: the owner column goes, and the name and its surname are replaced in a text file; the pet stays", () => {
    const r = apply({ "a.csv": "id,owner,pet\n1,Dana Quillfeather,Biscuit\n", "b.txt": "Dana Quillfeather called; Mr. Quillfeather will pick up Biscuit.\n" }, [rule("a.csv", { header: "id" }, "keep"), rule("a.csv", { header: "owner" }, "drop"), rule("a.csv", { header: "pet" }, "keep")]);
    expect(out(r, "a.csv")).toMatch(/^id,pet\n1,Biscuit\n$/);
    const b = out(r, "b.txt");
    expect(b).toBe("REDACTED called; Mr. REDACTED will pick up Biscuit.\n");
    expect(r.map.entries.filter((e) => e.kind === "person")).toEqual([]);
    const text = r.files.find((f) => f.path === "b.txt");
    expect(text?.removedReplacements).toBe(2);
    expect(text?.mappedReplacements).toBe(0);
  });

  test("a dropped column's recurrences are the placeholder, not the pseudonym a blinded column would give; reveal has nothing to restore", () => {
    const files = { "a.csv": "id,owner\n1,Dana Quillfeather\n", "b.txt": "Dana Quillfeather called.\n" };
    const dropped = apply(files, [rule("a.csv", { header: "id" }, "keep"), rule("a.csv", { header: "owner" }, "drop")]);
    expect(out(dropped, "b.txt")).toBe("REDACTED called.\n");
    expect(out(dropped, "a.csv")).toBe("id\n1\n");
    expect(dropped.map.entries).toEqual([]);
    const back = dec(revealFile("b.txt", (dropped.outputs.find((o) => o.path === "b.txt") as InputFile).bytes, new Revealer(dropped.map)).bytes);
    expect(back).toBe("REDACTED called.\n");
  });

  test("a redacted column still writes the placeholder and its values recur in another column of the same file", () => {
    const r = apply({ "a.csv": "owner,note\nDana Quillfeather,Dana Quillfeather rang again\n" }, [rule("a.csv", { header: "owner" }, "redact"), rule("a.csv", { header: "note" }, "keep", "vocabulary")]);
    const [, row] = out(r, "a.csv").trimEnd().split("\n");
    expect(row).toBe("REDACTED,REDACTED rang again");
    expect(r.files[0]?.removedReplacements).toBe(1);
  });

  test("a phone or email column recurs as the placeholder whatever its class", () => {
    const r = apply(
      { "a.csv": "phone,mail\n(801) 555-0142,dana@example.com\n", "b.txt": "Call (801) 555-0142 or write dana@example.com.\n" },
      [rule("a.csv", { header: "phone" }, "drop"), rule("a.csv", { header: "mail" }, "drop", "email")],
    );
    const b = out(r, "b.txt");
    expect(b).not.toContain("555-0142");
    expect(b).not.toContain("dana@example.com");
    expect(b).toBe("Call REDACTED or write REDACTED.\n");
    expect(r.map.entries).toEqual([]);
  });

  test("a column classed vocabulary contributes nothing, and an empty value is skipped", () => {
    const r = apply({ "a.csv": "species,owner\ncanine,Dana Quillfeather\ncanine,\n", "b.txt": "A canine named Biscuit.\n" }, [
      rule("a.csv", { header: "species" }, "drop", "vocabulary"),
      rule("a.csv", { header: "owner" }, "drop"),
    ]);
    expect(out(r, "b.txt")).toBe("A canine named Biscuit.\n");
  });

  test("JSON: a dropped and a redacted key both recur in prose", () => {
    const r = apply({ "p.json": '{"owner": "Dana Quillfeather", "pin": "gate-4471", "pet": "Biscuit"}\n', "b.txt": `${NOTE} Gate gate-4471.\n` }, [
      rule("p.json", { jsonPath: "$.owner" }, "drop"),
      rule("p.json", { jsonPath: "$.pin" }, "redact"),
      rule("p.json", { jsonPath: "$.pet" }, "keep"),
    ]);
    expect(out(r, "p.json")).toBe('{"pin": "REDACTED", "pet": "Biscuit"}\n');
    const b = out(r, "b.txt");
    expect(b).not.toContain("Dana");
    expect(b).not.toContain("Quillfeather");
    expect(b).not.toContain("gate-4471");
    expect(b).not.toMatch(/Person_|Value_|Id_/);
    expect(b).toContain("Biscuit");
    expect(r.files.find((f) => f.path === "b.txt")?.removedReplacements).toBe(3);
  });

  test("XLSX: a dropped text column's values recur in prose and in a kept column", () => {
    const bytes = buildWorkbook({
      sheets: [{ name: "Visits", rows: [["Owner", "Pet", "Note"], ["Dana Quillfeather", "Biscuit", "Dana Quillfeather paid"]] }],
      orphans: [],
      definedNames: [],
      core: { title: "", creator: "", modifiedBy: "" },
    });
    const r = apply({ "v.xlsx": bytes, "b.txt": "Dana Quillfeather called.\n" }, [rule("v.xlsx", { sheet: "Visits", header: "Owner" }, "drop"), rule("v.xlsx", { sheet: "Visits", header: "Pet" }, "keep"), rule("v.xlsx", { sheet: "Visits", header: "Note" }, "keep", "vocabulary")]);
    expect(r.skipped).toEqual([]);
    expect(out(r, "b.txt")).toBe("REDACTED called.\n");
    const wb = readWorkbook((r.outputs.find((o) => o.path === "v.xlsx") as InputFile).bytes);
    const rows = sheetRows(wb.sheets[0] as (typeof wb.sheets)[number], wb.sharedStrings);
    expect(rows[1]?.[0]).toBe("");
    expect(rows[1]?.[1]).toBe("Biscuit");
    expect(rows[1]?.[2]).toBe("REDACTED paid");
    expect(r.files.find((f) => f.path === "v.xlsx")?.removedReplacements).toBe(1);
  });
});
