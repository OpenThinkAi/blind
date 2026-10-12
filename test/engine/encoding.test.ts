import { describe, expect, test } from "bun:test";
import { decode, type Encoding, EncodingError, encode, isEightBit, NOT_UTF8 } from "../../src/engine/encoding.ts";

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
  }
};

describe("decode / encode", () => {
  test.each(["utf8", "utf8-bom", "utf16le", "utf16be"] as const)("%s is detected and round-trips", (enc) => {
    const bytes = bytesFor(enc);
    const d = decode(bytes);
    expect(d.encoding).toBe(enc);
    expect(d.text).toBe(SAMPLE);
    expect(Buffer.from(encode(d.text, enc)).equals(Buffer.from(bytes))).toBe(true);
  });

  test("a UTF-16 BOM over an odd byte count is an error", () => {
    expect(() => decode(Uint8Array.from([0xff, 0xfe, 0x41]))).toThrow(EncodingError);
  });
});

describe("8-bit text that is not UTF-8 is refused (AGT-1857)", () => {
  test("bytes that are not valid UTF-8 and have no BOM are refused with the stated reason", () => {
    const bytes = Uint8Array.from([0x41, 0x80, 0x9f, 0xff, 0x0a]);
    expect(isEightBit(bytes)).toBe(true);
    expect(() => decode(bytes)).toThrow(EncodingError);
    expect(() => decode(bytes)).toThrow(NOT_UTF8);
    expect(NOT_UTF8).toBe("not UTF-8: save the file as UTF-8 and run again");
  });

  test("cp1252 punctuation (0x80-0x9F) is refused, not decoded as characters", () => {
    expect(() => decode(Uint8Array.from([0x80, 0x85, 0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x99, 0x9f, 0xe9]))).toThrow(NOT_UTF8);
  });

  test("the five bytes cp1252 leaves undefined are refused too", () => {
    expect(() => decode(Uint8Array.from([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0xe9]))).toThrow(NOT_UTF8);
  });

  test("a single 8-bit byte in an otherwise ASCII file is refused", () => {
    expect(() => decode(Buffer.from("Call \xd3scar Example back.\n", "latin1"))).toThrow(NOT_UTF8);
  });

  test("valid UTF-8 and BOM-marked text are not 8-bit", () => {
    expect(isEightBit(Buffer.from("Zürich", "utf8"))).toBe(false);
    expect(isEightBit(bytesFor("utf8-bom"))).toBe(false);
    expect(isEightBit(bytesFor("utf16le"))).toBe(false);
  });

  test("encode writes only the encodings the engine still reads", () => {
    expect(encode("a", "utf16le").length).toBe(4);
    expect(encode("Ω", "utf8").length).toBe(2);
  });
});
