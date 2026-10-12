// Byte-faithful decoding: a file is decoded to a string and later re-encoded the same way, so untouched
// text round-trips to the original bytes. UTF-8 (with or without BOM) and BOM-marked UTF-16 are the only
// text encodings the engine reads. Anything else is 8-bit text that is not UTF-8, and it is refused
// (AGT-1857): guessing a code page is unreliable, so the engine never decodes it, never writes it, and
// the user re-saves the file as UTF-8. The same refusal applies to profile, plan, apply and reveal.

export type Encoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";

export class EncodingError extends Error {
  override name = "EncodingError";
}

/** The refusal reason for 8-bit text that is not UTF-8 (no byte-order mark). */
export const NOT_UTF8 = "not UTF-8: save the file as UTF-8 and run again";

const hasBom = (b: Uint8Array): boolean =>
  (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);

/** True for bytes the engine refuses: no byte-order mark and not valid UTF-8 (8-bit text, or binary). */
export function isEightBit(bytes: Uint8Array): boolean {
  if (hasBom(bytes)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
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
    throw new EncodingError(NOT_UTF8);
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
  }
}
