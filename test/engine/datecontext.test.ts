// AGT-1813: a name part that is also a month or weekday word is left alone in a date context.
// Synthetic data only: invented names, example.com.

import { describe, expect, test } from "bun:test";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { applySpec } from "../../src/engine/apply.ts";
import { inDateContext, isDateWord } from "../../src/engine/datecontext.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 17);
const rule: ColumnRule = { file: "staff.csv", header: "Name", class: "person", treatment: "blind", confidence: 1, source: "human" };
const SPEC: Spec = {
  version: 1,
  columns: [rule],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text, "utf8") });

function run(note: string) {
  const r = applySpec([file("staff.csv", "Name\nJan Vellacourt\n"), file("notes.txt", note)], SPEC, { salt: SALT });
  const text = (p: string) => Buffer.from(r.outputs.find((o) => o.path === p)?.bytes ?? new Uint8Array()).toString("utf8");
  return { r, notes: text("notes.txt"), pseudo: r.map.entries.find((e) => e.value === "Jan Vellacourt")?.pseudonym ?? "" };
}

describe("inDateContext", () => {
  const ctx = (t: string, w: string) => inDateContext(t, t.indexOf(w), t.indexOf(w) + w.length);
  test("next to a day number or year, either order", () => {
    expect(ctx("on 9 Jan. 2026", "Jan")).toBe(true);
    expect(ctx("Jan. 9 call", "Jan")).toBe(true);
    expect(ctx("Jan 2026", "Jan")).toBe(true);
    expect(ctx("due May 3rd", "May")).toBe(true);
    expect(ctx("2026, Jan", "Jan")).toBe(true);
    expect(ctx("Mon, 9 Feb", "Mon")).toBe(true);
  });
  test("elsewhere it is not", () => {
    expect(ctx("met Jan on", "Jan")).toBe(false);
    expect(ctx("Jan 45 units", "Jan")).toBe(false);
    expect(ctx("Jan 12345", "Jan")).toBe(false);
    expect(ctx("Jan 9am", "Jan")).toBe(false);
    expect(ctx("Jan 3.5 hours", "Jan")).toBe(false);
  });
  test("month and weekday words", () => {
    for (const w of ["Jan", "Sept", "June", "August", "Mon", "Sunday"]) expect(isDateWord(w)).toBe(true);
    expect(isDateWord("Avery")).toBe(false);
  });
});

describe("date context in free text", () => {
  test("the AGT-1813 example: the name is replaced, the date is not", () => {
    const { notes, pseudo } = run("met Jan on 9 Jan. 2026\n");
    expect(pseudo).not.toBe("");
    expect(notes).toBe("met Person_" + pseudo.replace(/^Person_/, "") + " on 9 Jan. 2026\n");
    expect(notes.startsWith("met Person_")).toBe(true);
  });
  test("both orders and a bare year", () => {
    const { notes } = run("Jan. 9 and Jan 2026 and 3 Jan, then Jan again\n");
    expect(notes.startsWith("Jan. 9 and Jan 2026 and 3 Jan, then Person_")).toBe(true);
  });
  test("the audit agrees: no leak and no lone-name candidate for the dated word", () => {
    const { r } = run("met Jan on 9 Jan. 2026\n");
    const entries: TreeEntry[] = r.outputs.map((o) => ({ path: o.path, kind: "file", bytes: o.bytes }));
    const report = addSemanticLayer(auditTree(entries, SPEC, r.map, []), entries, SPEC, r.map, { keep: [] });
    expect(report.status).toBe("clean");
    // The same dated text left unblinded (a name part survives alone): only the undated one is a finding.
    const raw: TreeEntry[] = [{ path: "n.txt", kind: "file", bytes: Buffer.from("met Jan on 9 Jan. 2026\nwrote 9 Jan. 2026\n") }];
    const rep = addSemanticLayer(auditTree(raw, SPEC, r.map, []), raw, SPEC, r.map, { keep: [] });
    const hits = rep.files.flatMap((f) => f.findings).map((f) => f.line);
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits)).toEqual(new Set([1]));
  });
});
