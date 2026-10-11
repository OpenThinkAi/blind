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
