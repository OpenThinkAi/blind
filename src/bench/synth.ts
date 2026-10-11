// The synthetic corpus generator (kit v1): a small CSV and text corpus with the
// shapes that break document blinding, plus an oracle listing every sensitive
// value in it with its class. Everything is invented: people, organisations,
// hosts under `.example`, RFC 5737 IP addresses. Nothing comes from a real
// corpus.
//
// Deterministic: the only input is the seed. The PRNG is a local mulberry32,
// so the same seed gives byte-identical files and oracle on every machine. No
// clock, no unseeded randomness, no environment.
//
// `bun src/bench/synth.ts <dir> [--seed N] [--rows N]` writes a kit to <dir>,
// which `blind bench <dir>` scores; see docs/bench.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Spec } from "../schema.ts";

export const KIT_VERSION = 1;
export const DEFAULT_SEED = 1739;
export const DEFAULT_ROWS = 60;

/** The kit's input files, relative to `<kit>/input`. */
export const ACCOUNTS_CSV = "accounts.csv";
export const NOTES_MD = "notes/review.md";
export const STANDUP_TXT = "notes/standup.txt";
export const SYNC_LOG = "sync.log";

export type OracleClass = "person" | "org" | "host" | "email" | "id";

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
}

/** A word that looks like a name part but is not one in its context. It must survive blinding. */
export interface Decoy {
  text: string;
  /** The name part it resembles. */
  resembles: string;
  why: string;
  files: string[];
}

/** Ground truth for one CSV column: what it holds, independent of any spec. */
export interface OracleColumn {
  file: string;
  header: string;
  /** `vocabulary`: ordinary values that identify no one. */
  class: OracleClass | "vocabulary";
  note: string;
}

export interface Oracle {
  version: typeof KIT_VERSION;
  seed: number;
  rows: number;
  /** Whether values from blinded columns were also written into free text (see `recurInProse`). */
  recurInProse: boolean;
  columns: OracleColumn[];
  /** Sorted by class, then value. */
  values: OracleValue[];
  decoys: Decoy[];
}

export interface KitFile {
  path: string;
  text: string;
}

export interface Kit {
  /** Sorted by path. */
  files: KitFile[];
  oracle: Oracle;
  /** The reviewed spec the kit is blinded with (see `kitSpec`). */
  spec: Spec;
}

export interface KitOptions {
  /** Data rows in accounts.csv (default 60, at least 8). */
  rows?: number;
  /**
   * Also cite account numbers, ledger refs and scope codes from accounts.csv in the notes. These are
   * column values, not spec entities or pattern matches, so the engine leaves them in free text until
   * AGT-1779 lands. Off by default.
   */
  recurInProse?: boolean;
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

/** CSV columns, in file order. The headers are fixed; only the values depend on the seed. */
export const COLUMNS: readonly OracleColumn[] = [
  { file: ACCOUNTS_CSV, header: "Acct No", class: "id", note: "short ID: 4 digits" },
  { file: ACCOUNTS_CSV, header: "Counterparty Label", class: "org", note: "organisation names under a header no rule names" },
  { file: ACCOUNTS_CSV, header: "client_scope_code", class: "id", note: "snake_case header; internal codes a reviewer cannot place" },
  { file: ACCOUNTS_CSV, header: "Ledger Ref", class: "id", note: "hex ID: 6 characters" },
  { file: ACCOUNTS_CSV, header: "Owner", class: "person", note: "account owner" },
  { file: ACCOUNTS_CSV, header: "Tenant Host", class: "host", note: "vendor-hosted tenant host" },
  { file: ACCOUNTS_CSV, header: "Status", class: "vocabulary", note: "status enum" },
  { file: ACCOUNTS_CSV, header: "Region", class: "vocabulary", note: "region enum" },
  { file: ACCOUNTS_CSV, header: "Amount", class: "vocabulary", note: "money, 3-digit integer part" },
  { file: ACCOUNTS_CSV, header: "Opened", class: "vocabulary", note: "ISO date" },
];

const STATUSES = ["open", "closed", "pending", "on hold"] as const;
const REGIONS = ["north", "south", "east", "west"] as const;
const MONTHS = ["Jan.", "Feb.", "Mar.", "Apr."] as const;

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

class Rng {
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

const HEX = "0123456789abcdef";
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const tenantHost = (o: CastOrg): string => `${o.slug}.${VENDOR_DOMAIN}`;
const emailOf = (p: CastPerson, o: CastOrg): string => `${p.local}@${o.slug}.example`;

class OracleBuilder {
  private readonly byKey = new Map<string, OracleValue>();
  add(value: string, cls: OracleClass, canonical: string, form: OracleValue["form"], file: string): void {
    const key = `${cls}\0${value}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      if (!hit.files.includes(file)) hit.files = [...hit.files, file].sort(cmp);
      return;
    }
    this.byKey.set(key, { value, class: cls, canonical, form, files: [file] });
  }
  values(): OracleValue[] {
    return [...this.byKey.values()].sort((a, b) => cmp(a.class, b.class) || cmp(a.value, b.value));
  }
}

interface Account {
  acct: string;
  org: CastOrg;
  scope: string;
  ledger: string;
  owner: CastPerson;
  status: string;
  region: string;
  amount: string;
  opened: string;
}

/** A person mention in prose, in one of their written forms; records it in the oracle. */
function mention(rng: Rng, p: CastPerson, oracle: OracleBuilder, file: string): string {
  const forms: [string, OracleValue["form"]][] = [
    [p.canonical, "canonical"],
    [p.given, "part"],
    [p.surname, "part"],
    ...p.aliases.map((a): [string, OracleValue["form"]] => [a, "alias"]),
  ];
  const [text, form] = rng.pick(forms);
  oracle.add(text, "person", p.canonical, form, file);
  return text;
}

function orgMention(rng: Rng, o: CastOrg, oracle: OracleBuilder, file: string): string {
  const forms: [string, OracleValue["form"]][] = [
    [o.canonical, "canonical"],
    [o.short, "part"],
    [o.acronym, "alias"],
  ];
  const [text, form] = rng.pick(forms);
  oracle.add(text, "org", o.canonical, form, file);
  return text;
}

/**
 * The reviewed spec for kit v1, as a reviewer would save it after `blind plan`: the organisation,
 * person, host and ID columns blinded, the enums, money and dates kept, `client_scope_code` left a
 * declared unknown, the cast as entities and the decoys as vocabulary. It depends on no seed: the
 * headers and the cast are fixed.
 */
export function kitSpec(): Spec {
  return {
    version: 1,
    columns: COLUMNS.map((c) =>
      c.header === "client_scope_code"
        ? { file: c.file, header: c.header, class: "unknown", treatment: "value", confidence: 0, source: "human" }
        : { file: c.file, header: c.header, class: c.class, treatment: c.class === "vocabulary" ? "keep" : "blind", confidence: 1, source: "human" },
    ),
    entities: {
      person: PEOPLE.map((p) => ({ canonical: p.canonical, aliases: [...p.aliases], parts: [p.given, p.surname] })),
      org: ORGS.map((o) => ({ canonical: o.canonical, aliases: [o.acronym], parts: [o.short] })),
      vocabulary: [
        { canonical: "Jan.", aliases: [], parts: [] },
        { canonical: "SAM", aliases: [], parts: [] },
      ],
    },
    patterns: { ip: true, email: true, host: true, guid: true, mac: true },
    questions: [],
  };
}

/** Generate kit v1 for `seed`. Pure: same seed and options, same kit. */
export function generateKit(seed: number = DEFAULT_SEED, options: KitOptions = {}): Kit {
  const rows = options.rows ?? DEFAULT_ROWS;
  if (!Number.isInteger(rows) || rows < 8) throw new RangeError(`rows must be an integer of 8 or more, got ${rows}`);
  const recur = options.recurInProse ?? false;
  const rng = new Rng(seed);
  const oracle = new OracleBuilder();
  const decoys: Decoy[] = [];

  // accounts.csv. ID ranges are chosen so no ID is ever a substring token of a date, amount or code:
  // account numbers 3000-9999 (dates are 2026-…, amounts have 3-digit integer parts), scope codes
  // carry 3 digits, ledger refs are 6 hex characters with at least one digit and one letter.
  const accts = rng.distinct(rows, () => String(rng.int(3000, 9999)));
  const scopes = rng.distinct(rows, () => `CS-${rng.int(100, 999)}-${rng.pick([...LETTERS])}${rng.pick([...LETTERS])}`);
  const ledgers = rng.distinct(rows, () => {
    for (;;) {
      const s = Array.from({ length: 6 }, () => HEX[rng.int(0, 15)]).join("");
      if (/[0-9]/.test(s) && /[a-f]/.test(s)) return s;
    }
  });
  const accounts: Account[] = accts.map((acct, i) => ({
    acct,
    // Every organisation and every person appears at least once.
    org: i < ORGS.length ? (ORGS[i] as CastOrg) : rng.pick(ORGS),
    scope: scopes[i] as string,
    ledger: ledgers[i] as string,
    owner: i < PEOPLE.length ? (PEOPLE[i] as CastPerson) : rng.pick(PEOPLE),
    status: rng.pick(STATUSES),
    region: rng.pick(REGIONS),
    amount: `${rng.int(100, 999)}.${pad2(rng.int(0, 99))}`,
    opened: `2026-${pad2(rng.int(1, 9))}-${pad2(rng.int(1, 28))}`,
  }));
  const csv = [COLUMNS.map((c) => c.header).join(",")];
  for (const a of accounts) {
    csv.push([a.acct, a.org.canonical, a.scope, a.ledger, a.owner.canonical, tenantHost(a.org), a.status, a.region, a.amount, a.opened].join(","));
    oracle.add(a.acct, "id", a.acct, "value", ACCOUNTS_CSV);
    oracle.add(a.org.canonical, "org", a.org.canonical, "canonical", ACCOUNTS_CSV);
    oracle.add(a.scope, "id", a.scope, "value", ACCOUNTS_CSV);
    oracle.add(a.ledger, "id", a.ledger, "value", ACCOUNTS_CSV);
    oracle.add(a.owner.canonical, "person", a.owner.canonical, "canonical", ACCOUNTS_CSV);
    oracle.add(tenantHost(a.org), "host", tenantHost(a.org), "value", ACCOUNTS_CSV);
  }

  // notes/review.md: prose with nicknames, misspellings, name parts, org aliases and the decoys.
  const md: string[] = ["# Quarterly account review", ""];
  const sam = PEOPLE.find((p) => p.given === "Sam") as CastPerson;
  const jan = PEOPLE.find((p) => p.given === "Jan") as CastPerson;
  const sentences = Math.max(12, Math.floor(rows / 3));
  for (let i = 0; i < sentences; i++) {
    const p = rng.pick(PEOPLE);
    const q = rng.pick(PEOPLE.filter((x) => x !== p));
    const a = rng.pick(accounts);
    const day = rng.int(2, 27);
    const month = rng.pick(MONTHS);
    const who = mention(rng, p, oracle, NOTES_MD);
    const other = mention(rng, q, oracle, NOTES_MD);
    const org = orgMention(rng, a.org, oracle, NOTES_MD);
    const template = rng.int(0, 4);
    if (template === 0) md.push(`- ${who} walked ${other} through the ${org} renewal on ${day} ${month}`);
    else if (template === 1) md.push(`- ${org} asked ${who} for the export; ${other} will send it by ${day} ${month}`);
    else if (template === 2) md.push(`- ${who} told ${other} that the SAM report for ${org} is late again.`);
    else if (template === 3) md.push(`- ${other} and ${who} agreed the ${org} invoice can wait`);
    else md.push(`- ${who} owns the follow-up with ${org} and will copy ${other}`);
    if (template === 2) decoys.push({ text: "SAM", resembles: sam.given, why: "an acronym (software asset management), not the given name", files: [NOTES_MD] });
    if ((template === 0 || template === 1) && month === "Jan.") decoys.push({ text: "Jan.", resembles: jan.given, why: "a month abbreviation, not a given name", files: [NOTES_MD] });
  }
  // Both decoys always appear at least once, next to the people they resemble.
  md.push(`- ${sam.given} reran the SAM reconciliation; ${jan.given} confirms the figures from 9 Jan.`);
  oracle.add(sam.given, "person", sam.canonical, "part", NOTES_MD);
  oracle.add(jan.given, "person", jan.canonical, "part", NOTES_MD);
  decoys.push({ text: "SAM", resembles: sam.given, why: "an acronym (software asset management), not the given name", files: [NOTES_MD] });
  decoys.push({ text: "Jan.", resembles: jan.given, why: "a month abbreviation, not a given name", files: [NOTES_MD] });
  md.push("", "## Contacts", "");
  for (const p of PEOPLE) {
    const o = rng.pick(ORGS);
    md.push(`- ${p.canonical}: ${emailOf(p, o)}, tenant ${tenantHost(o)}`);
    oracle.add(p.canonical, "person", p.canonical, "canonical", NOTES_MD);
    oracle.add(emailOf(p, o), "email", emailOf(p, o), "value", NOTES_MD);
    oracle.add(tenantHost(o), "host", tenantHost(o), "value", NOTES_MD);
  }
  if (recur) {
    md.push("", "## Open items", "");
    for (const a of [accounts[0], accounts[1]] as Account[]) {
      md.push(`- Account ${a.acct} (ledger ${a.ledger}, scope ${a.scope}) is still open.`);
      oracle.add(a.acct, "id", a.acct, "value", NOTES_MD);
      oracle.add(a.ledger, "id", a.ledger, "value", NOTES_MD);
      oracle.add(a.scope, "id", a.scope, "value", NOTES_MD);
    }
  }
  md.push("");

  // notes/standup.txt: speaker-labelled lines, the misspellings and nicknames again.
  const standup: string[] = ["Standup notes", ""];
  for (let i = 0; i < Math.max(8, Math.floor(rows / 6)); i++) {
    const p = rng.pick(PEOPLE);
    const a = rng.pick(accounts);
    const who = mention(rng, p, oracle, STANDUP_TXT);
    const org = orgMention(rng, a.org, oracle, STANDUP_TXT);
    standup.push(`${p.canonical}: ${who === p.canonical ? "I" : who} will chase ${org} about the ${a.region} region.`);
    oracle.add(p.canonical, "person", p.canonical, "canonical", STANDUP_TXT);
  }
  standup.push("");

  // sync.log: tenant hosts, emails and RFC 5737 addresses in machine-written lines.
  const ips = rng.distinct(6, () => `${rng.pick(["192.0.2", "198.51.100", "203.0.113"])}.${rng.int(1, 254)}`);
  const log: string[] = [];
  for (let i = 0; i < Math.max(10, Math.floor(rows / 4)); i++) {
    const a = rng.pick(accounts);
    const p = rng.pick(PEOPLE);
    const ip = rng.pick(ips);
    const ts = `2026-0${rng.int(1, 9)}-${pad2(rng.int(1, 28))} ${pad2(rng.int(0, 23))}:${pad2(rng.int(0, 59))}:${pad2(rng.int(0, 59))}`;
    log.push(`${ts} INFO sync tenant=${tenantHost(a.org)} user=${emailOf(p, a.org)} from ${ip} ok`);
    oracle.add(tenantHost(a.org), "host", tenantHost(a.org), "value", SYNC_LOG);
    oracle.add(emailOf(p, a.org), "email", emailOf(p, a.org), "value", SYNC_LOG);
    oracle.add(ip, "host", ip, "value", SYNC_LOG);
  }
  log.push("");

  const files: KitFile[] = [
    { path: ACCOUNTS_CSV, text: `${csv.join("\n")}\n` },
    { path: NOTES_MD, text: md.join("\n") },
    { path: STANDUP_TXT, text: standup.join("\n") },
    { path: SYNC_LOG, text: log.join("\n") },
  ].sort((x, y) => cmp(x.path, y.path));

  const decoyKeys = new Set<string>();
  const uniqueDecoys = decoys.filter((d) => {
    const k = `${d.text}\0${d.files.join("\0")}`;
    if (decoyKeys.has(k)) return false;
    decoyKeys.add(k);
    return true;
  });
  uniqueDecoys.sort((x, y) => cmp(x.text, y.text));

  return {
    files,
    oracle: { version: KIT_VERSION, seed, rows, recurInProse: recur, columns: [...COLUMNS], values: oracle.values(), decoys: uniqueDecoys },
    spec: kitSpec(),
  };
}

/**
 * Writes `<dir>/input/<files>`, `<dir>/oracle.json` and `<dir>/spec.json`, the layout `blind bench`
 * reads. The oracle and the spec sit outside the input on purpose.
 */
export function writeKit(dir: string, kit: Kit): void {
  for (const f of kit.files) {
    const dest = join(dir, "input", ...f.path.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.text);
  }
  writeFileSync(join(dir, "oracle.json"), `${JSON.stringify(kit.oracle, null, 2)}\n`);
  writeFileSync(join(dir, "spec.json"), `${JSON.stringify(kit.spec, null, 2)}\n`);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { seed: { type: "string" }, rows: { type: "string" }, "recur-in-prose": { type: "boolean", default: false } },
  });
  const dir = positionals[0];
  if (dir === undefined || positionals.length !== 1) {
    process.stderr.write("Usage: bun src/bench/synth.ts <dir> [--seed N] [--rows N] [--recur-in-prose]\n");
    process.exit(2);
  }
  const seed = values.seed === undefined ? DEFAULT_SEED : Number(values.seed);
  const rows = values.rows === undefined ? DEFAULT_ROWS : Number(values.rows);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    process.stderr.write(`--seed must be an integer from 0 to 4294967295, got ${values.seed}\n`);
    process.exit(2);
  }
  const kit = generateKit(seed, { rows, recurInProse: values["recur-in-prose"] });
  writeKit(dir, kit);
  process.stdout.write(`wrote kit v${KIT_VERSION} (seed ${seed}, ${rows} rows, ${kit.oracle.values.length} oracle values) to ${dir}\n`);
}
