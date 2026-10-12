import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import { planDocx } from "../../src/engine/docx.ts";
import type { BlindMap, MapEntry } from "../../src/engine/map.ts";
import { RevealError, revealFile, Revealer } from "../../src/engine/reveal.ts";
import { rewriteOoxml } from "../../src/formats/ooxml.ts";
import { cellText, classify, readWorkbook, slotRules } from "../../src/formats/xlsx.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";
import { docxMembers, xlsxMembers } from "../audit/ooxmlfixture.ts";
import { makeZip } from "../audit/zipfixture.ts";

// Synthetic salt and data only: invented names, example.com, RFC 5737 addresses, obviously fake IDs.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 29);
const PATTERNS = { ip: true, email: true, host: true, guid: true, mac: false };

const blind = (path: string, bytes: Uint8Array, spec: Spec): ApplyResult => {
  const r = applySpec([{ path, bytes }], spec, { salt: SALT });
  expect(r.skipped).toEqual([]);
  return r;
};
const output = (r: ApplyResult): Uint8Array => (r.outputs[0] as { bytes: Uint8Array }).bytes;
const pseudonym = (r: ApplyResult, value: string): string => {
  const e = r.map.entries.find((x) => x.value === value);
  if (e === undefined) throw new Error(`no pseudonym for ${value}`);
  return e.pseudonym;
};
const members = (bytes: Uint8Array): Map<string, string> => new Map(readZip(bytes).map((e) => [e.name, e.text]));
/** Rebuild a package with some members' text changed. */
const edit = (bytes: Uint8Array, change: (name: string, text: string) => string): Uint8Array =>
  buildZip(readZip(bytes).map((e): FixtureEntry => ({ name: e.name, data: change(e.name, e.text), method: e.method as 0 | 8 })));
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const entry = (kind: MapEntry["kind"], canonical: string, value: string, pseudo: string): MapEntry => ({ kind, canonical, value, pseudonym: pseudo });

// ---------------------------------------------------------------- XLSX

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
const XLSX_SPEC: Spec = {
  version: 1,
  columns: [rule("Name", "person", "blind"), rule("Employee ID", "id", "blind"), rule("Notes", "unknown", "value"), rule("Status", "vocabulary", "keep")],
  entities: {
    person: [{ canonical: "Avery Quill", aliases: [], parts: [] }],
    org: [{ canonical: "Example Widgets", aliases: [], parts: [] }],
  },
  patterns: PATTERNS,
  questions: [],
};

/**
 * Every place `classify` names, read independently of reveal: each value in document order, with
 * the runs of a shared or inline string read as the one text they make (blinding may move text
 * between the runs of one string; the string's text is what must come back).
 */
function xlsxLocations(bytes: Uint8Array): Map<string, string[]> {
  const wb = readWorkbook(bytes);
  const out = new Map<string, string[]>();
  rewriteOoxml(
    bytes,
    (value, ctx) => {
      const slot = classify(ctx.member, ctx.element, ctx.parents, ctx.attribute);
      if (slot !== "sharedRun" && slot !== "inlineRun") out.set(ctx.member, [...(out.get(ctx.member) ?? []), `${ctx.element.name}${ctx.attribute ?? ""}=${value}`]);
      return value;
    },
    (member) => slotRules(member),
  );
  out.set("(shared strings)", wb.sharedStrings.map((s) => s.runs.join("")));
  out.set("(cells)", wb.sheets.flatMap((s) => s.cells.map((c) => `${s.name}!${c.ref}=${cellText(c, wb.sharedStrings)}`)));
  return out;
}

/** Members, rows, cells, runs and formulas per member. */
const xlsxShape = (bytes: Uint8Array) =>
  [...members(bytes)].map(([name, xml]) => ({ name, rows: count(xml, /<row[\s>]/g), cells: count(xml, /<c[\s>]/g), runs: count(xml, /<r>/g), formulas: count(xml, /<f[\s>]/g) }));

describe("XLSX reveal", () => {
  const original = buildWorkbook();
  const r = blind(FILE, original, XLSX_SPEC);
  const blinded = output(r);
  const rv = new Revealer(r.map);
  const back = revealFile(FILE, blinded, rv);

  test("round trip: every rewritten location reads as it did before apply, and the structure is unchanged", () => {
    // Blinding changed the names, cells, formulas and metadata ...
    const before = members(blinded);
    expect(before.get("xl/workbook.xml")).not.toContain("Avery Quill");
    expect(before.get("xl/worksheets/sheet1.xml")).not.toContain("4417");
    expect(before.get("docProps/core.xml")).not.toContain("Avery Quill");
    // ... and reveal brings back every one of them.
    expect(back.restored).toBeGreaterThan(20);
    // "Avery" in the defined name Avery_Total is the given name of the workbook's creator, Avery
    // Quill, so it is blinded as a name part with the creator's pseudonym (AGT-1812) and comes back
    // as the whole recorded form, made a valid defined name (restoreName). Everything else comes
    // back as it was.
    const expected = new Map(
      [...xlsxLocations(original)].map(([k, v]) => [
        k,
        v.map((x) => x.replace(/^(definedNamename=|f=.*)Avery_Total/, "$1Avery_Quill_Total").replace(/^vt:lpstr=Avery_Total$/, "vt:lpstr=Avery Quill_Total")),
      ]),
    );
    expect(xlsxLocations(back.bytes)).toEqual(expected);
    expect(xlsxShape(back.bytes)).toEqual(xlsxShape(original));
  });

  test("sheet names are restored with every formula, hyperlink and pivot source naming them", () => {
    const m = members(back.bytes);
    const person = pseudonym(r, "Avery Quill");
    expect(members(blinded).get("xl/workbook.xml")).toContain(`<sheet name="${person}"`);
    expect(m.get("xl/workbook.xml")).toContain(`<sheet name="Avery Quill"`);
    expect(m.get("xl/workbook.xml")).toContain(`'Avery Quill'!$A$2</definedName>`);
    expect(m.get("xl/worksheets/sheet1.xml")).toContain(`<f>"see "&amp;'Avery Quill'!A1</f>`);
    expect(m.get("xl/worksheets/sheet3.xml")).toContain(`HYPERLINK("#'Avery Quill'!A1","Avery Quill")`);
    expect(m.get("xl/worksheets/sheet3.xml")).toContain(`display="Avery Quill"`);
    expect(m.get("xl/pivotCache/pivotCacheDefinition1.xml")).toContain(`<worksheetSource ref="A1:B5" sheet="Staff"/>`);
  });

  test("renumbered numbers come back, in cells and in the pivot caches that repeat them", () => {
    const blindedSheet = members(blinded).get("xl/worksheets/sheet1.xml") as string;
    expect(blindedSheet).not.toContain("<v>4417</v>");
    const m = members(back.bytes);
    expect(m.get("xl/worksheets/sheet1.xml")).toContain('<c r="B2"><v>4417</v></c>');
    expect(m.get("xl/pivotCache/pivotCacheRecords1.xml")).toContain('<n v="4417"/>');
    expect(m.get("xl/pivotCache/pivotCacheDefinition1.xml")).toContain('minValue="4417" maxValue="4418"');
  });

  test("a renumbered decimal comes back with its point where it was", () => {
    const rev = new Revealer({ version: 1, entries: [entry("id", "1250", "1250", "8836")] });
    const wb = buildWorkbook({ extra: [{ name: "xl/worksheets/sheet2.xml", data: members(buildWorkbook()).get("xl/worksheets/sheet2.xml")!.replace("<v>12.5</v>", "<v>88.36</v>") }] });
    expect(members(revealFile(FILE, wb, rev).bytes).get("xl/worksheets/sheet2.xml")).toContain("<v>12.50</v>");
  });

  test("a pseudonym split across the runs of a string is restored where it starts", () => {
    const robin = pseudonym(r, "Robin Example");
    const split = edit(blinded, (name, text) =>
      name === "xl/sharedStrings.xml" ? text.replace(`<si><t xml:space="preserve">${robin}</t></si>`, `<si><r><t>${robin.slice(0, 4)}</t></r><r><rPr><b/></rPr><t>${robin.slice(4)} (lead)</t></r></si>`) : text,
    );
    expect(members(split).get("xl/sharedStrings.xml")).not.toContain(`>${robin}<`);
    const sst = members(revealFile(FILE, split, rv).bytes).get("xl/sharedStrings.xml") as string;
    expect(sst).toContain("<si><r><t>Robin Example</t></r><r><rPr><b/></rPr><t> (lead)</t></r></si>");
  });

  test("a defined name blinded from part of an identity comes back valid, the same in every formula naming it", () => {
    const spec: Spec = { ...XLSX_SPEC, entities: { ...XLSX_SPEC.entities, person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }] } };
    const res = blind(FILE, original, spec);
    const m = members(revealFile(FILE, output(res), new Revealer(res.map)).bytes);
    // The map records one form per identity: "Avery" comes back as "Avery Quill", made a valid name.
    expect(m.get("xl/workbook.xml")).toContain('<definedName name="Avery_Quill_Total">');
    expect(m.get("xl/worksheets/sheet1.xml")).toContain("<f>SUM(B2:B4)+Avery_Quill_Total</f>");
  });

  test("restored sheet names that the spreadsheet would refuse, or that collide, refuse the workbook", () => {
    const person = pseudonym(r, "Avery Quill");
    const bad = (value: string) => new Revealer({ version: 1, entries: [entry("person", "x", value, person)] });
    expect(() => revealFile(FILE, blinded, bad("Avery/Quill"))).toThrow(/restored worksheet name contains a character/);
    expect(() => revealFile(FILE, blinded, bad("Staff"))).toThrow(/two worksheet names would reveal to the same name/);
  });

  test("fail closed: a member that cannot be read refuses the whole workbook", () => {
    const broken = edit(blinded, (name, text) => (name === "xl/comments1.xml" ? text.replace("</comments>", "") : text));
    expect(() => revealFile(FILE, broken, rv)).toThrow(RevealError);
    expect(() => revealFile(FILE, broken, rv)).toThrow(/xl\/comments1\.xml cannot be read/);
    expect(() => revealFile(FILE, new TextEncoder().encode("PK"), rv)).toThrow(/cannot read it as XLSX/);
  });

  test("a workbook with nothing to restore is returned as is", () => {
    const empty = new Revealer({ version: 1, entries: [] });
    const out = revealFile(FILE, original, empty);
    expect(out).toEqual({ bytes: original, restored: 0 });
  });
});

// ---------------------------------------------------------------- DOCX

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (text: string, rPr = "", tag = "w:t") => `<w:r w:rsidR="00A1B2C3">${rPr && `<w:rPr>${rPr}</w:rPr>`}<${tag}${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""}>${text}</${tag}></w:r>`;
const para = (...runs: string[]) => `<w:p w:rsidR="00A1B2C3"><w:pPr><w:pStyle w:val="Body"/></w:pPr>${runs.join("")}</w:p>`;
const BODY = [
  para(run("Contract with "), run("Ac", "<w:b/>"), run("me Corp", "<w:i/>"), run(" signed by Dana Pell.")),
  para(
    run("Owner: "),
    `<w:del w:id="1" w:author="Robin Example" w:date="2026-01-02T00:00:00Z">${run("Jo Sample", "", "w:delText")}</w:del>`,
    `<w:ins w:id="2" w:author="Robin Example" w:date="2026-01-02T00:00:00Z">${run("Dana Pell")}</w:ins>`,
  ),
  para(
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    run(' HYPERLINK "mailto:dana.p', "", "w:instrText"),
    run('ell@example.com" ', "", "w:instrText"),
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    run("write to us"),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ),
  para(run("Acme"), "<w:r><w:tab/></w:r>", run("Corporate travel at 192.0.2.10")),
].join("");
const DOCX_ENTRIES: FixtureEntry[] = [
  { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
  {
    name: "_rels/.rels",
    data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  },
  { name: "word/document.xml", data: `${DECL}<w:document ${W}><w:body>${BODY}<w:sectPr/></w:body></w:document>` },
  {
    name: "word/comments.xml",
    data: `${DECL}<w:comments ${W}><w:comment w:id="0" w:author="Robin Example" w:initials="RE">${para(run("Ask Dana "), run("Pell first"))}</w:comment></w:comments>`,
  },
  {
    name: "docProps/core.xml",
    data: `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Acme Corp contract</dc:title><dc:creator>Robin Example</dc:creator><cp:lastModifiedBy>Jo Sample</cp:lastModifiedBy></cp:coreProperties>`,
  },
  {
    name: "docProps/app.xml",
    data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Northwind Example</Company><Manager>Jo Sample</Manager></Properties>`,
  },
];
const DOCX_SPEC: Spec = {
  version: 1,
  columns: [],
  entities: {
    person: [
      { canonical: "Dana Pell", aliases: [], parts: [] },
      { canonical: "Jo Sample", aliases: [], parts: [] },
    ],
    // No aliases: an alias comes back as the form the map records ("Acme" as "Acme Corp").
    org: [{ canonical: "Acme Corp", aliases: [], parts: [] }],
  },
  patterns: PATTERNS,
  questions: [],
};

/** Each unit (a paragraph's text, its instructions, a single value) as one text, and every whole value. */
function docxText(bytes: Uint8Array): { units: string[]; wholes: string[] } {
  const plan = planDocx(bytes, "keep");
  return {
    units: plan.units.map((u) => u.items.map((i) => ("node" in i ? `${i.node.role}:${i.node.value}` : i.sep)).join("")),
    wholes: plan.wholes.map((n) => n.value),
  };
}
/** Members, paragraphs, runs and run properties per member. */
const docxShape = (bytes: Uint8Array) =>
  [...members(bytes)].map(([name, xml]) => ({ name, paragraphs: count(xml, /<w:p[\s>/]/g), runs: count(xml, /<w:r[\s>/]/g), rPr: xml.match(/<w:rPr>.*?<\/w:rPr>/g) ?? [], rsid: count(xml, /w:rsidR="[0-9A-F]{8}"/g) }));

describe("DOCX reveal", () => {
  const original = buildZip(DOCX_ENTRIES);
  const r = blind("contract.docx", original, DOCX_SPEC);
  const blinded = output(r);
  const rv = new Revealer(r.map);
  const back = revealFile("contract.docx", blinded, rv);
  const strip = (units: string[]) => units.map((u) => u.replace(/(plain|ins|del):/g, ""));

  test("round trip: every paragraph, instruction and metadata value reads as it did, and the structure is unchanged", () => {
    const before = [...members(blinded).values()].join("");
    for (const s of ["Dana", "Pell", "Acme Corp", "Jo Sample", "Robin", "Northwind", "192.0.2.10"]) expect(before).not.toContain(s);
    const a = docxText(original);
    const b = docxText(back.bytes);
    // Text may sit in different runs (blinding put a split name in its first run), never in a different place.
    expect(strip(b.units)).toEqual(strip(a.units));
    expect(b.wholes).toEqual(a.wholes);
    expect(docxShape(back.bytes)).toEqual(docxShape(original));
  });

  test("tracked changes: inserted and deleted text come back in their own revisions", () => {
    const doc = members(back.bytes).get("word/document.xml") as string;
    expect(doc).toContain('<w:delText>Jo Sample</w:delText>');
    expect(doc).toMatch(/<w:ins [^>]*w:author="Robin Example"[^>]*><w:r w:rsidR="[0-9A-F]{8}"><w:t>Dana Pell<\/w:t>/);
  });

  test("values replaced whole come back from the map: authors, initials, creator, manager, company", () => {
    const m = members(back.bytes);
    expect(m.get("word/comments.xml")).toContain('w:author="Robin Example" w:initials="RE"');
    expect(m.get("docProps/core.xml")).toContain("<dc:creator>Robin Example</dc:creator><cp:lastModifiedBy>Jo Sample</cp:lastModifiedBy>");
    expect(m.get("docProps/app.xml")).toContain("<Company>Northwind Example</Company><Manager>Jo Sample</Manager>");
  });

  test("a pseudonym split across runs is restored in the run where it starts, the formatting kept", () => {
    const dana = pseudonym(r, "Dana Pell");
    const split = edit(blinded, (name, text) =>
      name === "word/comments.xml" ? text.replace(`<w:t xml:space="preserve">Ask ${dana}</w:t>`, `<w:t xml:space="preserve">Ask ${dana.slice(0, 5)}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${dana.slice(5)}</w:t>`) : text,
    );
    expect(members(split).get("word/comments.xml")).not.toContain(dana);
    const c = members(revealFile("contract.docx", split, rv).bytes).get("word/comments.xml") as string;
    expect(c).toContain('<w:t xml:space="preserve">Ask Dana Pell</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t></w:t>');
  });

  test("Office's linking IDs stay as blinding wrote them (AGT-1791): never the original, never reversed", () => {
    const rsids = (b: Uint8Array) => (members(b).get("word/document.xml") as string).match(/w:rsidR="[^"]*"/g) ?? [];
    expect(rsids(back.bytes)).toEqual(rsids(blinded));
    expect(rsids(back.bytes)).toHaveLength(rsids(original).length);
    expect(rsids(back.bytes).some((a) => a.includes("00A1B2C3"))).toBe(false);
  });

  test("fail closed: a part that cannot be read refuses the whole document", () => {
    const broken = edit(blinded, (name, text) => (name === "word/comments.xml" ? text.replace("</w:comments>", "") : text));
    expect(() => revealFile("contract.docx", broken, rv)).toThrow(/cannot read it as DOCX: part word\/comments\.xml cannot be read/);
    expect(() => revealFile("contract.docx", new TextEncoder().encode("PK"), rv)).toThrow(/cannot read it as DOCX/);
  });

  test("a pseudonym that reads differently with tracked changes accepted and rejected refuses the document", () => {
    const m: BlindMap = { version: 1, entries: [entry("person", "a", "Ann Example", "Person_AB12"), entry("person", "b", "Bo Example", "Person_AB12CD")] };
    // Accepted: "Person_AB12" + "CD" reads Person_AB12CD; rejected: "Person_AB12" + "EF" reads Person_AB12 then "EF".
    const body = para(run("Person_AB"), `<w:ins w:id="1" w:author="x">${run("12CD")}</w:ins>`, `<w:del w:id="2" w:author="x">${run("12 EF", "", "w:delText")}</w:del>`);
    const doc = buildZip(DOCX_ENTRIES.map((e) => (e.name === "word/document.xml" ? { ...e, data: `${DECL}<w:document ${W}><w:body>${body}</w:body></w:document>` } : e)));
    expect(() => revealFile("contract.docx", doc, new Revealer(m))).toThrow(/tracked changes/);
  });
});

// ---------------------------------------------------------------- Office linking IDs (AGT-1791)

describe("reveal leaves Office linking IDs as blinding wrote them", () => {
  const ID_SPEC: Spec = {
    version: 1,
    columns: [],
    entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
    patterns: PATTERNS,
    questions: [],
  };
  const attrs = (xml: string): string[] =>
    [...xml.matchAll(/\b(w:rsid\w*|w14:paraId|w14:textId|wp14:anchorId|w:storeItemID|ds:itemID|w1[45]:val|xr:uid|documentId|xr10:uidLastSave|x14:cfRule[^>]* id)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);
  const ids = (bytes: Uint8Array): string[] => [...members(bytes).entries()].sort().flatMap(([n, t]) => attrs(t).map((a) => `${n} ${a}`));

  for (const [path, input] of [
    ["memo.docx", makeZip(docxMembers({ body: "Avery Quill met the team", officeIds: true }))],
    ["book.xlsx", makeZip(xlsxMembers({ body: "Avery Quill", officeIds: true }))],
  ] as const) {
    test(`${path}: the body is restored, every linking ID stays as written`, () => {
      const r = blind(path, input, ID_SPEC);
      const blinded = output(r);
      // The blinded GUIDs are pseudonyms in the map, so reveal could reverse them; it must not.
      expect(r.map.entries.some((e) => e.kind === "id")).toBe(true);
      const back = revealFile(path, blinded, new Revealer(r.map)).bytes;
      expect(ids(blinded).length).toBeGreaterThan(3);
      expect(ids(back)).toEqual(ids(blinded));
      expect([...members(back).values()].join("\n")).toContain("Avery Quill");
      const x14 = (b: Uint8Array) => /<x14:id>([^<]*)</.exec(members(b).get("xl/worksheets/sheet1.xml") ?? "")?.[1];
      expect(x14(back)).toBe(x14(blinded));
    });
  }
});
