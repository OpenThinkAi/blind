// Context-keyword redaction, round two (AGT-1841): a value a few words after its trigger, a value in
// the cell next to its label, and blind.toml triggers that name the kind of value they expect.
// Synthetic text only; every value is invented.

import { describe, expect, test } from "bun:test";
import { type ContextTriggerSpec, findContextSpans, labelTrigger, pairCells } from "../../src/engine/context.ts";
import { applySpec, type ApplyResult, type InputFile } from "../../src/engine/apply.ts";
import { defaultPolicy, parsePolicy, PolicyError, renderPolicy } from "../../src/policy.ts";
import { REDACTED_VALUE, type PatternName, type Spec } from "../../src/schema.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";

const found = (text: string, triggers: ContextTriggerSpec[] = []) =>
  findContextSpans(text, { triggers }).map((s) => text.slice(s.start, s.end));

describe("a few words between the trigger and the value", () => {
  test.each([
    ["Vault combo changed to 47-11-09 this morning.", ["47-11-09"]],
    ["the gate code is now 9182#", ["9182#"]],
    ["password was reset to Example!42", ["Example!42"]],
    ["her password was reset to swordfish", ["swordfish"]],
    ["driver's license on file is D1234567", ["D1234567"]],
    ["DOB was updated to 04/12/1980", ["04/12/1980"]],
    ["account is currently listed as 12345678", ["12345678"]],
    ["pw: was changed to Quill-9!", ["Quill-9!"]],
  ])("%j", (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test.each([
    ["the password is reset"],
    ["the password was reset."],
    ["the password was reset; 4471 is the room"],
    ["password was reset and then we left"],
    ["password was reset and then we all left the building"],
    ["the password was reset\n4471"],
    ["combination of both"],
    ["her password: none"],
    ["see the policy 2024 update"],
  ])("%j finds nothing", (text) => {
    expect(found(text)).toEqual([]);
  });

  test("a sentence end stops the search for a number", () => {
    expect(found("account is. 12345678")).toEqual([]);
  });
});

describe("label and value in neighbouring cells", () => {
  test("a label ends in a trigger, alone or with a colon or 'number'", () => {
    for (const label of ["DOB", "Owner DOB:", "Driver license", "Account number", "gate code", "Pet owner password"]) {
      expect(labelTrigger(label)).not.toBeNull();
    }
    for (const notLabel of ["Reset your password", "Owner", "DOB 04/12/1980", "the account manager", "", "Password was reset"]) {
      expect(labelTrigger(notLabel)).toBeNull();
    }
  });

  test("the cell to the right is the value", () => {
    const marks = pairCells([["Name", "Ada Example"], ["Owner DOB", "01/02/1960"], ["Driver license", "ST 123456789"], ["Notes", "calls Tuesday"]], { triggers: [] });
    expect(marks.map((m) => [m.row, m.col])).toEqual([[1, 1], [2, 1]]);
  });

  test("a value must fit the rule: a date for DOB, a digit for a number", () => {
    expect(pairCells([["DOB", "unknown"]], { triggers: [] })).toEqual([]);
    expect(pairCells([["Account", "closed"]], { triggers: [] })).toEqual([]);
  });

  test("a header row: the cells below a label whose right neighbour is no value", () => {
    const grid = [["Name", "DOB", "Notes"], ["Ada Example", "01/02/1960", "x"], ["Bo Sample", "03/04/1971", "y"]];
    expect(pairCells(grid, { triggers: [] }).map((m) => [m.row, m.col])).toEqual([[1, 1], [2, 1]]);
  });

  test("a secret next to a plain word in the header row is read as a header", () => {
    const grid = [["Password", "Notes"], ["swordfish", "x"]];
    expect(pairCells(grid, { triggers: [] }).map((m) => [m.row, m.col])).toEqual([[1, 0]]);
  });

  test("a label is never a value", () => {
    const grid = [["Password", "Driver license"], ["x", "ST 123456789"]];
    expect(pairCells(grid, { triggers: [] }).some((m) => m.row === 0)).toBe(false);
  });
});

const NONE: Record<PatternName, boolean> = { ip: false, email: false, host: false, guid: false, mac: false, phone: false };
const spec = (): Spec => ({ version: 1, columns: [], entities: {}, patterns: NONE, questions: [] });
const SALT = new Uint8Array(32).fill(5);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const apply = (files: InputFile[], context?: { enabled: boolean; triggers: ContextTriggerSpec[] }): ApplyResult =>
  applySpec(files, spec(), { salt: SALT, ...(context === undefined ? {} : { context }) });

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const table = (rows: string[][]) => `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${para(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
const docx = (body: string): InputFile => ({
  path: "form.docx",
  bytes: buildZip([
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: "_rels/.rels", data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `${DECL}<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>` },
  ]),
});
const docText = (r: ApplyResult): string => {
  const out = r.outputs[0];
  if (out === undefined) throw new Error(`no output; skipped: ${JSON.stringify(r.skipped)}`);
  return [...(readZip(out.bytes).find((e) => e.name === "word/document.xml")?.text ?? "").matchAll(/<w:t[^>]*>([^<]*)</g)].map((m) => m[1]).filter((t) => t !== "").join("|");
};

describe("DOCX tables", () => {
  const form = docx(table([["Owner DOB", "01/02/1960"], ["Driver license", "ST 123456789"], ["Visit", "Tuesday"]]));

  test("the label stays, the value in the next cell is redacted", () => {
    expect(docText(apply([form]))).toBe(`Owner DOB|${REDACTED_VALUE}|Driver license|${REDACTED_VALUE}|Visit|Tuesday`);
  });

  test("a header row with one record below it", () => {
    const t = docx(table([["Name", "DOB", "Plate"], ["Ada Example", "01/02/1960", "7ABC123"]]));
    expect(docText(apply([t]))).toBe(`Name|DOB|Plate|Ada Example|${REDACTED_VALUE}|${REDACTED_VALUE}`);
  });

  test("a value that does not fit stays; context disabled leaves the table alone", () => {
    const t = docx(table([["DOB", "unknown"], ["Account", "closed"]]));
    expect(docText(apply([t]))).toBe("DOB|unknown|Account|closed");
    expect(docText(apply([form], { enabled: false, triggers: [] }))).toBe("Owner DOB|01/02/1960|Driver license|ST 123456789|Visit|Tuesday");
  });

  test("a label cell in prose does not pair", () => {
    const t = docx(table([["Please reset your password", "4471"]]));
    expect(docText(apply([t]))).toBe("Please reset your password|4471");
  });
});

describe("CSV and XLSX cells", () => {
  test("a CSV form row: label cell then value cell (a column the pass left as text)", () => {
    const csv = "Field,Value\nOwner DOB,01/02/1960\nSitter DOB,03/04/1971\n";
    const out = dec(apply([{ path: "form.csv", bytes: enc(csv) }]).outputs[0]?.bytes);
    expect(out).not.toContain("1960");
    expect(out).not.toContain("1971");
    expect(out.match(new RegExp(REDACTED_VALUE, "g"))?.length).toBe(2);
  });

  test("a CSV column headed by a trigger", () => {
    const csv = "Name,DOB,Visit\nAda Example,01/02/1960,Tue\nBo Sample,03/04/1971,Wed\n";
    const out = dec(apply([{ path: "p.csv", bytes: enc(csv) }]).outputs[0]?.bytes);
    expect(out).toContain(`,${REDACTED_VALUE},`);
    expect(out).not.toContain("1960");
    expect(out).not.toContain("1971");
    expect(out).not.toContain("Ada Example");
  });

  test("an XLSX form row", () => {
    const str = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;
    const rows = [
      `<row r="1">${str("A1", "Field")}${str("B1", "Value")}</row>`,
      `<row r="2">${str("A2", "Owner DOB")}${str("B2", "01/02/1960")}</row>`,
      `<row r="3">${str("A3", "Sitter DOB")}${str("B3", "03/04/1971")}</row>`,
    ].join("");
    const r = apply([{ path: "form.xlsx", bytes: buildWorkbook({ staffRows: rows }) }]);
    const out = r.outputs[0];
    if (out === undefined) throw new Error(JSON.stringify(r.skipped));
    const sheet = readZip(out.bytes).find((e) => e.name === "xl/worksheets/sheet1.xml")?.text ?? "";
    expect(sheet).not.toContain("1960");
    expect(sheet).toContain(REDACTED_VALUE);
    expect(sheet).not.toContain("1971");
    expect(sheet.match(new RegExp(REDACTED_VALUE, "g"))?.length).toBe(2);
  });
});

describe("blind.toml triggers with a kind", () => {
  const license = { word: "license", kind: "number" as const };

  test("a number trigger takes a number, not the next word", () => {
    expect(found("her license photo is old", [license])).toEqual([]);
    expect(found("license 4417-22 expires", [license])).toEqual(["4417-22"]);
    expect(found("her license photo is old", ["license"])).toEqual(["photo"]);
  });

  test("a date trigger", () => {
    const born = { word: "born", kind: "date" as const };
    expect(found("she was born on 04/12/1980", [born])).toEqual(["04/12/1980"]);
    expect(found("born in Springfield", [born])).toEqual([]);
  });

  test("end to end: the repro", () => {
    const text = "Vault combo changed to 47-11-09 this morning.\nHer license photo is old.\n";
    const r = apply([{ path: "handoff.txt", bytes: enc(text) }], { enabled: true, triggers: [license] });
    expect(dec(r.outputs[0]?.bytes)).toBe(`Vault combo changed to ${REDACTED_VALUE} this morning.\nHer license photo is old.\n`);
  });

  test("a table label from blind.toml pairs with its kind", () => {
    const t = docx(table([["License", "ST 5551234"], ["License photo", "on file"]]));
    expect(docText(apply([t], { enabled: true, triggers: [license] }))).toBe(`License|${REDACTED_VALUE}|License photo|on file`);
  });

  test("parse, round-trip and validation", () => {
    const base = renderPolicy(defaultPolicy());
    const p = parsePolicy(`${base}\n[context]\ntriggers = ["vault code", { word = "license", kind = "number" }, { word = "born", kind = "date" }]`);
    expect(p.context.triggers).toEqual(["vault code", { word: "license", kind: "number" }, { word: "born", kind: "date" }]);
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
    const err = (extra: string) => {
      try {
        parsePolicy(`${base}\n${extra}`);
      } catch (e) {
        return e instanceof PolicyError ? e.message : String(e);
      }
      return "";
    };
    expect(err('[context]\ntriggers = [{ word = "x", kind = "colour" }]')).toContain("context.triggers[0].kind");
    expect(err('[context]\ntriggers = [{ word = "x" }]')).toContain("context.triggers[0].kind");
    expect(err('[context]\ntriggers = [{ kind = "date" }]')).toContain("context.triggers[0].word");
    expect(err('[context]\ntriggers = [{ word = " ", kind = "date" }]')).toContain("context.triggers[0].word");
    expect(err('[context]\ntriggers = [{ word = "x", kind = "date", extra = 1 }]')).toContain("unknown key context.triggers[0].extra");
    expect(err("[context]\ntriggers = [3]")).toContain("context.triggers[0]");
  });
});
