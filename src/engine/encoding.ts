// Byte-faithful decoding: a file is decoded to a string and later re-encoded
// the same way, so untouched text round-trips to the original bytes. UTF-8
// (with or without BOM) and BOM-marked UTF-16 are decoded as such; anything
// else is read as windows-1252 (AGT-1854): 0x80-0x9F become their cp1252 characters (en/em dash,
// curly quotes, ellipsis), so the scanners see punctuation, not C1 controls. Every other byte keeps
// its Latin-1 code unit, and the five bytes cp1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D)
// stay C1 controls, so the mapping is a bijection on bytes: one byte is one code unit, offsets in
// the text are offsets in the bytes, and untouched text re-encodes to the original bytes.

export type Encoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "latin1";

export class EncodingError extends Error {
  override name = "EncodingError";
}

// cp1252 characters of bytes 0x80-0x9F; null where cp1252 defines none.
const CP1252_HIGH: readonly (number | null)[] = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];
const FROM_CP1252 = new Map<number, number>();
CP1252_HIGH.forEach((cp, i) => {
  if (cp !== null) FROM_CP1252.set(cp, 0x80 + i);
});

function latin1View(b: Buffer): string {
  let out = b.toString("latin1");
  if (!/[\x80-\x9f]/.test(out)) return out;
  out = out.replace(/[\x80-\x9f]/g, (c) => {
    const cp = CP1252_HIGH[c.charCodeAt(0) - 0x80];
    return cp === null || cp === undefined ? c : String.fromCharCode(cp);
  });
  return out;
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
    return { encoding: "latin1", text: latin1View(b) };
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
      // Replacements are ASCII, so every code unit stays a single byte; the cp1252 characters decode put
      // in place of 0x80-0x9F go back to their bytes.
      const bytes = Buffer.alloc(text.length);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        const b = c <= 0xff ? c : FROM_CP1252.get(c);
        if (b === undefined) throw new EncodingError("replacement does not fit the file's 8-bit encoding");
        bytes[i] = b;
      }
      return bytes;
    }
  }
}
