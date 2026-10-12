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
import type { PatternName, Patterns } from "../schema.ts";
import { partExclusion } from "./recur.ts";
import type { Shield } from "./shield.ts";
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
export function violation(slot: NameSlot, name: string): string | null {
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

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * rewriteSpans for a name: a pseudonym that would touch a letter or digit of the name ("SampleTotal",
 * "Sample2") is set off with "_", so the pseudonym stays a whole token for `blind reveal` and the
 * name stays valid in every slot ("Person_1A2B_Total").
 */
function rewriteNameSpans(name: string, spans: readonly Span[], pz: Pseudonymizer): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += name.slice(at, s.start);
    if (s.cls === null) out += name.slice(s.start, s.end);
    else {
      const before = ALNUM.test([...name.slice(0, s.start)].pop() ?? "");
      const after = ALNUM.test(String.fromCodePoint(name.codePointAt(s.end) ?? 0x20));
      out += (before ? "_" : "") + pz.pseudonym(s.cls, s.value) + (after ? "_" : "");
    }
    at = s.end;
  }
  return out + name.slice(at);
}

/** The part of a file name that is rewritten: everything before the extension the engine read it by. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** A word of a name written as an identifier: [start, end) offsets into the name. */
export interface NameToken {
  start: number;
  end: number;
}

/**
 * The words of a name written as an identifier (AGT-1845): runs of letters and of digits (so a
 * letter/digit change splits), split again at a lower-to-Upper change ("SampleTotal") and before the
 * last capital of a capitals run that a lowercase word follows ("XMLFile"). Everything that is not a
 * letter or a digit ("_", "-", ".", space, brackets) separates words.
 */
export function nameTokens(name: string): NameToken[] {
  const out: NameToken[] = [];
  for (const m of name.matchAll(/[\p{L}\p{M}]+|\p{N}+/gu)) {
    const run = m[0];
    const base = m.index;
    if (!/^[\p{L}\p{M}]/u.test(run)) {
      out.push({ start: base, end: base + run.length });
      continue;
    }
    const cps = [...run];
    let unit = 0;
    const cuts: number[] = [0];
    for (let i = 1; i < cps.length; i++) {
      unit += (cps[i - 1] as string).length;
      const prev = cps[i - 1] as string;
      const cur = cps[i] as string;
      const next = cps[i + 1];
      const lowerToUpper = /\p{Ll}/u.test(prev) && /\p{Lu}/u.test(cur);
      const capsThenWord = /\p{Lu}/u.test(prev) && /\p{Lu}/u.test(cur) && next !== undefined && /\p{Ll}/u.test(next);
      if (lowerToUpper || capsThenWord) cuts.push(unit);
    }
    cuts.push(run.length);
    for (let k = 0; k + 1 < cuts.length; k++) out.push({ start: base + (cuts[k] as number), end: base + (cuts[k + 1] as number) });
  }
  return out;
}

/** Whether [start, end) of `name` begins and ends on word boundaries of nameTokens (the engine could replace it). */
export function onNameTokens(name: string, start: number, end: number): boolean {
  const t = nameTokens(name);
  return t.some((x) => x.start === start) && t.some((x) => x.end === end);
}

/** Whether `word`, found alone in a file, folder, sheet or defined name, may be replaced in any case (partExclusion). */
export function nameWordExcluded(word: string, vocabulary: ReadonlySet<string> = new Set(), keep: ReadonlySet<string> = new Set()): boolean {
  return partExclusion(word, vocabulary, keep) !== null;
}

export class NameRewriter {
  private readonly planned = new Map<string, Span[]>();

  /**
   * `matcher` holds the spec entities and the pseudonymised column values; `keep` the keep-list
   * domains (from keepDomains).
   */
  constructor(
    private readonly matcher: EntityMatcher,
    patterns: Patterns,
    private readonly keep: readonly string[] = [],
    /** Spec vocabulary forms and policy keep terms, folded (recur.ts vocabularyForms, keepForms): a lone word among them is never replaced in another case. */
    private readonly terms: { vocabulary: ReadonlySet<string>; keep: ReadonlySet<string> } = { vocabulary: new Set(), keep: new Set() },
    /** Kept values and placeholders (shield.ts): a span inside one is not replaced in a name either. */
    private readonly shield?: Shield,
  ) {
    // Names are never searched for secrets: every match would become the same REDACTED, and two
    // files could end up with one name. The audit does not read names for secrets either.
    this.patterns = { ...patterns, secret: false };
  }

  private readonly patterns: Patterns;

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
    // A lone word that only the identifier reading found is dropped if partExclusion excludes it
    // (a dictionary word, an honorific, a keep term), so "report_value" and "ReportValue" keep theirs.
    const known = new Set(candidates.map((s) => `${s.start}:${s.end}`));
    for (const s of this.identifierSpans(name) as (Span & { lone: boolean })[]) {
      if (s.lone && !known.has(`${s.start}:${s.end}`) && nameWordExcluded(name.slice(s.start, s.end), this.terms.vocabulary, this.terms.keep)) continue;
      const { lone: _lone, ...span } = s;
      candidates.push(span);
    }
    const shielded = this.shield === undefined ? candidates : this.shield.filter(name, candidates, false);
    shielded.sort((a, b) => a.start - b.start || b.end - a.end);
    const out: Span[] = [];
    let taken = 0;
    for (const s of shielded) {
      if (s.start < taken) continue;
      out.push(s);
      taken = s.end;
    }
    return out;
  }

  /**
   * Entity spans in a name written as an identifier (AGT-1845): "consult_sample", "SampleTotal",
   * "invoice-lee.sample". The name is cut into words (nameTokens) and each run of words (separated by
   * at most one character) is read as text, words joined by a space, with the capitalised-word rule
   * off, so a name part matches in any case and a two-word name matches across "_", "-", "." or a
   * CamelCase join. Each unbroken letter-and-digit run is read on its own as well. A lone word that
   * only the relaxed rule matched is dropped if partExclusion excludes it (a dictionary word, an
   * honorific, a keep term, a vocabulary form), so "report_Value" keeps its dictionary word.
   */
  private identifierSpans(name: string): Span[] {
    const tokens = nameTokens(name);
    if (tokens.length === 0) return [];
    const out: Span[] = [];
    const readPiece = (text: string, origin: (i: number) => number): void => {
      for (const s of this.matcher.find(text, [], true)) {
        const lone = !/\s/.test(text.slice(s.start, s.end));
        out.push({ ...s, start: origin(s.start), end: origin(s.end - 1) + 1, lone } as Span & { lone: boolean });
      }
    };
    let from = 0;
    while (from < tokens.length) {
      let to = from + 1;
      while (to < tokens.length && (tokens[to] as NameToken).start - (tokens[to - 1] as NameToken).end <= 1) to++;
      const seg = tokens.slice(from, to);
      from = to;
      let text = "";
      const at: number[] = [];
      for (const [k, t] of seg.entries()) {
        if (k > 0) {
          text += " ";
          at.push(-1);
        }
        for (let i = t.start; i < t.end; i++) at.push(i);
        text += name.slice(t.start, t.end);
      }
      readPiece(text, (i) => at[i] as number);
      // An unbroken letter-and-digit run of several words ("McSample") is also read as one word.
      for (const m of name.slice((seg[0] as NameToken).start, (seg[seg.length - 1] as NameToken).end).matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
        const base = (seg[0] as NameToken).start + m.index;
        if (seg.filter((t) => t.start >= base && t.end <= base + m[0].length).length > 1) readPiece(m[0], (i) => base + i);
      }
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
    const renamed = rewriteNameSpans(name, spans, pz);
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
