import { describe, expect, test } from "bun:test";
import { AUDITOR_SYSTEM, AUDITOR_SYSTEM_READABLE } from "../../src/audit/auditor.ts";
import { type AuditReport, auditTree, type Finding, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { findSecretSpans } from "../../src/engine/secret.ts";
import { findAddresses } from "../../src/engine/address.ts";
import { applySpec } from "../../src/engine/apply.ts";
import { nameSafe } from "../../src/engine/pseudonym.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic data only: invented names, example.com.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);

const rule = (header: string): ColumnRule => ({ file: "staff.csv", header, class: "person", treatment: "blind", confidence: 1, source: "human" });

const SPEC: Spec = {
  version: 1,
  columns: [rule("Staff")],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }], org: [{ canonical: "Client Quillworks", aliases: ["Client"], parts: [] }], vocabulary: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const file = (path: string, data: string): TreeEntry => ({ path, kind: "file", bytes: Buffer.from(data, "utf8") });

function both(entries: TreeEntry[], map: Parameters<typeof auditTree>[2]): AuditReport {
  return addSemanticLayer(auditTree(entries, SPEC, map), entries, SPEC, map, { keep: [] });
}
const findings = (r: AuditReport): Finding[] => r.files.flatMap((f) => f.findings);

function made() {
  const r = applySpec([{ path: "staff.csv", bytes: Buffer.from("Staff\nAvery Quill\n") }], SPEC, { salt: SALT, pseudonymStyle: "readable" });
  const out = Buffer.from(r.outputs[0]?.bytes as Uint8Array).toString("utf8");
  const pseudo = (out.match(/\[[^\]]+ #[0-9A-F]{4}\]/) ?? [])[0] as string;
  return { r, out, pseudo };
}

describe("audits recognise readable pseudonyms", () => {
  test("engine output in readable mode is clean in both layers", () => {
    const { r, out, pseudo } = made();
    expect(pseudo).toMatch(/^\[[A-Z][A-Za-z ]* [A-Z]+ #[0-9A-F]{4}\]$/);
    expect(findings(both([file("staff.csv", out)], r.map))).toEqual([]);
  });

  test("a real name next to a readable pseudonym is a leak; without it the output is clean", () => {
    const { r, pseudo } = made();
    const clean = both([file("notes.md", `Owner ${pseudo} signed.\n`)], r.map);
    expect(findings(clean)).toEqual([]);
    const dirty = both([file("notes.md", `Owner ${pseudo} Avery Quill signed.\n`)], r.map);
    expect(findings(dirty).some((f) => f.severity === "leak")).toBe(true);
    const unknown = both([file("notes.md", `Owner ${pseudo} Dana Example signed.\n`)], r.map);
    expect(findings(unknown).length).toBeGreaterThan(0);
  });

  test("a name-safe pseudonym inside an identifier is clean; a real name beside it is not", () => {
    const { r, pseudo } = made();
    // A role-labelled pseudonym (as a later ticket issues): only the map says its twin is one.
    const role = "[Client B #7F3A]";
    const map = { ...r.map, entries: [...r.map.entries, { kind: "person" as const, canonical: "dana example", value: "Dana Example", pseudonym: role }] };
    for (const safe of [nameSafe(pseudo), nameSafe(role)]) {
      expect(findings(both([file(`report_${safe}.txt`, "ok\n")], map))).toEqual([]);
      expect(findings(both([file(`report_${safe}_Avery_Quill.txt`, "ok\n")], map)).length).toBeGreaterThan(0);
    }
  });

  test("address detector takes a readable pseudonym as a street-name word", () => {
    const text = "Ship to 12 [Place A #7F3A] Street, Springfield UT 84000 today.";
    expect(findAddresses(text).length).toBe(1);
    const safe = "Ship to 12 Place_A_7F3A Street, Springfield UT 84000 today.";
    expect(findAddresses(safe).length).toBe(1);
  });

  test("auditor examples match the active style", () => {
    expect(AUDITOR_SYSTEM).toContain("Person_1A2B");
    expect(AUDITOR_SYSTEM_READABLE).toContain("[Person A #1A2B]");
    expect(AUDITOR_SYSTEM_READABLE).not.toContain("Person_1A2B");
  });

  test("secret detector: a readable pseudonym after a trigger is not flagged", () => {
    expect(findSecretSpans("password: [Client A #7F3A]")).toEqual([]);
  });

  test("secret detector: shaped identifiers after a trigger are still secrets, as on main", () => {
    for (const t of ["password: Prod_API_KEY_1234", "password: My_API_TOKEN_1234"]) {
      expect(findSecretSpans(t).length).toBeGreaterThan(0);
    }
  });

  test("a map value shaped like a name-safe twin is a leak; a real twin stays clean", () => {
    const { r, pseudo } = made();
    for (const original of ["Host_A_1234", "Id_A_1234"]) {
      const map = { ...r.map, entries: [...r.map.entries, { kind: "id" as const, canonical: original.toLowerCase(), value: original, pseudonym: "Id_ABCD" }] };
      const rep = both([file("notes.md", `see ${original} here\n`)], map);
      expect(findings(rep).some((f) => f.severity === "leak" && f.reason.includes("from the map survives"))).toBe(true);
      expect(findings(both([file(`x_${nameSafe(pseudo)}.txt`, "ok\n")], map))).toEqual([]);
    }
  });
});
