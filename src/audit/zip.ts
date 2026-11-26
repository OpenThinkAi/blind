// A minimal, read-only zip reader for the audit: the central directory, each
// member's name and its decompressed bytes (stored or deflated). It never
// writes, never follows paths and never throws on a bad member: a member it
// cannot decode is returned with the reason, so the audit can say so.

import { NO_ZIP_CODEC_REASON, zipCodec } from "../formats/zipcodec.ts";
import { latin1 } from "./views.ts";

/** Largest decompressed member the audit inflates; anything bigger is reported, not read. */
export const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
/** Most decompressed bytes the audit inflates for one top-level file, nested archives included. */
export const MAX_INFLATE_BYTES = 1024 * 1024 * 1024;

/**
 * What is left of one top-level file's decompression allowance. A caller that opens nested
 * archives passes the same budget to every readZip for that file, so a nested zip bomb is
 * bounded as a whole, not per level; members past it are reported, not read.
 */
export interface ZipBudget {
  left: number;
}

export function zipBudget(): ZipBudget {
  return { left: MAX_INFLATE_BYTES };
}

export interface ZipMember {
  name: string;
  /** Byte ranges in the archive that hold this member's name (local header and central directory). */
  nameRanges: [number, number][];
  /** Byte range of the member's stored (possibly compressed) data in the archive. */
  dataRange: [number, number];
  /** Decompressed content, when it could be decoded. */
  bytes?: Uint8Array;
  /** Why the content could not be decoded. */
  error?: string;
}

export class ZipError extends Error {
  override name = "ZipError";
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function looksLikeZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));
}

/** The archive's fields, read little-endian; a read past the end throws RangeError, as Buffer's readers did. */
interface Reader {
  u16(at: number): number;
  u32(at: number): number;
}

function reader(b: Uint8Array): Reader {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { u16: (at) => v.getUint16(at, true), u32: (at) => v.getUint32(at, true) };
}

/** Member names flagged UTF-8 (bit 11): invalid sequences become U+FFFD and a leading U+FEFF is kept. */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

function findEocd(b: Uint8Array, r: Reader): number {
  const min = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= min; i--) {
    if (r.u32(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Reads the archive's directory and every member. Throws ZipError only when there is no readable directory at all. */
export function readZip(bytes: Uint8Array, budget: ZipBudget = zipBudget()): ZipMember[] {
  const b = bytes;
  const r = reader(b);
  const eocd = b.length >= 22 ? findEocd(b, r) : -1;
  if (eocd < 0) throw new ZipError("no end-of-central-directory record");
  const count = r.u16(eocd + 10);
  const cdOffset = r.u32(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  const members: ZipMember[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || r.u32(p) !== CEN_SIG) throw new ZipError(`central directory entry ${n + 1} is corrupt`);
    const flags = r.u16(p + 8);
    const method = r.u16(p + 10);
    const compSize = r.u32(p + 20);
    const size = r.u32(p + 24);
    const nameLen = r.u16(p + 28);
    const extraLen = r.u16(p + 30);
    const commentLen = r.u16(p + 32);
    const local = r.u32(p + 42);
    const rawName = b.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? UTF8.decode(rawName) : latin1(rawName);
    const member: ZipMember = { name, nameRanges: [[p + 46, p + 46 + nameLen]], dataRange: [0, 0] };
    members.push(member);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      member.error = "ZIP64 member, not decoded";
      continue;
    }
    if (local + 30 > b.length || r.u32(local) !== LOC_SIG) {
      member.error = "local header missing or corrupt, not decoded";
      continue;
    }
    const lNameLen = r.u16(local + 26);
    const lExtraLen = r.u16(local + 28);
    member.nameRanges.push([local + 30, local + 30 + lNameLen]);
    const start = local + 30 + lNameLen + lExtraLen;
    const end = start + compSize;
    if (end > b.length) {
      member.error = "data runs past the end of the archive, not decoded";
      continue;
    }
    member.dataRange = [start, end];
    if (flags & 0x1) {
      member.error = "encrypted member, not decoded";
      continue;
    }
    const data = b.subarray(start, end);
    if (method === 0) {
      member.bytes = data;
    } else if (method === 8) {
      if (size > MAX_MEMBER_BYTES) {
        member.error = `declared size ${size} bytes exceeds the ${MAX_MEMBER_BYTES}-byte limit, not decoded`;
        continue;
      }
      if (size > budget.left || budget.left <= 0) {
        member.error = `decompressing it would pass the ${MAX_INFLATE_BYTES}-byte limit for one file, not decoded`;
        continue;
      }
      const codec = zipCodec();
      if (codec === null) {
        member.error = `${NO_ZIP_CODEC_REASON} (no zip codec installed), not decoded`;
        continue;
      }
      try {
        member.bytes = codec.inflateRaw(data, Math.min(MAX_MEMBER_BYTES, budget.left));
        // Charge the larger of the declared and actual sizes: a member may under-declare.
        budget.left -= Math.max(size, member.bytes.length);
      } catch {
        member.error = "deflate data could not be decoded";
      }
    } else {
      member.error = `compression method ${method} not supported, not decoded`;
    }
  }
  return members;
}
