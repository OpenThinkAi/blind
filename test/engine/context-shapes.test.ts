// Context-keyword redaction, round three (AGT-1850): multi-token plates, usernames and badges, where a
// key is hidden, and spoken dates after DOB. Synthetic text only; every value is invented.

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTEXT_TRIGGERS, findContextSpans, labelTrigger, pairCells } from "../../src/engine/context.ts";
import { applySpec, type ApplyResult, type InputFile } from "../../src/engine/apply.ts";
import { REDACTED_VALUE, type PatternName, type Spec } from "../../src/schema.ts";
import { buildZip, readZip } from "../formats/zipfixture.ts";

const found = (text: string) => findContextSpans(text, { triggers: [] }).map((s) => text.slice(s.start, s.end));

describe("plates", () => {
  test.each([
    ["plate ST 7AB C12.", ["ST 7AB C12"]],
    ["Second car plate ST 12-3456.", ["ST 12-3456"]],
    ["plate 7ABC123", ["7ABC123"]],
    ["license plate 7ABC 123 was seen", ["7ABC 123"]],
    ["plate OR 123 ABC today", ["OR 123 ABC"]],
    ["plate was ST 7AB C12", ["ST 7AB C12"]],
    ["plate: 12-3456, parked", ["12-3456"]],
  ])("%j", (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test.each([["plate 2"], ["plate of food"], ["plate of 12 items"], ["plate ST"], ["the plates were washed"], ["plate 12"]])("%j finds nothing", (text) => {
    expect(found(text)).toEqual([]);
  });

  test("a lowercase word after the first group is not part of the plate", () => {
    expect(found("plate 7AB was blue")).toEqual(["7AB"]);
  });
});

describe("usernames, handles and badges", () => {
  test.each([
    ["previous username was dana42", ["dana42"]],
    ["user name: d.quill", ["d.quill"]],
    ["login is dana_42.", ["dana_42"]],
    ["her handle @dana42 is public", ["@dana42"]],
    ["login: admin", ["admin"]],
    ["username: root", ["root"]],
    ["handle = alice", ["alice"]],
    ["the username is root.", ["root"]],
    ["previous login was admin", ["admin"]],
    ["screen name: quill99", ["quill99"]],
    ["Officer badge 7316 attended", ["7316"]],
    ["employee id E-77123", ["E-77123"]],
    ["member id: 0042-88", ["0042-88"]],
    ["staff id 4410", ["4410"]],
  ])("%j", (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test.each([
    ["please handle it with care"],
    ["login page is slow"],
    ["login: 7"],
    ["username: it"],
    ["the username is required"],
    ["login 7"],
    ["badge of honour"],
    ["employee id missing"],
    ["login.example.com"],
  ])("%j finds nothing", (text) => {
    expect(found(text)).toEqual([]);
  });
});

describe("where a key is hidden", () => {
  test.each([
    ["Spare key under the green mat by the back door.", ["under the green mat by the back door"]],
    ["The key is in the lockbox behind the shed, gate code 9038", ["in the lockbox behind the shed", "9038"]],
    ["house key kept beneath the third flower pot\nNext line", ["beneath the third flower pot"]],
    ["door keys are hidden above the frame; call me", ["above the frame"]],
    ["spare key left on top of the fridge in the garage with some more words after it", ["on top of the fridge in the garage"]],
  ])("%j", (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test.each([
    ["key under review"],
    ["the spare key under consideration"],
    ["keyboard under the desk"],
    ["key findings in the report"],
    ["primary key in the users table"],
    ["a key"],
    ["keyed in the order"],
  ])("%j finds nothing", (text) => {
    expect(found(text)).toEqual([]);
  });
});

describe("spoken dates after DOB", () => {
  test.each([
    ["date of birth is June third forty-two.", ["June third forty-two"]],
    ["DOB June the third nineteen forty-two ok", ["June the third nineteen forty-two"]],
    ["dob: March twenty-first nineteen eighty", ["March twenty-first nineteen eighty"]],
    ["birthday is the third of June forty-two", ["the third of June forty-two"]],
    ["DOB June 3rd '42", ["June 3rd '42"]],
    ["DOB June third 1942", ["June third 1942"]],
    ["DOB May twelve two thousand five", ["May twelve two thousand five"]],
    ["DOB June third", ["June third"]],
    ["DOB June 3, 1942", ["June 3, 1942"]],
    ["DOB: 04/12/1980", ["04/12/1980"]],
    ["DOB April 12, 1980 per chart", ["April 12, 1980"]],
    ["date of birth 12 April 1980.", ["12 April 1980"]],
    ["DOB June third forty people came", ["June third"]],
    ["birthdate October ninth oh seven", ["October ninth oh seven"]],
  ])("%j", (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test("a spoken date with no DOB keyword is left alone", () => {
    expect(found("We met on June third forty-two years ago.")).toEqual([]);
  });
});

describe("tables", () => {
  const rule = (label: string) => {
    const r = labelTrigger(label);
    if (r === null) throw new Error(`${label} is no label`);
    return r;
  };
  test("labels", () => {
    for (const l of ["Username", "Login:", "Badge", "Badge number", "Employee ID", "Member id", "Spare key", "Key location", "House key location"]) {
      expect(labelTrigger(l)).not.toBeNull();
    }
    // A bare "Key" header (a key/value table) is not a hiding-spot label.
    expect(labelTrigger("Key")).toBeNull();
    expect(rule("Plate")).not.toBeNull();
  });

  test("label and value pairs", () => {
    const grid = [["Plate", "ST 7AB C12"], ["Username", "dana42"], ["Badge", "7316"], ["Spare key", "under the green mat"], ["DOB", "June third forty-two"], ["Visit", "Tuesday"]];
    expect(pairCells(grid, { triggers: [] }).map((m) => m.row)).toEqual([0, 1, 2, 3, 4]);
  });

  test("a value must fit: a short word is no handle", () => {
    expect(pairCells([["Username", "x"]], { triggers: [] })).toEqual([]);
    expect(pairCells([["Username", "dana"]], { triggers: [] }).length).toBe(1);
  });
});

const NONE: Record<PatternName, boolean> = { ip: false, email: false, host: false, guid: false, mac: false, phone: false, address: false, secret: false };
const spec = (): Spec => ({ version: 1, columns: [], entities: {}, patterns: NONE, questions: [] });
const SALT = new Uint8Array(32).fill(5);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const apply = (files: InputFile[]): ApplyResult => applySpec(files, spec(), { salt: SALT });

describe("apply", () => {
  const NOTES = [
    "Driver left info, plate ST 7AB C12. Second car plate ST 12-3456.",
    "Client says previous username was dana42. Officer badge 7316 attended.",
    "Gate code 9038. Spare key under the green mat by the back door.",
    "Caller confirmed her date of birth is June third forty-two.",
    "",
  ].join("\n");

  test("the synthetic repro: every value goes, every other word stays", () => {
    const out = dec(apply([{ path: "notes.txt", bytes: enc(NOTES) }]).outputs[0]?.bytes);
    expect(out).toBe(
      [
        `Driver left info, plate ${REDACTED_VALUE}. Second car plate ${REDACTED_VALUE}.`,
        `Client says previous username was ${REDACTED_VALUE}. Officer badge ${REDACTED_VALUE} attended.`,
        `Gate code ${REDACTED_VALUE}. Spare key ${REDACTED_VALUE}.`,
        `Caller confirmed her date of birth is ${REDACTED_VALUE}.`,
        "",
      ].join("\n"),
    );
  });

  test("a CSV with label and value cells", () => {
    const csv = "Field,Value\nPlate,ST 7AB C12\nUsername,dana42\nSpare key,under the green mat\nDOB,June third forty-two\nVisit,Tuesday\n";
    const out = dec(apply([{ path: "form.csv", bytes: enc(csv) }]).outputs[0]?.bytes);
    for (const v of ["7AB", "dana42", "green mat", "forty-two"]) expect(out).not.toContain(v);
    expect(out.match(new RegExp(REDACTED_VALUE, "g"))?.length).toBe(4);
    expect(out).toContain("Tuesday");
  });

  test("a DOCX table", () => {
    const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const rows = [["Plate", "ST 7AB C12"], ["Username", "dana42"], ["Badge", "7316"], ["Spare key", "under the green mat"], ["DOB", "June third forty-two"], ["Visit", "Tuesday"]];
    const tbl = `<w:tbl><w:tblPr/>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/>${para(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
    const file: InputFile = {
      path: "form.docx",
      bytes: buildZip([
        { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
        { name: "_rels/.rels", data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
        { name: "word/document.xml", data: `${DECL}<w:document ${W}><w:body>${tbl}<w:sectPr/></w:body></w:document>` },
      ]),
    };
    const out = apply([file]).outputs[0];
    if (out === undefined) throw new Error("no output");
    const xml = readZip(out.bytes).find((e) => e.name === "word/document.xml")?.text ?? "";
    const texts = [...xml.matchAll(/<w:t[^>]*>([^<]*)</g)].map((m) => m[1]).filter((t) => t !== "").join("|");
    expect(texts).toBe(`Plate|${REDACTED_VALUE}|Username|${REDACTED_VALUE}|Badge|${REDACTED_VALUE}|Spare key|${REDACTED_VALUE}|DOB|${REDACTED_VALUE}|Visit|Tuesday`);
  });
});

test("the new triggers are listed for the docs and init", () => {
  const all = DEFAULT_CONTEXT_TRIGGERS.join(" | ");
  for (const w of ["username", "badge", "key", "plate"]) expect(all).toContain(w);
});
