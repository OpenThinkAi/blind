// Person identity (AGT-1842): which written forms of a name are one person. The canonical form
// (canonical.ts) already makes "Dr. Jo Sample", "Jo Sample" and "Sample, Jo" one person. This
// resolves the two shorter forms that canonicalisation cannot, deterministically and only when
// the corpus leaves no doubt:
//
// - An initial and a surname ("J. Sample", "Dr. J. Sample") is the person with a full name of
//   that surname and that initial ("Jo Sample") when exactly one such person is known and no
//   other known person with that surname has a different initial. "J. Sample" next to "Jo Sample"
//   and "Rex Sample" stays a person of its own.
// - A title and a single name ("Dr. Sample") is the one known person with that name in any
//   position, if there is exactly one; otherwise the one person with that surname who is ever
//   written with a title, if there is exactly one ("Dr. J. Sample" when the owner "Rex Sample"
//   never is). Otherwise it stays unresolved, and its lone name is the shared part it is today.
//
// Everything else is left alone: a lone name without a title is never resolved here (nameParts
// in recur.ts decides it), and a full name is its own identity.

import { canonicalize } from "./canonical.ts";
import { isHonorificOrRole } from "./honorifics.ts";

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The person a canonical form resolves to: its canonical key and the surface form to record. */
export interface PersonAlias {
  key: string;
  display: string;
}

/** Canonical person form → the person it is (only forms that resolve to someone else are listed). */
export type PersonAliases = ReadonlyMap<string, PersonAlias>;

/** The canonical key a person form stands for under `aliases`. */
export const identityOf = (aliases: PersonAliases | undefined, canonical: string): string => aliases?.get(canonical)?.key ?? canonical;

interface Shape {
  kind: "full" | "initialed" | "titled";
  /** The first letter of the given name or of the first initial; empty for `titled`. */
  initial: string;
  /** The last word: the surname, or the name after the title. */
  surname: string;
  words: string[];
}

const isInitial = (w: string): boolean => [...w].length === 1;

function shape(key: string): Shape | undefined {
  const words = key.split(" ").filter((w) => w !== "");
  if (words.length < 2) return undefined;
  const last = words[words.length - 1] as string;
  if (isInitial(last)) return undefined;
  const first = words[0] as string;
  if (words.length === 2 && isHonorificOrRole(first) && !isHonorificOrRole(last)) return { kind: "titled", initial: "", surname: last, words };
  if (words.some((w) => isHonorificOrRole(w))) return undefined;
  if (isInitial(first)) return { kind: "initialed", initial: first, surname: last, words };
  return { kind: "full", initial: String.fromCodePoint(first.codePointAt(0) as number), surname: last, words };
}

/**
 * Resolve the people in `values` (each written as found: column values, speakers, names in prose
 * with their title when they had one). `titled` holds the canonical forms of people ever written
 * after a title ("Dr. J. Sample" gives "j sample"). Deterministic: the result depends only on the
 * set of values.
 */
export function personAliases(values: Iterable<string>, titled: ReadonlySet<string> = new Set()): Map<string, PersonAlias> {
  const display = new Map<string, string>();
  for (const v of values) {
    const k = canonicalize("person", v);
    const prior = display.get(k);
    if (prior === undefined || v < prior) display.set(k, v);
  }
  const keys = [...display.keys()].sort(cmp);
  const shapes = new Map<string, Shape>();
  for (const k of keys) {
    const s = shape(k);
    if (s !== undefined) shapes.set(k, s);
  }
  const aliases = new Map<string, PersonAlias>();
  const to = (key: string): PersonAlias => ({ key, display: display.get(key) as string });

  // Initials: one full name with that surname and initial, and no different initial for that surname.
  for (const [k, s] of shapes) {
    if (s.kind !== "initialed") continue;
    const same = [...shapes].filter(([, o]) => o.kind !== "titled" && o.surname === s.surname);
    if (new Set(same.map(([, o]) => o.initial)).size !== 1) continue;
    const full = same.filter(([, o]) => o.kind === "full");
    if (full.length === 1) aliases.set(k, to((full[0] as [string, Shape])[0]));
  }
  const rep = (k: string): string => aliases.get(k)?.key ?? k;

  // A title and one name: the one person with that name, else the one titled person with that surname.
  for (const [k, s] of shapes) {
    if (s.kind !== "titled") continue;
    const people = new Set<string>();
    const titledPeople = new Set<string>();
    for (const [o, os] of shapes) {
      if (os.kind === "titled" || !os.words.includes(s.surname)) continue;
      people.add(rep(o));
      // A titled member makes its person titled: "J. Sample" written "Dr. J. Sample".
      if (os.surname === s.surname && titled.has(o)) titledPeople.add(rep(o));
    }
    const [only] = people;
    const [onlyTitled] = titledPeople;
    if (people.size === 1 && only !== undefined) aliases.set(k, to(only));
    else if (titledPeople.size === 1 && onlyTitled !== undefined) aliases.set(k, to(onlyTitled));
  }
  return aliases;
}
