// AGT-1801: lone given names and nicknames the spec missed. The semantic layer flags a lone
// capitalised word as a `semantic:name` candidate; the mechanical layer calls a word of a blinded
// person's name (from the map) found alone a leak, under the engine's case rules.
// Synthetic data only: invented names, example.com.

import { describe, expect, test } from "bun:test";
import { type AuditReport, auditTree, type Finding, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { generateKit, kitFileBytes, kitSpec } from "../../src/bench/synth.ts";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import type { Spec } from "../../src/schema.ts";
import { makeZip } from "./zipfixture.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);
const EMPTY_MAP: BlindMap = { version: 1, entries: [] };

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { vocabulary: [{ canonical: "Jan.", aliases: [], parts: [] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const file = (path: string, data: Uint8Array | string): TreeEntry => ({
  path,
  kind: "file",
  bytes: typeof data === "string" ? Buffer.from(data, "utf8") : data,
});

function audit(entries: TreeEntry[], spec: Spec = SPEC, map: BlindMap = EMPTY_MAP, keep: string[] = []): AuditReport {
  return addSemanticLayer(auditTree(entries, spec, map, keep), entries, spec, map, { keep });
}

const all = (r: AuditReport): Finding[] => [...r.files.flatMap((f) => f.findings), ...r.general];
const names = (r: AuditReport): string[] => all(r).filter((f) => f.class === "semantic:name").map((f) => f.masked);

/** Kit v1 blinded under `spec`, audited by both layers, as `blind audit --no-model` runs them. */
function kitAudit(spec: Spec): { report: AuditReport; text: string } {
  const kit = generateKit();
  const r = applySpec(kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) })), spec, { salt: SALT });
  const entries = [{ path: "notes", kind: "dir" } as TreeEntry, ...r.outputs.map((o) => file(o.path, o.bytes))];
  const text = r.outputs.map((o) => Buffer.from(o.bytes).toString("utf8")).join("\n");
  return { report: audit(entries, spec, r.map), text };
}

describe("lone names on synthetic kit v1", () => {
  test("after a correct spec there are at most 3 semantic:name candidates (in fact none) and no leak", () => {
    const { report } = kitAudit(kitSpec());
    expect(names(report).length).toBeLessThanOrEqual(3);
    expect(names(report)).toEqual([]);
    expect(report.summary.leaks).toBe(0);
  });

  test("a spec that leaves out a person's given name: the engine still replaces it, and the audit agrees", () => {
    const spec = kitSpec();
    spec.entities.person = spec.entities.person?.map((p) => (p.canonical === "Marisol Penhallow" ? { ...p, parts: p.parts.filter((x) => x !== "Marisol") } : p));
    const { report, text } = kitAudit(spec);
    // The person is blinded in the Owner column, so their given name alone gets their pseudonym too (AGT-1803).
    expect(text).not.toMatch(/\bMarisol\b/);
    expect(report.summary.leaks).toBe(0);
    // Had it survived, the audit would call it a leak.
    const kit = generateKit();
    const r = applySpec(kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) })), spec, { salt: SALT });
    const entries = r.outputs.map((o) => file(o.path, o.path === "notes/review.md" ? `${Buffer.from(o.bytes).toString("utf8")}\nAsk Marisol.\n` : o.bytes));
    const leaked = audit(entries, spec, r.map);
    expect(leaked.status).toBe("leak");
    expect(all(leaked)).toContainEqual(expect.objectContaining({ file: "notes/review.md", class: "person", source: "map", severity: "leak", masked: "Ma***7" }));
  });

  test("a forgotten nickname is a semantic:name candidate: the file is not clean", () => {
    const spec = kitSpec();
    spec.entities.person = spec.entities.person?.map((p) => ({ ...p, aliases: p.aliases.filter((a) => a !== "Iggy") }));
    const { report, text } = kitAudit(spec);
    expect(text).toMatch(/\bIggy\b/);
    expect(report.status).toBe("candidates");
    expect(names(report)).toEqual(["Ig***4"]);
    expect(report.files.find((f) => f.path === "notes/review.md")?.status).toBe("candidates");
  });
});

describe("semantic:name candidates", () => {
  test("a lone capitalised word mid-sentence is a candidate, once per file with its count", () => {
    const text = "the export went to Marisol on Monday.\nWe asked Marisol again.\n";
    const r = audit([file("a.txt", text)]);
    expect(all(r)).toEqual([
      expect.objectContaining({ class: "semantic:name", severity: "candidate", masked: "Ma***7", offset: text.indexOf("Marisol"), line: 1 }),
    ]);
    expect(all(r)[0]?.reason).toContain("(2 places in this file)");
    expect(r.status).toBe("candidates");
  });

  test("a word only ever sentence-initial is prose; repeated mid-sentence elsewhere it is a candidate", () => {
    expect(names(audit([file("a.txt", "Quarterly review.\n# Standup\n- Contacts follow. Reconciled later? Yes: Totals match\n")]))).toEqual([]);
    expect(names(audit([file("a.txt", "Teddie sent it.\nThen we thanked Teddie.\n")]))).toEqual(["Te***6"]);
    // In another file the mid-sentence use does not count.
    expect(names(audit([file("a.txt", "Teddie sent it.\n"), file("b.txt", "we thanked Teddie\n")]))).toEqual(["Te***6"]);
    expect(all(audit([file("a.txt", "Teddie sent it.\n"), file("b.txt", "we thanked Teddie\n")])).map((f) => f.file)).toEqual(["b.txt"]);
  });

  test("dictionary words, short words, keep terms, vocabulary forms and pseudonyms are not candidates", () => {
    const spec: Spec = { ...SPEC, entities: { vocabulary: [{ canonical: "Grafton", aliases: [], parts: [] }, { canonical: "Jan.", aliases: [], parts: [] }] } };
    const map: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "x", value: "x", pseudonym: "Person_A1B2" }] };
    const text = "we saw Server and Report, Al and Bo, the Halverson team, the Grafton site, Person_A1B2 again, on 9 Jan.\n";
    expect(names(audit([file("a.txt", text)], spec, map, ["Halverson"]))).toEqual([]);
    expect(names(audit([file("a.txt", text)]))).toEqual(["Ha***9", "Gr***7"]);
  });

  test("a month or weekday abbreviation with its dot is not a name; without it, it may be", () => {
    expect(names(audit([file("a.txt", "due 9 Feb. and 3 Sept. then Tues. again\n")]))).toEqual([]);
    expect(names(audit([file("a.txt", "we met Feb on the stairs\n")]))).toEqual(["F***3"]);
  });

  test("a word inside a Title-Case phrase is the phrase's, not a lone name", () => {
    const r = audit([file("a.txt", "we called Northwind Harbor today\n")]);
    expect(all(r).map((f) => f.class)).toEqual(["semantic:phrase"]);
  });

  test("a vocabulary term starting at a leading function word explains the lone word after it", () => {
    const spec: Spec = { ...SPEC, entities: { vocabulary: [{ canonical: "Not Halted", aliases: [], parts: [] }] } };
    expect(names(audit([file("a.txt", "status is Not Halted now\n")], spec))).toEqual([]);
  });

  test("after a title abbreviation, a key-value colon or a CSV comma, a word is mid-sentence", () => {
    expect(names(audit([file("a.txt", "Dr. Marisol\n")]))).toEqual(["Ma***7"]);
    expect(names(audit([file("a.json", '{"owner": "Marisol"}\n')]))).toEqual(["Ma***7"]);
    expect(names(audit([file("a.csv", "id,owner\n1,Marisol\n")]))).toEqual(["Ma***7"]);
  });

  test("a name in a DOCX paragraph run is found in its text; archive headers and binary bytes are not read for names", () => {
    const doc = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>we asked Marisol</w:t></w:r></w:p></w:body></w:document>';
    const zip = makeZip([{ name: "word/document.xml", data: doc }]);
    expect(names(audit([file("memo.docx", zip)]))).toEqual(["Ma***7"]);
    // Random bytes that happen to spell Title-Case words are not names.
    const binary = Uint8Array.from([0x00, 0x01, ...Buffer.from(" the Qwerty and Zxcvb "), 0x02]);
    expect(names(audit([file("blob.bin", binary)]))).toEqual([]);
  });
});

describe("a word of a blinded person's name, alone (mechanical, map source)", () => {
  const MAP: BlindMap = {
    version: 1,
    entries: [
      { kind: "person", canonical: "marisol penhallow", value: "Marisol Penhallow", pseudonym: "Person_1A2B" },
      { kind: "person", canonical: "will price", value: "Will Price", pseudonym: "Person_3C4D" },
    ],
  };
  const mech = (text: string, keep: string[] = []) => all(auditTree([file("a.txt", text)], SPEC, MAP, keep)).filter((f) => f.source === "map");

  test("the given name or surname in the engine's case is a leak", () => {
    expect(mech("we asked Marisol and PENHALLOW")).toEqual([
      expect.objectContaining({ class: "person", severity: "leak", masked: "Ma***7" }),
      expect.objectContaining({ class: "person", severity: "leak", masked: "PE***9" }),
    ]);
  });

  test("in another case it is a candidate; inside a longer word it is not reported", () => {
    expect(mech("we asked marisol")).toEqual([expect.objectContaining({ severity: "candidate", masked: "ma***7" })]);
    expect(mech("the Marisolas file")).toEqual([]);
  });

  test("a part that is an ordinary word or a keep term is a candidate at most", () => {
    expect(mech("Price went up; we will see")).toEqual([expect.objectContaining({ severity: "candidate", masked: "Pr***5" })]);
    expect(mech("Penhallow Gardens", ["Penhallow"])).toEqual([expect.objectContaining({ severity: "candidate", masked: "Pe***9" })]);
  });

  test("the whole value is still one finding, and a pseudonym is not one", () => {
    expect(mech("Marisol Penhallow")).toEqual([expect.objectContaining({ severity: "leak", masked: "Ma***17" })]);
    expect(mech("Person_1A2B said so")).toEqual([]);
  });
});
