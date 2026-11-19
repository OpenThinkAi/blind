import { describe, expect, test } from "bun:test";
import { inflateRawSync } from "node:zlib";
import { type ApplyOptions, type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import { SCRUBBED_DATE, SCRUBBED_SERIAL, scrubPackage } from "../../src/formats/metadata.ts";
import { renderReport } from "../../src/apply.ts";
import { defaultPolicy, parsePolicy, renderPolicy } from "../../src/policy.ts";
import type { Spec } from "../../src/schema.ts";
import { workbookEntries } from "./xlsxfixture.ts";
import { buildZip, type FixtureEntry } from "./zipfixture.ts";

// AGT-2459: document dates and zip metadata are written as constants. Synthetic data only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 91);
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Dana Pell", aliases: [], parts: [] }] },
  patterns: { ip: false, email: false, host: false, guid: false, mac: false },
  questions: [],
};
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const CORE =
  `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
  "<dc:title>Plan</dc:title><cp:revision>42</cp:revision>" +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2026-03-04T05:06:07Z</dcterms:created>' +
  '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-03-05T06:07:08Z</dcterms:modified>' +
  "<cp:lastPrinted>2026-03-06T07:08:09Z</cp:lastPrinted></cp:coreProperties>";
const APP =
  `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
  "<Template>Normal.dotm</Template><TotalTime>317</TotalTime><Pages>1</Pages></Properties>";
// Extended timestamp extra field (0x5455): flags 1, then a Unix mtime.
const EXTRA = new Uint8Array([0x55, 0x54, 0x05, 0x00, 0x01, 0x80, 0x1d, 0x0b, 0x6a]);
// 2026-03-04 05:06:08 as a DOS time and date.
const DOS = { time: (5 << 11) | (6 << 5) | 4, date: ((2026 - 1980) << 9) | (3 << 5) | 4 };
const stamped = (entries: FixtureEntry[]): FixtureEntry[] => entries.map((e) => ({ ...e, dos: DOS, extra: EXTRA }));

function docx(): Uint8Array {
  return buildZip(stamped([
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "_rels/.rels",
      data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/document.xml",
      data:
        `${DECL}<w:document ${W}><w:body><w:p><w:r><w:t>Owner: </w:t></w:r>` +
        '<w:ins w:id="1" w:author="Robin Example" w:date="2026-03-04T05:06:07Z"><w:r><w:t>Dana Pell</w:t></w:r></w:ins>' +
        "</w:p><w:sectPr/></w:body></w:document>",
    },
    {
      name: "word/comments.xml",
      data: `${DECL}<w:comments ${W}><w:comment w:id="0" w:author="Robin Example" w:initials="RE" w:date="2026-03-04T05:06:07Z"><w:p><w:r><w:t>Ask first</w:t></w:r></w:p></w:comment></w:comments>`,
    },
    {
      name: "word/commentsExtensible.xml",
      data: `${DECL}<w16cex:commentsExtensible xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"><w16cex:commentExtensible w16cex:durableId="1A2B3C4D" w16cex:dateUtc="2026-03-04T12:06:07Z"/></w16cex:commentsExtensible>`,
    },
    { name: "docProps/core.xml", data: CORE },
    { name: "docProps/app.xml", data: APP },
  ]));
}

function xlsx(): Uint8Array {
  const entries = workbookEntries({
    extra: [{
      name: "xl/threadedComments/threadedComment1.xml",
      data: `${DECL}<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" dT="2026-03-04T05:06:07.12" personId="{11111111-2222-3333-4444-555555555555}" id="{66666666-7777-8888-9999-AAAAAAAAAAAA}"><text>Check this</text></threadedComment></ThreadedComments>`,
    }],
  }).map((e) => {
    if (e.name === "docProps/core.xml") return { ...e, data: CORE.replace("<dc:title>Plan</dc:title>", "<dc:creator>Dana Pell</dc:creator>") };
    if (e.name === "docProps/app.xml") return { ...e, data: APP };
    if (e.name === "xl/pivotCache/pivotCacheDefinition1.xml" && typeof e.data === "string") {
      return { ...e, data: e.data.replace('recordCount="2"', 'recordCount="2" refreshedDate="46085.2125" refreshedDateIso="2026-03-04T05:06:00"') };
    }
    return e;
  });
  return buildZip(stamped(entries));
}

const run = (path: string, bytes: Uint8Array, opts: Partial<ApplyOptions> = {}): ApplyResult => {
  const r = applySpec([{ path, bytes }], SPEC, { salt: SALT, ...opts });
  expect(r.skipped).toEqual([]);
  return r;
};
const out = (r: ApplyResult): Uint8Array => (r.outputs[0] as { bytes: Uint8Array }).bytes;

interface Header { name: string; time: number; date: number; extra: number }

/** Every member's local header and central record times, dates and extra lengths, read independently of ooxml.ts. */
function headers(bytes: Uint8Array): { local: Header[]; central: Header[]; texts: Map<string, string> } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const local: Header[] = [];
  const central: Header[] = [];
  const texts = new Map<string, string>();
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    central.push({ name, time: v.getUint16(p + 12, true), date: v.getUint16(p + 14, true), extra: v.getUint16(p + 30, true) });
    const off = v.getUint32(p + 42, true);
    local.push({ name, time: v.getUint16(off + 10, true), date: v.getUint16(off + 12, true), extra: v.getUint16(off + 28, true) });
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const raw = bytes.subarray(start, start + v.getUint32(p + 20, true));
    const plain = v.getUint16(p + 10, true) === 8 ? inflateRawSync(raw) : raw;
    texts.set(name, new TextDecoder().decode(plain));
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return { local, central, texts };
}

const EPOCH = { time: 0, date: 0x0021, extra: 0 };
const expectScrubbedZip = (bytes: Uint8Array) => {
  const h = headers(bytes);
  expect(h.local.length).toBeGreaterThan(0);
  for (const e of [...h.local, ...h.central]) expect({ time: e.time, date: e.date, extra: e.extra }).toEqual(EPOCH);
  return h.texts;
};

describe("DOCX: document dates and zip metadata are scrubbed by default", () => {
  const r = run("plan.docx", docx());
  const texts = expectScrubbedZip(out(r));

  test("core created, modified, lastPrinted and revision", () => {
    const core = texts.get("docProps/core.xml")!;
    expect(core).toContain(`<dcterms:created xsi:type="dcterms:W3CDTF">${SCRUBBED_DATE}</dcterms:created>`);
    expect(core).toContain(`<dcterms:modified xsi:type="dcterms:W3CDTF">${SCRUBBED_DATE}</dcterms:modified>`);
    expect(core).toContain(`<cp:lastPrinted>${SCRUBBED_DATE}</cp:lastPrinted>`);
    expect(core).toContain("<cp:revision>1</cp:revision>");
    expect(core).toContain("<dc:title>Plan</dc:title>");
    expect(core).not.toMatch(/2026-03/);
  });

  test("app TotalTime, other properties kept", () => {
    const app = texts.get("docProps/app.xml")!;
    expect(app).toContain("<TotalTime>0</TotalTime>");
    expect(app).toContain("<Pages>1</Pages><");
    expect(app).toContain("<Template>Normal.dotm</Template>");
  });

  test("w:date on revisions and comments, w16cex:dateUtc in commentsExtensible", () => {
    expect(texts.get("word/document.xml")).toContain(`w:date="${SCRUBBED_DATE}"`);
    expect(texts.get("word/comments.xml")).toContain(`w:date="${SCRUBBED_DATE}"`);
    expect(texts.get("word/commentsExtensible.xml")).toContain(`w16cex:dateUtc="${SCRUBBED_DATE}"`);
    for (const t of texts.values()) expect(t).not.toMatch(/2026-03/);
    // The blinding itself still ran.
    expect(texts.get("word/document.xml")).not.toContain("Dana Pell");
  });

  test("output is deterministic for a given input", () => {
    expect(out(run("plan.docx", docx()))).toEqual(out(r));
  });

  test("the report counts the dates and says how to keep them", () => {
    expect(r.files[0]?.datesScrubbed).toBe(8);
    expect(renderReport(r)).toContain("document dates: 8 date or edit-history values and the zip timestamps written as constants ([metadata] keep_dates = true keeps them)");
    const kept = run("plan.docx", docx(), { dates: "keep" });
    expect(kept.files[0]?.datesScrubbed).toBeUndefined();
    expect(renderReport(kept)).not.toContain("document dates");
  });

  test("a DOCX with nothing to blind is still scrubbed and reported changed", () => {
    const plain = buildZip(stamped([
      { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
      {
        name: "_rels/.rels",
        data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      },
      { name: "word/document.xml", data: `${DECL}<w:document ${W}><w:body><w:p><w:r><w:t>Nothing here</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
      { name: "docProps/core.xml", data: CORE },
    ]));
    const res = run("plain.docx", plain);
    expect(res.files[0]?.changed).toBe(true);
    expect(expectScrubbedZip(out(res)).get("docProps/core.xml")).toContain(SCRUBBED_DATE);
  });
});

describe("XLSX: document dates and zip metadata are scrubbed by default", () => {
  const r = run("staff.xlsx", xlsx());
  const texts = expectScrubbedZip(out(r));

  test("core and app properties (the XLSX core-properties path)", () => {
    const core = texts.get("docProps/core.xml")!;
    expect(core).toContain(`<dcterms:created xsi:type="dcterms:W3CDTF">${SCRUBBED_DATE}</dcterms:created>`);
    expect(core).toContain(`<dcterms:modified xsi:type="dcterms:W3CDTF">${SCRUBBED_DATE}</dcterms:modified>`);
    expect(core).toContain(`<cp:lastPrinted>${SCRUBBED_DATE}</cp:lastPrinted>`);
    expect(core).toContain("<cp:revision>1</cp:revision>");
    expect(core).not.toContain("Dana Pell");
    expect(texts.get("docProps/app.xml")).toContain("<TotalTime>0</TotalTime>");
  });

  test("threaded comment and pivot cache refresh dates", () => {
    expect(texts.get("xl/threadedComments/threadedComment1.xml")).toContain(`dT="${SCRUBBED_DATE}"`);
    const def = texts.get("xl/pivotCache/pivotCacheDefinition1.xml")!;
    expect(def).toContain(`refreshedDate="${SCRUBBED_SERIAL}"`);
    expect(def).toContain(`refreshedDateIso="${SCRUBBED_DATE}"`);
    for (const t of texts.values()) expect(t).not.toMatch(/2026-03|46085/);
  });

  test("output is deterministic for a given input", () => {
    expect(out(run("staff.xlsx", xlsx()))).toEqual(out(r));
  });
});

describe("dates = keep: today's behaviour", () => {
  for (const [path, build] of [["plan.docx", docx], ["staff.xlsx", xlsx]] as const) {
    test(`${path} keeps its dates, zip times and extra fields`, () => {
      const h = headers(out(run(path, build(), { dates: "keep" })));
      for (const e of [...h.local, ...h.central]) expect({ time: e.time, date: e.date, extra: e.extra }).toEqual({ ...DOS, extra: EXTRA.length });
      expect(h.texts.get("docProps/core.xml")).toContain("2026-03-04T05:06:07Z");
      expect(h.texts.get("docProps/core.xml")).toContain("<cp:revision>42</cp:revision>");
      expect(h.texts.get("docProps/app.xml")).toContain("<TotalTime>317</TotalTime>");
    });
  }
});

describe("scrubPackage", () => {
  test("a package already scrubbed is returned byte for byte", () => {
    const once = scrubPackage(docx());
    expect(once.changed).toBe(true);
    expect(once.dates).toBe(8);
    const twice = scrubPackage(once.bytes);
    expect(twice.changed).toBe(false);
    expect(twice.dates).toBe(0);
    expect(twice.bytes).toEqual(once.bytes);
  });

  test("the archive comment is dropped", () => {
    const bytes = buildZip([{ name: "x/part.xml", data: `${DECL}<root xmlns="urn:example"/>` }], "written on host-17 by avery");
    const scrubbed = scrubPackage(bytes).bytes;
    expect(new TextDecoder().decode(scrubbed)).not.toContain("host-17");
    expect(headers(scrubbed).texts.get("x/part.xml")).toContain("<root");
  });

  test("strict OOXML namespaces are covered", () => {
    const bytes = buildZip([
      { name: "docProps/app.xml", data: `${DECL}<Properties xmlns="http://purl.oclc.org/ooxml/officeDocument/extendedProperties"><TotalTime>12</TotalTime></Properties>` },
      { name: "word/document.xml", data: `${DECL}<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:ins w:id="1" w:date="2026-03-04T05:06:07Z"/></w:body></w:document>` },
      { name: "xl/pivotCache/pivotCacheDefinition1.xml", data: `${DECL}<pivotCacheDefinition xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" refreshedDate="46085.2"/>` },
    ]);
    const t = headers(scrubPackage(bytes).bytes).texts;
    expect(t.get("docProps/app.xml")).toContain("<TotalTime>0</TotalTime>");
    expect(t.get("word/document.xml")).toContain(`w:date="${SCRUBBED_DATE}"`);
    expect(t.get("xl/pivotCache/pivotCacheDefinition1.xml")).toContain(`refreshedDate="${SCRUBBED_SERIAL}"`);
  });

  test("a date attribute outside a Word namespace is left alone", () => {
    const bytes = buildZip([{ name: "x/part.xml", data: `${DECL}<root xmlns="urn:example" date="2026-03-04"/>` }]);
    expect(headers(scrubPackage(bytes).bytes).texts.get("x/part.xml")).toContain('date="2026-03-04"');
  });
});

describe("blind.toml [metadata] keep_dates", () => {
  test("defaults to false and round-trips through the rendered policy", () => {
    expect(defaultPolicy().metadata.keepDates).toBe(false);
    const p = defaultPolicy();
    expect(parsePolicy(renderPolicy(p)).metadata.keepDates).toBe(false);
    p.metadata.keepDates = true;
    const text = renderPolicy(p);
    expect(text).toContain("[metadata]\n");
    expect(text).toContain("keep_dates = true");
    expect(parsePolicy(text).metadata.keepDates).toBe(true);
  });

  test("a non-boolean or unknown key is refused", () => {
    const base = renderPolicy(defaultPolicy()).replace("# keep_dates = false", "");
    expect(() => parsePolicy(base.replace("[metadata]\n", '[metadata]\nkeep_dates = "yes"\n'))).toThrow(/metadata\.keep_dates/);
    expect(() => parsePolicy(base.replace("[metadata]\n", "[metadata]\nkeep_times = true\n"))).toThrow(/keep_times/);
  });
});
