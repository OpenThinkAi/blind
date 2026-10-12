import { describe, expect, test } from "bun:test";
import { auditTree } from "../../src/audit/mechanical.ts";
import { readZip as readZipBytes } from "../../src/audit/zip.ts";
import { renderReport } from "../../src/apply.ts";
import { applySpec, type ApplyOptions } from "../../src/engine/apply.ts";
import { isPlaceholderImage, placeholderFor } from "../../src/engine/images.ts";
import type { Spec } from "../../src/schema.ts";
import { docxMembers } from "../audit/ooxmlfixture.ts";
import { buildWorkbook } from "../formats/xlsxfixture.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";

// Synthetic only: the "images" are a few invented header bytes plus marker strings standing in for
// pixels and EXIF; no real picture is involved.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }], org: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...xs: Uint8Array[]) => Uint8Array.from(xs.flatMap((x) => [...x]));

const PNG = cat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), enc("scanned-id-of-Avery-Quill"));
// A JPEG whose APP1 segment carries invented EXIF with a GPS tag and an owner name.
const JPEG = cat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x40]), enc("Exif\0\0GPSLatitude=40.00000 GPSLongitude=-111.00000 OwnerName=Avery Quill"), Uint8Array.from([0xff, 0xd9]));
const WORD_IMAGES: FixtureEntry[] = [
  { name: "word/media/image1.png", data: PNG, method: 0 },
  { name: "word/media/image2.jpeg", data: JPEG, method: 8 },
];
const SHEET_IMAGES: FixtureEntry[] = [
  { name: "xl/media/image1.png", data: PNG },
  { name: "xl/media/image2.jpg", data: JPEG },
];

const docxBytes = (extra: FixtureEntry[] = WORD_IMAGES) => buildZip([...(docxMembers({ body: "Meeting with Avery Quill." }) as FixtureEntry[]), ...extra]);
const apply = (path: string, bytes: Uint8Array, opts: Partial<ApplyOptions> = {}) => applySpec([{ path, bytes }], SPEC, { salt: SALT, ...opts });
const bytesOf = (a: Uint8Array) => Buffer.from(a).toString("latin1");

function check(path: string, input: Uint8Array, names: string[]) {
  const before = new Map(readZip(input).map((e) => [e.name, e]));
  const kept = apply(path, input, { images: "keep" });
  const res = apply(path, input);
  expect(res.skipped).toEqual([]);
  const out = res.outputs[0]!.bytes;
  const after = readZip(out);
  // Same members in the same order, with the same compression: part names and relationships are untouched.
  expect(after.map((e) => [e.name, e.method])).toEqual([...before.values()].map((e) => [e.name, e.method]));
  for (const e of after) {
    if (names.includes(e.name)) continue;
    if (e.name.endsWith(".rels") || e.name === "[Content_Types].xml") expect(e.text).toBe(before.get(e.name)!.text);
  }
  // Default: no original image bytes, no EXIF, and each part is the placeholder for its format.
  for (const n of names) {
    const raw = Buffer.from(readZipBytes(out).find((m) => m.name === n)!.bytes!);
    expect(isPlaceholderImage(raw)).toBe(true);
    expect(Buffer.from(placeholderFor(n)!).equals(raw)).toBe(true);
  }
  const whole = bytesOf(Buffer.concat(readZipBytes(out).map((m) => Buffer.from(m.bytes ?? []))));
  for (const secret of ["scanned-id", "GPSLatitude", "OwnerName", "Exif"]) expect(whole.includes(secret)).toBe(false);
  expect(res.files[0]!.changed).toBe(true);
  expect(renderReport(res)).toContain("2 images replaced with placeholders (images are not blinded; set [images] keep = true to keep them)");
  // keep: byte-identical images, today's behaviour.
  const keptAfter = readZip(kept.outputs[0]!.bytes);
  for (const n of names) expect(keptAfter.find((e) => e.name === n)!.text).toBe(before.get(n)!.text);
  return { res, kept };
}

describe("images: replaced with placeholders by default (AGT-1865)", () => {
  test("DOCX: PNG and JPEG (with EXIF GPS) become placeholders under the same part names", () => {
    const { kept } = check("note.docx", docxBytes(), ["word/media/image1.png", "word/media/image2.jpeg"]);
    expect(renderReport(kept)).toContain("warning: 2 images copied unchanged (images are not blinded): word/media/image1.png, word/media/image2.jpeg");
  });

  test("XLSX: PNG and JPEG (with EXIF GPS) become placeholders under the same part names", () => {
    const { res, kept } = check("book.xlsx", buildWorkbook({ extra: SHEET_IMAGES }), ["xl/media/image1.png", "xl/media/image2.jpg"]);
    expect(res.files[0]!.unread).toEqual([]);
    expect(kept.files[0]!.unread).toEqual(["xl/media/image1.png", "xl/media/image2.jpg"]);
  });

  test("a package without pictures is untouched by the setting", () => {
    const input = buildZip(docxMembers({ body: "Meeting with Avery Quill." }) as FixtureEntry[]);
    expect(renderReport(apply("note.docx", input))).not.toContain("placeholders");
    expect(apply("note.docx", input).outputs[0]!.bytes).toEqual(apply("note.docx", input, { images: "keep" }).outputs[0]!.bytes);
  });

  test("a picture format with no placeholder stops the file, unless images are kept", () => {
    const tiff = { name: "word/media/scan.tiff", data: enc("II*\0 scanned page") };
    const res = apply("note.docx", docxBytes([tiff]));
    expect(res.outputs).toEqual([]);
    expect(res.skipped[0]!.reason).toContain("image word/media/scan.tiff cannot be replaced with a placeholder");
    expect(res.skipped[0]!.reason).toContain("[images] keep = true");
    expect(apply("note.docx", docxBytes([tiff]), { images: "keep" }).skipped).toEqual([]);
    const sheet = apply("book.xlsx", buildWorkbook({ extra: [{ name: "xl/media/scan.emf", data: enc("\x01\0\0\0 page") }] }));
    expect(sheet.outputs).toEqual([]);
    expect(sheet.skipped[0]!.reason).toContain("image xl/media/scan.emf cannot be replaced with a placeholder");
  });

  test("the audit lists a kept picture as unscanned, and not a placeholder", () => {
    const audit = (bytes: Uint8Array) => auditTree([{ path: "note.docx", kind: "file", bytes }], SPEC, apply("note.docx", docxBytes()).map);
    const unscanned = (bytes: Uint8Array) =>
      audit(bytes).files.flatMap((f) => f.findings).filter((f) => f.class === "unscanned").map((f) => f.part);
    expect(unscanned(apply("note.docx", docxBytes(), { images: "keep" }).outputs[0]!.bytes).sort()).toEqual(["word/media/image1.png", "word/media/image2.jpeg"]);
    expect(unscanned(apply("note.docx", docxBytes()).outputs[0]!.bytes)).toEqual([]);
  });
});

describe("placeholders", () => {
  test("each raster format has a valid placeholder with the right signature", () => {
    const sig = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], jpeg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46, 0x38], bmp: [0x42, 0x4d] };
    for (const [ext, magic] of Object.entries(sig)) expect([...placeholderFor(`x/a.${ext.toUpperCase()}`)!.subarray(0, magic.length)]).toEqual(magic);
    expect(new TextDecoder().decode(placeholderFor("a.svg")!)).toContain("<svg");
    for (const ext of ["tiff", "emf", "wmf", "ico", "webp"]) expect(placeholderFor(`a.${ext}`)).toBeNull();
  });
});
