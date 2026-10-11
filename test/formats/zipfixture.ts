// Synthetic zip builder and reader for tests, written independently of
// src/formats/ooxml.ts so each checks the other. Fixed DOS timestamp
// (1980-01-01 00:00), entries in the order given.

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { crc32 } from "../../src/formats/ooxml.ts";

export interface FixtureEntry {
  name: string;
  data: string | Uint8Array;
  method?: 0 | 8;
  /** Write sizes in a trailing data descriptor (flag bit 3), with or without its signature. */
  descriptor?: "signed" | "unsigned";
}

const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

export function buildZip(entries: FixtureEntry[], comment = ""): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  for (const e of entries) {
    const plain = typeof e.data === "string" ? new TextEncoder().encode(e.data) : e.data;
    const method = e.method ?? 8;
    const data = method === 8 ? deflateRawSync(plain) : plain;
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(plain);
    const flags = 0x0800 | (e.descriptor ? 8 : 0);
    const offset = local.length;
    u32(local, 0x04034b50); u16(local, 20); u16(local, flags); u16(local, method); u16(local, DOS_TIME); u16(local, DOS_DATE);
    u32(local, e.descriptor ? 0 : crc); u32(local, e.descriptor ? 0 : data.length); u32(local, e.descriptor ? 0 : plain.length);
    u16(local, name.length); u16(local, 0);
    local.push(...name, ...data);
    if (e.descriptor) {
      if (e.descriptor === "signed") u32(local, 0x08074b50);
      u32(local, crc); u32(local, data.length); u32(local, plain.length);
    }
    u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, flags); u16(central, method); u16(central, DOS_TIME); u16(central, DOS_DATE);
    u32(central, crc); u32(central, data.length); u32(central, plain.length);
    u16(central, name.length); u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, offset);
    central.push(...name);
  }
  const c = new TextEncoder().encode(comment);
  const end: number[] = [];
  u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, entries.length); u16(end, entries.length);
  u32(end, central.length); u32(end, local.length); u16(end, c.length);
  return new Uint8Array([...local, ...central, ...end, ...c]);
}

export interface ReadEntry {
  name: string;
  method: number;
  time: number;
  date: number;
  text: string;
}

/** Read every member through the central directory, checking CRCs. */
export function readZip(bytes: Uint8Array): ReadEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22 - v.getUint16(bytes.length - 2, true);
  if (v.getUint32(eocd, true) !== 0x06054b50) throw new Error("fixture reader: no EOCD (comments with zero length only)");
  const out: ReadEntry[] = [];
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const off = v.getUint32(p + 42, true);
    const start = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const raw = bytes.subarray(start, start + csize);
    const plain = method === 8 ? inflateRawSync(raw) : raw;
    if (crc32(plain) !== crc) throw new Error(`fixture reader: CRC mismatch in ${name}`);
    out.push({ name, method, time: v.getUint16(p + 12, true), date: v.getUint16(p + 14, true), text: new TextDecoder().decode(plain) });
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}
