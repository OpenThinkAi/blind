// Name blinding: file names, folder names, and the name slots inside a format
// (worksheet names, defined names) are rewritten through the same patterns,
// spec entities and pseudonymised column values as the content, so a value
// hidden in a cell cannot reappear in the name of the file it sits in.
//
// Two phases, like the rest of the engine. `plan` every name first (this finds
// the spans and lists the pseudonyms they need, which the caller feeds to the
// pseudonymizer in sorted order with everything else); then `rename` each one.
// A name that was not planned cannot be renamed, so no pseudonym is ever
// derived out of order.
//
// Format handlers use the "sheet" and "definedName" slots: they list their
// names at plan time and call `rename` while rendering. Those slots are checked
// against the spreadsheet naming rules, and a rename that would break them
// throws NameError rather than writing a workbook the application refuses.

import type { PseudoClass } from "./canonical.ts";
import type { Pseudonymizer } from "./pseudonym.ts";
import type { PatternName } from "../schema.ts";
import { type EntityMatcher, findSpans, type Span } from "./text.ts";

export type NameSlot = "file" | "folder" | "sheet" | "definedName";

/** A rewritten name breaks the rules of its slot. */
export class NameError extends Error {
  override name = "NameError";
}

export interface PseudonymRequest {
  cls: PseudoClass;
  value: string;
}

// Worksheet names: at most 31 characters, none of []:*?/\, and no apostrophe at either end.
const SHEET_MAX = 31;
const SHEET_FORBIDDEN = /[[\]:*?/\\]/;
// Defined names: a letter, underscore or backslash first, then letters, digits, "_" and ".".
const DEFINED_NAME_RE = /^[\p{L}_\\][\p{L}\p{N}_.]*$/u;
const DEFINED_NAME_MAX = 255;

/** Why `name` cannot fill `slot`, or null when it can. */
function violation(slot: NameSlot, name: string): string | null {
  if (slot === "sheet") {
    if ([...name].length > SHEET_MAX) return `is longer than ${SHEET_MAX} characters`;
    if (SHEET_FORBIDDEN.test(name) || name.startsWith("'") || name.endsWith("'")) {
      return "contains a character a worksheet name may not have";
    }
  }
  if (slot === "definedName" && (!DEFINED_NAME_RE.test(name) || name.length > DEFINED_NAME_MAX)) {
    return "is not a valid defined name";
  }
  return null;
}

/** `value` with each span replaced by its pseudonym; spans with no class are kept as written. */
export function rewriteSpans(value: string, spans: readonly Span[], pz: Pseudonymizer): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += value.slice(at, s.start) + (s.cls === null ? value.slice(s.start, s.end) : pz.pseudonym(s.cls, s.value));
    at = s.end;
  }
  return out + value.slice(at);
}

/** The part of a file name that is rewritten: everything before the extension the engine read it by. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

export class NameRewriter {
  private readonly planned = new Map<string, Span[]>();

  /**
   * `matcher` holds the spec entities and the pseudonymised column values; `keep` the keep-list
   * domains (from keepDomains).
   */
  constructor(
    private readonly matcher: EntityMatcher,
    private readonly patterns: Record<PatternName, boolean>,
    private readonly keep: readonly string[] = [],
  ) {}

  /**
   * The spans in one name. Names join words with "_" ("backup_db01.example.com", "Robin
   * Example_avery@example.com"), which the pattern boundaries read as part of a token, so the
   * name is searched both whole and piece by piece between underscores, and the spans are merged
   * leftmost first, then longest: whichever reading reaches an identifier first wins it.
   */
  private find(name: string): Span[] {
    const candidates = findSpans(name, this.matcher, this.patterns, this.keep);
    if (name.includes("_")) {
      let offset = 0;
      for (const piece of name.split("_")) {
        for (const s of findSpans(piece, this.matcher, this.patterns, this.keep)) {
          candidates.push({ ...s, start: s.start + offset, end: s.end + offset });
        }
        offset += piece.length + 1;
      }
    }
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    const out: Span[] = [];
    let taken = 0;
    for (const s of candidates) {
      if (s.start < taken) continue;
      out.push(s);
      taken = s.end;
    }
    return out;
  }

  /** Pass 1: find the spans in a name. Planning the same name twice is a no-op. */
  plan(slot: NameSlot, name: string): void {
    const key = `${slot}\0${name}`;
    if (!this.planned.has(key)) this.planned.set(key, this.find(name));
  }

  /** Pass 1, for a "/"-separated output path: each folder whole, the file name without its extension. */
  planPath(path: string): void {
    const segments = path.split("/");
    const last = segments.pop() as string;
    for (const s of segments) this.plan("folder", s);
    this.plan("file", splitExtension(last)[0]);
  }

  /** Every pseudonym the planned names need, for the caller's sorted derivation. */
  requests(): PseudonymRequest[] {
    const out: PseudonymRequest[] = [];
    for (const spans of this.planned.values()) {
      for (const s of spans) if (s.cls !== null) out.push({ cls: s.cls, value: s.value });
    }
    return out;
  }

  /** Pass 2: the blinded name. Throws NameError when the result breaks the slot's naming rules. */
  rename(slot: NameSlot, name: string, pz: Pseudonymizer): string {
    const spans = this.planned.get(`${slot}\0${name}`);
    if (spans === undefined) throw new Error(`name not planned before rename (${slot})`);
    const renamed = rewriteSpans(name, spans, pz);
    const why = renamed === name ? null : violation(slot, renamed);
    if (why !== null) throw new NameError(`the blinded ${slot === "sheet" ? "worksheet" : "defined"} name ${why}`);
    return renamed;
  }

  /** Pass 2, for a path planned with planPath. */
  renamePath(path: string, pz: Pseudonymizer): string {
    const segments = path.split("/");
    const [stem, ext] = splitExtension(segments.pop() as string);
    return [...segments.map((s) => this.rename("folder", s, pz)), this.rename("file", stem, pz) + ext].join("/");
  }
}
