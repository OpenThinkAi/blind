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

export function decode(b: Uint8Array): Decoded {
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

function utf8(b: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new EncodingError(`marked ${label} but not valid UTF-8`);
  }
}

function utf16(b: Uint8Array, label: "utf-16le" | "utf-16be"): string {
  if (b.length % 2 !== 0) throw new EncodingError(`marked ${label.toUpperCase()} but has an odd number of bytes`);
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new EncodingError(`marked ${label.toUpperCase()} but not valid ${label.toUpperCase()}`);
  }
}

// Encoding uses only web-standard APIs (TextEncoder and plain byte arrays), never Node's Buffer, so the
// engine runs in a browser (D-15). The bytes are the ones Buffer wrote: TextEncoder, like Buffer's
// "utf8", writes a lone surrogate as EF BF BD; UTF-16 is written code unit by code unit, so a lone
// surrogate is kept as it is, as Buffer's "utf16le" kept it.
export function encode(text: string, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      return new TextEncoder().encode(text);
    case "utf8-bom":
      return withBom([0xef, 0xbb, 0xbf], new TextEncoder().encode(text));
    case "utf16le":
      return utf16Bytes(text, true);
    case "utf16be":
      return utf16Bytes(text, false);
  }
}

function withBom(bom: readonly number[], body: Uint8Array): Uint8Array {
  const out = new Uint8Array(bom.length + body.length);
  out.set(bom, 0);
  out.set(body, bom.length);
  return out;
}

/** The byte-order mark for the byte order, then each UTF-16 code unit of `text` in that order. */
function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = littleEndian ? 0xff : 0xfe;
  out[1] = littleEndian ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out[2 + i * 2] = littleEndian ? unit & 0xff : unit >> 8;
    out[3 + i * 2] = littleEndian ? unit >> 8 : unit & 0xff;
  }
  return out;
}
