import { describe, expect, test } from "bun:test";
import { ApplyError, type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { renderReport } from "../../src/apply.ts";
import type { Spec } from "../../src/schema.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";

// A generated DOCX. Every name, company and address is invented; hosts are example.com.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS = `${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const r = (text: string, rPr = "", tag = "w:t") => `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<${tag}${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""}>${text}</${tag}></w:r>`;
const p = (...runs: string[]) => `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>${runs.join("")}</w:p>`;

const BODY = [
  // 0: a name split across differently formatted runs.
  p(r("Contract with "), r("Ac", "<w:b/>"), r("me Corp", "<w:i/>"), r(" signed by Dana Pell.")),
  // 1: a table cell.
  `<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/>${p(r("Dana Pell", "<w:u w:val=\"single\"/>"))}</w:tc><w:tc>${p(r("Acmeville office"))}</w:tc></w:tr></w:tbl>`,
  // 2: tracked changes, with authors.
  p(
    r("Owner: "),
    `<w:del w:id="1" w:author="Robin Example" w:date="2026-01-02T00:00:00Z">${r("Jo Sample", "", "w:delText")}</w:del>`,
    `<w:ins w:id="2" w:author="Robin Example" w:date="2026-01-02T00:00:00Z">${r("Dana Pell")}</w:ins>`,
  ),
  // 3: a field whose instruction is split across runs.
  p(
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
    r(' HYPERLINK "mailto:dana.p', "", "w:instrText"),
    r('ell@example.com" ', "", "w:instrText"),
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    r("write to us"),
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ),
  // 4: a tab between runs separates words: "Acme" stays a whole word.
  p(r("Acme"), "<w:r><w:tab/></w:r>", r("Corporate travel")),
  // 5: a split that leaves leading whitespace in a run without xml:space.
  p(r("Dana P"), r("ell said hello")),
  // 6: a drawing's name and alt text.
  p(`<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Dana Pell headshot" descr="Photo of Dana Pell"/></wp:inline></w:drawing></w:r>`),
  // 7: a simple field.
  `<w:p><w:fldSimple w:instr=" AUTHOR Dana Pell "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>`,
].join("");

function entries(over: { body?: string; extra?: FixtureEntry[] } = {}): FixtureEntry[] {
  return [
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>` },
    { name: "_rels/.rels", data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    {
      name: "word/_rels/document.xml.rels",
      data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:dana.pell@example.com" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>`,
    },
    { name: "word/document.xml", data: `${DECL}<w:document ${NS}><w:body>${over.body ?? BODY}<w:sectPr/></w:body></w:document>` },
    { name: "word/header1.xml", data: `${DECL}<w:hdr ${W}>${p(r("Prepared for "), r("Acme", "<w:b/>"), r(" Corp"))}</w:hdr>` },
    { name: "word/footer1.xml", data: `${DECL}<w:ftr ${W}>${p(r("Dana Pell, confidential"))}</w:ftr>` },
    { name: "word/footnotes.xml", data: `${DECL}<w:footnotes ${W}><w:footnote w:id="1">${p('<w:r><w:footnoteRef/></w:r>', r(" Per Dana"), r(" Pell."))}</w:footnote></w:footnotes>` },
    { name: "word/endnotes.xml", data: `${DECL}<w:endnotes ${W}><w:endnote w:id="1">${p(r("Source: Acme Corp"))}</w:endnote></w:endnotes>` },
    {
      name: "word/comments.xml",
      data: `${DECL}<w:comments ${W}><w:comment w:id="0" w:author="Robin Example" w:initials="RE" w:date="2026-01-02T00:00:00Z">${p(r("Ask Dana "), r("Pell first"))}</w:comment></w:comments>`,
    },
    {
      name: "word/people.xml",
      data: `${DECL}<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Robin Example"><w15:presenceInfo w15:providerId="AD" w15:userId="S::robin@example.com::0000"/></w15:person></w15:people>`,
    },
    {
      name: "docProps/core.xml",
      data: `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Acme Corp contract</dc:title><dc:creator>Robin Example</dc:creator><cp:lastModifiedBy>Jo Sample</cp:lastModifiedBy><cp:keywords>acme corp, renewal</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`,
    },
    {
      name: "docProps/app.xml",
      data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Template>Normal.dotm</Template><Company>Northwind Example</Company><Manager>Jo Sample</Manager><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Acme Corp contract</vt:lpstr></vt:vector></TitlesOfParts></Properties>`,
    },
    {
      name: "docProps/custom.xml",
      data: `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Reviewer Dana Pell"><vt:lpwstr>Acme Corp</vt:lpwstr></property></Properties>`,
    },
    { name: "word/media/image1.png", data: PNG, method: 0 },
    ...(over.extra ?? []),
  ];
}

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: {
    person: [
      { canonical: "Dana Pell", aliases: [], parts: ["Dana", "Pell"] },
      { canonical: "Jo Sample", aliases: [], parts: [] },
    ],
    org: [{ canonical: "Acme Corp", aliases: ["Acme"], parts: [] }],
  },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const SENSITIVE = ["Dana", "Pell", "Acme", "Jo Sample", "Robin", "Northwind", "robin@example.com", "dana.pell", "ell@example.com", "RE\""];

const docx = (e: FixtureEntry[] = entries()): InputFile => ({ path: "contract.docx", bytes: buildZip(e) });
const run = (input: InputFile = docx(), spec: Spec = SPEC) => applySpec([input], spec, { salt: SALT });
const parts = (res: ApplyResult): Map<string, string> => {
  const out = res.outputs[0];
  if (out === undefined) throw new Error("no output");
  return new Map(readZip(out.bytes).map((e) => [e.name, e.text]));
};
const pseudo = (res: ApplyResult, kind: string, value: string): string => {
  const e = res.map.entries.find((x) => x.kind === kind && x.value.toLowerCase() === value.toLowerCase());
  if (e === undefined) throw new Error(`no pseudonym for ${kind} ${value}`);
  return e.pseudonym;
};

// An independent reading of WordprocessingML for the round-trip check: well-formed tags, and the
// paragraphs, runs and run properties in document order.
function shape(xml: string): { paragraphs: number; runs: number; rPr: string[]; text: string } {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
    const [, close, name, , self] = m as unknown as [string, string, string, string, string];
    if (close) {
      if (stack.pop() !== name) throw new Error(`unbalanced </${name}>`);
    } else if (!self) stack.push(name);
  }
  if (stack.length !== 0) throw new Error("unclosed elements");
  return {
    paragraphs: (xml.match(/<w:p[\s>/]/g) ?? []).length,
    runs: (xml.match(/<w:r[\s>/]/g) ?? []).length,
    rPr: xml.match(/<w:rPr>.*?<\/w:rPr>/g) ?? [],
    text: [...xml.matchAll(/<w:(?:t|delText|instrText)(?:\s[^>]*)?>([^<]*)</g)].map((m) => m[1]).join("|"),
  };
}

describe("DOCX: text across runs (AC1)", () => {
  const res = run();
  const doc = parts(res).get("word/document.xml") as string;
  const acme = pseudo(res, "org", "Acme Corp");
  const dana = pseudo(res, "person", "Dana Pell");

  test("a name split across runs is replaced, its pseudonym in the first run and its formatting kept", () => {
    expect(doc).toContain(`<w:r><w:rPr><w:b/></w:rPr><w:t>${acme}</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t></w:t></w:r>`);
    expect(doc).toContain(`signed by ${dana}.`);
  });

  test("a removal that exposes leading whitespace marks the run xml:space=\"preserve\"", () => {
    expect(doc).toContain(`<w:r><w:t>${dana}</w:t></w:r><w:r><w:t xml:space="preserve"> said hello</w:t></w:r>`);
  });

  test("a tab between runs separates words; a longer word is left alone", () => {
    expect(doc).toContain(`<w:t>${acme}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Corporate travel</w:t>`);
    expect(doc).toContain("<w:t>Acmeville office</w:t>");
  });

  test("tables are rewritten", () => {
    expect(doc).toContain(`<w:u w:val="single"/></w:rPr><w:t>${dana}</w:t>`);
  });

  test("field instructions split across runs are matched, apart from the visible text", () => {
    const instr = [...doc.matchAll(/<w:instrText[^>]*>([^<]*)</g)].map((m) => m[1]).join("");
    expect(instr).not.toContain("dana.pell@example.com");
    expect(instr).toMatch(/^ HYPERLINK "mailto:[^"]+@[^"]+" $/);
    expect(doc).toContain("<w:t>write to us</w:t>");
    expect(doc).not.toContain('w:instr=" AUTHOR Dana Pell "');
    expect(doc).toContain(`w:instr=" AUTHOR ${dana} "`);
  });

  test("drawing names and alt text are free text", () => {
    expect(doc).toContain(`name="${dana} headshot" descr="Photo of ${dana}"`);
  });
});

describe("DOCX: every location (AC2, AC4)", () => {
  const res = run();
  const out = parts(res);
  const acme = pseudo(res, "org", "Acme Corp");
  const dana = pseudo(res, "person", "Dana Pell");
  const robin = pseudo(res, "person", "Robin Example");
  const jo = pseudo(res, "person", "Jo Sample");

  test("tracked changes: deleted text, inserted text and revision authors", () => {
    const doc = out.get("word/document.xml") as string;
    expect(doc).toContain(`<w:del w:id="1" w:author="${robin}"`);
    expect(doc).toContain(`<w:ins w:id="2" w:author="${robin}"`);
    expect(doc).toContain(`<w:delText>${jo}</w:delText>`);
    expect(doc).toMatch(new RegExp(`<w:ins [^>]*><w:r><w:t>${dana}</w:t>`));
  });

  test("headers, footers, footnotes and endnotes", () => {
    expect(out.get("word/header1.xml")).toContain(`<w:rPr><w:b/></w:rPr><w:t>${acme}</w:t></w:r><w:r><w:t xml:space="preserve"></w:t></w:r>`);
    expect(out.get("word/footer1.xml")).toContain(`${dana}, confidential`);
    expect(out.get("word/footnotes.xml")).toContain(`<w:t xml:space="preserve"> Per ${dana}</w:t></w:r><w:r><w:t xml:space="preserve">.</w:t>`);
    expect(out.get("word/endnotes.xml")).toContain(`Source: ${acme}`);
  });

  test("comments: text and the author and initials attributes", () => {
    const c = out.get("word/comments.xml") as string;
    expect(c).toContain(`w:author="${robin}"`);
    expect(c).not.toContain('w:initials="RE"');
    expect(c).toMatch(/w:initials="Person_[0-9A-F]{4}"/);
    expect(c).toContain(`Ask ${dana}`);
  });

  test("people: author and presence user ID", () => {
    const people = out.get("word/people.xml") as string;
    expect(people).toContain(`w15:author="${robin}"`);
    expect(people).toMatch(/w15:userId="Id_[0-9A-F]{4}"/);
    expect(people).toContain('w15:providerId="AD"');
  });

  test("docProps core, app and custom", () => {
    const core = out.get("docProps/core.xml") as string;
    expect(core).toContain(`<dc:title>${acme} contract</dc:title>`);
    expect(core).toContain(`<dc:creator>${robin}</dc:creator>`);
    expect(core).toContain(`<cp:lastModifiedBy>${jo}</cp:lastModifiedBy>`);
    expect(core).toContain(`<cp:keywords>${acme}, renewal</cp:keywords>`);
    expect(core).toContain("2026-01-01T00:00:00Z");
    const app = out.get("docProps/app.xml") as string;
    expect(app).toContain("<Template>Normal.dotm</Template>");
    expect(app).toMatch(/<Company>Org_[0-9A-F]{4}<\/Company>/);
    expect(app).toContain(`<Manager>${jo}</Manager>`);
    expect(app).toContain(`<vt:lpstr>${acme} contract</vt:lpstr>`);
    const custom = out.get("docProps/custom.xml") as string;
    expect(custom).toContain(`name="Reviewer ${dana}"`);
    expect(custom).toContain(`<vt:lpwstr>${acme}</vt:lpwstr>`);
  });

  test("external hyperlink targets; internal targets are untouched", () => {
    const rels = out.get("word/_rels/document.xml.rels") as string;
    expect(rels).not.toContain("dana.pell@example.com");
    expect(rels).toMatch(/Target="mailto:[^"]+@[^"]+" TargetMode="External"/);
    expect(rels).toContain('Target="header1.xml"');
  });

  test("no sensitive value survives in any part", () => {
    for (const [name, text] of out) {
      if (name.endsWith(".png")) continue;
      for (const s of SENSITIVE) expect({ name, found: text.replaceAll("Acmeville", "").includes(s) }).toEqual({ name, found: false });
    }
  });

  test("the report counts the replacements and lists the replaced image", () => {
    const f = res.files[0]!;
    expect(f.format).toBe("docx");
    expect(f.changed).toBe(true);
    expect(f.entityReplacements).toBeGreaterThan(10);
    expect(f.patternReplacements).toBe(2);
    expect(f.metadataReplacements).toBe(10);
    const report = renderReport(res);
    expect(report).toContain("contract.docx (docx, utf8)");
    expect(report).toContain("metadata: 10 author, creator, company or account-name values replaced");
    expect(report).toContain("warning: 1 image replaced with placeholders (images are not blinded; set [images] keep = true to keep them)");
    expect(res.skipped).toEqual([]);
  });
});

describe("DOCX: round trip (AC3)", () => {
  const input = docx();
  const res = run(input);
  const before = new Map(readZip(input.bytes).map((e) => [e.name, e]));
  const after = readZip(res.outputs[0]!.bytes);

  test("same members in the same order, with the same compression and timestamps; the image keeps its part name and is replaced by a placeholder (see images.test.ts)", () => {
    expect(after.map((e) => [e.name, e.method, e.time, e.date])).toEqual([...before.values()].map((e) => [e.name, e.method, e.time, e.date]));
    expect(after.find((e) => e.name === "word/media/image1.png")!.text).not.toBe(before.get("word/media/image1.png")!.text);
  });

  test("every Word part is well formed, with paragraph count, run count and run formatting unchanged", () => {
    for (const e of after) {
      if (!e.name.startsWith("word/") || !e.name.endsWith(".xml")) continue;
      const a = shape(e.text);
      const b = shape(before.get(e.name)!.text);
      expect({ name: e.name, paragraphs: a.paragraphs, runs: a.runs, rPr: a.rPr }).toEqual({ name: e.name, paragraphs: b.paragraphs, runs: b.runs, rPr: b.rPr });
    }
    expect(shape(after.find((e) => e.name === "word/document.xml")!.text).paragraphs).toBe(9);
  });

  test("output is deterministic and a second pass changes nothing more", () => {
    expect(Buffer.from(run(docx()).outputs[0]!.bytes).equals(Buffer.from(res.outputs[0]!.bytes))).toBe(true);
    const again = applySpec([{ path: "contract.docx", bytes: res.outputs[0]!.bytes }], SPEC, { salt: SALT, map: res.map });
    expect(again.files[0]!.entityReplacements).toBe(0);
  });

  test("a document with nothing to blind is written byte for byte", () => {
    const plain = docx(entries({ body: p(r("Nothing to see here.")) }).filter((e) => !e.name.startsWith("docProps/") && e.name !== "word/people.xml" && e.name !== "word/comments.xml" && e.name !== "word/_rels/document.xml.rels"));
    const empty: Spec = { ...SPEC, entities: {} };
    // The footer names a person in prose (AGT-1830); the keep list keeps her, so nothing changes.
    // Images are kept here: the default would replace the fixture's picture, which is a change.
    const rr = applySpec([plain], empty, { salt: SALT, keep: ["Dana Pell"], images: "keep" });
    const doc = shape(readZip(rr.outputs[0]!.bytes).find((e) => e.name === "word/footer1.xml")!.text);
    expect(doc.text).toBe("Dana Pell, confidential");
    expect(rr.files[0]!.changed).toBe(false);
    expect(Buffer.from(rr.outputs[0]!.bytes).equals(Buffer.from(plain.bytes))).toBe(true);
  });
});

describe("DOCX: tracked changes read both ways", () => {
  test("a name completed by an insertion is matched in the accepted reading; the rejected reading leaks nothing either", () => {
    const body = p(r("Dana "), `<w:del w:id="1" w:author="Jo Sample">${r("Smith", "", "w:delText")}</w:del>`, `<w:ins w:id="2" w:author="Jo Sample">${r("Pell")}</w:ins>`, r(" agreed"));
    const res = run(docx(entries({ body })));
    const doc = parts(res).get("word/document.xml") as string;
    const dana = pseudo(res, "person", "Dana Pell");
    // Accepted: "Dana Pell agreed". The pseudonym sits in the inserted run, the plain "Dana " is removed.
    const accepted = shape(doc.replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")).text.replaceAll("|", "");
    expect(accepted).toBe(`${dana} agreed`);
    // Rejected: "Dana Smith agreed". "Dana" is a part; its text is already removed by the accepted
    // match, so no second pseudonym is inserted into the shared run (that would read twice when accepted).
    const rejected = shape(doc.replace(/<w:ins\b[\s\S]*?<\/w:ins>/g, "")).text.replaceAll("|", "");
    expect(rejected).toBe("Smith agreed");
  });
});

describe("DOCX: fail closed", () => {
  const skippedReason = (res: ApplyResult) => {
    expect(res.outputs).toEqual([]);
    expect(res.skipped.length).toBe(1);
    return res.skipped[0]!.reason;
  };

  test("a part that cannot be parsed: the file is not written, the part is named", () => {
    const e = entries();
    e[4] = { name: "word/header1.xml", data: `${DECL}<w:hdr ${W}><w:p><w:r><w:t>Dana Pell</w:r></w:p></w:hdr>` };
    expect(skippedReason(run(docx(e)))).toMatch(/^part word\/header1\.xml cannot be read \(line 2: .*\); not written$/);
  });

  test("a corrupt member (CRC mismatch) is not processed", () => {
    const bytes = buildZip([{ name: "word/document.xml", data: `<w:document ${W}><w:body/></w:document>`, method: 0 }]);
    bytes[30 + "word/document.xml".length + 5]! ^= 1;
    expect(skippedReason(run({ path: "contract.docx", bytes }))).toBe("part word/document.xml cannot be read (CRC mismatch); not written");
  });

  test("not a zip", () => {
    expect(skippedReason(run({ path: "contract.docx", bytes: Buffer.from("Dana Pell") }))).toMatch(/^not a readable DOCX package \(.*\); not written$/);
  });

  test("an embedded file", () => {
    const e = entries({ extra: [{ name: "word/embeddings/oleObject1.bin", data: "Dana Pell" }] });
    expect(skippedReason(run(docx(e)))).toBe("embedded file word/embeddings/oleObject1.bin cannot be blinded inside a DOCX; not written");
  });

  test("a package thumbnail is a picture of the original, so the document is not written", () => {
    const e = entries({ extra: [{ name: "docProps/thumbnail.jpeg", data: "\xff\xd8\xff" }] });
    expect(skippedReason(run(docx(e)))).toBe(
      "docProps/thumbnail.jpeg is a picture of the original document and cannot be blinded; save the file without a thumbnail; not written",
    );
  });

  const CUSTOM_REASON = (part: string) => `custom XML part ${part} holds data blind cannot confirm it blinded; remove the part or save without it; not written`;

  test("a custom XML data part with text or attribute values is refused, naming the part and not the value (AGT-1840)", () => {
    const item = (xml: string) => entries({ extra: [{ name: "customXml/item1.xml", data: `${DECL}${xml}` }] });
    const repro = '<crm><contact name="Dana Example" email="dana@example.com" host="crm01.example.net" acct="AC-55501"/></crm>';
    for (const xml of [repro, '<props xmlns="urn:example:props"><client>Dana Pell</client></props>', '<props xmlns="urn:example:props"><client name="Dana Pell"/></props>', "<r><![CDATA[x]]></r>"]) {
      const res = run(docx(item(xml)));
      expect(skippedReason(res)).toBe(CUSTOM_REASON("customXml/item1.xml"));
      expect(skippedReason(res)).not.toMatch(/Dana|example/);
    }
  });

  test("empty or structural custom XML parts Word writes are not refused (AGT-1840)", () => {
    const BIB = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
    const parts = [
      `<b:Sources SelectedStyle="\\APA.XSL" StyleName="APA" xmlns:b="${BIB}" xmlns="${BIB}"/>`,
      '<CoverPageProperties xmlns="http://schemas.microsoft.com/office/2006/coverPageProps"><PublishDate/><Abstract/><CompanyAddress></CompanyAddress></CoverPageProperties>',
      '<p:properties xmlns:p="http://schemas.microsoft.com/office/2006/metadata/properties" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><documentManagement><Title xsi:nil="true"/></documentManagement></p:properties>',
      '<ct:contentTypeSchema xmlns:ct="http://schemas.microsoft.com/office/2006/metadata/contentType" xmlns:ma="http://schemas.microsoft.com/office/2006/metadata/properties/metaAttributes" ct:_="" ma:_="" ma:contentTypeName="Document" ma:contentTypeID="0x0101"/>',
      '<crm><contact name="" email=" "/></crm>',
    ];
    for (const xml of parts) {
      const res = run(docx(entries({ extra: [{ name: "customXml/item1.xml", data: `${DECL}${xml}` }] })));
      expect(res.skipped).toEqual([]);
    }
  });

  test("a bibliography part that lists a source is refused (AGT-1840)", () => {
    const BIB = "http://schemas.openxmlformats.org/officeDocument/2006/bibliography";
    const data = `${DECL}<b:Sources xmlns:b="${BIB}"><b:Source><b:Tag>x</b:Tag></b:Source></b:Sources>`;
    expect(skippedReason(run(docx(entries({ extra: [{ name: "customXml/item1.xml", data }] }))))).toBe(CUSTOM_REASON("customXml/item1.xml"));
  });

  test("a host, email or address in a part nothing rewrites stops the document, naming the part and not the value (AGT-1810)", () => {
    const itemProps = (uri: string, attr = "ds:ref") =>
      `${DECL}<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{3F2504E0-4F89-11D3-9A0C-0305E82C3301}"><ds:schemaRefs><ds:schemaRef ${attr}="${uri}"/></ds:schemaRefs></ds:datastoreItem>`;
    for (const value of ["Server=db01.example.com;Uid=pat.doe@example.com", "192.0.2.55"]) {
      const reason = skippedReason(run(docx(entries({ extra: [{ name: "customXml/itemProps1.xml", data: itemProps(value) }] }))));
      expect(reason).toMatch(/customXml\/itemProps1\.xml <ds:schemaRef> attribute ds:ref/);
      expect(reason).not.toMatch(/db01|pat\.doe|192\.0/);
    }
    // The format's own ids and URIs are structure, not hits.
    expect(run(docx(entries({ extra: [{ name: "customXml/itemProps2.xml", data: itemProps("urn:example:schema") }] }))).skipped).toEqual([]);
  });

  test("a Word bibliography part (schemaRef uri with the OOXML host) is blinded, not refused (AGT-1819)", () => {
    const item = { name: "customXml/itemProps3.xml", data: `${DECL}<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{3F2504E0-4F89-11D3-9A0C-0305E82C3301}"><ds:schemaRefs><ds:schemaRef ds:uri="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/></ds:schemaRefs></ds:datastoreItem>` };
    const res = run(docx(entries({ extra: [item] })));
    expect(res.skipped).toEqual([]);
    expect(parts(res).get("customXml/itemProps3.xml")).toContain("officeDocument/2006/bibliography");
  });

  test("a column rule naming a DOCX file is refused", () => {
    const spec: Spec = { ...SPEC, columns: [{ file: "contract.docx", header: "Name", class: "person", treatment: "blind", confidence: 1, source: "human" }] };
    expect(() => run(docx(), spec)).toThrow(ApplyError);
  });
});

describe("DOCX: recurring values from other files", () => {
  test("a value a CSV column blinded is replaced in a DOCX paragraph, even split across runs", () => {
    const csv: InputFile = { path: "staff.csv", bytes: Buffer.from("Owner,Status\nKestrel Vantwerp,open\nMarlo Quist,closed\n") };
    const spec: Spec = {
      ...SPEC,
      entities: {},
      columns: [{ file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" }],
    };
    const body = p(r("Escalate to "), r("Kes", "<w:b/>"), r("trel Vant", "<w:i/>"), r("werp today."));
    const res = applySpec([csv, docx(entries({ body }))], spec, { salt: SALT });
    const kestrel = pseudo(res, "person", "Kestrel Vantwerp");
    const out = res.outputs.find((o) => o.path === "contract.docx")!;
    const doc = readZip(out.bytes).find((e) => e.name === "word/document.xml")!.text;
    expect(doc).not.toContain("Kes");
    expect(doc).toContain(`<w:rPr><w:b/></w:rPr><w:t>${kestrel}</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t></w:t></w:r><w:r><w:t xml:space="preserve"> today.</w:t>`);
    expect(Buffer.from(res.outputs.find((o) => o.path === "staff.csv")!.bytes).toString()).toContain(kestrel);
    expect(res.files.find((f) => f.path === "contract.docx")!.mappedReplacements).toBe(1);
  });
});
