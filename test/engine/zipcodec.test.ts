import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditTree } from "../../src/audit/mechanical.ts";
import { applySpec, type InputFile } from "../../src/engine/apply.ts";
import { readOoxml, rewriteOoxml, ZipError } from "../../src/formats/ooxml.ts";
import { NO_ZIP_CODEC_REASON, setZipCodec, zipCodec } from "../../src/formats/zipcodec.ts";
import { installNodeZipCodec } from "../../src/nodezip.ts";
import type { Spec } from "../../src/schema.ts";
import { buildZip } from "../formats/zipfixture.ts";

// D-24 / AGT-2733: the zip codec is injected; with none installed, Office files are refused, never half-read.
// Every value here is invented.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 3);
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Dana Pell", aliases: [], parts: ["Dana", "Pell"] }], org: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const docxBytes = () =>
  buildZip([
    { name: "[Content_Types].xml", data: CT },
    { name: "word/document.xml", data: `<w:document ${W}><w:body><w:p><w:r><w:t>Signed by Dana Pell.</w:t></w:r></w:p></w:body></w:document>` },
  ]);
const xlsxBytes = () =>
  buildZip([
    { name: "[Content_Types].xml", data: CT },
    { name: "xl/workbook.xml", data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' },
  ]);

const inputs = (): InputFile[] => [
  { path: "contract.docx", bytes: docxBytes() },
  { path: "people.csv", bytes: new TextEncoder().encode("Name,Team\nDana Pell,Blue\n") },
  { path: "sheet.xlsx", bytes: xlsxBytes() },
];

afterEach(() => installNodeZipCodec());

describe("zip codec injection", () => {
  test("the test preload installs the node:zlib codec, as the CLI does", () => {
    expect(zipCodec()).not.toBeNull();
  });

  test("with no codec, .docx and .xlsx inputs are skipped with the build reason and not written", () => {
    setZipCodec(null);
    for (const style of ["compact", "readable"] as const) {
      const res = applySpec(inputs(), SPEC, { salt: SALT, pseudonymStyle: style });
      expect(res.skipped).toEqual([
        { path: "contract.docx", reason: NO_ZIP_CODEC_REASON },
        { path: "sheet.xlsx", reason: NO_ZIP_CODEC_REASON },
      ]);
      expect(res.outputs.map((o) => o.path)).toEqual(["people.csv"]);
    }
    expect(NO_ZIP_CODEC_REASON).toBe("Office files are not supported in this build");
  });

  test("with the codec installed, the same .docx is blinded", () => {
    const res = applySpec(inputs(), SPEC, { salt: SALT });
    expect(res.skipped.map((s) => s.path)).not.toContain("contract.docx");
    expect(res.outputs.map((o) => o.path)).toContain("contract.docx");
  });

  test("with no codec, a deflated Office file is reported unread by the audit, never clean", () => {
    const map = applySpec([inputs()[1]!], SPEC, { salt: SALT }).map;
    const neutral = buildZip([
      { name: "[Content_Types].xml", data: CT },
      { name: "word/document.xml", data: `<w:document ${W}><w:body><w:p><w:r><w:t>Nothing to see.</w:t></w:r></w:p></w:body></w:document>` },
    ]);
    const entries = [{ path: "out.docx", kind: "file" as const, bytes: neutral }];
    expect(auditTree(entries, SPEC, map).files[0]!.status).toBe("clean");

    setZipCodec(null);
    const report = auditTree(entries, SPEC, map);
    expect(report.status).not.toBe("clean");
    expect(report.files[0]!.status).not.toBe("clean");
    const unread = report.files[0]!.findings.filter((f) => f.class === "unscanned");
    expect(unread.map((f) => f.part).sort()).toEqual(["[Content_Types].xml", "word/document.xml"]);
    for (const f of unread) expect(f.reason).toContain(NO_ZIP_CODEC_REASON);
  });

  test("with no codec, the OOXML reader reports each deflated member as an error, and rewriting refuses", () => {
    setZipCodec(null);
    expect(readOoxml(docxBytes()).map((m) => (m.kind === "error" ? m.error : m.kind))).toEqual([NO_ZIP_CODEC_REASON, NO_ZIP_CODEC_REASON]);
    expect(() => rewriteOoxml(docxBytes(), (v) => v, undefined, () => new Uint8Array([1]))).not.toThrow();
    const binary = buildZip([{ name: "word/media/a.bin", data: "x", method: 8 }]);
    expect(() => rewriteOoxml(binary, (v) => v, undefined, () => new Uint8Array([1]))).toThrow(ZipError);
  });

  test("no file under src/engine, src/formats or src/audit (but audit/command.ts) imports node:zlib", () => {
    const root = join(import.meta.dir, "../../src");
    const offenders: string[] = [];
    for (const dir of ["engine", "formats", "audit"]) {
      for (const name of readdirSync(join(root, dir), { recursive: true }) as string[]) {
        const rel = `${dir}/${name}`;
        if (!/\.[cm]?[jt]s$/.test(name) || rel === "audit/command.ts") continue;
        if (/["'](node:)?zlib["']/.test(readFileSync(join(root, rel), "utf8"))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
