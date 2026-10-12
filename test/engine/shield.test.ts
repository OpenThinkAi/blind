// Kept values and textbook placeholders are shielded (AGT-1853): a value held in a `keep` column is
// kept as written wherever else it appears, and the documentation placeholders (John Doe, 123 Main
// St, 999-9999, user@example.com) are kept too, unless [keep] placeholders = false. Synthetic data
// only: invented names, 555-01xx numbers.

import { describe, expect, test } from "bun:test";
import { renderReport } from "../../src/apply.ts";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { applySpec, type ApplyOptions, type InputFile } from "../../src/engine/apply.ts";
import { Shield, shieldable } from "../../src/engine/shield.ts";
import { defaultPolicy, parsePolicy, renderPolicy } from "../../src/policy.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const SALT = new Uint8Array(32).fill(7);
const PATTERNS = { ip: false, email: true, host: true, guid: false, mac: false, phone: true };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const rule = (file: string, header: string, treatment: ColumnRule["treatment"], cls: ColumnRule["class"] = treatment === "keep" ? "vocabulary" : "person"): ColumnRule =>
  ({ file, header, class: cls, treatment, confidence: 1, source: "policy" }) as ColumnRule;
const spec = (columns: ColumnRule[], entities: Spec["entities"] = {}): Spec => ({ version: 1, columns, entities, patterns: PATTERNS, questions: [] });
const apply = (files: Record<string, string>, s: Spec, opts: Partial<ApplyOptions> = {}) =>
  applySpec(Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: enc(v) })), s, { salt: SALT, ...opts });
const out = (r: ReturnType<typeof apply>, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);

const VISITS = "clinic_phone,owner_name\n(555) 555-0199,Dana Example\n";
const HANDBOOK = "After hours call (555) 555-0199.\nExample form: John Doe, 123 Main St, (999) 999-9999\n";
const RULES = [rule("v.csv", "clinic_phone", "keep"), rule("v.csv", "owner_name", "blind", "person")];

describe("a kept value shields the same text everywhere", () => {
  test("the repro: the kept phone and the textbook placeholders are unchanged in the handbook", () => {
    const r = apply({ "v.csv": VISITS, "handbook.md": HANDBOOK }, spec(RULES));
    expect(out(r, "v.csv")).toContain("(555) 555-0199");
    expect(out(r, "v.csv")).not.toContain("Dana Example");
    expect(out(r, "handbook.md")).toBe(HANDBOOK);
  });

  test("a phone is compared by canonical digits, however it is written", () => {
    const r = apply({ "v.csv": VISITS, "letter.txt": "Call 555-555-0199, or +1 555.555.0199, or 555 555 0199.\n" }, spec(RULES));
    expect(out(r, "letter.txt")).toBe("Call 555-555-0199, or +1 555.555.0199, or 555 555 0199.\n");
    // A different number is still a phone.
    const other = apply({ "v.csv": VISITS, "letter.txt": "Call (555) 555-0123.\n" }, spec(RULES));
    expect(out(other, "letter.txt")).toMatch(/^Call Id_[0-9A-F]{4}\.\n$/);
  });

  test("without the keep column the same phone is blinded", () => {
    const r = apply({ "v.csv": VISITS, "handbook.md": HANDBOOK }, spec([rule("v.csv", "owner_name", "blind", "person")]), { placeholders: false });
    expect(out(r, "handbook.md")).toMatch(/call Id_[0-9A-F]{4}\./);
  });

  test("a kept clinic name is not eaten by a learned name inside it", () => {
    const s = spec([rule("v.csv", "clinic", "keep", "location"), rule("v.csv", "owner_name", "blind", "person")], {
      location: [{ canonical: "Harbor", aliases: [], parts: [] }],
    });
    const csv = "clinic,owner_name\nHarbor View Animal Clinic,Dana Example\n";
    const r = apply({ "v.csv": csv, "a.txt": "Visit Harbor View Animal Clinic. The harbor road is closed, Harbor Lane too.\n" }, s);
    const a = out(r, "a.txt");
    expect(a).toStartWith("Visit Harbor View Animal Clinic.");
    // Elsewhere the spec entity still applies.
    expect(a).not.toContain("Harbor Lane");
  });

  test("an explicit rule wins: a kept value also blinded in a column is not shielded, and the conflict is counted", () => {
    const files = {
      "v.csv": "clinic_phone,backup\n(555) 555-0199,x\n",
      "w.csv": "owner,line\nDana Example,(555) 555-0199\n",
      "t.txt": "Call (555) 555-0199.\n",
    };
    const r = apply(files, spec([rule("v.csv", "clinic_phone", "keep"), rule("w.csv", "line", "blind", "id"), rule("w.csv", "owner", "blind", "person")]));
    expect(out(r, "t.txt")).toMatch(/^Call Id_[0-9A-F]{4}\.\n$/);
    expect(r.shield.conflicts).toBe(1);
    expect(renderReport(r)).toContain("1 kept value not shielded elsewhere");
  });

  test("short values, numbers, dates and measures never shield", () => {
    for (const v of ["abc", "12345", "2026-10-12", "38.6 lb", "$1,250.00", " "]) expect(shieldable(v)).toBe(false);
    for (const v of ["Canine", "Harbor View", "(555) 555-0199", "front@clinic.example"]) expect(shieldable(v)).toBe(true);
  });

  test("the run reports how many kept values shielded how many spans", () => {
    const r = apply({ "v.csv": VISITS, "handbook.md": HANDBOOK }, spec(RULES));
    expect(r.shield.shielding).toBe(1);
    expect(r.shield.spans).toBe(1);
    expect(r.shield.placeholderSpans).toBe(2);
    const text = renderReport(r);
    expect(text).toContain("1 kept value shielded 1 span elsewhere");
    expect(text).toContain("2 textbook placeholders");
  });
});

describe("built-in placeholders", () => {
  const TEMPLATES = [
    "Name: John Doe or Jane Doe, John Q. Public",
    "Address: 123 Main St",
    "Phone: (999) 999-9999 or 000-000-0000 or 555-123-4444x",
    "Email: user@example.com, name@example.org, you@sub.example.net, me@host.test",
  ].join("\n") + "\n";

  test("are kept verbatim, except where the whole email is not a template", () => {
    const r = apply({ "form.txt": TEMPLATES + "Write to dana@example.com.\n" }, spec([]));
    const o = out(r, "form.txt");
    for (const kept of ["John Doe", "Jane Doe", "John Q. Public", "123 Main St", "(999) 999-9999", "000-000-0000", "user@example.com", "name@example.org", "you@sub.example.net"]) {
      expect(o).toContain(kept);
    }
    // A real-looking number and an ordinary address on the example domain are not placeholders.
    expect(o).not.toContain("dana@example.com");
    const real = apply({ "x.txt": "Call (555) 555-0100 or 555-555-0142.\n" }, spec([]));
    expect(out(real, "x.txt")).not.toContain("0100");
  });

  test("[keep] placeholders = false blinds them like any value", () => {
    const r = apply({ "form.txt": "Write to user@example.com or call (999) 999-9999.\n" }, spec([]), { placeholders: false });
    expect(out(r, "form.txt")).not.toContain("user@example.com");
    expect(out(r, "form.txt")).not.toContain("999-9999");
  });

  test("blind.toml reads [keep] placeholders, defaulting to true", () => {
    expect(defaultPolicy().keep.placeholders).toBe(true);
    const text = renderPolicy(defaultPolicy());
    expect(parsePolicy(text).keep.placeholders).toBe(true);
    const off = parsePolicy(text.replace("# placeholders = true", "placeholders = false"));
    expect(off.keep.placeholders).toBe(false);
    expect(parsePolicy(renderPolicy(off)).keep.placeholders).toBe(false);
    expect(() => parsePolicy(text.replace("# placeholders = true", 'placeholders = "no"'))).toThrow("keep.placeholders must be true or false");
  });
});

describe("the mechanical audit agrees", () => {
  const s = spec(RULES);
  const entry = (path: string, text: string): TreeEntry => ({ path, kind: "file", bytes: Buffer.from(text, "utf8") });
  const leaks = (r: ReturnType<typeof auditTree>) => r.files.flatMap((f) => f.findings).filter((f) => f.severity === "leak");

  test("a shielded kept value and a placeholder are not leaks; another phone still is", () => {
    const tree = [entry("v.csv", "clinic_phone,owner_name\n(555) 555-0199,Person_1A2B\n"), entry("handbook.md", HANDBOOK)];
    expect(leaks(auditTree(tree, s, { version: 1, entries: [] }))).toEqual([]);
    const bad = [...tree, entry("other.md", "Call (555) 555-0123.\n")];
    expect(leaks(auditTree(bad, s, { version: 1, entries: [] })).map((f) => f.file)).toEqual(["other.md"]);
  });

  test("placeholders = false: the placeholders are findings again", () => {
    const l = leaks(auditTree([entry("handbook.md", HANDBOOK)], spec([]), { version: 1, entries: [] }, [], false));
    expect(l.length).toBeGreaterThan(0);
  });
});

describe("Shield", () => {
  test("a kept value counts only when it shields", () => {
    const sh = new Shield(["(555) 555-0199", "Harbor View"], [], false);
    expect(sh.values).toBe(2);
    expect(sh.occurrences("call 555-555-0199 at Harbor View").length).toBe(2);
  });
});
