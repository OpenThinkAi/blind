// AGT-2731: the engine's pure-JS SHA-256 and HMAC-SHA256 against RFC 4231 and node:crypto. This
// test may import node:crypto; src/engine/sha256.ts, and every other file under src/engine, may not.

import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSha256, sha256, toHex, utf8 } from "../../src/engine/sha256.ts";
import { mulberry32 } from "../../src/bench/synth.ts";

const hex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
const repeat = (byte: number, n: number): Uint8Array => new Uint8Array(n).fill(byte);
const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "latin1"));

// RFC 4231 section 4, HMAC-SHA-256 results. Case 5's output is truncated to 128 bits.
const RFC4231: { key: Uint8Array; data: Uint8Array; mac: string; truncate?: number }[] = [
  { key: repeat(0x0b, 20), data: ascii("Hi There"), mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7" },
  { key: ascii("Jefe"), data: ascii("what do ya want for nothing?"), mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843" },
  { key: repeat(0xaa, 20), data: repeat(0xdd, 50), mac: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe" },
  { key: hex("0102030405060708090a0b0c0d0e0f10111213141516171819"), data: repeat(0xcd, 50), mac: "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b" },
  { key: repeat(0x0c, 20), data: ascii("Test With Truncation"), mac: "a3b6167473100ee06e0c796c2955552b", truncate: 16 },
  { key: repeat(0xaa, 131), data: ascii("Test Using Larger Than Block-Size Key - Hash Key First"), mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54" },
  {
    key: repeat(0xaa, 131),
    data: ascii("This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."),
    mac: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
  },
];

describe("hmacSha256", () => {
  test("matches the RFC 4231 test vectors", () => {
    RFC4231.forEach(({ key, data, mac, truncate }, i) => {
      expect({ case: i + 1, mac: toHex(hmacSha256(key, data).slice(0, truncate ?? 32)) }).toEqual({ case: i + 1, mac });
    });
  });

  test("matches node:crypto for 1,000 random keys and messages", () => {
    const rnd = mulberry32(2731);
    const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
    // Lengths around the 64-byte block and the 55/56-byte padding edge come up often.
    const EDGES = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129];
    const len = (max: number): number => (rnd() < 0.3 ? (EDGES[Math.floor(rnd() * EDGES.length)] as number) : Math.floor(rnd() * max));
    for (let i = 0; i < 1000; i++) {
      const key = bytes(len(200));
      const msg = bytes(len(1200));
      const want = createHmac("sha256", key).update(msg).digest("hex");
      expect({ i, mac: toHex(hmacSha256(key, msg)) }).toEqual({ i, mac: want });
    }
  });

  test("returns 32 bytes and leaves its inputs alone", () => {
    const key = repeat(0x42, 70);
    const msg = repeat(0x17, 10);
    expect(hmacSha256(key, msg)).toHaveLength(32);
    expect(key.every((b) => b === 0x42) && msg.every((b) => b === 0x17)).toBe(true);
  });
});

describe("sha256", () => {
  test("matches the FIPS 180-4 examples and node:crypto across block edges", () => {
    expect(toHex(sha256(new Uint8Array()))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(sha256(ascii("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(toHex(sha256(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    for (let n = 0; n <= 300; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect({ n, d: toHex(sha256(data)) }).toEqual({ n, d: createHash("sha256").update(data).digest("hex") });
    }
    const big = repeat(0x61, 1_000_000);
    expect(toHex(sha256(big))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });
});

describe("utf8 and toHex", () => {
  test("encode text the way node:crypto's utf8 input does, lone surrogates included", () => {
    const key = repeat(0x09, 32);
    for (const s of ["", "plain", "Zoë Ñandú", "名前", "\u{1F600}", "a\ud800b", "\udc00", "x\0#3"]) {
      expect({ s, mac: toHex(hmacSha256(key, utf8(s))) }).toEqual({ s, mac: createHmac("sha256", key).update(s, "utf8").digest("hex") });
    }
  });

  test("toHex is lowercase, two digits a byte", () => {
    expect(toHex(Uint8Array.from([0, 9, 10, 255]))).toBe("00090aff");
  });
});

describe("imports", () => {
  test("src/engine/sha256.ts imports nothing", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/engine/sha256.ts"), "utf8");
    expect(src).not.toMatch(/^\s*(import|export)\b[^;]*\bfrom\b/m);
    expect(src).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
  });

  test("no file under src/engine imports node:crypto", () => {
    const dir = join(import.meta.dir, "../../src/engine");
    const hits = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts") && /from\s+["'](node:)?crypto["']|require\(\s*["'](node:)?crypto["']\s*\)/.test(readFileSync(join(dir, f), "utf8")));
    expect(hits).toEqual([]);
  });
});
