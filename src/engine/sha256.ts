// SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104), synchronous, over Uint8Array (AGT-2731, D-24).
// The engine is synchronous and a browser has no synchronous HMAC, so the engine computes its
// stand-ins with this module instead of node:crypto. It imports nothing: no node: or bun module,
// so it bundles for a browser. Output is byte-identical to node:crypto's createHash("sha256") and
// createHmac("sha256", key); test/engine/sha256.test.ts checks both against it and RFC 4231.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INIT = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const BLOCK = 64;
const encoder = new TextEncoder();

/** Compress the 64-byte blocks of `p` (whose length is a multiple of 64) into the state `h`. */
function compress(h: Int32Array, p: Uint8Array, w: Int32Array): void {
  for (let off = 0; off < p.length; off += BLOCK) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((p[j] as number) << 24) | ((p[j + 1] as number) << 16) | ((p[j + 2] as number) << 8) | (p[j + 3] as number);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let k = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (k + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + k) | 0;
  }
}

/** SHA-256 of `parts` taken as one message, concatenated in order. */
function digestParts(parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const part of parts) len += part.length;
  // Message, a 0x80 byte, zeros to 56 mod 64, then the bit length as a 64-bit big-endian integer.
  const padded = new Uint8Array(Math.ceil((len + 9) / BLOCK) * BLOCK);
  let at = 0;
  for (const part of parts) {
    padded.set(part, at);
    at += part.length;
  }
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
  view.setUint32(padded.length - 4, (len * 8) >>> 0, false);
  const h = Int32Array.from(INIT);
  compress(h, padded, new Int32Array(64));
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setInt32(i * 4, h[i] as number, false);
  return out;
}

/** SHA-256 of `data`: 32 bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  return digestParts([data]);
}

/** HMAC-SHA256 of `message` under `key` (any length; a key over 64 bytes is hashed first): 32 bytes. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = new Uint8Array(BLOCK);
  k.set(key.length > BLOCK ? sha256(key) : key);
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = (k[i] as number) ^ 0x36;
    opad[i] = (k[i] as number) ^ 0x5c;
  }
  return digestParts([opad, digestParts([ipad, message])]);
}

/** UTF-8 bytes of `s`; a lone surrogate becomes U+FFFD, as node:crypto's "utf8" input encoding does. */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += (b < 16 ? "0" : "") + b.toString(16);
  return out;
}
