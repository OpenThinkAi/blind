import { describe, expect, test } from "bun:test";
import { rewriteOoxml, rewriteXml, ZipError, XmlError, type RewriteRules, defaultRules, localName } from "../../src/formats/ooxml.ts";
import { buildZip, readZip, type FixtureEntry } from "./zipfixture.ts";

// Synthetic OOXML, generated here. Names and hosts are invented.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function docx(body = '<w:p><w:r><w:t xml:space="preserve">Dana Pell </w:t></w:r><w:r><w:t>met Orbit &amp; Co at &#x41;7</w:t></w:r></w:p>'): FixtureEntry[] {
  return [
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>` },
    { name: "_rels/.rels", data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`, method: 0 },
    { name: "word/document.xml", data: `${DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
    { name: "word/media/image1.png", data: PNG, method: 0 },
  ];
}

function xlsx(): FixtureEntry[] {
  return [
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    { name: "xl/workbook.xml", data: `${DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Dana Pell" sheetId="1"/></sheets></workbook>` },
    { name: "xl/sharedStrings.xml", data: `${DECL}<sst count="2" uniqueCount="2"><si><t>Dana Pell</t></si><si><r><t>host01.example.com</t></r></si></sst>`, descriptor: "signed" },
    { name: "xl/worksheets/sheet1.xml", data: `${DECL}<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="str"><f>A1</f><v>Dana Pell</v></c><c r="C1"><v>42</v></c><c r="D1" t="inlineStr"><is><t>Orbit Co</t></is></c></row></sheetData></worksheet>`, descriptor: "unsigned" },
    { name: "docProps/thumbnail.bin", data: PNG },
  ];
}

const upper = (v: string) => v.toUpperCase();

describe("rewriteOoxml", () => {
  test("a no-op rewrite gives a byte-identical docx and xlsx", () => {
    for (const entries of [docx(), xlsx()]) {
      const input = buildZip(entries);
      const seen: string[] = [];
      const r = rewriteOoxml(input, (v, ctx) => (seen.push(`${ctx.member}|${ctx.element.name}|${v}`), v));
      expect(Buffer.from(r.bytes).equals(Buffer.from(input))).toBe(true);
      expect(r.members.every((m) => m.kind !== "error")).toBe(true);
      expect(seen.length).toBeGreaterThan(0);
    }
  });

  test("offers <t> in any namespace and <v> on formula-string cells only, in document order", () => {
    const seen: string[] = [];
    rewriteOoxml(buildZip(xlsx()), (v, ctx) => (seen.push(`${ctx.member}:${ctx.element.name}:${v}`), v));
    expect(seen).toEqual([
      "xl/sharedStrings.xml:t:Dana Pell",
      "xl/sharedStrings.xml:t:host01.example.com",
      "xl/worksheets/sheet1.xml:v:Dana Pell",
      "xl/worksheets/sheet1.xml:t:Orbit Co",
    ]);
  });

  test("rewrites text, keeps member order, methods, timestamps and non-XML members", () => {
    const input = buildZip(xlsx());
    const r = rewriteOoxml(input, upper);
    const before = readZip(input);
    const after = readZip(r.bytes);
    expect(after.map((e) => [e.name, e.method, e.time, e.date])).toEqual(before.map((e) => [e.name, e.method, e.time, e.date]));
    const text = (name: string) => after.find((e) => e.name === name)!.text;
    expect(text("xl/sharedStrings.xml")).toContain("<si><t>DANA PELL</t></si><si><r><t>HOST01.EXAMPLE.COM</t></r></si>");
    expect(text("xl/worksheets/sheet1.xml")).toContain('<c r="A1" t="s"><v>0</v></c><c r="B1" t="str"><f>A1</f><v>DANA PELL</v></c><c r="C1"><v>42</v></c>');
    expect(text("xl/workbook.xml")).toBe(before.find((e) => e.name === "xl/workbook.xml")!.text);
    expect(text("docProps/thumbnail.bin")).toBe(before.find((e) => e.name === "docProps/thumbnail.bin")!.text);
    expect(r.members).toEqual([
      { name: "[Content_Types].xml", kind: "xml", changed: false },
      { name: "xl/workbook.xml", kind: "xml", changed: false },
      { name: "xl/sharedStrings.xml", kind: "xml", changed: true },
      { name: "xl/worksheets/sheet1.xml", kind: "xml", changed: true },
      { name: "docProps/thumbnail.bin", kind: "other" },
    ]);
    // A second pass reads the rewritten zip, data descriptors included.
    expect(rewriteOoxml(r.bytes, (v) => v).bytes).toEqual(r.bytes);
  });

  test("output is deterministic", () => {
    const input = buildZip(docx());
    expect(Buffer.from(rewriteOoxml(input, upper).bytes).equals(Buffer.from(rewriteOoxml(input, upper).bytes))).toBe(true);
  });

  test("stored members stay stored", () => {
    const entries = docx();
    entries[2]!.method = 0;
    const r = rewriteOoxml(buildZip(entries), upper);
    const doc = readZip(r.bytes).find((e) => e.name === "word/document.xml")!;
    expect(doc.method).toBe(0);
    expect(doc.text).toContain('<w:t xml:space="preserve">DANA PELL </w:t>');
  });

  test("decodes entities for the callback, re-encodes on write, keeps xml:space", () => {
    const seen: string[] = [];
    const r = rewriteOoxml(buildZip(docx()), (v) => (seen.push(v), v.replace("Dana", "<Person_1>")));
    expect(seen).toEqual(["Dana Pell ", "met Orbit & Co at A7"]);
    const doc = readZip(r.bytes).find((e) => e.name === "word/document.xml")!.text;
    expect(doc).toContain('<w:t xml:space="preserve">&lt;Person_1&gt; Pell </w:t>');
    // Unchanged node keeps its original entity spelling.
    expect(doc).toContain("<w:t>met Orbit &amp; Co at &#x41;7</w:t>");
  });

  test("a malformed member is reported and left untouched; the others are still rewritten", () => {
    const entries = docx('<w:p><w:r><w:t>Dana Pell</w:r></w:p>');
    entries.push({ name: "word/footer1.xml", data: `${DECL}<w:ftr><w:t>Dana Pell</w:t></w:ftr>` });
    const input = buildZip(entries);
    const r = rewriteOoxml(input, upper);
    const doc = r.members.find((m) => m.name === "word/document.xml")!;
    expect(doc.kind).toBe("error");
    expect(doc.kind === "error" && doc.error).toMatch(/line 2: <\/w:r> does not match <w:t>/);
    const out = readZip(r.bytes);
    expect(out.find((e) => e.name === "word/document.xml")!.text).toBe(readZip(input).find((e) => e.name === "word/document.xml")!.text);
    expect(out.find((e) => e.name === "word/footer1.xml")!.text).toContain("<w:t>DANA PELL</w:t>");
  });

  test("a CRC mismatch is a member error, not a crash", () => {
    const input = buildZip([{ name: "a.xml", data: "<a><t>x</t></a>", method: 0 }]);
    input[30 + 5 + 6] = "y".charCodeAt(0); // inside the stored data
    const r = rewriteOoxml(input, upper);
    expect(r.members).toEqual([{ name: "a.xml", kind: "error", error: "CRC mismatch" }]);
    expect(r.bytes).toEqual(input);
  });

  test("an unreadable archive throws ZipError", () => {
    expect(() => rewriteOoxml(new TextEncoder().encode("not a zip"), upper)).toThrow(ZipError);
    const z = buildZip([{ name: "a.xml", data: "<a/>" }]);
    const gap = new Uint8Array([0, ...z]); // a byte outside any member
    const v = new DataView(gap.buffer);
    const cd = v.getUint32(gap.length - 6, true) + 1;
    v.setUint32(gap.length - 6, cd, true);
    v.setUint32(cd + 42, 1, true);
    expect(() => rewriteOoxml(gap, upper)).toThrow("unexpected bytes at offset 0, outside any member");
  });
});

describe("rewriteXml", () => {
  const id = (v: string) => v;

  test("normalises line ends in text and encodes CR as a reference", () => {
    const seen: string[] = [];
    expect(rewriteXml("<a><t>x\r\ny&#13;</t></a>", (v) => (seen.push(v), v))).toBe("<a><t>x\r\ny&#13;</t></a>");
    expect(seen).toEqual(["x\ny\r"]);
    expect(rewriteXml("<a><t>x\r\ny&#13;</t></a>", (v) => v + "!")).toBe("<a><t>x\ny&#13;!</t></a>");
  });

  test("CDATA and text inside one element are one value", () => {
    expect(rewriteXml("<a><t>Da<![CDATA[na <P>]]></t></a>", (v) => (expect(v).toBe("Dana <P>"), "x&y"))).toBe("<a><t>x&amp;y</t></a>");
  });

  test("attribute allowlist rewrites only listed attributes, in place", () => {
    const rules: RewriteRules = {
      text: defaultRules.text,
      attribute: (el, name) => localName(el.name) === "sheet" && name === "name",
    };
    const seen: string[] = [];
    const out = rewriteXml(`<s><sheet  name = 'Dana &amp; Pell' r:id="Dana"/></s>`, (v, ctx) => (seen.push(`${ctx.attribute}=${v}`), `O'Co "x"`), rules);
    expect(seen).toEqual(["name=Dana & Pell"]);
    expect(out).toBe(`<s><sheet  name = 'O&apos;Co &quot;x&quot;' r:id="Dana"/></s>`);
    expect(rewriteXml(`<s><sheet name="a&#10;b"/></s>`, id, rules)).toBe(`<s><sheet name="a&#10;b"/></s>`);
  });

  test("empty and self-closing text elements are not offered", () => {
    const seen: string[] = [];
    rewriteXml("<a><t/><t></t></a>", (v) => (seen.push(v), v));
    expect(seen).toEqual([]);
  });

  test("text outside selected elements is not offered", () => {
    const seen: string[] = [];
    rewriteXml("<a>Dana<b>Pell</b><v>1</v></a>", (v) => (seen.push(v), v));
    expect(seen).toEqual([]);
  });

  test("keeps comments, processing instructions and a BOM byte for byte", () => {
    const xml = '﻿<?xml version="1.0"?><!-- c --><a><?pi x?><t>v</t></a>\r\n';
    expect(rewriteXml(xml, id)).toBe(xml);
  });

  for (const [why, xml, msg] of [
    ["unbalanced", "<a><b></a>", /<\/a> does not match <b>/],
    ["unclosed", "<a><b/>", /<a> is never closed/],
    ["bad entity", "<a>&nbsp;</a>", /unknown entity/],
    ["bare ampersand", "<a>x & y</a>", /bare "&"/],
    ["invalid char ref", "<a>&#0;</a>", /invalid code point/],
    ["DTD", '<!DOCTYPE a [<!ENTITY e "x">]><a/>', /DTD/],
    ["markup in text element", "<a><t>x<b/>y</t></a>", /markup inside <t>/],
    ["comment in text element", "<a><t>x<!-- -->y</t></a>", /markup inside <t>/],
    ["unquoted attribute", "<a b=c/>", /not quoted/],
    ["lt in attribute", '<a b="<"/>', /"<" inside an attribute/],
    ["duplicate attribute", '<a b="1" b="2"/>', /duplicate attribute/],
    ["unterminated comment", "<a><!-- x</a>", /unterminated comment/],
    ["two roots", "<a/><b/>", /second root/],
    ["text after root", "<a/>x", /outside the root/],
    ["UTF-16 declared", '<?xml version="1.0" encoding="UTF-16"?><a/>', /unsupported encoding/],
    ["no root", "  ", /no root element/],
  ] as const) {
    test(`rejects ${why}`, () => {
      expect(() => rewriteXml(xml, id)).toThrow(XmlError);
      expect(() => rewriteXml(xml, id)).toThrow(msg);
    });
  }

  test("refuses a rewrite that XML cannot carry", () => {
    expect(() => rewriteXml("<a><t>x</t></a>", () => "\u0001")).toThrow(/cannot represent/);
  });
});
