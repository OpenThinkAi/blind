import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import { revealFile, Revealer } from "../../src/engine/reveal.ts";
import { auditTree } from "../../src/audit/mechanical.ts";
import { accountSegments, replaceAccounts } from "../../src/formats/paths.ts";
import { classify } from "../../src/formats/xlsx.ts";
import type { Frame } from "../../src/formats/ooxml.ts";
import type { Spec } from "../../src/schema.ts";
import { workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";

// Author metadata and account names in Office paths (AGT-1809). Synthetic only: invented names and
// account names, example.com hosts.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const CORE_NS =
  'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
const APP_NS = 'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"';

/** No spec entity names any of these: they survive only if blind misses them. */
const AUTHORS = ["Wren Halloway", "Tobin Marsh", "Ilsa Fenwick", "Corvid Analytics", "Pell Brightwater", "wren.h@example.com"];
const ACCOUNTS = ["whalloway", "tmarsh", "ifenwick", "pbright"];

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [], org: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const members = (bytes: Uint8Array): Map<string, string> => new Map(readZip(bytes).map((e) => [e.name, e.text]));
const output = (r: ApplyResult): Uint8Array => {
  expect(r.skipped).toEqual([]);
  return (r.outputs[0] as { bytes: Uint8Array }).bytes;
};
const allText = (bytes: Uint8Array): string => [...members(bytes).values()].join("\n");
const pseudonymOf = (r: ApplyResult, value: string): string => {
  const e = r.map.entries.find((x) => x.value === value);
  if (e === undefined) throw new Error(`no pseudonym for ${value}`);
  return e.pseudonym;
};

describe("account names in paths", () => {
  test("the user folder at a path's root, in every form Office writes", () => {
    const seg = (v: string) => accountSegments(v).map((s) => s.value);
    expect(seg("C:\\Users\\whalloway\\Documents\\")).toEqual(["whalloway"]);
    expect(seg("file:///C:/Users/tmarsh/Book2.xlsx")).toEqual(["tmarsh"]);
    expect(seg("file:///C:\\Users\\tmarsh\\Book2.xlsx")).toEqual(["tmarsh"]);
    expect(seg("file://files.example.com/Users/ifenwick/a.docx")).toEqual(["ifenwick"]);
    expect(seg("\\\\files.example.com\\Users\\ifenwick\\a.docx")).toEqual(["ifenwick"]);
    expect(seg("/Users/pbright/Library/Group Containers/x.dotm")).toEqual(["pbright"]);
    expect(seg("/home/pbright/templates/x.dotx")).toEqual(["pbright"]);
    expect(seg("../../Users/pbright/Desktop/x.xlsx")).toEqual(["pbright"]);
    expect(seg("C:\\Documents and Settings\\Wren Halloway\\x.dot")).toEqual(["Wren Halloway"]);
    expect(seg(" C:\\Users\\whalloway ")).toEqual(["whalloway"]);
  });

  test("not a user folder: deeper in the path, shared folders, URLs, bare names", () => {
    for (const v of ["/var/lib/app/home/svc-sync", "C:\\Users\\Public\\x.xlsx", "C:\\Users\\Default\\x", "https://example.com/users/wren", "Users/whalloway", "Normal.dotm", "see C:\\Users\\whalloway", ""]) {
      expect(accountSegments(v)).toEqual([]);
    }
  });

  test("replaceAccounts replaces the segment and hands every other piece to `other`", () => {
    expect(replaceAccounts("C:\\Users\\tmarsh\\Notes", (s) => `<${s}>`, (s) => s.toUpperCase())).toBe("C:\\USERS\\<tmarsh>\\NOTES");
    expect(replaceAccounts("Normal.dotm", () => "x", (s) => `[${s}]`)).toBe("[Normal.dotm]");
  });
});

// ---------------------------------------------------------------- XLSX

const frame = (name: string, attrs: Record<string, string> = {}): Frame => ({ name, attrs: new Map(Object.entries(attrs)) });

describe("XLSX classify: whole metadata and paths", () => {
  test("authors, people and company are replaced whole; paths are paths", () => {
    const core = [frame("cp:coreProperties")];
    expect(classify("docProps/core.xml", frame("dc:creator"), core)).toBe("whole");
    expect(classify("docProps/core.xml", frame("cp:lastModifiedBy"), core)).toBe("whole");
    const app = [frame("Properties")];
    expect(classify("docProps/app.xml", frame("Company"), app)).toBe("whole");
    expect(classify("docProps/app.xml", frame("Manager"), app)).toBe("whole");
    expect(classify("docProps/app.xml", frame("Template"), app)).toBe("path");
    expect(classify("docProps/app.xml", frame("HyperlinkBase"), app)).toBe("path");
    expect(classify("docProps/app.xml", frame("Application"), app)).toBe("text");
    expect(classify("xl/comments1.xml", frame("author"), [frame("comments"), frame("authors")])).toBe("whole");
    expect(classify("xl/persons/person.xml", frame("person"), [frame("personList")], "displayName")).toBe("whole");
    expect(classify("xl/persons/person.xml", frame("person"), [frame("personList")], "userId")).toBe("whole");
    expect(classify("xl/persons/person.xml", frame("person"), [frame("personList")], "providerId")).toBeNull();
    expect(classify("xl/workbook.xml", frame("fileSharing"), [frame("workbook")], "userName")).toBe("whole");
    expect(classify("xl/workbook.xml", frame("x15ac:absPath"), [frame("workbook"), frame("mc:AlternateContent")], "url")).toBe("path");
  });

  test("any other attribute holding a path is a path, but never a part name or an internal target", () => {
    const ws = [frame("worksheet")];
    expect(classify("xl/worksheets/sheet1.xml", frame("oleObject", { link: "C:\\Users\\tmarsh\\x.bin" }), ws, "link")).toBe("path");
    expect(classify("xl/worksheets/sheet1.xml", frame("pageMargins", { left: "0.7" }), ws, "left")).toBeNull();
    const rel = frame("Relationship", { Target: "/Users/tmarsh/x.xml" });
    expect(classify("xl/_rels/workbook.xml.rels", rel, [frame("Relationships")], "Target")).toBeNull();
    const ov = frame("Override", { PartName: "/Users/tmarsh/x.xml" });
    expect(classify("[Content_Types].xml", ov, [frame("Types")], "PartName")).toBeNull();
  });
});

const XLSX_EXTRA: FixtureEntry[] = [
  {
    name: "docProps/core.xml",
    data: `${DECL}<cp:coreProperties ${CORE_NS}><dc:title>Staff list</dc:title><dc:creator>Wren Halloway</dc:creator><cp:lastModifiedBy>Tobin Marsh</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created></cp:coreProperties>`,
  },
  {
    name: "docProps/app.xml",
    data: `${DECL}<Properties ${APP_NS}><Application>Example Sheets</Application><Template>C:\\Users\\whalloway\\AppData\\Roaming\\Templates\\Staff.xltx</Template><Manager>Ilsa Fenwick</Manager><Company>Corvid Analytics</Company><HyperlinkBase>/Users/pbright/Shared/</HyperlinkBase></Properties>`,
  },
  {
    name: "xl/workbook.xml",
    data:
      `${DECL}<workbook xmlns="${MAIN}" xmlns:r="${REL}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" mc:Ignorable="x15ac">` +
      '<fileSharing userName="Pell Brightwater"/>' +
      '<mc:AlternateContent><mc:Choice Requires="x15"><x15ac:absPath url="C:\\Users\\tmarsh\\Documents\\Reports\\"/></mc:Choice></mc:AlternateContent>' +
      '<sheets><sheet name="Staff" sheetId="1" r:id="rId1"/><sheet name="Avery Quill" sheetId="2" r:id="rId2"/><sheet name="Contents" sheetId="3" r:id="rId3"/></sheets>' +
      "<definedNames><definedName name=\"Avery_Total\">'Avery Quill'!$A$2</definedName></definedNames>" +
      '<pivotCaches><pivotCache cacheId="1" r:id="rId5"/></pivotCaches></workbook>',
  },
  {
    name: "xl/_rels/workbook.xml.rels",
    data:
      `${DECL}<Relationships xmlns="${PKG_REL}">` +
      [1, 2, 3].map((n) => `<Relationship Id="rId${n}" Type="${REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`).join("") +
      `<Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rId5" Type="${REL}/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>` +
      `<Relationship Id="rId6" Type="${REL}/externalLinkPath" Target="file:///C:\\Users\\ifenwick\\Budget.xlsx" TargetMode="External"/>` +
      `<Relationship Id="rId7" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/>` +
      "</Relationships>",
  },
  {
    name: "xl/comments1.xml",
    data: `${DECL}<comments xmlns="${MAIN}"><authors><author>Wren Halloway</author><author>tc={6F0E2A10-0000-4000-8000-000000000001}</author></authors><commentList><comment ref="A2" authorId="0"><text><r><t>Ask Sam Placeholder</t></r></text></comment></commentList></comments>`,
  },
  {
    name: "xl/persons/person.xml",
    data: `${DECL}<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments" xmlns:x="${MAIN}"><person displayName="Tobin Marsh" id="{3A5D1C20-0000-4000-8000-000000000002}" userId="wren.h@example.com" providerId="PeoplePicker"/></personList>`,
  },
];

describe("XLSX: author metadata and account names", () => {
  const input = buildZip(workbookEntries({ extra: XLSX_EXTRA }));
  const r = applySpec([{ path: "staff.xlsx", bytes: input }], SPEC, { salt: SALT });
  const out = output(r);
  const text = allText(out);

  test("no author, company, user ID or account name survives, whatever the spec says", () => {
    for (const v of [...AUTHORS, ...ACCOUNTS]) expect(text).not.toContain(v);
  });

  test("authors and managers are persons, the company an org, the user ID an id; account names persons", () => {
    expect(pseudonymOf(r, "Wren Halloway")).toMatch(/^Person_/);
    expect(pseudonymOf(r, "Ilsa Fenwick")).toMatch(/^Person_/);
    expect(pseudonymOf(r, "Corvid Analytics")).toMatch(/^Org_/);
    expect(pseudonymOf(r, "whalloway")).toMatch(/^Person_/);
    const m = members(out);
    expect(m.get("docProps/app.xml")).toContain(`<Template>C:\\Users\\${pseudonymOf(r, "whalloway")}\\AppData\\Roaming\\Templates\\Staff.xltx</Template>`);
    expect(m.get("xl/workbook.xml")).toContain(`url="C:\\Users\\${pseudonymOf(r, "tmarsh")}\\Documents\\Reports\\"`);
    expect(m.get("xl/_rels/workbook.xml.rels")).toContain(`Target="file:///C:\\Users\\${pseudonymOf(r, "ifenwick")}\\Budget.xlsx"`);
    // One comment author per entry; a threaded-comment placeholder author is left to the officeId rule.
    expect(m.get("xl/comments1.xml")).toContain(`<author>${pseudonymOf(r, "Wren Halloway")}</author>`);
    expect((r.files[0] as { metadataReplacements?: number }).metadataReplacements).toBeGreaterThanOrEqual(11);
  });

  test("the audit finds nothing left of them", () => {
    const report = auditTree([{ path: "staff.xlsx", kind: "file", bytes: out }], SPEC, r.map);
    expect(report.files.flatMap((f) => f.findings).filter((f) => f.class === "account")).toEqual([]);
  });

  test("reveal restores every author, company, user ID and account name", () => {
    const back = revealFile("staff.xlsx", out, new Revealer(r.map));
    const orig = members(input);
    const got = members(back.bytes);
    for (const name of ["docProps/core.xml", "docProps/app.xml", "xl/comments1.xml", "xl/_rels/workbook.xml.rels"]) {
      expect(got.get(name)).toBe(orig.get(name) as string);
    }
    expect(got.get("xl/workbook.xml")).toContain('url="C:\\Users\\tmarsh\\Documents\\Reports\\"');
    expect(got.get("xl/workbook.xml")).toContain('userName="Pell Brightwater"');
    // The person's linking id stays as blinding wrote it; its name and user ID come back.
    expect(got.get("xl/persons/person.xml")).toContain('displayName="Tobin Marsh"');
    expect(got.get("xl/persons/person.xml")).toContain('userId="wren.h@example.com"');
  });
});

// ---------------------------------------------------------------- DOCX

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DOCX_ENTRIES: FixtureEntry[] = [
  { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
  {
    name: "_rels/.rels",
    data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  },
  {
    name: "word/document.xml",
    data: `${DECL}<w:document ${W}><w:body><w:p><w:r><w:t>Quarterly notes.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  },
  {
    name: "word/settings.xml",
    data: `${DECL}<w:settings ${W}><w:attachedTemplate r:id="rId1"/><w:docVars><w:docVar w:name="Source" w:val="/home/pbright/drafts/notes.docx"/></w:docVars></w:settings>`,
  },
  {
    name: "word/_rels/settings.xml.rels",
    data: `${DECL}<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/attachedTemplate" Target="file:///C:\\Users\\whalloway\\AppData\\Roaming\\Microsoft\\Templates\\Notes.dotm" TargetMode="External"/></Relationships>`,
  },
  {
    name: "docProps/core.xml",
    data: `${DECL}<cp:coreProperties ${CORE_NS}><dc:title>Notes</dc:title><dc:creator>Wren Halloway</dc:creator><cp:lastModifiedBy>Tobin Marsh</cp:lastModifiedBy></cp:coreProperties>`,
  },
  {
    name: "docProps/app.xml",
    data: `${DECL}<Properties ${APP_NS}><Template>/Users/tmarsh/Library/Group Containers/Templates/Notes.dotm</Template><Manager>Ilsa Fenwick</Manager><Company>Corvid Analytics</Company></Properties>`,
  },
];

describe("DOCX: account names in paths", () => {
  const input = buildZip(DOCX_ENTRIES);
  const r = applySpec([{ path: "notes.docx", bytes: input }], SPEC, { salt: SALT });
  const out = output(r);
  const text = allText(out);

  test("no account name or author survives", () => {
    for (const v of ["whalloway", "tmarsh", "pbright", "Wren Halloway", "Tobin Marsh", "Ilsa Fenwick", "Corvid Analytics"]) expect(text).not.toContain(v);
    const m = members(out);
    expect(m.get("docProps/app.xml")).toContain(`<Template>/Users/${pseudonymOf(r, "tmarsh")}/Library/Group Containers/Templates/Notes.dotm</Template>`);
    expect(m.get("word/_rels/settings.xml.rels")).toContain(`Target="file:///C:\\Users\\${pseudonymOf(r, "whalloway")}\\AppData`);
    expect(m.get("word/settings.xml")).toContain(`w:val="/home/${pseudonymOf(r, "pbright")}/drafts/notes.docx"`);
    // Four authors and company, three account names.
    expect((r.files[0] as { metadataReplacements?: number }).metadataReplacements).toBe(7);
  });

  test("the audit finds nothing left of them", () => {
    const report = auditTree([{ path: "notes.docx", kind: "file", bytes: out }], SPEC, r.map);
    expect(report.files.flatMap((f) => f.findings).filter((f) => f.class === "account")).toEqual([]);
  });

  test("reveal restores them", () => {
    const back = members(revealFile("notes.docx", out, new Revealer(r.map)).bytes);
    const orig = members(input);
    for (const name of ["docProps/app.xml", "docProps/core.xml", "word/settings.xml", "word/_rels/settings.xml.rels"]) expect(back.get(name)).toBe(orig.get(name) as string);
  });
});

// ---------------------------------------------------------------- audit

describe("audit: a surviving account name in a path is a leak", () => {
  test("in an attribute and in app.xml Template, not when it is a pseudonym or deeper in the path", () => {
    const input = buildZip(DOCX_ENTRIES);
    const report = auditTree([{ path: "notes.docx", kind: "file", bytes: input }], SPEC, { version: 1, entries: [] } as never);
    const accounts = report.files.flatMap((f) => f.findings).filter((f) => f.class === "account");
    expect(accounts.map((f) => [f.part, f.severity])).toEqual([
      ["docProps/app.xml", "leak"],
      ["word/_rels/settings.xml.rels", "leak"],
      ["word/settings.xml", "leak"],
    ]);
    expect(report.status).toBe("leak");
    // The masked value never carries the whole account name.
    for (const f of accounts) expect(ACCOUNTS.some((a) => f.masked.includes(a))).toBe(false);

    const clean = buildZip(
      DOCX_ENTRIES.map((e) =>
        e.name === "docProps/app.xml"
          ? { ...e, data: `${DECL}<Properties ${APP_NS}><Template>/Users/Person_1E95/x.dotm</Template><HyperlinkBase>/var/lib/app/home/svc-sync/</HyperlinkBase></Properties>` }
          : e.name === "word/settings.xml" || e.name === "word/_rels/settings.xml.rels"
            ? { ...e, data: `${DECL}<Relationships xmlns="${PKG_REL}"/>` }
            : e,
      ),
    );
    const ok = auditTree([{ path: "notes.docx", kind: "file", bytes: clean }], SPEC, { version: 1, entries: [] } as never);
    expect(ok.files.flatMap((f) => f.findings).filter((f) => f.class === "account")).toEqual([]);
  });
});
