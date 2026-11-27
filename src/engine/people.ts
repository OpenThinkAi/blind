// The people in one name cell (AGT-1859, AGT-2787). A person column holds "Dana & Lee Quillfeather",
// "Quillfeather, Dana & Lee", "Dana Quillfeather and Lee Marwick" or "Nora Teasdale; Owen Brandvik"
// as often as one name. Each person in it has name parts of their own, the shared surname
// included, so "Rex Quillfeather" in another column and "the Quillfeather household" in prose are
// replaced like any other recurrence of a known person.
//
// A cell in which every person is written as a full name of their own (peopleSegments) is written
// one stand-in per person, the separators kept as written: "Nora Teasdale; Owen Brandvik" gives
// "<Nora's stand-in>; <Owen's stand-in>", the same stand-ins those people get written alone. A
// cell where a name borrows a surname ("Dana & Lee Quillfeather") or is written "Surname, Given"
// still gets one stand-in for the whole cell, so reveal restores it exactly.
//
// The separators are "&", "+", ";", a line break and the word "and". Never "," (one person with a
// credential, "Owen Bellamy, PT", or "Surname, Given") and never "/" ("Main / Room 1").
//
// Deterministic and string-only: no dictionary, no model. A cell that does not clearly hold
// two or more people with a surname for each gets null, and is read as one name as before.

import { isHonorificOrRole } from "./honorifics.ts";

/** A word of a name as a value writes it: letters and marks, joined by an apostrophe, a hyphen or a dot ("O'Neil", "J.", "St.-Pierre"). */
export const NAME_TOKEN_RE = /^[\p{L}\p{M}]+(?:['’.-][\p{L}\p{M}]*)*$/u;

/** Words that make a value an organisation, not a person: "Hill Valley Rescue", "Example Pet Clinic LLC". */
export const ORG_WORDS: ReadonlySet<string> = new Set(
  (
    "inc incorporated llc llp lp ltd plc gmbh corp corporation company co group holdings partners associates " +
    "clinic clinics hospital hospitals veterinary services supplies foods labs laboratory laboratories insurance " +
    "university college school academy foundation society shelter rescue kennels pharmacy solutions technologies " +
    "consulting enterprises industries international trust bank agency"
  ).split(" "),
);

/** What separates the people of one cell: "&", "+", ";", a line break, or the word "and" (any case). */
const PEOPLE_SEP_RE = /\s*(?:[&+;]|\r\n|\r|\n)\s*|\s+and\s+/iu;
/** PEOPLE_SEP_RE as a capturing group, for splitting a cell while keeping its separators. */
const PEOPLE_SEP_SPLIT_RE = new RegExp(`(${PEOPLE_SEP_RE.source})`, "iu");

const tokensOf = (seg: string): string[] => seg.replace(/[()"“”]/gu, " ").trim().split(/\s+/u).filter((t) => t !== "");

/** Tokens that are not a title ("Dr.", "Mrs") or an initial: what a given name or surname is made of. */
const isBare = (tokens: readonly string[]): boolean => tokens.filter((t) => !isHonorificOrRole(t)).length <= 1;

interface Segment {
  tokens: string[];
  /** Written "Surname, First": the tokens are already put in reading order. */
  reversed: boolean;
}

/**
 * The individual people of a cell written as several ("Dana & Lee Quillfeather" gives "Dana
 * Quillfeather" and "Lee Quillfeather"), each as a full name with the shared surname, in the order
 * written. Segments are separated by "&", "+", ";", a line break and " and "; "Surname, First" is read as a reversed name
 * ("Quillfeather, Dana & Lee" gives the same two people). A bare given name takes the surname of
 * the next full name, else of the reversed name before it, else of the last full name before it.
 * Returns null for one person ("Marwick, Jo"), for a value with a digit or an organisation word,
 * and when a bare name has no surname to take (the cell is then read as one name, as before).
 */
export function splitPeople(value: string): string[] | null {
  const v = value.normalize("NFKC").trim();
  if (v === "" || /\p{N}/u.test(v)) return null;
  const raw = v.split(PEOPLE_SEP_RE);
  if (raw.length < 2) return null;
  const segs: Segment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const seg = raw[i] as string;
    const pieces = seg.split(/\s*,\s*/u);
    const later = raw.slice(i + 1);
    // "Surname, First" is reversed unless a plain full name follows ("Marwick, Jo & Dana Quillfeather" stays ambiguous).
    const plainAfter = later.some((l) => !l.includes(",") && !isBare(tokensOf(l)));
    if (pieces.length === 2 && tokensOf(pieces[0] as string).length === 1 && tokensOf(pieces[1] as string).length >= 1 && !plainAfter) {
      segs.push({ tokens: [...tokensOf(pieces[1] as string), ...tokensOf(pieces[0] as string)], reversed: true });
    } else {
      for (const p of pieces) segs.push({ tokens: tokensOf(p), reversed: false });
    }
  }
  const all = segs.flatMap((s) => s.tokens);
  if (segs.some((s) => s.tokens.length === 0 || s.tokens.length > 4)) return null;
  for (const t of all) if (!NAME_TOKEN_RE.test(t) || ORG_WORDS.has(t.toLowerCase().replace(/\.$/u, ""))) return null;
  const bare = segs.map((s) => !s.reversed && isBare(s.tokens));
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] as Segment;
    if (!bare[i]) {
      out.push(s.tokens.join(" "));
      continue;
    }
    // The surname to take: the next full name's, else the nearest one before.
    let src = segs.findIndex((o, j) => j > i && !bare[j]);
    if (src < 0) for (let j = i - 1; j >= 0; j--) if (!bare[j]) { src = j; break; }
    if (src < 0) return null;
    const donor = (segs[src] as Segment).tokens;
    out.push([...s.tokens, donor[donor.length - 1] as string].join(" "));
  }
  return out;
}

/** A cell written as several people, each a full name: the names as written and the text around and between them. */
export interface PeopleCell {
  /** Each person's name, as written in the cell (trimmed), in order. At least two. */
  names: string[];
  /** The text before the first name, between each pair of names (the separator with its spacing) and after the last: `names.length + 1` pieces. */
  around: string[];
}

/**
 * The people of a cell that holds two or more full names separated by "&", "+", ";", a line break or
 * the word "and" (AGT-2787), each name with two to four words of its own ("Nora Teasdale; Owen
 * Brandvik"), with the separators and spacing exactly as written, so the cell can be written one
 * stand-in per person and revealed byte for byte. Null for one name, a name that borrows a surname
 * ("Dana & Lee Quillfeather"), a "Surname, Given" or comma-separated name, a digit, or an
 * organisation word: such a cell is one stand-in as before.
 */
export function peopleSegments(value: string): PeopleCell | null {
  if (/\p{N}/u.test(value)) return null;
  const pieces = value.split(PEOPLE_SEP_SPLIT_RE);
  if (pieces.length < 3) return null;
  const names: string[] = [];
  const around: string[] = [""];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as string;
    if (i % 2 === 1) {
      around[around.length - 1] += piece;
      continue;
    }
    const name = piece.trim();
    const lead = piece.slice(0, piece.length - piece.trimStart().length);
    const tail = piece.slice(lead.length + name.length);
    if (name === "" || name.includes(",")) return null;
    const tokens = tokensOf(name.normalize("NFKC"));
    if (tokens.length < 2 || tokens.length > 4 || isBare(tokens)) return null;
    for (const t of tokens) if (!NAME_TOKEN_RE.test(t) || ORG_WORDS.has(t.toLowerCase().replace(/\.$/u, ""))) return null;
    around[around.length - 1] += lead;
    names.push(name);
    around.push(tail);
  }
  return names.length >= 2 ? { names, around } : null;
}

/** A full name on each side of a comma: "Iris Halloway, Hugo Okonkwo-Lund" (two people, or one name written "Surname, Given"?). */
export function commaNames(value: string): boolean {
  const v = value.normalize("NFKC").trim();
  if (v === "" || /\p{N}/u.test(v) || PEOPLE_SEP_RE.test(v)) return false;
  const parts = v.split(",");
  if (parts.length < 2) return false;
  return parts.every((p) => {
    const tokens = tokensOf(p);
    return (
      tokens.length >= 2 &&
      tokens.length <= 4 &&
      !isBare(tokens) &&
      tokens.every((t) => NAME_TOKEN_RE.test(t) && /^\p{Lu}/u.test(t) && !isHonorificOrRole(t) && !ORG_WORDS.has(t.toLowerCase().replace(/\.$/u, "")))
    );
  });
}
