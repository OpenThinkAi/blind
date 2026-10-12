// A minimal, read-only zip reader for the audit: the central directory, each
// member's name and its decompressed bytes (stored or deflated). It never
// writes, never follows paths and never throws on a bad member: a member it
// cannot decode is returned with the reason, so the audit can say so.

import { inflateRawSync } from "node:zlib";

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

function findEocd(b: Buffer): number {
  const min = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Reads the archive's directory and every member. Throws ZipError only when there is no readable directory at all. */
export function readZip(bytes: Uint8Array, budget: ZipBudget = zipBudget()): ZipMember[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = b.length >= 22 ? findEocd(b) : -1;
  if (eocd < 0) throw new ZipError("no end-of-central-directory record");
  const count = b.readUInt16LE(eocd + 10);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported");
  const members: ZipMember[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== CEN_SIG) throw new ZipError(`central directory entry ${n + 1} is corrupt`);
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const compSize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const rawName = b.subarray(p + 46, p + 46 + nameLen);
    const name = flags & 0x800 ? rawName.toString("utf8") : rawName.toString("latin1");
    const member: ZipMember = { name, nameRanges: [[p + 46, p + 46 + nameLen]], dataRange: [0, 0] };
    members.push(member);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
      member.error = "ZIP64 member, not decoded";
      continue;
    }
    if (local + 30 > b.length || b.readUInt32LE(local) !== LOC_SIG) {
      member.error = "local header missing or corrupt, not decoded";
      continue;
    }
    const lNameLen = b.readUInt16LE(local + 26);
    const lExtraLen = b.readUInt16LE(local + 28);
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
      try {
        member.bytes = inflateRawSync(data, { maxOutputLength: Math.min(MAX_MEMBER_BYTES, budget.left) });
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
