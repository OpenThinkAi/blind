import { describe, expect, test } from "bun:test";
import { auditTree, type AuditReport, type TreeEntry } from "../../src/audit/mechanical.ts";
import { recurrenceForms, recurrenceExclusion, vocabularyForms } from "../../src/engine/recur.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// AGT-1838: the audit and the engine agree on which whole map values blind never recurs (one rule,
// recurrenceExclusion), and a pattern match or entity inside a cell of a column the spec keeps is a
// candidate ("kept by rule"), not a leak. Synthetic data only.

const rule = (file: string, header: string, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = "unknown"): ColumnRule => ({
  file, header, class: cls, treatment, confidence: 1, source: "human",
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns: [],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false, phone: true },
  questions: [],
  ...over,
});

const entry = (path: string, text: string): TreeEntry => ({ path, kind: "file", bytes: Buffer.from(text, "utf8") });
const mapOf = (...e: [string, string, string][]): BlindMap => ({
  version: 1,
  entries: e.map(([value, pseudonym, kind]) => ({ kind, canonical: value.toLowerCase(), value, pseudonym })) as BlindMap["entries"],
});
const all = (r: AuditReport) => [...r.files.flatMap((f) => f.findings), ...r.general];

describe("a whole map value that blind never recurs", () => {
  const map = mapOf(["Contact", "Value_1A2B", "value"], ["Quillhaven Annex", "Value_3C4D", "value"], ["ab", "Value_5E6F", "value"]);

  test("a dictionary-only survivor is a candidate, a name outside the dictionary is a leak", () => {
    const r = auditTree([entry("a.txt", "Contact: see Contact and Quillhaven Annex.\n")], spec(), map);
    const hits = all(r).filter((f) => f.source === "map");
    expect(hits.map((f) => [f.severity, f.reason.includes("does not recur it")])).toEqual([["candidate", true], ["candidate", true], ["leak", false]]);
    expect(r.status).toBe("leak");
  });

  test("a spec vocabulary form is not a leak either", () => {
    const s = spec({ entities: { vocabulary: [{ canonical: "Quillhaven Annex", aliases: [], parts: [] }] } });
    expect(all(auditTree([entry("a.txt", "Quillhaven Annex.\n")], s, map)).filter((f) => f.severity === "leak")).toEqual([]);
  });

  test("the engine and the audit agree: what the engine does not recur is never a leak", () => {
    const s = spec();
    const values = ["Contact", "Main Office", "Quillhaven Annex", "Ridgeway", "ab"];
    const recurred = new Set(recurrenceForms(values.map((value) => ({ cls: "value" as const, value })), s.entities).map((f) => f.value));
    for (const v of values) {
      const m = mapOf([v, "Value_1A2B", "value"]);
      const leak = all(auditTree([entry("a.txt", `see ${v} here\n`)], s, m)).some((f) => f.source === "map" && f.severity === "leak");
      expect(recurrenceExclusion(v, vocabularyForms(s.entities)) === null).toBe(recurred.has(v));
      if (!recurred.has(v)) expect(leak).toBe(false);
    }
  });
});

describe("a cell of a column the spec keeps", () => {
  const s = spec({ columns: [rule("clinic.csv", "clinic_phone", "keep", "vocabulary")], entities: { person: [{ canonical: "Dana Quill", aliases: [], parts: [] }] } });
  const csv = 'name,clinic_phone\nAnn,(206) 555-0199\n"Q, R",Dana Quill\n';

  test("a kept phone is shielded (no finding); an entity in the column is a candidate saying it was kept by rule", () => {
    const r = auditTree([entry("clinic.csv", csv)], s, mapOf());
    const hits = all(r).filter((f) => f.source === "pattern" || f.source === "entity");
    expect(hits.length).toBe(1);
    for (const f of hits) {
      expect(f.source).toBe("entity");
      expect(f.severity).toBe("candidate");
      expect(f.reason).toContain("kept by rule");
    }
    expect(r.status).toBe("candidates");
  });

  test("the same values outside the keep column, or in another file, stay leaks", () => {
    const other = 'name,clinic_phone\n(206) 555-0199 Dana Quill,x\n';
    const r = auditTree([entry("clinic.csv", other), entry("handbook.txt", "Call (206) 555-0199 or Dana Quill.\n")], s, mapOf());
    const leaks = all(r).filter((f) => f.severity === "leak");
    expect(leaks.map((f) => f.file).sort()).toEqual(["clinic.csv", "clinic.csv", "handbook.txt", "handbook.txt"]);
  });

  test("a BOM, a quoted cell and a tab-separated table are read exactly: both kept phones are shielded", () => {
    const tsv = spec({ columns: [rule("c.tsv", "phone", "keep", "vocabulary")] });
    const text = '﻿name\tphone\n"é, ü"\t(206) 555-0199\nx\t"(206) 555-0198"\n';
    const r = auditTree([entry("c.tsv", text)], tsv, mapOf());
    expect(all(r).filter((f) => f.source === "pattern")).toEqual([]);
  });
});
