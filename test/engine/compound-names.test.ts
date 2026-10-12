// AGT-1859: a person cell holding several people or a reversed name ("Dana & Lee Quillfeather",
// "Quillfeather, Dana & Lee", "Dana Quillfeather and Lee Marwick") gives name parts for each
// person, the shared surname included, so each recurs corpus-wide. Synthetic data only.

import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { Revealer, revealFile } from "../../src/engine/reveal.ts";
import { personAliases } from "../../src/engine/identity.ts";
import { splitPeople } from "../../src/engine/people.ts";
import { nameParts, personPartForms } from "../../src/engine/recur.ts";
import type { Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 59);
const spec = (): Spec => ({
  version: 1,
  columns: [{ file: "owners.csv", header: "owner", class: "person", treatment: "blind", confidence: 1, source: "human" }],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false, phone: true },
  questions: [],
});
const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => Buffer.from(r.outputs.find((o) => o.path === path)?.bytes ?? new Uint8Array()).toString("utf8");
const forms = (v: string) => nameParts([v], [], new Set(), new Set()).map((p) => `${p.form}=${p.value}${p.shared ? "*" : ""}`);

describe("splitPeople", () => {
  test("each form gives every person with the shared surname", () => {
    expect(splitPeople("Dana & Lee Quillfeather")).toEqual(["Dana Quillfeather", "Lee Quillfeather"]);
    expect(splitPeople("Dana and Lee Quillfeather")).toEqual(["Dana Quillfeather", "Lee Quillfeather"]);
    expect(splitPeople("Dana + Lee Quillfeather")).toEqual(["Dana Quillfeather", "Lee Quillfeather"]);
    expect(splitPeople("Quillfeather, Dana & Lee")).toEqual(["Dana Quillfeather", "Lee Quillfeather"]);
    expect(splitPeople("Dana Quillfeather & Lee Marwick")).toEqual(["Dana Quillfeather", "Lee Marwick"]);
    expect(splitPeople("Dr. Dana & Lee Quillfeather")).toEqual(["Dr. Dana Quillfeather", "Lee Quillfeather"]);
    expect(splitPeople("Marwick, Jo & Dana Quillfeather")).not.toBeNull();
  });
  test("one person, a non-name, or a cell with no surname to share is not split", () => {
    for (const v of ["Marwick, Jo", "Dana Quillfeather", "Smith & Wesson Holdings", "Room 4 & Lee Quill", "Dana & Lee", "Dr. A & Mrs. B", ""]) expect(splitPeople(v)).toBeNull();
  });
});

describe("name parts of a compound cell", () => {
  test("A & B Surname, A and B Surname, A + B Surname, Surname, First & Second: both given names and the shared surname", () => {
    for (const v of ["Dana & Lee Quillfeather", "Dana and Lee Quillfeather", "Dana + Lee Quillfeather", "Quillfeather, Dana & Lee"]) {
      // The surname belongs to two people, so it is given a pseudonym of its own.
      expect(forms(v)).toEqual(["Dana=Dana Quillfeather", "Lee=Lee Quillfeather", "Quillfeather=Quillfeather*"]);
    }
  });
  test("First Surname & Second Surname2 and Surname, First", () => {
    expect(forms("Dana Quillfeather & Lee Marwick")).toEqual(["Dana=Dana Quillfeather", "Lee=Lee Marwick", "Marwick=Lee Marwick", "Quillfeather=Dana Quillfeather"]);
    expect(forms("Marwick, Jo")).toContain("Marwick=Marwick, Jo");
  });
  test("a dictionary-word surname is still not recurred alone; the given name is", () => {
    const f = personPartForms([{ cls: "person", value: "Dana & Lee Brown" }], undefined, new Set()).map((x) => x.form);
    expect(f).toContain("Dana");
    expect(f).not.toContain("Brown");
  });
  test("every person's surname is a surname mark, and each person recurs as a full name", () => {
    const f = personPartForms([{ cls: "person", value: "Dana Quillfeather & Lee Marwick" }], undefined, new Set());
    expect(f.filter((x) => x.surname === true).map((x) => x.form).sort()).toEqual(["Marwick", "Quillfeather"]);
    expect(f.filter((x) => (x.form as string).includes(" ")).map((x) => x.form)).toEqual(["Dana Quillfeather", "Lee Marwick"]);
  });
  test("identity: a compound cell is its people, so an initial resolves to the one of that name", () => {
    const a = personAliases(["Dana Quillfeather & Lee Marwick", "L. Marwick"]);
    expect(a.get("l marwick")?.key).toBe("lee marwick");
  });
});

describe("a compound cell end to end", () => {
  const csv = 'owner,pet\nDana & Lee Quillfeather,Rex Quillfeather\n"Marwick, Jo",Biscuit Marwick\n"Vale, Ann & Bo",Pip Vale\nOrla Fenn and Kit Brandt,Moss\n';
  const prose = "the Quillfeather household called; Rex Quillfeather barked. Biscuit Marwick ate; Lee Quillfeather waved.\nThe Vale family, Kit Brandt and Orla Fenn.\n";
  const run = () => applySpec([file("owners.csv", csv), file("n.txt", prose)], spec(), { salt: SALT });

  test("surnames recur in a pet's full name and in prose; each cell has one pseudonym", () => {
    const r = run();
    const o = out(r, "n.txt");
    for (const s of ["Quillfeather", "Marwick", "Vale", "Brandt", "Fenn"]) expect(o).not.toContain(s);
    const rows = out(r, "owners.csv").trimEnd().split("\n");
    expect(rows[1]?.split(",")[0]).toMatch(/^Person_/);
    // Each individual full name takes the pseudonym that name has wherever it is written.
    const lee = r.map.entries.find((e) => e.value === "Lee Quillfeather")?.pseudonym;
    expect(lee).toBeDefined();
    expect(o).toContain(`${lee} waved`);
    // The shared surname has one pseudonym everywhere.
    const sur = r.map.entries.find((e) => e.value === "Quillfeather")?.pseudonym;
    expect(o).toContain(`the ${sur} household`);
    expect(o.match(new RegExp(sur as string, "g"))?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("reveal round-trips the prose and the table", () => {
    const r = run();
    const rv = new Revealer(r.map);
    for (const [path, original] of [["n.txt", prose], ["owners.csv", csv]] as const) {
      const bytes = r.outputs.find((x) => x.path === path)?.bytes as Uint8Array;
      expect(Buffer.from(revealFile(path, bytes, rv).bytes).toString("utf8")).toBe(original);
    }
  });
});
