// A given name right before a known surname (AGT-1854): another person's full name, not the known
// person's lone surname; and 8-bit text read as windows-1252. Everything here is invented.

import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const bytesFile = (path: string, bytes: Uint8Array): InputFile => ({ path, bytes });
const file = (path: string, text: string): InputFile => bytesFile(path, Buffer.from(text, "utf8"));
const outBytes = (r: ApplyResult, path: string): Buffer => Buffer.from((r.outputs.find((o) => o.path === path) as InputFile).bytes);
const out = (r: ApplyResult, path: string): string => outBytes(r, path).toString("utf8");
const rule = (f: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file: f,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "policy",
});
const spec = (columns: ColumnRule[]): Spec => ({ version: 1, columns, entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false, phone: true }, questions: [] });
const tokens = (s: string): string[] => s.match(/Person_[0-9A-F]{4}/g) ?? [];

const run = (inputs: InputFile[], keep: string[] = []) =>
  applySpec(inputs, spec([rule("v.csv", "owner_name", "person", "blind"), rule("v.csv", "emergency_contact", "unknown", "scan")]), { salt: SALT, keep });

describe("a given name before a known surname", () => {
  const r = run([
    file("v.csv", "owner_name,emergency_contact\nDana Quillfeather,Sam Quillfeather (sister) 555-555-0150\nDana Quillfeather,Quillfeather says hi\n"),
    file("notes.txt", "Dana Quillfeather called. Noémie Quillfeather — her aunt — and Ann O' Quillfeather and Ann O'Quillfeather.\n"),
  ]);
  const csv = out(r, "v.csv");

  test("it is a new person with its own pseudonym, never the known person's", () => {
    const [dana, sam, lone] = tokens(csv);
    expect(csv).not.toContain("Sam");
    expect(csv).not.toContain("Quillfeather");
    expect(sam).not.toBe(dana);
    // The lone surname keeps the known person's pseudonym.
    expect(lone).toBe(dana);
    expect(csv).toContain(`${sam} (sister)`);
  });

  test("particles stay inside the one span", () => {
    const txt = out(r, "notes.txt");
    expect(txt).not.toMatch(/Ann|Noémie|Quillfeather|O'/);
    const [dana, noemie, ann, ann2] = tokens(txt);
    expect(new Set([dana, noemie, ann]).size).toBe(3);
    // The same name written with and without a space after the particle is two spans of two people's text, each replaced whole.
    expect(ann2).toBeDefined();
  });

  test("the report counts them", () => {
    expect(r.files.find((f) => f.path === "v.csv")?.joinedNames).toBe(1);
    expect(r.files.find((f) => f.path === "notes.txt")?.joinedNames).toBe(3);
  });

  test("a repeated full name has one pseudonym", () => {
    const again = run([file("v.csv", "owner_name,emergency_contact\nDana Quillfeather,Sam Quillfeather and Sam Quillfeather\n")]);
    const [dana, a, b] = tokens(out(again, "v.csv"));
    expect(a).toBe(b);
    expect(a).not.toBe(dana);
  });
});

describe("a word that is not a given name stays a lone surname", () => {
  test.each([
    ["Dr Quillfeather", "Dr "],
    ["Front Quillfeather", "Front "],
    ["The Quillfeather", "The "],
    ["March Quillfeather", "March "],
    ["thanks quillfeather", ""],
  ])("%s", (text, kept) => {
    const r = run([file("v.csv", `owner_name,emergency_contact\nDana Quillfeather,${text} x\n`)]);
    const cell = out(r, "v.csv").split("\n")[1]?.split(",")[1] as string;
    expect(cell.startsWith(kept)).toBe(true);
    expect(r.files[0]?.joinedNames).toBeUndefined();
  });

  test("a keep term", () => {
    const r = run([file("v.csv", "owner_name,emergency_contact\nDana Quillfeather,Riverside Quillfeather x\n")], ["Riverside"]);
    expect(out(r, "v.csv")).toContain("Riverside Person_");
  });

  test("a sentence break is not joined", () => {
    const r = run([file("v.csv", "owner_name,emergency_contact\nDana Quillfeather,Call Sam. Quillfeather x\n")]);
    expect(out(r, "v.csv")).toContain("Sam. Person_");
  });
});

describe("8-bit text is read as windows-1252", () => {
  const bytes = Buffer.concat([
    Buffer.from("Dana Quillfeather\n"),
    Buffer.from([0x4e, 0x6f, 0xe9]),
    Buffer.from("mie Quillfeather "),
    Buffer.from([0x97]),
    Buffer.from(" 555-555-0104 "),
    Buffer.from([0x97]),
    Buffer.from(" notes\nAnn O' Quillfeather "),
    Buffer.from([0x97, 0x93]),
    Buffer.from("quoted"),
    Buffer.from([0x94, 0x81, 0x8d, 0x0a]),
  ]);
  const r = run([bytesFile("legacy.txt", bytes), file("v.csv", "owner_name,emergency_contact\nDana Quillfeather,x\n")]);
  const o = outBytes(r, "legacy.txt");

  test("names are replaced whole and the phone is replaced", () => {
    const text = o.toString("latin1");
    expect(text).not.toMatch(/Quillfeather|Ann|No.mie|555-555-0104/);
    expect(r.files.find((f) => f.path === "legacy.txt")?.encoding).toBe("latin1");
  });

  test("bytes outside replacements are identical, including the cp1252 punctuation and undefined bytes", () => {
    const masked = (b: Buffer) => b.toString("latin1").replace(/Person_[0-9A-F]{4}|Id_[0-9A-F]{4}|Id_[0-9A-F]+/g, "#");
    // 0x97 em dash and 0x93/0x94 quotes survive; 0x81 and 0x8d (undefined in cp1252) keep their bytes.
    expect(o.includes(Buffer.from([0x20, 0x97, 0x20]))).toBe(true);
    expect(o.includes(Buffer.from([0x93, 0x71]))).toBe(true);
    expect(o.includes(Buffer.from([0x94, 0x81, 0x8d, 0x0a]))).toBe(true);
    expect(masked(o).split("\n").length).toBe(masked(bytes).split("\n").length);
  });

  test("the dash is punctuation: a phone joined by dashes is still found", () => {
    const only = Buffer.concat([Buffer.from("call "), Buffer.from([0x97]), Buffer.from("555-555-0104"), Buffer.from([0x97]), Buffer.from("now\n")]);
    const res = run([bytesFile("a.txt", only)]);
    const text = outBytes(res, "a.txt").toString("latin1");
    expect(text).not.toContain("555-555-0104");
    expect(text.startsWith("call \x97")).toBe(true);
    expect(text.endsWith("\x97now\n")).toBe(true);
  });
});
