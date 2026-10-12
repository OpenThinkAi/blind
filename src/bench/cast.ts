// The synthetic kits' shared parts: the invented cast, the seeded PRNG and the
// oracle builder. Kit v1 (synth.ts) and kit v2 (kit2.ts) both draw on them.
// Everything here is invented; nothing comes from a real corpus.

export type OracleClass = "person" | "org" | "host" | "email" | "id";

/** One place a value is planted: an input file and where in it (a column, a key path, a part). */
export interface OracleScope {
  file: string;
  where: string;
}

/** One sensitive value as it is written somewhere in the kit's input. */
export interface OracleValue {
  value: string;
  class: OracleClass;
  /** The entity or value it stands for; equal to `value` for column and pattern values. */
  canonical: string;
  /** How it is written: the canonical form, a nickname or misspelling, a name part, or a cell or pattern value. */
  form: "canonical" | "alias" | "part" | "value";
  /** Input files it occurs in, sorted. */
  files: string[];
  /** Kit v2 only: every place it is planted, sorted by file, then where. */
  scope?: OracleScope[];
}

/** A person: canonical name, given name and surname (parts), nicknames and misspellings (aliases). */
export interface CastPerson {
  canonical: string;
  given: string;
  surname: string;
  aliases: string[];
  /** Email local part; the domain is the person's organisation's. */
  local: string;
}

export interface CastOrg {
  canonical: string;
  /** Short name used alone in prose, and the tenant label of its vendor-hosted host. */
  short: string;
  acronym: string;
  slug: string;
}

// The cast is fixed; the seed decides who appears where. "Sam" and "Jan" are given names that are
// also an acronym (SAM) and a month (Jan.) elsewhere in the prose.
export const PEOPLE: readonly CastPerson[] = [
  { canonical: "Bartholomew Quince", given: "Bartholomew", surname: "Quince", aliases: ["Bart", "Bartholemew Quince", "B. Quince"], local: "bart.quince" },
  { canonical: "Marisol Penhallow", given: "Marisol", surname: "Penhallow", aliases: ["Mari", "Marisole Penhallow", "Penhalow"], local: "mpenhallow" },
  { canonical: "Sam Ettrickfold", given: "Sam", surname: "Ettrickfold", aliases: ["Sammy", "Sam Etrickfold"], local: "sam.ettrickfold" },
  { canonical: "Jan Vellacourt", given: "Jan", surname: "Vellacourt", aliases: ["Jan Velacourt", "J. Vellacourt"], local: "jvellacourt" },
  { canonical: "Ignatius Dunmorrow", given: "Ignatius", surname: "Dunmorrow", aliases: ["Iggy", "Ignatious Dunmorrow"], local: "idunmorrow" },
  { canonical: "Theodora Wrexley", given: "Theodora", surname: "Wrexley", aliases: ["Teddie", "Theadora Wrexley"], local: "teddie.wrexley" },
];

export const ORGS: readonly CastOrg[] = [
  { canonical: "Quillfeather Holdings", short: "Quillfeather", acronym: "QFH", slug: "quillfeather" },
  { canonical: "Brambleworth Freight", short: "Brambleworth", acronym: "BWF", slug: "brambleworth" },
  { canonical: "Vantmoor Analytics", short: "Vantmoor", acronym: "VMA", slug: "vantmoor" },
  { canonical: "Ossory Pinewick Partners", short: "Pinewick", acronym: "OPP", slug: "pinewick" },
];

/** The vendor whose platform hosts every organisation's tenant (`<slug>.tenanthub.example`). */
export const VENDOR_DOMAIN = "tenanthub.example";

/** mulberry32: a small 32-bit PRNG. Deterministic for a seed; not for anything secret. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)] as T;
  }
  /** `n` distinct values from `make`, in generation order. */
  distinct(n: number, make: () => string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    while (out.length < n) {
      const v = make();
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }
}

/** Code-unit order, never locale order. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const tenantHost = (o: CastOrg): string => `${o.slug}.${VENDOR_DOMAIN}`;
export const emailOf = (p: CastPerson, o: CastOrg): string => `${p.local}@${o.slug}.example`;

export class OracleBuilder {
  private readonly byKey = new Map<string, OracleValue>();
  private readonly scopes = new Map<string, Map<string, OracleScope>>();
  /** Records `value` as planted in `file` at `where`. The first call for a value fixes its canonical and form. */
  add(value: string, cls: OracleClass, canonical: string, form: OracleValue["form"], file: string, where: string): void {
    const key = `${cls}\0${value}`;
    const at = this.scopes.get(key) ?? new Map<string, OracleScope>();
    at.set(`${file}\0${where}`, { file, where });
    this.scopes.set(key, at);
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      if (!hit.files.includes(file)) hit.files = [...hit.files, file].sort(cmp);
      return;
    }
    this.byKey.set(key, { value, class: cls, canonical, form, files: [file] });
  }
  /** Sorted by class, then value. `withScope` adds each value's `scope` (kit v2). */
  values(withScope = false): OracleValue[] {
    return [...this.byKey.entries()]
      .map(([key, v]) => (withScope ? { ...v, scope: [...(this.scopes.get(key)?.values() ?? [])].sort((a, b) => cmp(a.file, b.file) || cmp(a.where, b.where)) } : v))
      .sort((a, b) => cmp(a.class, b.class) || cmp(a.value, b.value));
  }
}

/** A person mention in prose, in one of their written forms; records it in the oracle. */
export function mention(rng: Rng, p: CastPerson, oracle: OracleBuilder, file: string, where = "prose"): string {
  const forms: [string, OracleValue["form"]][] = [
    [p.canonical, "canonical"],
    [p.given, "part"],
    [p.surname, "part"],
    ...p.aliases.map((a): [string, OracleValue["form"]] => [a, "alias"]),
  ];
  const [text, form] = rng.pick(forms);
  oracle.add(text, "person", p.canonical, form, file, where);
  return text;
}

export function orgMention(rng: Rng, o: CastOrg, oracle: OracleBuilder, file: string, where = "prose"): string {
  const forms: [string, OracleValue["form"]][] = [
    [o.canonical, "canonical"],
    [o.short, "part"],
    [o.acronym, "alias"],
  ];
  const [text, form] = rng.pick(forms);
  oracle.add(text, "org", o.canonical, form, file, where);
  return text;
}

