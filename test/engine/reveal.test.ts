import { describe, expect, test } from "bun:test";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap, MapEntry } from "../../src/engine/map.ts";
import { RevealError, revealFile, Revealer } from "../../src/engine/reveal.ts";
import type { Spec } from "../../src/schema.ts";

// Synthetic values only (invented names, example.com, RFC 5737 IPs).

const entry = (kind: MapEntry["kind"], canonical: string, value: string, pseudonym: string): MapEntry => ({ kind, canonical, value, pseudonym });

const MAP: BlindMap = {
  version: 1,
  entries: [
    entry("person", "quill, avery", "Quill, Avery", "Person_A7F3"),
    entry("person", "robin example", "Robin Example", "Person_4C1D"),
    entry("host", "192.0.2.10", "192.0.2.10", "203.0.113.7"),
    entry("host", "app01.corp.example.com", "app01.corp.example.com", "host-1a2b.host-3c4d.host-5e6f.com"),
    entry("host", "corp.example.com", "corp.example.com", "host-3c4d.host-5e6f.com"),
    entry("host-label", "app01", "app01", "host-1a2b"),
    entry("id", "0f8fad5b-d9cb-469f-a165-70867728950e", "{0F8FAD5B-D9CB-469F-A165-70867728950E}", "4b1d2c3e-5f60-4a7b-8c9d-0e1f2a3b4c5d"),
    entry("id", "004217", "004217", "731905"),
    entry("email", "jo.sample@example.com", "jo.sample@example.com", "user_559f@host-9a8b.com"),
  ],
};
const rv = new Revealer(MAP);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("Revealer.text", () => {
  test("restores each pseudonym to the value the map records", () => {
    const r = rv.text("Person_4C1D met Person_A7F3 at 203.0.113.7 (ticket 731905).");
    expect(r.text).toBe("Robin Example met Quill, Avery at 192.0.2.10 (ticket 004217).");
    expect(r.restored).toBe(4);
  });

  test("matches whole tokens only: not inside a longer number, word or dotted name", () => {
    const s = "7319050 x731905 203.0.113.70 10.203.0.113.7 Person_4C1Dx";
    expect(rv.text(s)).toEqual({ text: s, restored: 0 });
  });

  test("the longest host wins, so a host that ends in another host's pseudonym is restored whole", () => {
    expect(rv.text("see host-1a2b.host-3c4d.host-5e6f.com and host-3c4d.host-5e6f.com.").text).toBe("see app01.corp.example.com and corp.example.com.");
  });

  test("a GUID comes back in the case it was written, inside its braces", () => {
    expect(rv.text("{4B1D2C3E-5F60-4A7B-8C9D-0E1F2A3B4C5D}").text).toBe("{0F8FAD5B-D9CB-469F-A165-70867728950E}");
    expect(rv.text("4b1d2c3e-5f60-4a7b-8c9d-0e1f2a3b4c5d").text).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
  });

  test("components are never restored on their own; text with no pseudonym is unchanged", () => {
    expect(rv.text("host-1a2b alone").text).toBe("host-1a2b alone");
    expect(new Revealer({ version: 1, entries: [] }).text("Person_4C1D")).toEqual({ text: "Person_4C1D", restored: 0 });
  });

  test("underscores separate tokens, as in blinded file names", () => {
    expect(rv.text("Person_4C1D_user_559f@host-9a8b.com").text).toBe("Robin Example_jo.sample@example.com");
  });
});

describe("Revealer.path", () => {
  test("restores folder names and the file name, never the extension", () => {
    expect(rv.path("reviews/Person_4C1D/Person_A7F3.md")).toEqual({ text: "reviews/Robin Example/Quill, Avery.md", restored: 2 });
    expect(rv.path("plain/notes.txt")).toEqual({ text: "plain/notes.txt", restored: 0 });
  });

  test("refuses a restored name that is not usable as a name", () => {
    const slash = new Revealer({ version: 1, entries: [entry("org", "a/b", "A/B", "Org_1111")] });
    expect(() => slash.path("Org_1111.txt")).toThrow(RevealError);
  });
});

describe("revealFile", () => {
  test("CSV: a restored value that needs quoting is quoted; untouched cells stay byte for byte", () => {
    const out = revealFile("staff.csv", bytes('Owner,Note\r\nPerson_A7F3,"kept, as is"\r\nPerson_4C1D,x\r\n'), rv);
    expect(text(out.bytes)).toBe('Owner,Note\r\n"Quill, Avery","kept, as is"\r\nRobin Example,x\r\n');
    expect(out.restored).toBe(2);
  });

  test("TSV uses tabs", () => {
    expect(text(revealFile("a.tsv", bytes("Owner\tHost\nPerson_4C1D\t203.0.113.7\n"), rv).bytes)).toBe("Owner\tHost\nRobin Example\t192.0.2.10\n");
  });

  test("JSON: strings are spliced with untouched escapes kept; a number restored to a non-number is quoted; keys too", () => {
    const src = '{"owner": "Person_A7F3 \\u00e9", "ref": 731905, "731905": {"by": "Person_4C1D"}}\n';
    expect(text(revealFile("t.json", bytes(src), rv).bytes)).toBe('{"owner": "Quill, Avery \\u00e9", "ref": "004217", "004217": {"by": "Robin Example"}}\n');
  });

  test("JSON: two keys of one object revealing to one name are refused", () => {
    const m = new Revealer({ version: 1, entries: [entry("person", "a", "Same", "Person_1111"), entry("person", "b", "Same", "Person_2222")] });
    expect(() => revealFile("t.json", bytes('{"Person_1111": 1, "Person_2222": 2}'), m)).toThrow(RevealError);
  });

  test("JSONL stays one record per line", () => {
    expect(text(revealFile("t.jsonl", bytes('{"o":"Person_4C1D"}\n{"o":"Person_A7F3"}\n'), rv).bytes)).toBe('{"o":"Robin Example"}\n{"o":"Quill, Avery"}\n');
  });

  test("text keeps its encoding; a file with nothing to restore is returned as is", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi Person_4C1D\n", "utf16le")]);
    const out = revealFile("n.txt", utf16, rv);
    expect(Buffer.from(out.bytes)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi Robin Example\n", "utf16le")]));
    const same = bytes("nothing here\n");
    expect(revealFile("n.md", same, rv).bytes).toBe(same);
  });

  test("formats with no reversal path, and files that do not parse, are refused", () => {
    expect(() => revealFile("scan.pdf", bytes("%PDF"), rv)).toThrow(/no reversal path for \.pdf/);
    expect(() => revealFile("book.xlsx", bytes("PK"), rv)).toThrow(/cannot read it as XLSX/);
    expect(() => revealFile("doc.docx", bytes("PK"), rv)).toThrow(RevealError);
    expect(() => revealFile("noext", bytes("x"), rv)).toThrow(/no extension/);
    expect(() => revealFile("bad.json", bytes("{"), rv)).toThrow(RevealError);
    expect(() => revealFile("bad.csv", bytes('"open'), rv)).toThrow(RevealError);
  });
});

test("a CSV blinded by the engine reveals back byte for byte", () => {
  const spec: Spec = {
    version: 1,
    columns: [
      { file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
      { file: "staff.csv", header: "Box", class: "host", treatment: "blind", confidence: 1, source: "human" },
      { file: "staff.csv", header: "Ref", class: "id", treatment: "blind", confidence: 1, source: "human" },
      { file: "staff.csv", header: "Status", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
    ],
    entities: {},
    patterns: { ip: true, email: true, host: true, guid: true, mac: false },
    questions: [],
  };
  const csv = 'Owner,Box,Ref,Status\n"Quill, Avery",192.0.2.10,004217,open\nRobin Example,app01.corp.example.com,004218,closed\n';
  const result = applySpec([{ path: "staff.csv", bytes: bytes(csv) }], spec, { salt: Uint8Array.from({ length: 32 }, (_, i) => i + 7) });
  const blinded = result.outputs[0]?.bytes as Uint8Array;
  expect(text(blinded)).not.toContain("Avery");
  expect(text(revealFile("staff.csv", blinded, new Revealer(result.map)).bytes)).toBe(csv);
});
