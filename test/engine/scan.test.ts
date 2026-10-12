// The `scan` column treatment and the `[defaults] columns` switch (AGT-1834): a scanned cell is kept
// as written apart from what the free-text scanner finds in it; a column no rule decides can be
// scanned instead of failing closed; and a value held whole in a `keep` or `scan` cell is never
// pseudonymised whole by the fallback elsewhere. Synthetic data only: invented people, numbers,
// plates and codes.

import { describe, expect, test } from "bun:test";
import { renderReport } from "../../src/apply.ts";
import { auditTree } from "../../src/audit/mechanical.ts";
import { semanticFindings } from "../../src/audit/semantic.ts";
import { buildWorkbook } from "../../src/bench/office.ts";
import { applySpec, type ApplyOptions, type InputFile } from "../../src/engine/apply.ts";
import { scanJson } from "../../src/engine/json.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { defaultPolicy, parsePolicy, PolicyError, renderPolicy } from "../../src/policy.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { validateSpec } from "../../src/validate.ts";

const SALT = new Uint8Array(32).fill(5);
const PATTERNS = { ip: false, email: true, host: false, guid: false, mac: false, phone: true };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

type Where = { header: string } | { jsonPath: string } | { sheet: string; header: string };
const rule = (file: string, where: Where, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = treatment === "keep" ? "vocabulary" : "unknown"): ColumnRule =>
  ({ file, ...where, class: cls, treatment, confidence: 1, source: "policy" }) as ColumnRule;
const spec = (columns: ColumnRule[]): Spec => ({ version: 1, columns, entities: {}, patterns: PATTERNS, questions: [] });
const apply = (files: Record<string, string | Uint8Array>, columns: ColumnRule[], opts: Partial<ApplyOptions> = {}) =>
  applySpec(Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: typeof v === "string" ? enc(v) : v })), spec(columns), { salt: SALT, ...opts });
const out = (r: ReturnType<typeof apply>, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);
const cols = (r: ReturnType<typeof apply>, path: string) => (r.files.find((f) => f.path === path) as (typeof r.files)[number]).columns;

const NOTE = "Ear infection. Neighbour Dana Whitfield (801-555-0100, plate 7ABC123) drove her in.";
const VISITS = `pet,notes\nBiscuit,"${NOTE}"\nPepper,"Recheck in 2 weeks"\n`;
const book = (rows: (string | number)[][]): Uint8Array =>
  buildWorkbook({ sheets: [{ name: "Visits", rows }], orphans: [], definedNames: [], core: { title: "", creator: "", modifiedBy: "" } });
const xlsxRows = (bytes: Uint8Array): string[][] => {
  const wb = readWorkbook(bytes);
  return sheetRows(wb.sheets[0] as (typeof wb.sheets)[number], wb.sharedStrings);
};

/** What the scan treatment must do to NOTE: the name, the phone and the plate go; the clinical text stays. */
function expectScanned(note: string): void {
  expect(note).toStartWith("Ear infection. Neighbour Person_");
  expect(note).not.toContain("Dana");
  expect(note).not.toContain("Whitfield");
  expect(note).not.toContain("801-555-0100");
  expect(note).toContain("plate REDACTED");
  expect(note).toEndWith(") drove her in.");
}

describe("scan treatment", () => {
  test("CSV: the phone, the name and the plate are replaced, the rest of the note is unchanged", () => {
    const r = apply({ "visits.csv": VISITS }, [rule("visits.csv", { header: "pet" }, "keep"), rule("visits.csv", { header: "notes" }, "scan")]);
    const lines = out(r, "visits.csv").split("\n");
    expect(lines[1]).toStartWith('Biscuit,"');
    expectScanned((lines[1] as string).slice('Biscuit,"'.length, -1));
    expect(lines[2]).toBe('Pepper,"Recheck in 2 weeks"');
    const notes = cols(r, "visits.csv")[1];
    expect([notes?.outcome, notes?.changed, notes?.flagged]).toEqual(["scanned", 1, 0]);
    // Reported as a scanned column, not as a kept one with a warning.
    const report = renderReport(r);
    expect(report).toContain('"notes": unknown/scan → scanned');
    expect(report).not.toContain("review this rule");
  });

  test("keep stays byte-identical, and its warning names scan as the fix", () => {
    const r = apply({ "visits.csv": VISITS }, [rule("visits.csv", { header: "pet" }, "keep"), rule("visits.csv", { header: "notes" }, "keep")]);
    expect(out(r, "visits.csv")).toBe(VISITS);
    expect(cols(r, "visits.csv")[1]?.flagged).toBe(1);
    expect(renderReport(r)).toContain('give this column treatment "scan"');
  });

  test("JSON: a scanned key's string values are scanned as free text; keys and layout stay", () => {
    const json = `[\n  {"pet": "Biscuit", "notes": ${JSON.stringify(NOTE)}},\n  {"pet": "Pepper", "notes": "Recheck in 2 weeks"}\n]\n`;
    const r = apply({ "v.json": json }, [rule("v.json", { jsonPath: "$[*].pet" }, "keep"), rule("v.json", { jsonPath: "$[*].notes" }, "scan")]);
    const text = out(r, "v.json");
    const notes = scanJson(text).filter((t) => t.kind === "string" && t.column === "$[*].notes").map((t) => t.value);
    expectScanned(notes[0] as string);
    expect(notes[1]).toBe("Recheck in 2 weeks");
    expect(text).toContain('"pet": "Biscuit"');
    expect(cols(r, "v.json").map((c) => c.outcome)).toEqual(["kept", "scanned"]);
  });

  test("XLSX: a scanned column's cells are scanned as free text", () => {
    const bytes = book([["pet", "notes"], ["Biscuit", NOTE], ["Pepper", "Recheck in 2 weeks"]]);
    const r = apply({ "v.xlsx": bytes }, [rule("v.xlsx", { sheet: "Visits", header: "pet" }, "keep"), rule("v.xlsx", { sheet: "Visits", header: "notes" }, "scan")]);
    expect(r.skipped).toEqual([]);
    const rows = xlsxRows((r.outputs[0] as InputFile).bytes);
    expect(rows[1]?.[0]).toBe("Biscuit");
    expectScanned(rows[1]?.[1] as string);
    expect(rows[2]).toEqual(["Pepper", "Recheck in 2 weeks"]);
    expect(cols(r, "v.xlsx").map((c) => [c.outcome, c.changed])).toEqual([["kept", 0], ["scanned", 1]]);
  });

  test("a scan rule with class unknown is valid in a spec", () => {
    expect(validateSpec(spec([rule("a.csv", { header: "notes" }, "scan")])).ok).toBe(true);
  });
});

describe("[defaults] columns", () => {
  // An identifier-like code column, an identifier-like name column and a free-text column, none ruled.
  const KENNELS = "slot,owner,remark\nK-0141,Avery Quill,call avery.quill@example.com\nK-0142,Bo Sample,ok\nK-0143,Cy Tester,fine\nK-0144,Di Trial,fine\n";

  test("fallback (the default) pseudonymises identifier-like columns whole", () => {
    const r = apply({ "k.csv": KENNELS }, []);
    expect(cols(r, "k.csv").map((c) => c.outcome)).toEqual(["unknown-pseudonymised", "unknown-pseudonymised", "unknown-kept-not-identifier-like"]);
    expect(out(r, "k.csv")).not.toContain("K-0141");
  });

  test("scan keeps every unruled column and replaces only what the scanner finds; rules still win", () => {
    const r = apply({ "k.csv": KENNELS }, [], { columns: "scan" });
    const text = out(r, "k.csv");
    expect(cols(r, "k.csv").map((c) => c.outcome)).toEqual(["unknown-scanned", "unknown-scanned", "unknown-scanned"]);
    // Codes and the free text stay; the scanner still finds the email and a known given name + surname.
    expect(text).toMatch(/^K-0141,Person_[0-9A-F]+,call user_/m);
    expect(text).toContain("K-0142,Bo Sample,ok\n");
    expect(text).not.toContain("avery.quill@example.com");
    expect(renderReport(r)).toContain('"slot": unknown → scanned (the [defaults] columns setting)');
    // An explicit rule is not overridden by the default; an unknown/value rule is unruled.
    const ruled = apply({ "k.csv": KENNELS }, [rule("k.csv", { header: "owner" }, "blind", "person"), rule("k.csv", { header: "slot" }, "value")], { columns: "scan" });
    expect(cols(ruled, "k.csv").map((c) => c.outcome)).toEqual(["unknown-scanned", "blinded", "unknown-scanned"]);
    expect(out(ruled, "k.csv")).not.toContain("Avery Quill");
    expect(out(ruled, "k.csv")).toContain("K-0141");
  });

  test("scan applies to JSON keys and worksheet columns too", () => {
    const json = '[{"id": "K-0141"}, {"id": "K-0142"}, {"id": "K-0143"}, {"id": "K-0144"}]';
    const j = apply({ "k.json": json }, [], { columns: "scan" });
    expect(out(j, "k.json")).toBe(json);
    expect(cols(j, "k.json").find((c) => c.jsonPath === "$[*].id")?.outcome).toBe("unknown-scanned");
    const x = apply({ "k.xlsx": book([["slot"], ["K-0141"], ["K-0142"], ["K-0143"], ["K-0144"]]) }, [], { columns: "scan" });
    expect(xlsxRows((x.outputs[0] as InputFile).bytes).map((r) => r[0])).toEqual(["slot", "K-0141", "K-0142", "K-0143", "K-0144"]);
    expect(cols(x, "k.xlsx")[0]?.outcome).toBe("unknown-scanned");
  });
});

describe("a value held whole in a keep or scan cell", () => {
  // Contact is kept; Caller has no rule and is identifier-like, so the fallback pseudonymises it.
  const CALLS = "Caller\nBiscuit\n801-555-0177\nRiver Clinic\nAda Quill\nBo Sample\n";
  const CONTACTS = "Pet,Contact\nBiscuit,801-555-0177\nPepper,River Clinic\n";

  test("CSV: the fallback leaves it as text, scanned, and counts it; the kept cells do not change", () => {
    const r = apply({ "calls.csv": CALLS, "contacts.csv": CONTACTS }, [rule("contacts.csv", { header: "Pet" }, "keep"), rule("contacts.csv", { header: "Contact" }, "keep")]);
    expect(out(r, "contacts.csv")).toBe(CONTACTS);
    expect(cols(r, "contacts.csv").map((c) => c.changed)).toEqual([0, 0]);
    const calls = out(r, "calls.csv").split("\n");
    expect(calls[1]).toBe("Biscuit");
    // Held whole, but still scanned like free text: the phone pattern replaces it.
    expect(calls[2]).toMatch(/^Id_/);
    expect(calls[3]).toBe("River Clinic");
    expect(calls[4]).not.toContain("Ada Quill");
    const caller = cols(r, "calls.csv")[0];
    expect(caller?.outcome).toBe("unknown-pseudonymised");
    expect(caller?.heldWhole).toBe(3);
    expect(renderReport(r)).toContain('3 cells not pseudonymised whole: the same value is kept in a "keep" or "scan" cell elsewhere');
  });

  test("an explicit rule still blinds it", () => {
    const r = apply({ "calls.csv": CALLS, "contacts.csv": CONTACTS }, [rule("calls.csv", { header: "Caller" }, "blind", "person"), rule("contacts.csv", { header: "Pet" }, "keep")]);
    expect(out(r, "calls.csv")).not.toContain("Biscuit");
    expect(cols(r, "calls.csv")[0]?.heldWhole).toBeUndefined();
  });

  test("JSON and XLSX: held values are left as text there too", () => {
    const json = JSON.stringify(["Biscuit", "Ada Quill", "Bo Sample", "Cy Tester", "Di Trial"].map((caller) => ({ caller })));
    const j = apply({ "calls.json": json, "contacts.csv": CONTACTS }, [rule("contacts.csv", { header: "Pet" }, "keep")]);
    expect(out(j, "calls.json")).toContain('{"caller":"Biscuit"}');
    expect(out(j, "calls.json")).not.toContain("Ada Quill");
    expect(cols(j, "calls.json").find((c) => c.jsonPath === "$[*].caller")?.heldWhole).toBe(1);

    const x = apply({ "calls.xlsx": book([["Caller"], ["Biscuit"], ["Ada Quill"], ["Bo Sample"], ["Cy Tester"]]), "contacts.csv": CONTACTS }, [rule("contacts.csv", { header: "Pet" }, "keep")]);
    const rows = xlsxRows((x.outputs.find((o) => o.path === "calls.xlsx") as InputFile).bytes);
    expect(rows[1]).toEqual(["Biscuit"]);
    expect(rows[2]?.[0]).not.toBe("Ada Quill");
    const caller = cols(x, "calls.xlsx")[0];
    expect([caller?.heldWhole, caller?.changed]).toEqual([1, 3]);
  });

  test("a value held in a scanned XLSX cell counts too", () => {
    const x = apply({ "v.xlsx": book([["Caller", "Note"], ["Biscuit", "Biscuit"], ["Ada Quill", "ok"], ["Bo Sample", "fine"], ["Cy Tester", "fine"]]) }, [rule("v.xlsx", { sheet: "Visits", header: "Note" }, "scan")]);
    const rows = xlsxRows((x.outputs[0] as InputFile).bytes);
    expect(rows[1]).toEqual(["Biscuit", "Biscuit"]);
    expect(cols(x, "v.xlsx")[0]?.heldWhole).toBe(1);
  });
});

describe("policy", () => {
  const base = renderPolicy(defaultPolicy());

  test("[[columns]] accepts scan with no class; [defaults] columns parses and round-trips", () => {
    const p = parsePolicy(`${base}\n[[columns]]\nheader = ["notes"]\ntreatment = "scan"\n`.replace("[defaults]\n", "[defaults]\ncolumns = \"scan\"\n"));
    expect(p.columns).toEqual([{ header: ["notes"], treatment: "scan", class: "unknown" }]);
    expect(p.defaults.columns).toBe("scan");
    expect(parsePolicy(renderPolicy(p)).defaults.columns).toBe("scan");
    expect(parsePolicy(base).defaults.columns).toBe("fallback");
  });

  test("a bad [defaults] value is refused", () => {
    expect(() => parsePolicy(base.replace("[defaults]\n", '[defaults]\ncolumns = "keep"\n'))).toThrow(PolicyError);
    expect(() => parsePolicy(base.replace("[defaults]\n", "[defaults]\nrows = 1\n"))).toThrow(/unknown key defaults\.rows/);
  });

  test("the init template shows scan for notes-style columns and the defaults switch", () => {
    expect(base).toContain('# header = ["notes", "remarks", "diagnosis"]\n# treatment = "scan"');
    expect(base).toContain('# columns = "fallback"');
  });
});

describe("audit", () => {
  const empty = { version: 1, entries: [] } as never;

  test("a scan column with class unknown is not reported as an undecided column", () => {
    const report = auditTree([{ path: "v.csv", kind: "file", bytes: enc("notes\nok\n") }], spec([rule("v.csv", { header: "notes" }, "scan")]), empty);
    expect(report.files.flatMap((f) => f.findings).filter((f) => f.reason.includes("as unknown"))).toEqual([]);
  });

  test("a scan column is audited as free text even when classed vocabulary", () => {
    const bytes = enc("notes\nMarisol Okonkwo\n");
    const keep = semanticFindings([{ path: "v.csv", kind: "file", bytes }], spec([rule("v.csv", { header: "notes" }, "keep", "vocabulary")]), empty, { keep: [] });
    expect(keep.get("v.csv") ?? []).toEqual([]);
    const scan = semanticFindings([{ path: "v.csv", kind: "file", bytes }], spec([rule("v.csv", { header: "notes" }, "scan", "vocabulary")]), empty, { keep: [] });
    expect((scan.get("v.csv") ?? []).length).toBeGreaterThan(0);
  });
});
