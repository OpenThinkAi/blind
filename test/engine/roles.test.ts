import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile, roleLabel } from "../../src/engine/apply.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";

// Synthetic salt and data only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);

const rule = (file: string, where: { header?: string; jsonPath?: string; sheet?: string }, cls: ColumnRule["class"] = "person", treatment: ColumnRule["treatment"] = "blind"): ColumnRule => ({
  file,
  ...where,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
}) as ColumnRule;

const spec = (columns: ColumnRule[], over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns,
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
  ...over,
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const run = (inputs: InputFile[], s: Spec, style: "readable" | "compact" = "readable") => applySpec(inputs, s, { salt: SALT, pseudonymStyle: style });
const out = (r: ApplyResult, path: string): string => Buffer.from(r.outputs.find((o) => o.path === path)?.bytes ?? new Uint8Array()).toString("utf8");
const READABLE = /\[([A-Za-z ]+?) ([A-Z]+) #[0-9A-F]{4}\]/g;
const labels = (s: string): string[] => [...s.matchAll(READABLE)].map((m) => m[1] as string);

describe("role labels from headers (AGT-1932)", () => {
  test("roleLabel rules", () => {
    expect(roleLabel("client_name")).toBe("Client Name");
    expect(roleLabel("accountOwner")).toBe("Account Owner");
    expect(roleLabel("billing-contact")).toBe("Billing Contact");
    for (const g of ["name", "Value", "ID", "field", "Column", "col", "2024", "", "   "]) expect(roleLabel(g)).toBeUndefined();
    expect(roleLabel("Prénom")).toBeUndefined();
    expect((roleLabel("a".repeat(40)) ?? "").length).toBe(24);
  });

  test("CSV: a header labels its column", () => {
    const r = run([file("t.csv", "Client\nAvery Quill\nRobin Example\n")], spec([rule("t.csv", { header: "Client" })]));
    expect(labels(out(r, "t.csv"))).toEqual(["Client", "Client"]);
  });

  test("CSV: snake_case headers become Title Case words", () => {
    const r = run([file("t.csv", "client_name\nAvery Quill\n")], spec([rule("t.csv", { header: "client_name" })]));
    expect(labels(out(r, "t.csv"))).toEqual(["Client Name"]);
    expect(out(r, "t.csv").split("\n")[0]).toBe("client_name");
  });

  test("CSV: a generic header falls back to the class word", () => {
    const r = run([file("t.csv", "Name\nAvery Quill\n")], spec([rule("t.csv", { header: "Name" })]));
    expect(labels(out(r, "t.csv"))).toEqual(["Person"]);
  });

  test("CSV: a header that holds a person's name falls back to the class word", () => {
    const s = spec([rule("t.csv", { header: "Avery Quill" })], { entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }] } });
    const r = run([file("t.csv", "Avery Quill\nRobin Example\n")], s);
    const o = out(r, "t.csv");
    expect(o).not.toContain("Avery");
    const l = labels(o);
    expect(l.length).toBeGreaterThan(0);
    for (const x of l) expect(x).toBe("Person");
  });

  test("CSV: the same value in two columns keeps the first label", () => {
    const s = spec([rule("t.csv", { header: "Owner" }), rule("t.csv", { header: "Approver" })]);
    const r = run([file("t.csv", "Owner,Approver\nAvery Quill,Avery Quill\n")], s);
    const l = labels(out(r, "t.csv"));
    expect(l).toHaveLength(2);
    expect(l[0]).toBe(l[1] as string);
    const cells = out(r, "t.csv").split("\n")[1]?.split(",") as string[];
    expect(cells[0]).toBe(cells[1] as string);
  });

  test("CSV: an overlong header is cut at a word and a number header is generic", () => {
    const r = run([file("t.csv", "Primary Account Holder Of Record,Reference Code\nAvery Quill,Robin Example\nSam Placeholder,Jo Sample\nDana Pell,Lee Orbit\n")], spec([rule("t.csv", { header: "Primary Account Holder Of Record" }), rule("t.csv", { header: "Reference Code" })]));
    const l = labels(out(r, "t.csv"));
    expect(l[0]).toBe("Primary Account Holder");
    expect(l[1]).toBe("Reference Code");
  });

  test("JSON: a key labels its values (camelCase and snake_case)", () => {
    const j = JSON.stringify({ account_owner: "Avery Quill", approvedBy: "Robin Example" });
    const r = run([file("t.json", j)], spec([rule("t.json", { jsonPath: "$.account_owner" }), rule("t.json", { jsonPath: "$.approvedBy" })]));
    expect(labels(out(r, "t.json"))).toEqual(["Account Owner", "Approved By"]);
  });

  test("JSON: a generic key falls back", () => {
    const r = run([file("t.json", JSON.stringify({ value: "Avery Quill" }))], spec([rule("t.json", { jsonPath: "$.value" })]));
    expect(labels(out(r, "t.json"))).toEqual(["Person"]);
  });

  test("free text uses the class word", () => {
    const s = spec([rule("t.csv", { header: "Client" }), rule("t.csv", { header: "Notes" }, "vocabulary", "scan")], { entities: { person: [{ canonical: "Robin Example", aliases: [], parts: ["Robin", "Example"] }] } });
    const r = run([file("t.csv", "Client,Notes\nAvery Quill,call Robin Example back\n")], s);
    const o = out(r, "t.csv");
    expect(o).not.toContain("Robin");
    expect(labels(o)).toEqual(["Client", "Person"]);
  });

  test("XLSX: a header labels its column", () => {
    const rows = [
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Client</t></is></c><c r="B1" t="inlineStr"><is><t>Notes</t></is></c></row>',
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Dana Pell</t></is></c><c r="B2" t="inlineStr"><is><t>ok</t></is></c></row>',
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Lee Orbit</t></is></c><c r="B3" t="inlineStr"><is><t>ok</t></is></c></row>',
    ].join("");
    const bytes = buildWorkbook({
      staffRows: rows,
      extra: [
        {
          name: "xl/workbook.xml",
          data:
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
            '<sheet name="Staff" sheetId="1" r:id="rId1"/><sheet name="Annex" sheetId="2" r:id="rId2"/><sheet name="Contents" sheetId="3" r:id="rId3"/>' +
            '</sheets><pivotCaches><pivotCache cacheId="1" r:id="rId5"/></pivotCaches></workbook>',
        },
      ],
    });
    const r = applySpec([{ path: "b.xlsx", bytes }], spec([{ ...rule("b.xlsx", { header: "Client" }), sheet: "Staff" }]), { salt: SALT, pseudonymStyle: "readable" });
    const o = r.outputs.find((x) => x.path === "b.xlsx");
    expect(o).toBeDefined();
    expect(Buffer.from(o?.bytes as Uint8Array).includes(Buffer.from("Dana"))).toBe(false);
    expect(r.map.entries.map((e) => e.pseudonym).filter((p) => /^\[Client [A-Z]+ #[0-9A-F]{4}\]$/.test(p))).toHaveLength(2);
    expect(r.files.find((f) => f.path === "b.xlsx")?.columns.find((c) => c.header === "Client")?.outcome).toBe("blinded");
  });

  test("compact style is unchanged by labels", () => {
    const r = run([file("t.csv", "Client\nAvery Quill\n")], spec([rule("t.csv", { header: "Client" })]), "compact");
    expect(out(r, "t.csv")).toMatch(/^Client\nPerson_[0-9A-F]{4}\n$/);
  });
});
