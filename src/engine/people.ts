// The people in one name cell (AGT-1859). A person column holds "Dana & Lee Quillfeather",
// "Quillfeather, Dana & Lee" or "Dana Quillfeather and Lee Marwick" as often as one name. The
// whole cell still gets one pseudonym (the column pass), but each person in it has name parts
// of their own, the shared surname included, so "Rex Quillfeather" in another column and "the
// Quillfeather household" in prose are replaced like any other recurrence of a known person.
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
 * written. Segments are separated by "&", "+", " and "; "Surname, First" is read as a reversed name
 * ("Quillfeather, Dana & Lee" gives the same two people). A bare given name takes the surname of
 * the next full name, else of the reversed name before it, else of the last full name before it.
 * Returns null for one person ("Marwick, Jo"), for a value with a digit or an organisation word,
 * and when a bare name has no surname to take (the cell is then read as one name, as before).
 */
export function splitPeople(value: string): string[] | null {
  const v = value.normalize("NFKC").trim();
  if (v === "" || /\p{N}/u.test(v)) return null;
  const raw = v.split(/\s*[&+]\s*|\s+(?:and)\s+/iu);
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
