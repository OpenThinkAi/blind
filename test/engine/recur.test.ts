import { describe, expect, test } from "bun:test";
import { auditTree, MIN_LEAK_LENGTH, type TreeEntry } from "../../src/audit/mechanical.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { MIN_RECUR_LENGTH, nameParts, partExclusion, recurrenceExclusion, recurrenceForms, TextScanner } from "../../src/engine/recur.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic salt and data only: invented names and codes, example.com, RFC 5737 addresses.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});
const jrule = (file: string, jsonPath: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  jsonPath,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns: [],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
  ...over,
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`no output ${path}`);
  return Buffer.from(o.bytes).toString("utf8");
};
const pseudonymOf = (r: ApplyResult, value: string): string => {
  const e = r.map.entries.find((x) => x.value === value);
  if (e === undefined) throw new Error(`${value} is not in the map`);
  return e.pseudonym;
};

const PROJECTS = [
  "Project,Phase,Notes",
  "PRJ-7731,build,kickoff done",
  "Larkspur Ridge Upgrade,design,waiting on PRJ-7731 sign-off",
  "QX9,build,short code",
  "N/A,build,placeholder",
  "open,build,an ordinary word as a value",
].join("\n") + "\n";

const PROJECT_SPEC = spec({
  columns: [
    rule("projects.csv", "Project", "id", "blind"),
    rule("projects.csv", "Phase", "vocabulary", "keep"),
    rule("projects.csv", "Notes", "unknown", "value"),
  ],
});

describe("recurrence rules", () => {
  test("the minimum length agrees with the audit's", () => {
    expect(MIN_RECUR_LENGTH).toBe(MIN_LEAK_LENGTH);
  });

  test("short values, dictionary words and vocabulary forms are excluded, with the reason", () => {
    const vocab = new Set(["larkspur"]);
    expect(recurrenceExclusion("42", vocab)).toContain("fewer than 3");
    expect(recurrenceExclusion("N/A", vocab)).toContain("fewer than 3");
    expect(recurrenceExclusion("open", vocab)).toBe("only dictionary words");
    expect(recurrenceExclusion("Main Office", vocab)).toBe("only dictionary words");
    expect(recurrenceExclusion("Larkspur", vocab)).toBe("a spec vocabulary form");
    expect(recurrenceExclusion("QX9", vocab)).toBeNull();
    expect(recurrenceExclusion("PRJ-7731", vocab)).toBeNull();
    expect(recurrenceExclusion("Office 12B", vocab)).toBeNull();
  });

  test("forms: the value and its canonical form, sorted, deduplicated and independent of input order", () => {
    const values = [
      { cls: "org" as const, value: "Brightwater Mills, Inc." },
      { cls: "org" as const, value: "Copperleaf Ltd" },
      { cls: "person" as const, value: "Quill, Avery" },
      { cls: "id" as const, value: "PRJ-7731" },
      { cls: "id" as const, value: "PRJ-7731" },
      { cls: "id" as const, value: "42" },
    ];
    const forms = recurrenceForms(values, {});
    expect(forms).toEqual([
      { cls: "id", value: "PRJ-7731", form: "PRJ-7731" },
      { cls: "org", value: "Brightwater Mills, Inc.", form: "Brightwater Mills, Inc." },
      // A one-word canonical form is capitalised, so lowercase "copperleaf" in prose is not matched.
      { cls: "org", value: "Copperleaf Ltd", form: "Copperleaf" },
      { cls: "org", value: "Copperleaf Ltd", form: "Copperleaf Ltd" },
      { cls: "org", value: "Brightwater Mills, Inc.", form: "brightwater mills" },
      // A person's name parts recur on their own, with the person's value (AGT-1803).
      { cls: "person", value: "Quill, Avery", form: "Avery" },
      { cls: "person", value: "Quill, Avery", form: "Quill", surname: true },
      { cls: "person", value: "Quill, Avery", form: "Quill, Avery" },
      { cls: "person", value: "Quill, Avery", form: "avery quill" },
    ]);
    expect(recurrenceForms([...values].reverse(), {})).toEqual(forms);
  });

  test("earlier map entries recur; host labels and email local parts do not", () => {
    const map: BlindMap = {
      version: 1,
      entries: [
        { kind: "id", canonical: "zx-9001", value: "ZX-9001", pseudonym: "Id_0A0A" },
        { kind: "host-label", canonical: "mailhub", value: "mailhub", pseudonym: "host-0b0b" },
        { kind: "email-local", canonical: "rowan.sample", value: "rowan.sample", pseudonym: "user_0c0c" },
      ],
    };
    expect(recurrenceForms([], {}, map)).toEqual([{ cls: "id", value: "ZX-9001", form: "ZX-9001" }]);
  });

  test("a kept cell gets only recurring values; spec entities stay and are flagged", () => {
    const entities = { person: [{ canonical: "Avery Quill", aliases: [], parts: [] }] };
    const scanner = new TextScanner(entities, spec().patterns, [], [{ cls: "id", value: "PRJ-7731", form: "PRJ-7731" }]);
    const cell = "Avery Quill owns PRJ-7731";
    expect(scanner.kept(cell).map((s) => [cell.slice(s.start, s.end), s.source])).toEqual([["PRJ-7731", "map"]]);
    expect(scanner.flagged(cell)).toBe(true);
    expect(scanner.free(cell).map((s) => s.source)).toEqual(["entity", "map"]);
  });
});

describe("applySpec: values blinded in a column are replaced where they recur", () => {
  const notes = [
    "Status for PRJ-7731: on track.",
    "Larkspur Ridge Upgrade slips a week; larkspur ridge upgrade is the lowercase spelling.",
    "QX9 and qx9 and PRJ-77310 and XPRJ-7731 and prj-7731.",
    "Leave this open, N/A for now.",
  ].join("\n") + "\n";
  const kept = ["Ticket,Summary", "T-1,blocked by PRJ-7731", "T-2,QX9 needs review", "T-3,keep it open"].join("\n") + "\n";
  const keptSpec = spec({
    columns: [...PROJECT_SPEC.columns, rule("tickets.csv", "Ticket", "id", "keep"), rule("tickets.csv", "Summary", "vocabulary", "keep")],
  });
  const inputs = [file("projects.csv", PROJECTS), file("notes.txt", notes), file("tickets.csv", kept)];
  const r = applySpec(inputs, keptSpec, { salt: SALT });
  const prj = pseudonymOf(r, "PRJ-7731");
  const qx9 = pseudonymOf(r, "QX9");
  const lark = pseudonymOf(r, "Larkspur Ridge Upgrade");

  test("in a text file, by whole token and the entity case rules", () => {
    const t = out(r, "notes.txt");
    expect(t).toContain(`Status for ${prj}: on track.`);
    // A multi-word value matches in any case.
    expect(t).toContain(`${lark} slips a week; ${lark} is the lowercase spelling.`);
    // A short all-caps code matches exactly; a longer token containing a value is left alone.
    expect(t).toContain(`${qx9} and qx9 and PRJ-77310 and XPRJ-7731 and prj-7731.`);
    // Short values and dictionary words are not replaced in prose.
    expect(t).toContain("Leave this open, N/A for now.");
    expect(r.files.find((f) => f.path === "notes.txt")?.mappedReplacements).toBe(4);
  });

  test("in a column kept as text (unknown) and in a keep column", () => {
    expect(out(r, "projects.csv")).toContain(`waiting on ${prj} sign-off`);
    const t = out(r, "tickets.csv");
    expect(t).toBe(["Ticket,Summary", `T-1,blocked by ${prj}`, `T-2,${qx9} needs review`, "T-3,keep it open"].join("\n") + "\n");
    expect(r.files.find((f) => f.path === "tickets.csv")?.columns.find((c) => c.header === "Summary")?.changed).toBe(2);
  });

  test("values an unknown or unmentioned column pseudonymised as identifier-like recur too", () => {
    const staff = "Owner,Badge\nAvery Quill,BX-1001\nRobin Example,BX-1002\nJo Sample,BX-1003\nKit Placeholder,BX-1004\n";
    const notes = "Avery Quill met Robin Example about BX-1003.\n";
    const s = spec({ columns: [rule("staff.csv", "Owner", "unknown", "value")] });
    const res = applySpec([file("staff.csv", staff), file("notes.txt", notes)], s, { salt: SALT });
    const cols = res.files.find((f) => f.path === "staff.csv")?.columns.map((c) => c.outcome);
    // Owner holds people's names, so it is pseudonymised as person (AGT-1830); Badge as values.
    expect(cols).toEqual(["unknown-person", "unknown-pseudonymised"]);
    expect(out(res, "notes.txt")).toBe(
      `${pseudonymOf(res, "Avery Quill")} met ${pseudonymOf(res, "Robin Example")} about ${pseudonymOf(res, "BX-1003")}.\n`,
    );
  });

  test("a value from a vocabulary column does not recur", () => {
    const s = spec({
      columns: [rule("tags.csv", "Tag", "vocabulary", "blind"), rule("tags.csv", "Note", "vocabulary", "keep")],
    });
    const res = applySpec([file("tags.csv", "Tag,Note\nHelixwork,see Helixwork\n")], s, { salt: SALT });
    expect(out(res, "tags.csv")).toMatch(/^Tag,Note\nValue_[0-9A-F]{4},see Helixwork\n$/);
  });

  test("a spec vocabulary form shields its text", () => {
    const s = spec({
      columns: [rule("a.csv", "Code", "id", "blind")],
      entities: { vocabulary: [{ canonical: "Bramble", aliases: [], parts: [] }] },
    });
    const res = applySpec([file("a.csv", "Code\nBramble\nHX-2201\n"), file("b.txt", "Bramble and HX-2201\n")], s, { salt: SALT });
    expect(out(res, "b.txt")).toBe(`Bramble and ${pseudonymOf(res, "HX-2201")}\n`);
  });

  test("the longest form wins over a shorter spec entity inside it", () => {
    const s = spec({
      columns: [rule("orgs.csv", "Org", "org", "blind")],
      entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
    });
    const res = applySpec([file("orgs.csv", "Org\nAvery Quill Studio\n"), file("n.txt", "Avery Quill Studio hired Avery.\n")], s, { salt: SALT });
    const t = out(res, "n.txt");
    expect(t).toMatch(new RegExp(`^${pseudonymOf(res, "Avery Quill Studio")} hired Person_[0-9A-F]{4}\\.\\n$`));
  });

  test("in JSON string values, kept or free", () => {
    const json = `{"projects":[{"code":"PRJ-7731","note":"see PRJ-7731","log":"PRJ-7731 moved"}]}\n`;
    const s = spec({ columns: [jrule("p.json", "$.projects[*].code", "id", "blind"), jrule("p.json", "$.projects[*].note", "vocabulary", "keep")] });
    const res = applySpec([file("p.json", json)], s, { salt: SALT });
    const p = pseudonymOf(res, "PRJ-7731");
    expect(out(res, "p.json")).toBe(`{"projects":[{"code":"${p}","note":"see ${p}","log":"${p} moved"}]}\n`);
    expect(res.files[0]?.mappedReplacements).toBe(2);
  });

  test("a value an earlier map holds recurs even when no column holds it this time", () => {
    const first = applySpec([file("projects.csv", PROJECTS)], PROJECT_SPEC, { salt: SALT });
    const second = applySpec([file("later.txt", "PRJ-7731 shipped\n")], spec(), { salt: SALT, map: first.map });
    expect(out(second, "later.txt")).toBe(`${pseudonymOf(first, "PRJ-7731")} shipped\n`);
  });

  test("deterministic: a second run, and a run on shuffled inputs, are byte-identical", () => {
    const again = applySpec([...inputs].reverse(), keptSpec, { salt: SALT });
    expect(again.outputs.map((o) => [o.path, Buffer.from(o.bytes).toString("hex")])).toEqual(
      r.outputs.map((o) => [o.path, Buffer.from(o.bytes).toString("hex")]),
    );
    expect(again.map).toEqual(r.map);
  });
});

describe("name parts of people blinded in a column (AGT-1803)", () => {
  const people = "Owner,Ticket\nAvery Quill,T-1\nBea Quill,T-2\nRowan Tamsin-Vale,T-3\nWill Price,T-4\n";
  const peopleSpec = spec({ columns: [rule("people.csv", "Owner", "person", "blind"), rule("people.csv", "Ticket", "id", "keep")] });
  const audited = (r: ApplyResult, keep: string[] = []) =>
    auditTree(r.outputs.map((o): TreeEntry => ({ path: o.path, kind: "file", bytes: o.bytes })), peopleSpec, r.map, keep);

  test("a lone given name or surname gets the person's pseudonym, and apply then audit has no leak", () => {
    const res = applySpec([file("people.csv", "Owner\nAvery Quill\n"), file("notes.txt", "Quill approved it; Avery agreed.\n")], spec({ columns: [rule("people.csv", "Owner", "person", "blind")] }), { salt: SALT });
    const avery = pseudonymOf(res, "Avery Quill");
    expect(out(res, "notes.txt")).toBe(`${avery} approved it; ${avery} agreed.\n`);
    expect(res.files.find((f) => f.path === "notes.txt")?.mappedReplacements).toBe(2);
    const report = auditTree(res.outputs.map((o): TreeEntry => ({ path: o.path, kind: "file", bytes: o.bytes })), spec({ columns: [rule("people.csv", "Owner", "person", "blind")] }), res.map);
    expect(report.summary.leaks).toBe(0);
    expect(report.status).toBe("clean");
    expect(res.sharedNameParts).toEqual([]);
  });

  test("a part two people share gets its own pseudonym, never either person's, and is reported", () => {
    const notes = "Quill signed; Avery and Bea agreed. Rowan, Tamsin-Vale and Vale too.\n";
    const res = applySpec([file("people.csv", people), file("notes.txt", notes)], peopleSpec, { salt: SALT });
    const [avery, bea, rowan] = [pseudonymOf(res, "Avery Quill"), pseudonymOf(res, "Bea Quill"), pseudonymOf(res, "Rowan Tamsin-Vale")];
    const quill = pseudonymOf(res, "Quill");
    expect(new Set([avery, bea, quill]).size).toBe(3);
    // "Rowan, Tamsin-Vale" is two parts of one person next to each other: one span (AGT-1842).
    expect(out(res, "notes.txt")).toBe(`${quill} signed; ${avery} and ${bea} agreed. ${rowan} and ${rowan} too.\n`);
    expect(res.sharedNameParts).toEqual([quill]);
    expect(audited(res).summary.leaks).toBe(0);
  });

  test("left alone: dictionary-word parts, short parts, keep terms, vocabulary forms, and a lowercase part", () => {
    const s = spec({ ...peopleSpec, entities: { vocabulary: [{ canonical: "Tamsin", aliases: [], parts: [] }] } });
    const notes = "Price and Will left; Al stayed; quill pens; Tamsin site; Vale road.\n";
    const res = applySpec([file("people.csv", `${people}Al Ostrander,T-5\n`), file("notes.txt", notes)], s, { salt: SALT, keep: ["Vale"] });
    expect(out(res, "notes.txt")).toBe(notes);
    expect(partExclusion("Will", new Set(), new Set())).toBe("a dictionary word");
    expect(partExclusion("Al", new Set(), new Set())).toContain("fewer than 3");
    expect(partExclusion("Vale", new Set(), new Set(["vale"]))).toBe("a keep term");
    expect(partExclusion("Tamsin", new Set(["tamsin"]), new Set())).toBe("a spec vocabulary form");
    // Whole-word dictionary check, as the audit makes it: a hyphenated name of two words is a name.
    expect(partExclusion("Rose-May", new Set(), new Set())).toBeNull();
  });

  test("nameParts: written and canonical words, hyphen pieces, capitalised; independent of input order", () => {
    const parts = nameParts(["QUILL, AVERY", "Bea Quill", "Rowan Tamsin-Vale", "Mary-Kate"], [], new Set(), new Set());
    const by = Object.fromEntries(parts.map((p) => [p.form, [p.value, p.shared]]));
    expect(by).toEqual({
      Avery: ["QUILL, AVERY", false],
      Bea: ["Bea Quill", false],
      Kate: ["Mary-Kate", false],
      Mary: ["Mary-Kate", false],
      Quill: ["Quill", true],
      Rowan: ["Rowan Tamsin-Vale", false],
      Tamsin: ["Rowan Tamsin-Vale", false],
      "Tamsin-Vale": ["Rowan Tamsin-Vale", false],
      Vale: ["Rowan Tamsin-Vale", false],
    });
    expect(nameParts(["Mary-Kate", "Rowan Tamsin-Vale", "Bea Quill", "QUILL, AVERY"], [], new Set(), new Set())).toEqual(parts);
    // A part equal to someone's whole one-word name, or to a part of one of `others`, is shared.
    expect(nameParts(["Avery Quill"], ["Quill"], new Set(), new Set()).find((p) => p.form === "Quill")?.shared).toBe(true);
    expect(nameParts(["Avery Quill"], ["Avery Stone"], new Set(), new Set()).find((p) => p.form === "Avery")?.shared).toBe(true);
    // The same person written two ways is one person.
    expect(nameParts(["Avery Quill", "Quill, Avery"], [], new Set(), new Set()).every((p) => !p.shared)).toBe(true);
  });

  test("person entries of an earlier map give their parts too", () => {
    const first = applySpec([file("people.csv", "Owner\nAvery Quill\n")], spec({ columns: [rule("people.csv", "Owner", "person", "blind")] }), { salt: SALT });
    const second = applySpec([file("later.txt", "Avery called Quill.\n")], spec(), { salt: SALT, map: first.map });
    const avery = pseudonymOf(first, "Avery Quill");
    expect(out(second, "later.txt")).toBe(`${avery} called ${avery}.\n`);
  });

  test("a part a column person shares with a transcript speaker is ambiguous on both sides", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Avery Stone>Hello.</v>\n";
    const res = applySpec(
      [file("people.csv", "Owner\nAvery Quill\n"), file("call.vtt", vtt), file("notes.txt", "Avery wrote, Quill and Stone read.\n")],
      spec({ columns: [rule("people.csv", "Owner", "person", "blind")] }),
      { salt: SALT },
    );
    const avery = pseudonymOf(res, "Avery");
    expect(out(res, "notes.txt")).toBe(`${avery} wrote, ${pseudonymOf(res, "Avery Quill")} and ${pseudonymOf(res, "Avery Stone")} read.\n`);
    expect(new Set([avery, pseudonymOf(res, "Avery Quill"), pseudonymOf(res, "Avery Stone")]).size).toBe(3);
    expect(res.sharedNameParts).toEqual([avery]);
  });

  test("in JSON strings, kept cells and file names, through the same scan", () => {
    const res = applySpec(
      [file("people.csv", people), file("Quill review.txt", "ok\n"), file("t.json", '{"note":"Avery says hi"}\n')],
      spec({ columns: [...peopleSpec.columns, jrule("t.json", "$.note", "vocabulary", "keep")] }),
      { salt: SALT },
    );
    const avery = pseudonymOf(res, "Avery Quill");
    expect(out(res, "t.json")).toBe(`{"note":"${avery} says hi"}\n`);
    expect(res.files.find((f) => f.path === "Quill review.txt")?.outputPath).toBe(`${pseudonymOf(res, "Quill")} review.txt`);
  });

  test("deterministic on shuffled inputs", () => {
    const inputs = [file("people.csv", people), file("notes.txt", "Quill and Avery and Rowan.\n")];
    const a = applySpec(inputs, peopleSpec, { salt: SALT });
    const b = applySpec([...inputs].reverse(), peopleSpec, { salt: SALT });
    expect(b.outputs).toEqual(a.outputs);
    expect(b.map).toEqual(a.map);
    expect(b.sharedNameParts).toEqual(a.sharedNameParts);
  });
});
