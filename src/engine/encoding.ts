// Byte-faithful decoding: a file is decoded to a string and later re-encoded
// the same way, so untouched text round-trips to the original bytes. UTF-8
// (with or without BOM) and BOM-marked UTF-16 are decoded as such; anything
// else is decoded as Latin-1, which maps every byte to one code unit and back.

export type Encoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "latin1";

export class EncodingError extends Error {
  override name = "EncodingError";
}

export interface Decoded {
  encoding: Encoding;
  text: string;
}

export function decode(bytes: Uint8Array): Decoded {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { encoding: "utf8-bom", text: utf8(b.subarray(3), "UTF-8 (BOM)") };
  }
  if (b[0] === 0xff && b[1] === 0xfe) return { encoding: "utf16le", text: utf16(b.subarray(2), "utf-16le") };
  if (b[0] === 0xfe && b[1] === 0xff) return { encoding: "utf16be", text: utf16(b.subarray(2), "utf-16be") };
  try {
    return { encoding: "utf8", text: new TextDecoder("utf-8", { fatal: true }).decode(b) };
  } catch {
    return { encoding: "latin1", text: b.toString("latin1") };
  }
}

function utf8(b: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new EncodingError(`marked ${label} but not valid UTF-8`);
  }
}

function utf16(b: Buffer, label: "utf-16le" | "utf-16be"): string {
  if (b.length % 2 !== 0) throw new EncodingError(`marked ${label.toUpperCase()} but has an odd number of bytes`);
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new EncodingError(`marked ${label.toUpperCase()} but not valid ${label.toUpperCase()}`);
  }
}

export function encode(text: string, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return Buffer.from(text, "utf8");
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf16be":
      return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
    case "latin1": {
      // Replacements are ASCII, so every code unit stays a single byte.
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0xff) throw new EncodingError("replacement does not fit the file's 8-bit encoding");
      }
      return Buffer.from(text, "latin1");
    }
  }
}
