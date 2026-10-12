// AGT-1852: a column value recurs as name parts only when it is shaped like a name; common words
// (dictionary, field-label, role and kept words) never stand alone; dates joined by "-", "/" or "."
// are date context; a key/value block's labels are not person values. Both directions are tested:
// what must stay as written does, and every real name, id, email and phone is still blinded where it
// recurs. Synthetic data only: invented names, example.com, 555 numbers.

import { describe, expect, test } from "bun:test";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { type Candidate, leakDecisions } from "../../src/analyst/fromaudit.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { inDateContext } from "../../src/engine/datecontext.ts";
import { isLabelCell, isLabelColumn, isLabelWord } from "../../src/engine/labels.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { keptWords, nameParts, nameShaped, partExclusion, recurrenceExclusion, recurrenceForms } from "../../src/engine/recur.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 71);

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"], sheet?: string): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
  ...(sheet !== undefined ? { sheet } : {}),
});

const spec = (columns: ColumnRule[]): Spec => ({
  version: 1,
  columns,
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false, phone: true },
  questions: [],
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => Buffer.from(r.outputs.find((o) => o.path === path)?.bytes ?? new Uint8Array()).toString("utf8");
const pseudo = (r: ApplyResult, value: string): string => {
  const e = r.map.entries.find((x) => x.value === value);
  if (e === undefined) throw new Error(`no map entry for ${value}`);
  return e.pseudonym;
};
const audit = (r: ApplyResult, s: Spec) => {
  const entries: TreeEntry[] = r.outputs.map((o) => ({ path: o.path, kind: "file", bytes: o.bytes }));
  return addSemanticLayer(auditTree(entries, s, r.map, []), entries, s, r.map, { keep: [] });
};
const leaks = (r: ApplyResult, s: Spec) => audit(r, s).files.flatMap((f) => f.findings).filter((f) => f.severity === "leak");

describe("nameShaped", () => {
  test("names, in any case and with joiners, are name-shaped", () => {
    for (const v of ["Dana Quillfeather", "Quill, Avery", "avery quill", "Mary-Jane O'Neil", "Avery & Bea Quill", "J. Quill", "Dana Quill and Bea Quill", "Quillfeather"]) {
      expect(nameShaped(v)).toBe(true);
    }
  });
  test("dates, numbers, emails, organisations and long values are not", () => {
    for (const v of ["17-Sep-1983", "02/01/1970", "ST 12345", "dana@example.com", "Hill Valley Rescue", "Example Pet Clinic LLC", "Avery Bea Cole Dana Quill", ""]) {
      expect(nameShaped(v)).toBe(false);
    }
  });
  test("a value that is not name-shaped has no name parts; a name still does", () => {
    const parts = nameParts(["17-Sep-1983", "Hill Valley Rescue", "Dana Quillfeather"], [], new Set(), new Set());
    expect(parts.map((p) => p.form)).toEqual(["Dana", "Quillfeather"]);
  });
});

describe("common words never stand alone", () => {
  test("field-label words are excluded as name parts and as whole values", () => {
    for (const w of ["Card", "Phone", "Email", "Address", "Agency", "Fax"]) expect(isLabelWord(w)).toBe(true);
    expect(partExclusion("Card", new Set(), new Set())).toBe("a field-label word");
    expect(partExclusion("Agency", new Set(), new Set())).toBe("a field-label word");
    expect(recurrenceExclusion("Card", new Set())).toBe("only dictionary or field-label words");
    expect(recurrenceExclusion("Fax Agency", new Set())).toBe("only dictionary or field-label words");
    // A name is not a label.
    expect(partExclusion("Quillfeather", new Set(), new Set())).toBeNull();
    expect(recurrenceExclusion("Dana Quillfeather", new Set())).toBeNull();
  });
  test("a map entry for a label word from an earlier round is not reused for new spans", () => {
    const map: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "card", value: "Card", pseudonym: "Person_0A0A" }] };
    expect(recurrenceForms([], {}, map)).toEqual([]);
    const r = applySpec([file("n.txt", "Card on file; the card was declined.\n")], spec([]), { salt: SALT, map });
    expect(out(r, "n.txt")).toBe("Card on file; the card was declined.\n");
  });
  test("--accept-leaks never accepts a label word, even one the map holds", () => {
    const map: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "card", value: "Card", pseudonym: "Person_0A0A" }] };
    const c = (id: string, value: string): Candidate => ({ id, value, kinds: ["person"], suggested: "person", pattern: null, known: true, severity: "leak", places: [] });
    const { decisions, skipped } = leakDecisions(spec([]), [c("c1", "Card"), c("c2", "Fax"), c("c3", "Dana Quillfeather")], [], map);
    expect(skipped.map((s) => s.value)).toEqual(["Card", "Fax"]);
    expect(skipped[0]?.why).toContain("field-label");
    // A real name is still accepted.
    expect(decisions.map((d) => d.id)).toEqual(["c3"]);
  });
  test("words of kept proper-name values shield name parts; kept prose does not", () => {
    const w = keptWords(["Example Valley Clinic", "Avery says hi", "Bank of the West", "Dana Quill"], ["Dana Quill"]);
    expect(w.has("valley")).toBe(true);
    expect(w.has("west")).toBe(true);
    expect(w.has("avery")).toBe(false);
    expect(w.has("quill")).toBe(false);
  });
});

describe("date context joined by -, / or .", () => {
  const ctx = (t: string, word: string) => inDateContext(t, t.indexOf(word), t.indexOf(word) + word.length);
  test("joined dates", () => {
    expect(ctx("seen 1-Sep-2024 ok", "Sep")).toBe(true);
    expect(ctx("Sep-2024", "Sep")).toBe(true);
    expect(ctx("on 01/Sep/24", "Sep")).toBe(true);
    expect(ctx("Sep-01", "Sep")).toBe(true);
    expect(ctx("9.Jan.2026", "Jan")).toBe(true);
  });
  test("a joined word or a long number is not a date", () => {
    expect(ctx("Jan-Erik called", "Jan")).toBe(false);
    expect(ctx("Jan-12345", "Jan")).toBe(false);
    expect(ctx("met Jan today", "Jan")).toBe(false);
  });
  test("a person named Jan is still blinded alone, outside a date", () => {
    const s = spec([rule("staff.csv", "Name", "person", "blind")]);
    const r = applySpec([file("staff.csv", "Name\nJan Vellacourt\n"), file("n.txt", "met Jan on 1-Jan-2026 and Jan/2026\n")], s, { salt: SALT });
    const p = pseudo(r, "Jan Vellacourt");
    expect(out(r, "n.txt")).toBe(`met ${p} on 1-Jan-2026 and Jan/2026\n`);
    expect(leaks(r, s)).toEqual([]);
  });
});

describe("the AGT-1852 repro", () => {
  const csv =
    "clinic,owner_name,owner_dob,visit_date,notes\n" +
    "Example Valley Clinic,Dana Quillfeather,17-Sep-1983,1-Sep-2024,Recheck 9-Sep-2024\n" +
    "Example Valley Clinic,Hill Valley Rescue,02-Jan-1970,3-Sep-2024,ok\n";
  const s = spec([
    rule("v.csv", "clinic", "vocabulary", "keep"),
    rule("v.csv", "owner_name", "person", "blind"),
    rule("v.csv", "owner_dob", "person", "blind"),
    rule("v.csv", "visit_date", "vocabulary", "keep"),
    rule("v.csv", "notes", "unknown", "scan"),
  ]);
  const prose = "Dana Quillfeather rang. Quillfeather paid; Dana will bring Hill Valley Rescue papers. Filed 17-Sep-1983. Seen 1-Sep-2024.\n";
  const r = applySpec([file("v.csv", csv), file("call.txt", prose)], s, { salt: SALT });
  const rows = out(r, "v.csv").split("\n").map((l) => l.split(","));
  const cols = (i: number) => rows.slice(1, 3).map((x) => x[i]);

  test("keep columns and notes are byte-identical", () => {
    const input = csv.split("\n").map((l) => l.split(","));
    for (const i of [0, 3, 4]) expect(cols(i)).toEqual(input.slice(1, 3).map((x) => x[i]));
  });
  test("both owner names are blinded, and the DOB values are blinded whole", () => {
    expect(cols(1)).toEqual([pseudo(r, "Dana Quillfeather"), pseudo(r, "Hill Valley Rescue")]);
    expect(cols(2)).toEqual([pseudo(r, "17-Sep-1983"), pseudo(r, "02-Jan-1970")]);
    // No month word, date piece or organisation word got a pseudonym of its own.
    expect(r.map.entries.map((e) => e.value).sort()).toEqual(["02-Jan-1970", "17-Sep-1983", "Dana Quillfeather", "Hill Valley Rescue"]);
  });
  test("protection: every recurrence of a name, name part and whole value is still caught elsewhere", () => {
    const d = pseudo(r, "Dana Quillfeather");
    expect(out(r, "call.txt")).toBe(`${d} rang. ${d} paid; ${d} will bring ${pseudo(r, "Hill Valley Rescue")} papers. Filed ${pseudo(r, "17-Sep-1983")}. Seen 1-Sep-2024.\n`);
    expect(leaks(r, s)).toEqual([]);
  });
});

describe("a part that is a word of a kept value", () => {
  const s = spec([rule("v.csv", "clinic", "vocabulary", "keep"), rule("v.csv", "owner", "person", "blind")]);
  const csv = "clinic,owner\nExample Valley Clinic,Avery Valley\n";
  const r = applySpec([file("v.csv", csv), file("n.txt", "Avery Valley called. Avery asked; the Valley Clinic replied.\n")], s, { salt: SALT });
  test("is not matched alone, so the kept cell is unchanged; the whole name and the other part still are", () => {
    expect(out(r, "v.csv")).toBe(`clinic,owner\nExample Valley Clinic,${pseudo(r, "Avery Valley")}\n`);
    const p = pseudo(r, "Avery Valley");
    expect(out(r, "n.txt")).toBe(`${p} called. ${p} asked; the Valley Clinic replied.\n`);
  });
  test("and is counted in the report", () => {
    expect(r.commonNameParts).toBe(1);
  });
  test("kept prose shields nothing: a name part in a kept notes cell is still replaced", () => {
    const s2 = spec([rule("w.csv", "owner", "person", "blind"), rule("w.csv", "notes", "vocabulary", "keep")]);
    const r2 = applySpec([file("w.csv", "owner,notes\nAvery Quillfeather,spoke to Quillfeather again\n")], s2, { salt: SALT });
    const p = pseudo(r2, "Avery Quillfeather");
    expect(out(r2, "w.csv")).toBe(`owner,notes\n${p},spoke to ${p} again\n`);
  });
});

describe("key/value layout", () => {
  const kv = "Client,Dana Quillfeather\nPhone,555-201-7788\nCard,4111 1111 1111 1111\nEmail,dana.q@example.com\n";
  const note = "Card on file for Dana Quillfeather; the card and phone are below. Quillfeather agreed.\n";
  const s = spec([rule("kv.csv", "Client", "person", "blind")]);
  const r = applySpec([file("kv.csv", kv), file("n.txt", note)], s, { salt: SALT, context: { enabled: true, triggers: [] } });

  test("labels stay as written; the client's name is blinded, and so are the phone, card and email", () => {
    const lines = out(r, "kv.csv").split("\n");
    const d = pseudo(r, "Dana Quillfeather");
    expect(lines[0]).toBe(`Client,${d}`);
    expect(lines.slice(1, 4).map((l) => l.split(",")[0])).toEqual(["Phone", "Card", "Email"]);
    const body = out(r, "kv.csv");
    for (const secret of ["555-201-7788", "4111", "dana.q@example.com"]) expect(body).not.toContain(secret);
    expect(r.map.entries.some((e) => e.kind === "person" && ["Phone", "Card", "Email"].includes(e.value))).toBe(false);
  });
  test("label words in prose are left alone; the name and its parts are not", () => {
    const d = pseudo(r, "Dana Quillfeather");
    expect(out(r, "n.txt")).toBe(`Card on file for ${d}; the card and phone are below. ${d} agreed.\n`);
    expect(leaks(r, s)).toEqual([]);
  });
  test("isLabelColumn and isLabelCell", () => {
    expect(isLabelColumn(["Phone", "Card", "Email", "Home address"])).toBe(true);
    expect(isLabelColumn(["Dana Quillfeather", "Avery Quill", "Card"])).toBe(false);
    expect(isLabelColumn(["Phone"])).toBe(false);
    expect(isLabelCell("Email:")).toBe(true);
    expect(isLabelCell("Quillfeather")).toBe(false);
    expect(isLabelCell("Card 4111")).toBe(false);
  });
  test("a person column that only holds a label word or two is still blinded", () => {
    const s2 = spec([rule("p.csv", "owner", "person", "blind")]);
    const r2 = applySpec([file("p.csv", "owner,pet\nDana Quillfeather,Biscuit\nAvery Quill,Pepper\nOwner,Mochi\n")], s2, { salt: SALT });
    const body = out(r2, "p.csv");
    expect(body).not.toContain("Dana Quillfeather");
    expect(body).not.toContain("Avery Quill");
  });
});

describe("key/value layout in XLSX", () => {
  const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const inline = (ref: string, text: string): string => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
  const rows: [string, string][] = [
    ["Client", "Dana Quillfeather"],
    ["Phone", "555-201-7788"],
    ["Card", "4111 1111 1111 1111"],
    ["Email", "dana.q@example.com"],
  ];
  const entries: FixtureEntry[] = [
    {
      name: "[Content_Types].xml",
      data:
        `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    { name: "_rels/.rels", data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Intake" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `${DECL}<worksheet xmlns="${MAIN}" xmlns:r="${REL}"><sheetData>${rows.map(([a, b], i) => `<row r="${i + 1}">${inline(`A${i + 1}`, a)}${inline(`B${i + 1}`, b)}</row>`).join("")}</sheetData></worksheet>`,
    },
  ];
  const s = spec([rule("intake.xlsx", "Client", "person", "blind", "Intake")]);
  const r = applySpec([{ path: "intake.xlsx", bytes: buildZip(entries) }, file("n.txt", "Card on file for Dana Quillfeather.\n")], s, { salt: SALT, context: { enabled: true, triggers: [] } });
  const sheetXml = (): string => {
    const o = r.outputs.find((x) => x.path === "intake.xlsx");
    const m = readZip(o?.bytes ?? new Uint8Array()).find((e) => e.name === "xl/worksheets/sheet1.xml");
    return m?.text ?? "";
  };

  test("labels stay; the paired name is blinded, and so are the phone, card and email", () => {
    const xml = sheetXml();
    for (const label of ["Client", "Phone", "Card", "Email"]) expect(xml).toContain(`>${label}<`);
    expect(xml).toContain(pseudo(r, "Dana Quillfeather"));
    for (const secret of ["Dana Quillfeather", "555-201-7788", "4111", "dana.q@example.com"]) expect(xml).not.toContain(secret);
    expect(r.map.entries.some((e) => e.kind === "person" && ["Phone", "Card", "Email"].includes(e.value))).toBe(false);
    expect(out(r, "n.txt")).toBe(`Card on file for ${pseudo(r, "Dana Quillfeather")}.\n`);
  });
});
