// Rewriting Office's per-document linking IDs (positions: src/formats/officeids.ts). Nothing
// of the original value survives:
//
// - a GUID gets an `id` pseudonym, braces and case kept. It goes in the map like every other
//   pseudonym, so a GUID Office wrote is replaced by the same pseudonym wherever it repeats
//   (an x14:cfRule id and the x14:id that points at it, a threaded comment and its legacy
//   comment), and the audit recognises it;
// - a hex value (Word's rsids, paragraph and text ids, durable ids) gets a same-length hex value
//   derived with HMAC-SHA256 under the corpus salt, in the same case. An 8-digit value under
//   0x80000000 stays under it and non-zero, as Word requires of paragraph ids. These values are
//   not in the map: they carry no identity, only a link, and `blind reveal` does not restore them;
// - anything else at such a position is replaced whole with an `id` pseudonym.
//
// The same value gets the same replacement everywhere in the corpus, so the references between
// parts (a comment's paragraph id, a list's id, a content control's data store) still resolve.
// Deterministic: HMAC only, values derived in sorted order before rendering.

import { createHmac } from "node:crypto";
import { guidCore, type PseudoClass } from "./canonical.ts";
import type { LinkShape } from "../formats/officeids.ts";

export interface IdNamer {
  pseudonym(cls: PseudoClass, value: string): string;
}

/** Hands out hex replacements; a recorder while planning. */
export interface HexNamer {
  hex(value: string): string;
}

export class OfficeIdError extends Error {
  override name = "OfficeIdError";
}

const HEX = /^[0-9A-Fa-f]{1,64}$/;
const MAX_ATTEMPTS = 10_000;

/** Same-length hex replacements for hex linking IDs, keyed on the value (case-folded). */
export class OfficeIds implements HexNamer {
  private readonly out = new Map<string, string>();
  private readonly issued = new Set<string>();
  constructor(private readonly salt: Uint8Array) {}

  hex(value: string): string {
    if (!HEX.test(value)) throw new OfficeIdError("not a hex value");
    const key = value.toLowerCase();
    let got = this.out.get(key);
    if (got === undefined) {
      got = this.derive(key);
      this.out.set(key, got);
      this.issued.add(got);
    }
    return value === value.toUpperCase() ? got.toUpperCase() : got;
  }

  private derive(key: string): string {
    const n = key.length;
    const below = n === 8 && Number.parseInt(key[0] as string, 16) < 8;
    for (let counter = 0; counter < MAX_ATTEMPTS; counter++) {
      const digest = createHmac("sha256", this.salt).update(`office-id\0${key}\0${counter}`, "utf8").digest("hex");
      let c = digest.slice(0, n);
      if (below) c = (Number.parseInt(c[0] as string, 16) & 7).toString(16) + c.slice(1);
      if (c === key || this.issued.has(c)) continue;
      if (below && (/^0+$/.test(c) || c === "7fffffff")) continue;
      return c;
    }
    throw new OfficeIdError(`no free ${n}-digit hex id after ${MAX_ATTEMPTS} attempts`);
  }
}

const DOCUMENT_ID = /^(\d+_(?:[A-Za-z]+:\d+_)?)(.+)$/;

function rewritePart(part: string, pz: IdNamer, hex: HexNamer): string | null {
  if (guidCore(part) !== undefined) {
    // Office writes GUIDs in upper case; one with no letters at all ("{00000000-0001-...}") stays upper case too.
    const g = pz.pseudonym("id", part);
    return /[a-f]/.test(part) ? g : g.toUpperCase();
  }
  if (HEX.test(part)) return hex.hex(part);
  return null;
}

/**
 * The replacement for the linking ID `value` at a position of shape `shape`. While planning, pass
 * recorders: every pseudonym and hex value the render will need is asked for here, so the caller can
 * derive them in sorted order first.
 */
export function rewriteOfficeId(shape: LinkShape, value: string, pz: IdNamer, hex: HexNamer): string {
  if (value === "") return value;
  if (shape === "documentId") {
    // "8_{GUID}", "13_ncr:1_{GUID}_{GUID}", "11_<hex>": the version prefix is kept.
    const m = DOCUMENT_ID.exec(value);
    if (m) {
      const parts = (m[2] as string).split("_").map((p) => rewritePart(p, pz, hex));
      if (parts.every((p) => p !== null)) return (m[1] as string) + parts.join("_");
    }
  } else {
    const r = rewritePart(value, pz, hex);
    if (r !== null) return r;
  }
  return pz.pseudonym("id", value);
}
