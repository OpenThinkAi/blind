import { describe, expect, test } from "bun:test";
import { ApplyError, type ApplyOptions, type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import type { Spec } from "../../src/schema.ts";
import { workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip, type FixtureEntry } from "../formats/zipfixture.ts";

// AGT-1933 coverage: readable-shaped text in an XLSX cell, the name-safe twin in text and a CSV cell,
// and a DOCX paragraph. Each is refused under the readable style with the position named and the value
// masked; under compact each is written as usual. Synthetic data only.

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const SHAPED = "[Client A #7F3A]";
const SAFE = "Client_A_7F3A";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }], org: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const run = (path: string, bytes: Uint8Array, opts: Partial<ApplyOptions> = {}): ApplyResult =>
  applySpec([{ path, bytes }], SPEC, { salt: SALT, ...opts });

function refusal(path: string, bytes: Uint8Array): ApplyError {
  try {
    run(path, bytes, { pseudonymStyle: "readable" });
  } catch (e) {
    expect(e).toBeInstanceOf(ApplyError);
    return e as ApplyError;
  }
  throw new Error("expected a refusal, but applySpec returned");
}

const masked = (e: ApplyError): void => {
  for (const v of ["7F3A", "Client A", SAFE, SHAPED]) expect(e.message).not.toContain(v);
};

// An XLSX whose first sheet is named Staff and whose A2 cell holds the shaped text as an inline string.
const xlsxWithCell = (text: string): Uint8Array =>
  buildZip(workbookEntries({ staffRows: `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>` }));

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// A minimal DOCX: one body paragraph holding the text.
const docx = (text: string): Uint8Array => {
  const entries: FixtureEntry[] = [
    {
      name: "[Content_Types].xml",
      data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/document.xml",
      data: `${DECL}<w:document ${W}><w:body><w:p><w:r><w:t>Intro line.</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ];
  return buildZip(entries);
};

describe("readable style refuses shaped XLSX cells, name-safe twins and DOCX paragraphs", () => {
  test("an XLSX cell: refused naming the file, sheet and cell, value masked", () => {
    const e = refusal("cells.xlsx", xlsxWithCell(SHAPED));
    expect(e.message).toContain("cells.xlsx");
    expect(e.message).toMatch(/sheet 1, cell A1/);
    masked(e);
  });

  test("a name-safe twin in a text file: refused with file:line, value masked", () => {
    const e = refusal("twin.txt", enc("first line\nsee " + SAFE + " here\n"));
    expect(e.message).toContain("twin.txt:2");
    masked(e);
  });

  test("a name-safe twin in a CSV cell: refused with file:line, value masked", () => {
    const e = refusal("twin.csv", enc("Name,Notes\nAvery Quill,fine\nBlake Example," + SAFE + "\n"));
    expect(e.message).toContain("twin.csv:3");
    masked(e);
  });

  test("a DOCX paragraph: refused naming the file and paragraph, value masked", () => {
    const e = refusal("memo.docx", docx(SHAPED));
    expect(e.message).toContain("memo.docx");
    expect(e.message).toMatch(/paragraph 2/);
    masked(e);
  });
});

// The fixture workbook with its one defined name renamed to the name-safe twin (names cannot hold brackets).
const xlsxWithDefinedName = (name: string): Uint8Array =>
  buildZip(
    workbookEntries().map((e) =>
      e.name === "xl/workbook.xml" ? { ...e, data: String(e.data).replace('name="Avery_Total"', `name="${name}"`) } : e,
    ),
  );

describe("readable style refuses a shaped file path and a shaped defined name", () => {
  test("a file name in name-safe form: refused naming the file, value masked", () => {
    const e = refusal(SAFE + ".txt", enc("Avery Quill met the team.\n"));
    expect(e.message).toContain(".txt");
    masked(e);
  });

  test("a file name in readable form: refused naming the file, value masked", () => {
    const e = refusal("[Client A #7F3A].txt", enc("Avery Quill met the team.\n"));
    expect(e.message).toContain(".txt");
    masked(e);
  });

  test("a clean file name is not refused", () => {
    const r = run("clean-notes.txt", enc("Avery Quill met the team.\n"), { pseudonymStyle: "readable" });
    expect(r.outputs.map((o) => o.path)).toContain("clean-notes.txt");
  });

  test("an XLSX defined name in name-safe form: refused naming the file and the name, value masked", () => {
    const e = refusal("names.xlsx", xlsxWithDefinedName(SAFE));
    expect(e.message).toContain("names.xlsx");
    expect(e.message).toMatch(/defined name/);
    masked(e);
  });

  test("compact writes a file with a shaped name and a shaped defined name", () => {
    const a = run(SAFE + ".txt", enc("Avery Quill met the team.\n"), { pseudonymStyle: "compact" });
    expect(a.outputs.length).toBe(1);
    const b = run("names.xlsx", xlsxWithDefinedName(SAFE), { pseudonymStyle: "compact" });
    expect(b.outputs.map((o) => o.path)).toContain("names.xlsx");
  });
});

describe("compact style writes the same input without refusing", () => {
  test.each([
    ["cells.xlsx", () => xlsxWithCell(SHAPED)],
    ["twin.txt", () => enc("first line\nsee " + SAFE + " here\n")],
    ["twin.csv", () => enc("Name,Notes\nAvery Quill,fine\nBlake Example," + SAFE + "\n")],
    ["memo.docx", () => docx(SHAPED)],
  ] as const)("%s is not refused under compact", (path, bytes) => {
    const r = run(path, bytes(), { pseudonymStyle: "compact" });
    expect(r.outputs.map((o) => o.path)).toContain(path);
  });
});
