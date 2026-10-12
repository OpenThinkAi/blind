// People named only in prose (AGT-1830): recall and precision of the detector on invented text, the
// person-column rule, and the engine end to end under a `none`-mode spec (no entities, no model).
// Every name, pet, place and clinic here is invented.

import { describe, expect, test } from "bun:test";
import { buildWorkbook } from "../../src/bench/office.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { Revealer, revealFile } from "../../src/engine/reveal.ts";
import { isPersonColumn, looksLikePersonName, proseNames } from "../../src/engine/prose.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const none = { keep: new Set<string>(), vocabulary: new Set<string>() };
const find = (text: string, opts: Partial<Parameters<typeof proseNames>[1]> = {}) => proseNames([text], { ...none, ...opts });

describe("proseNames: recall", () => {
  test("a given name and a surname, with or without a middle initial, and possessives", () => {
    expect(find("Spoke with Avery Quill today. Marisol J. Okonkwo phoned. Grace Nguyen's dog is fine.")).toEqual([
      "Avery Quill",
      "Grace Nguyen",
      "Marisol J. Okonkwo",
    ]);
  });

  test("an honorific before one to three name words, with or without its dot", () => {
    expect(find("Dr. Thistlewood examined her. Ask Mrs Lindqvist. Mr. Theo Brannagh paid.")).toEqual(["Lindqvist", "Theo Brannagh", "Thistlewood"]);
  });

  test("a given name that is also a dictionary word, mid-sentence before a known surname", () => {
    expect(find("We met Will Carter at noon.")).toEqual(["Will Carter"]);
  });

  test("the result is sorted, one spelling per name, whatever order the texts come in", () => {
    const a = proseNames(["Robin Carter left.", "AVERY QUILL and Avery Quill.", "avery quill"], none);
    const b = proseNames(["avery quill", "AVERY QUILL and Avery Quill.", "Robin Carter left."], none);
    expect(a).toEqual(["Avery Quill", "Robin Carter"]);
    expect(b).toEqual(a);
  });
});

describe("proseNames: precision", () => {
  const cases: [string, string][] = [
    ["pet names alone", "Bella and Max are eating; Biscuit was sedated; Pepper is shy. Hello Avery."],
    ["a pet's name before a drug", "Gave Bella Rimadyl 75 mg and Max Carprofen."],
    ["places and streets", "Near the Jordan River and Logan Canyon, Salt Lake City, Austin Texas and Highland Dr. by Murray Parkway."],
    ["breeds and species", "A Jack Russell, a Jack Russell Terrier, a Golden Retriever, a German Shepherd and a Maine Coon. Canine. Feline."],
    ["organisations", "Logan Animal Clinic referred to Avery Veterinary Group and Quinn Holdings."],
    ["honorifics and roles alone", "Front Desk called. The Doctor and the Nurse. Highland Dr. is closed. Dr. Front Desk."],
    ["headings and record words", "Max Dose 5 mg. Visit Date June 14. Monday Morning. Total Amount. Patient History."],
    ["a dictionary given name starting a sentence", "Will Brown be there? Will Carter arrive?"],
    ["ordinary Title-Case prose", "The Quick Brown Fox. Please Call Back. Thanks Again."],
    ["a cast name made of dictionary words", "Robin Example met Kit Sample."],
  ];
  for (const [what, text] of cases) test(what, () => expect(find(text)).toEqual([]));

  test("a keep term, a vocabulary form, or a word of either, is not a person", () => {
    const text = "Robin Ashdown met Holly Fernwood and Avery Quill.";
    expect(find(text)).toEqual(["Avery Quill", "Holly Fernwood", "Robin Ashdown"]);
    expect(find(text, { keep: new Set(["robin ashdown"]), vocabulary: new Set(["holly fernwood"]) })).toEqual(["Avery Quill"]);
    expect(find(text, { keep: new Set(["quill"]) })).toEqual(["Holly Fernwood", "Robin Ashdown"]);
  });

  test("a name wholly inside a kept cell value is kept, a name only sharing a word with one is not", () => {
    const text = "Recheck with Dr. Okonkwo. Marisol Okonkwo agreed. Avery Okonkwo is the owner.";
    expect(find(text, { kept: ["Dr. Marisol Okonkwo"] })).toEqual(["Avery Okonkwo"]);
  });
});

describe("person columns", () => {
  test("names read as people; organisations, places, breeds, roles and pets do not", () => {
    for (const v of ["Avery Quill", "Quill, Avery", "Marisol J. Okonkwo", "Okonkwo, Marisol J."]) expect([v, looksLikePersonName(v)]).toEqual([v, true]);
    for (const v of ["Quillfeather Holdings", "Logan Animal Clinic", "Salt Lake City", "Golden Retriever", "Jack Russell", "Front Desk", "Bella", "Avery Quill 2", "A B"]) {
      expect([v, looksLikePersonName(v)]).toEqual([v, false]);
    }
  });

  test("a column is people when at least half its values read as names", () => {
    expect(isPersonColumn(["Avery Quill", "Robin Carter", "Kit Placeholder", "Jo Thistle"])).toBe(true);
    expect(isPersonColumn(["Quillfeather Holdings", "Bramblecote Partners", "Avery Quill", "Saltmarsh Group"])).toBe(false);
    expect(isPersonColumn([])).toBe(false);
  });
});

// --- The engine, end to end ------------------------------------------------

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 0,
  source: "heuristic",
});

/** What a `none`-mode run hands the engine: no entities, columns unknown and value-treated (the pet and Vet columns kept by rules). */
const SPEC: Spec = {
  version: 1,
  columns: [rule("visits.csv", "Pet", "vocabulary", "keep"), rule("visits.csv", "Species", "unknown", "value"), rule("visits.csv", "Vet", "person", "keep"), rule("visits.csv", "Notes", "unknown", "value")],
  entities: { vocabulary: [{ canonical: "Holly Fernwood", aliases: [], parts: [] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: true },
  questions: [],
};

const VISITS = [
  "Pet,Species,Vet,Notes",
  'Bella,Canine,Dr. Marisol Okonkwo,"Owner Avery Quill called; Bella is eating well."',
  "Max,Canine,Dr. Marisol Okonkwo,Jack Russell. Recheck with Dr. Okonkwo in two weeks.",
  "Biscuit,Feline,Dr. Theo Brannagh,Maine Coon. Quill asked about boarding.",
  "Pepper,Feline,Dr. Theo Brannagh,Seen by Dr. Brannagh at the Front Desk.",
  "",
].join("\n");

const NOTES = [
  "Spoke with Avery Quill and Grace Nguyen about Bella and Max.",
  "Robin Ashdown dropped off Biscuit near Highland Dr. by the Jordan River.",
  "Holly Fernwood is the kennel's feed brand. Quill will call back; Nguyen paid.",
  "",
].join("\n");

const INPUTS: InputFile[] = [
  { path: "visits.csv", bytes: enc(VISITS) },
  { path: "notes.txt", bytes: enc(NOTES) },
];

const out = (r: ApplyResult, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);
const pseudonymOf = (r: ApplyResult, value: string) => r.map.entries.find((e) => e.value === value)?.pseudonym as string;

describe("applySpec: a person named only in prose is blinded (AC)", () => {
  const r = applySpec(INPUTS, SPEC, { salt: SALT, keep: ["Robin Ashdown"] });

  test("whole names and lone parts get one pseudonym per person, in a text file and in a free-text column", () => {
    expect(r.skipped).toEqual([]);
    const avery = pseudonymOf(r, "Avery Quill");
    const grace = pseudonymOf(r, "Grace Nguyen");
    expect(avery).toMatch(/^Person_[0-9A-F]{4}$/);
    expect(grace).toMatch(/^Person_[0-9A-F]{4}$/);
    expect(out(r, "notes.txt")).toBe(
      [
        `Spoke with ${avery} and ${grace} about Bella and Max.`,
        "Robin Ashdown dropped off Biscuit near Highland Dr. by the Jordan River.",
        `Holly Fernwood is the kennel's feed brand. ${avery} will call back; ${grace} paid.`,
        "",
      ].join("\n"),
    );
    expect(out(r, "visits.csv")).toContain(`"Owner ${avery} called; Bella is eating well."`);
    expect(out(r, "visits.csv")).toContain(`Maine Coon. ${avery} asked about boarding.`);
  });

  test("kept terms, vocabulary, kept-column names, pets, places, breeds and roles are left as written", () => {
    const visits = out(r, "visits.csv").split("\n");
    // The Vet column is kept byte for byte, and its names stay in prose too.
    expect(visits.slice(1, 5).map((l) => l.split(",")[2])).toEqual(["Dr. Marisol Okonkwo", "Dr. Marisol Okonkwo", "Dr. Theo Brannagh", "Dr. Theo Brannagh"]);
    expect(visits[2]).toContain("Jack Russell. Recheck with Dr. Okonkwo in two weeks.");
    expect(visits[4]).toContain("Seen by Dr. Brannagh at the Front Desk.");
    expect(r.map.entries.filter((e) => e.kind === "person").map((e) => e.value).sort()).toEqual(["Avery Quill", "Grace Nguyen"]);
  });

  test("the report counts the replacements", () => {
    expect(r.files.find((f) => f.path === "notes.txt")?.proseNames).toBe(4);
    expect(r.files.find((f) => f.path === "visits.csv")?.proseNames).toBe(2);
  });

  test("reveal restores every file (a lone part as its whole name), and a second run with the map gives the same output", () => {
    const rv = new Revealer(r.map);
    const whole = (s: string) => s.replace(/(?<!Avery )Quill/g, "Avery Quill").replace(/(?<!Grace )Nguyen/g, "Grace Nguyen");
    for (const i of INPUTS) expect(dec(revealFile(i.path, enc(out(r, i.path)), rv).bytes)).toBe(whole(dec(i.bytes)));
    const again = applySpec(INPUTS, SPEC, { salt: SALT, keep: ["Robin Ashdown"], map: r.map });
    for (const i of INPUTS) expect(out(again, i.path)).toBe(out(r, i.path));
  });
});

describe("applySpec: a column of names is pseudonymised as people, so their parts recur", () => {
  const clients = "Client,Account\nAvery Quill,Q-88123\nRobin Carter,Q-88124\nKit Placeholder,Q-88125\nJo Thistle,Q-88126\n";
  const orgs = "Vendor\nQuillfeather Holdings\nBramblecote Partners\nSaltmarsh Group\nThornbury Supply\n";
  const notes = "Carter called. Quill paid. Thornbury shipped.\n";
  const spec: Spec = { ...SPEC, columns: [], entities: {} };
  const r = applySpec(
    [
      { path: "clients.csv", bytes: enc(clients) },
      { path: "vendors.csv", bytes: enc(orgs) },
      { path: "n.txt", bytes: enc(notes) },
    ],
    spec,
    { salt: SALT },
  );

  test("the names column is `unknown-person`, the organisations column is not", () => {
    expect(r.files.find((f) => f.path === "clients.csv")?.columns.map((c) => c.outcome)).toEqual(["unknown-person", "unknown-pseudonymised"]);
    expect(r.files.find((f) => f.path === "vendors.csv")?.columns.map((c) => c.outcome)).toEqual(["unknown-pseudonymised"]);
  });

  test("a surname alone in a note gets its person's pseudonym; an organisation word does not recur", () => {
    expect(out(r, "n.txt")).toBe(`${pseudonymOf(r, "Robin Carter")} called. ${pseudonymOf(r, "Avery Quill")} paid. Thornbury shipped.\n`);
  });
});

describe("applySpec: a workbook's free-text cells", () => {
  test("a person named only in a notes cell is blinded; the pet and breed beside it are not", () => {
    // Notes long enough in ordinary words that the column reads as prose, not identifiers.
    const notes = ["Jack Russell. Owner Grace Nguyen called about the next visit.", "Maine Coon, quiet and eating well this week.", "Nguyen will collect her on Friday after work.", "No notes for this one at the moment."];
    const rows = [["Pet", "Notes"], ...["Bella", "Max", "Biscuit", "Pepper"].map((pet, i) => [pet, notes[i] as string])];
    const bytes = buildWorkbook({ sheets: [{ name: "Visits", rows }], orphans: [], definedNames: [], core: { title: "Visits", creator: "Clinic", modifiedBy: "Clinic" } });
    const spec: Spec = { ...SPEC, columns: [{ file: "v.xlsx", sheet: "Visits", header: "Pet", class: "vocabulary", treatment: "keep", confidence: 0, source: "heuristic" }], entities: {} };
    const r = applySpec([{ path: "v.xlsx", bytes }], spec, { salt: SALT });
    expect(r.skipped).toEqual([]);
    const wb = readWorkbook((r.outputs[0] as InputFile).bytes);
    const grace = pseudonymOf(r, "Grace Nguyen");
    expect(sheetRows(wb.sheets[0]!, wb.sharedStrings).slice(1)).toEqual([
      ["Bella", `Jack Russell. Owner ${grace} called about the next visit.`],
      ["Max", "Maine Coon, quiet and eating well this week."],
      ["Biscuit", `${grace} will collect her on Friday after work.`],
      ["Pepper", "No notes for this one at the moment."],
    ]);
    expect(r.files[0]?.proseNames).toBe(2);
  });
});

describe("applySpec: column rules win over the person-column heuristic, and drop/redact columns are not read for names", () => {
  const csv = "Client,Notes,Private\nAvery Quill,Seen today and doing well.,Grace Nguyen called\nRobin Carter,Seen today and eating well.,Theo Brannagh paid\nKit Placeholder,No change since the last visit.,x\nJo Thistle,Recheck in a week or two.,y\n";
  const at = (header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => rule("c.csv", header, cls, treatment);
  const run = (columns: ColumnRule[]) => applySpec([{ path: "c.csv", bytes: enc(csv) }], { ...SPEC, columns, entities: {} }, { salt: SALT });

  test("a rule that keeps or values a names column is followed, not the heuristic", () => {
    const kept = run([at("Client", "person", "keep"), at("Private", "unknown", "drop")]);
    expect(kept.files[0]?.columns.find((c) => c.header === "Client")?.outcome).toBe("kept");
    expect(out(kept, "c.csv").split("\n")[1]).toBe("Avery Quill,Seen today and doing well.");
    const valued = run([at("Client", "org", "value"), at("Private", "unknown", "drop")]);
    expect(valued.files[0]?.columns.find((c) => c.header === "Client")?.outcome).toBe("value");
    expect(out(valued, "c.csv").split("\n")[1]).toMatch(/^Value_[0-9A-F]{4},/);
  });

  test("names only in a dropped or redacted column are not prose people: nothing else is rewritten for them", () => {
    for (const treatment of ["drop", "redact"] as const) {
      const r = run([at("Client", "person", "keep"), at("Private", "unknown", treatment)]);
      expect(r.map.entries.filter((e) => e.kind === "person")).toEqual([]);
      expect(out(r, "c.csv")).not.toContain("Nguyen");
      expect(r.files[0]?.proseNames).toBeUndefined();
    }
  });
});
