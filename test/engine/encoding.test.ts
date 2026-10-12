import { describe, expect, test } from "bun:test";
import { decode, type Encoding, EncodingError, encode } from "../../src/engine/encoding.ts";

const SAMPLE = "Name,Ort\nAvery Quill,Zürich\n";

const bytesFor = (enc: Encoding): Uint8Array => {
  switch (enc) {
    case "utf8":
      return Buffer.from(SAMPLE, "utf8");
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SAMPLE, "utf8")]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE, "utf16le")]);
    case "utf16be":
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(SAMPLE, "utf16le").swap16()]);
    case "latin1":
      return Buffer.from(SAMPLE, "latin1");
  }
};

describe("decode / encode", () => {
  test.each(["utf8", "utf8-bom", "utf16le", "utf16be", "latin1"] as const)("%s is detected and round-trips", (enc) => {
    const bytes = bytesFor(enc);
    const d = decode(bytes);
    expect(d.encoding).toBe(enc);
    expect(d.text).toBe(SAMPLE);
    expect(Buffer.from(encode(d.text, enc)).equals(Buffer.from(bytes))).toBe(true);
  });

  test("bytes that are not UTF-8 fall back to Latin-1 and round-trip exactly", () => {
    const bytes = Uint8Array.from([0x41, 0x80, 0x9f, 0xff, 0x0a]);
    const d = decode(bytes);
    expect(d.encoding).toBe("latin1");
    expect(Buffer.from(encode(d.text, "latin1")).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a UTF-16 BOM over an odd byte count is an error", () => {
    expect(() => decode(Uint8Array.from([0xff, 0xfe, 0x41]))).toThrow(EncodingError);
  });

  test("Latin-1 refuses text outside 8 bits instead of mangling it", () => {
    expect(() => encode("Ω", "latin1")).toThrow(EncodingError);
  });
});

describe("windows-1252 view of 8-bit text (AGT-1854)", () => {
  test("0x80-0x9F decode to their cp1252 characters and encode back", () => {
    const bytes = Uint8Array.from([0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x99, 0x9f, 0xe9]);
    const d = decode(bytes);
    expect(d.encoding).toBe("latin1");
    expect(d.text).toBe("€…‘’“”–—™Ÿé");
    expect(Buffer.from(encode(d.text, "latin1")).equals(Buffer.from(bytes))).toBe(true);
  });

  test("the five bytes cp1252 leaves undefined keep their Latin-1 code units", () => {
    const bytes = Uint8Array.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xe9]);
    const d = decode(bytes);
    expect(d.text).toBe("\u0081\u008d\u008f\u0090\u009dé");
    expect(Buffer.from(encode(d.text, "latin1")).equals(Buffer.from(bytes))).toBe(true);
  });

  test("every byte round-trips", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    bytes[0] = 0xe9; // not valid UTF-8 as a whole, so it is read as 8-bit
    const d = decode(bytes);
    expect(d.encoding).toBe("latin1");
    expect(d.text.length).toBe(256);
    expect(Buffer.from(encode(d.text, "latin1")).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a character outside the file's 8-bit encoding is refused", () => {
    expect(() => encode("a中", "latin1")).toThrow(EncodingError);
  });
});
