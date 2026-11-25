// AGT-2736: the library entry, in memory. This file imports nothing but src/lib.ts (and bun:test): no
// file system, no CLI module. Synthetic data only.
import { describe, expect, test } from "bun:test";
import {
  applySpec,
  engineFormat,
  MIN_SALT_BYTES,
  newSalt,
  NO_ZIP_CODEC_REASON,
  setZipCodec,
  type ZipCodec,
  zipCodec,
  parseMap,
  parseSpec,
  PseudonymError,
  revealFile,
  Revealer,
  revealText,
  SALT_BYTES,
  serializeMap,
  type InputFile,
  type Spec,
} from "../src/lib.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const SPEC: Spec = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "name", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "email", class: "email", treatment: "blind", confidence: 1, source: "human" },
    { file: "tickets.json", jsonPath: "$[*].owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "tickets.json", jsonPath: "$[*].title", class: "vocabulary", treatment: "scan", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }, { canonical: "Rowan Pike", aliases: [], parts: ["Rowan", "Pike"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const CSV = "name,email,team\nAvery Quill,avery.quill@example-corp.test,North\nRowan Pike,rowan.pike@example-corp.test,South\n";
const JSON_TEXT = `[
  { "owner": "Avery Quill", "title": "Rowan Pike asked about the 192.0.2.10 outage" },
  { "owner": "Rowan Pike", "title": "Printer jam" }
]
`;
const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

const inputs = (): InputFile[] => [
  { path: "staff.csv", bytes: enc(CSV) },
  { path: "tickets.json", bytes: enc(JSON_TEXT) },
];

describe("library entry: blind and reveal in memory", () => {
  test("a CSV and a JSON file held as Uint8Array come back byte-exact", () => {
    const result = applySpec(inputs(), SPEC, { salt: SALT });
    expect(result.skipped).toEqual([]);
    expect(result.outputs.map((o) => o.path).sort()).toEqual(["staff.csv", "tickets.json"]);
    for (const o of result.outputs) {
      const text = dec(o.bytes);
      expect(text).not.toContain("Avery");
      expect(text).not.toContain("Rowan");
      expect(text).not.toContain("example-corp");
    }
    // The map goes through its text form and back, as a caller storing it would.
    const map = parseMap(serializeMap(result.map));
    const rv = new Revealer(map);
    const back = new Map(result.outputs.map((o) => [rv.path(o.path).text, revealFile(o.path, o.bytes, rv).bytes]));
    expect(back.get("staff.csv")).toEqual(enc(CSV));
    expect(back.get("tickets.json")).toEqual(enc(JSON_TEXT));
  });

  test("revealText restores a plain string", () => {
    const result = applySpec(inputs(), SPEC, { salt: SALT });
    const blinded = dec(result.outputs.find((o) => o.path === "staff.csv")!.bytes);
    const line = blinded.split("\n")[1] as string;
    expect(revealText(`Report for ${line}.`, result.map)).toBe("Report for Avery Quill,avery.quill@example-corp.test,North.");
  });

  test("the same salt gives the same bytes; a different salt different ones", () => {
    const a = applySpec(inputs(), SPEC, { salt: SALT });
    const b = applySpec(inputs(), SPEC, { salt: SALT.slice() });
    const c = applySpec(inputs(), SPEC, { salt: newSalt() });
    expect(b.outputs).toEqual(a.outputs);
    expect(serializeMap(b.map)).toBe(serializeMap(a.map));
    expect(c.outputs.map((o) => dec(o.bytes))).not.toEqual(a.outputs.map((o) => dec(o.bytes)));
  });

  test("an earlier map's pseudonyms are reused", () => {
    const first = applySpec([{ path: "staff.csv", bytes: enc(CSV) }], SPEC, { salt: SALT });
    const again = applySpec(inputs(), SPEC, { salt: newSalt(), map: first.map });
    const staff = (r: typeof first) => dec(r.outputs.find((o) => o.path === "staff.csv")!.bytes);
    expect(staff(again)).toBe(staff(first));
  });

  test("policy options are a plain object: pseudonym style, patterns, defaults", () => {
    const readable = applySpec(inputs(), SPEC, { salt: SALT, policy: { pseudonyms: { style: "readable" } } });
    expect(dec(readable.outputs.find((o) => o.path === "staff.csv")!.bytes)).toMatch(/\[[A-Z][A-Za-z ]*? [A-Z]{1,3} #[0-9A-F]{4}\]/);

    const ipOff = applySpec(inputs(), SPEC, { salt: SALT, policy: { patterns: { ip: false } } });
    expect(dec(ipOff.outputs.find((o) => o.path === "tickets.json")!.bytes)).toContain("192.0.2.10");
    const ipOn = applySpec(inputs(), SPEC, { salt: SALT });
    expect(dec(ipOn.outputs.find((o) => o.path === "tickets.json")!.bytes)).not.toContain("192.0.2.10");

    const scan = applySpec(inputs(), SPEC, { salt: SALT, policy: { defaults: { columns: "scan" } } });
    const team = scan.files.find((f) => f.path === "staff.csv")!.columns.find((c) => c.header === "team");
    expect(team?.outcome).toBe("unknown-scanned");
  });

  test("newSalt gives SALT_BYTES fresh random bytes, enough for the engine", () => {
    const a = newSalt();
    const b = newSalt();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(SALT_BYTES);
    expect(SALT_BYTES).toBeGreaterThanOrEqual(MIN_SALT_BYTES);
    expect(a).not.toEqual(b);
  });

  test("a salt too short is refused", () => {
    expect(() => applySpec(inputs(), SPEC, { salt: new Uint8Array(4) })).toThrow(PseudonymError);
  });

  test("with no zip codec installed an Office file is skipped with the reason, the rest is blinded", () => {
    // The test preload installs the CLI's codec; take it out and put it back as found.
    const saved: ZipCodec | null = zipCodec();
    setZipCodec(null);
    try {
      const r = applySpec([...inputs(), { path: "notes/plan.docx", bytes: enc("PK not really a zip") }], SPEC, { salt: SALT });
      expect(r.skipped).toEqual([{ path: "notes/plan.docx", reason: NO_ZIP_CODEC_REASON }]);
      expect(r.outputs.map((o) => o.path).sort()).toEqual(["staff.csv", "tickets.json"]);
    } finally {
      setZipCodec(saved);
    }
  });

  test("parseSpec and engineFormat are exported", () => {
    expect(parseSpec(JSON.stringify(SPEC))).toEqual(SPEC);
    expect(engineFormat("a/b.csv")).toBe("csv");
    expect(engineFormat("a/b.bin")).toBeNull();
  });
});
