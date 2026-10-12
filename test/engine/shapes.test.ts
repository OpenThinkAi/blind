// Column shapes (AGT-1846): licence plates, usernames/handles and phones are classified by shape, so an
// unruled column of them is blinded even under `[defaults] columns = "scan"`; product codes, SKUs,
// order numbers, short ids, measures and lowercase categoricals are not. The profile's host detector
// shares the engine's host rule. Synthetic data only: invented plates, handles, codes and numbers.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristicRule, heuristicShape, heuristicSpec } from "../../src/analyst/heuristic.ts";
import { auditTree, type TreeEntry } from "../../src/audit/mechanical.ts";
import { applySpec, type InputFile } from "../../src/engine/apply.ts";
import { headerNames, isHandle, isPlate, plateSplit, pseudoWrite, shapeHolds, shapeRates } from "../../src/engine/shapes.ts";
import { holdsPhone } from "../../src/engine/text.ts";
import { buildWorkbook } from "../../src/bench/office.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { buildProfile } from "../../src/profile/profile.ts";
import { valueStats } from "../../src/profile/stats.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const POLICY = { sensitive: { classes: ["person", "location", "email", "id", "secret"] as const, description: "", examples: [] } } as never;
/** Whether the heuristic classes a column `id` (blind) by a column shape, under this header. */
function classed(header: string, values: string[]): string | undefined {
  const stats = valueStats(values, 0);
  return heuristicShape({ file: "t.csv", header }, stats, POLICY)?.shape;
}

describe("per-value shapes", () => {
  test("plates: bare, after colour/make/model words, with a region code", () => {
    for (const v of ["7ABC123", "8XYZ987", "blue Civic 7ABC123", "grey Golf 2QRS456", "ST 12-3456", "ABC 1234", "KP4 7RW", "dark blue Ford 7ABC123"]) {
      expect(isPlate(v), v).toBe(true);
    }
    // At most three words before the plate.
    expect(isPlate("a dark blue Ford 7ABC123")).toBe(false);
  });

  test("plate negatives: codes, short ids, measures, dates, microchips", () => {
    for (const v of ["RX-2231", "B-04", "K12", "A1", "ABC-DRP", "250 MG", "12LBS", "38.6", "2026-03-14", "985112003456789", "USD 4000", "abc1234", "EMP-0044171", "Q-4"]) {
      expect(isPlate(v), v).toBe(false);
    }
  });

  test("handles: one lowercase token, three letters or more, not a dictionary word", () => {
    for (const v of ["dana42", "lee.sample7", "rspec", "kit_09", "ray-s"]) expect(isHandle(v), v).toBe(true);
    for (const v of ["yes", "no", "follow-up", "check-in", "Dana42", "dana 42", "k12", "12abc", "ab", "dana..x", "dana.", "4417"]) expect(isHandle(v), v).toBe(false);
  });

  test("phones: whatever the free-text phone pattern replaces", () => {
    for (const v of ["+1 555 555 0100", "(801) 555-0100", "801.555.0100", "call 801-555-0100 after 5", "+44 20 7946 0000"]) expect(holdsPhone(v), v).toBe(true);
    for (const v of ["8015550100", "2026-03-14", "192.0.2.1", "SKU-10442", "4417"]) expect(holdsPhone(v), v).toBe(false);
  });
});

describe("column classification", () => {
  test("the repro columns: plates and handles under naming headers, a phone key", () => {
    expect(classed("vehicle", ["blue Civic 7ABC123", "red Focus 8XYZ987", "grey Golf 2QRS456"])).toBe("plate");
    expect(classed("login", ["dana42", "leesample7", "rspec"])).toBe("handle");
    expect(classed("to", ["+1 555 555 0100", "+1 555 555 0100", "+1 555 555 0100"])).toBe("phone");
  });

  test("a phone column as the engine reads one (isPhoneColumn): bare NANP runs among formatted phones", () => {
    expect(classed("contact", ["801-555-0100", "8015550101", "(801) 555-0102"])).toBe("phone");
    expect(classed("accession", ["8015550100", "8015550101", "8015550102"])).toBeUndefined();
  });

  test("no header needed when the shape is clear", () => {
    expect(classed("col3", ["7ABC123", "8XYZ987", "2QRS456", "5LMN204", "ST 12-3456"])).toBe("plate");
    expect(classed("who", ["dana42", "lee.sample7", "kit_09", "ray.s3", "jo-q1"])).toBe("handle");
  });

  test("a naming header lowers the rate needed; a header alone never classifies", () => {
    const mixed = ["7ABC123", "8XYZ987", "2QRS456", "unknown", "n/a"];
    expect(classed("Licence Plate", mixed)).toBe("plate");
    expect(classed("notes", mixed)).toBeUndefined();
    for (const h of ["vehicle", "plate", "login", "username", "User Name", "user_id", "screenName", "handle", "account name"]) {
      expect(classed(h, ["blue", "red", "grey", "green"]), h).toBeUndefined();
      expect(classed(h, ["", "", ""]), h).toBeUndefined();
    }
  });

  test("header words: whole words, any case or separator, camelCase split; JSON key paths by last segment", () => {
    expect(headerNames("plate", "vehicle_plate")).toBe(true);
    expect(headerNames("plate", "LicensePlate")).toBe(true);
    expect(headerNames("plate", "$[*].owner.vehicle")).toBe(true);
    expect(headerNames("plate", "platelet count")).toBe(false);
    expect(headerNames("plate", "stage")).toBe(false);
    expect(headerNames("handle", "UserName")).toBe(true);
    expect(headerNames("handle", "user id")).toBe(true);
    expect(headerNames("handle", "username_hash")).toBe(true);
    expect(headerNames("handle", "user")).toBe(false);
    expect(headerNames("phone", "Mobile Phone")).toBe(true);
  });

  // Precision: none of these is a plate or handle column, with or without a header naming the shape.
  // (`categorical` rows: a lowercase categorical under a header that says "login" is beyond saving;
  // they are checked with no header and under their own.)
  const NEGATIVES: [string, string[], ("categorical" | undefined)?][] = [
    ["SKUs with a fixed prefix", ["SKU-10442", "SKU-10443", "SKU-20991", "SKU-31007", "SKU-10442"]],
    ["product codes with a two-letter prefix", ["RX-2231", "RX-2232", "TB-1101", "AB-9921"]],
    ["project codes with a shared prefix", ["PRJ-7A3F", "PRJ-7A40", "PRJ-7A41", "PRJ-7A42"]],
    ["order numbers", ["SO-10442", "SO-10443", "SO-10471", "SO-10502"]],
    ["dated order numbers", ["ORD-20260311-0042", "ORD-20260311-0043", "ORD-20260312-0007"]],
    ["hash-prefixed order numbers", ["#10442", "#10443", "#10471"]],
    ["short ids", ["A12", "X9", "B7K", "Q-4", "Z3"]],
    ["clinic and location codes", ["ABC-DRP", "XYZ-NTH", "QRS-STH", "ABC-DRP"]],
    ["kennel and slot codes", ["K12", "B-04", "C-11", "K7", "A-01"]],
    ["species", ["canine", "feline", "equine", "canine", "feline", "avian"], "categorical"],
    ["distinct species and breeds", ["canine", "feline", "equine", "lapine", "shih-tzu", "beagle"], "categorical"],
    ["colours", ["brown", "black", "white", "brindle", "tabby"], "categorical"],
    ["lab units", ["mg/dL", "mmol/L", "U/L", "g/dL", "mEq/L"]],
    ["lab units in capitals", ["250 MG", "10 ML", "5 MG", "1000 MCG"]],
    ["lab results", ["ALT 45", "BUN 22", "ALT 52", "BUN 19", "ALT 61", "BUN 30"]],
    ["ISO dates", ["2026-03-14", "2026-03-15", "2026-04-01"]],
    ["decimal measures", ["38.6", "12.25", "4.1", "38.6 lb", "101.2 °F"]],
    ["microchips", ["985112003456789", "985112003456790", "900215000012345"]],
    ["yes/no", ["yes", "no", "yes", "yes", "no"]],
    ["payment methods", ["cash", "card", "card", "cash", "check"]],
    ["event names", ["msg.reply", "msg.delivered", "user.login", "visit.created", "invoice.paid"], "categorical"],
    ["numbered test accounts", ["user1", "user2", "user3", "user4"]],
    ["lowercase sku codes", ["sku-10442", "sku-10443", "sku-20991"]],
  ];
  for (const [what, values, kind] of NEGATIVES) {
    test(`not a plate or handle column: ${what}`, () => {
      expect(classed("col", values)).not.toBeOneOf(["plate", "handle"]);
      expect(classed(what, values)).not.toBeOneOf(["plate", "handle"]);
      expect(classed("vehicle", values)).not.toBe("plate");
      if (kind !== "categorical") expect(classed("login", values)).not.toBe("handle");
    });
  }

  test("a lowercase categorical is not a handle column even under a naming header", () => {
    expect(shapeHolds("handle", valueStats(["rspec", "rspec", "rspec", "rspec", "rspec", "rspec"], 0), "login")).toBe(false);
  });

  test("shapeRates: a column's shared code prefix cancels plates, not a plate region code", () => {
    expect(shapeRates(["SKU-10442", "SKU-10443"]).plate).toBe(0);
    expect(shapeRates(["ST 12-3456", "ST 98-7654", "ST 55-1200"]).plate).toBe(1);
    expect(shapeRates(["ABC-1234", "XYZ-9876", "DEF-1111"]).plate).toBe(1);
  });

  test("heuristic rule: class id, blind when id is sensitive, keep when not", () => {
    const loc = { file: "t.csv", header: "vehicle" };
    const stats = valueStats(["7ABC123", "8XYZ987", "2QRS456"], 0);
    expect(heuristicRule(loc, stats, POLICY)).toMatchObject({ class: "id", treatment: "blind", source: "heuristic", confidence: 1 });
    const noId = { sensitive: { classes: ["person"], description: "", examples: [] } } as never;
    expect(heuristicRule(loc, stats, noId)).toMatchObject({ class: "id", treatment: "keep" });
  });
});

describe("profile host detector", () => {
  test("uses the engine's host rule: event names are not hosts, real host names are", () => {
    expect(valueStats(["msg.reply", "msg.delivered", "msg.reply"], 0).detectorRates.host).toBe(0);
    expect(valueStats(["db01.example.internal", "api.example.com", "files.example.co.uk"], 0).detectorRates.host).toBe(1);
    expect(heuristicRule({ file: "e.jsonl", jsonPath: "$.event" }, valueStats(["msg.reply", "msg.read", "msg.sent"], 0), POLICY).class).toBe("unknown");
  });
});

describe("plate cells", () => {
  const pz = { pseudonym: (cls: string, v: string) => `${cls === "id" ? "Id" : "Value"}_${v.length}` };

  test("only the plate is replaced after colour/make/model words", () => {
    expect(plateSplit("blue Civic 7ABC123")).toEqual({ lead: "blue Civic ", plate: "7ABC123", core: "7ABC123" });
    expect(pseudoWrite(pz, "id", "blue Civic 7ABC123")).toBe("blue Civic Id_7");
    expect(pseudoWrite(pz, "id", " silver Toyota Camry ST 12-3456 ")).toBe(" silver Toyota Camry Id_10 ");
  });

  test("anything else before the plate keeps the whole cell blinded (fail closed)", () => {
    expect(plateSplit("Dana Example 7ABC123")).toBeUndefined();
    expect(pseudoWrite(pz, "id", "Dana Example 7ABC123")).toBe("Id_20");
    expect(pseudoWrite(pz, "id", "7ABC123")).toBe("Id_7");
    // Only an id cell is split.
    expect(pseudoWrite(pz, "value", "blue Civic 7ABC123")).toBe("Value_18");
  });
});

describe("the AGT-1846 repro, end to end", () => {
  const VISITS = "pet,owner_name,vehicle,login\nBiscuit,Dana Example,blue Civic 7ABC123,dana42\nPepper,Lee Sample,red Focus 8XYZ987,leesample7\nMango,Ray Specimen,grey Golf 2QRS456,rspec\n";
  const EVENTS = '{"event":"msg.reply","to":"+1 555 555 0100"}\n'.repeat(3);
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);

  function planned(): Spec {
    const dir = mkdtempSync(join(tmpdir(), "blind-shapes-"));
    try {
      mkdirSync(join(dir, "in"));
      writeFileSync(join(dir, "in", "visits.csv"), VISITS);
      writeFileSync(join(dir, "in", "events.jsonl"), EVENTS);
      const { profile } = buildProfile(["in"], 0, dir);
      const spec = heuristicSpec(profile, POLICY);
      // blind.toml's `owner*` → blind/person rule, as applyColumnPolicy would write it.
      const owner: ColumnRule = { file: "visits.csv", header: "owner_name", class: "person", treatment: "blind", confidence: 1, source: "policy" };
      return { ...spec, columns: spec.columns.map((c) => (c.header === "owner_name" ? owner : c)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("vehicle → descriptive words + Id_, login → Id_, event and pet unchanged, under the scan default", () => {
    const spec = planned();
    const r = applySpec([{ path: "visits.csv", bytes: enc(VISITS) }, { path: "events.jsonl", bytes: enc(EVENTS) }], spec, { salt: new Uint8Array(32).fill(7), columns: "scan" });
    const out = (p: string) => dec((r.outputs.find((o) => o.path === p) as InputFile).bytes);
    const rows = out("visits.csv").trim().split("\n").map((l) => l.split(","));
    expect(rows[0]).toEqual(["pet", "owner_name", "vehicle", "login"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(["Biscuit", "Pepper", "Mango"]);
    expect(rows.slice(1).map((r) => (r[2] as string).replace(/Id_[0-9A-F]+$/, "Id_"))).toEqual(["blue Civic Id_", "red Focus Id_", "grey Golf Id_"]);
    for (const row of rows.slice(1)) expect(row[3]).toMatch(/^Id_[0-9A-F]+$/);
    const events = out("events.jsonl").trim().split("\n").map((l) => JSON.parse(l) as { event: string; to: string });
    for (const e of events) {
      expect(e.event).toBe("msg.reply");
      expect(e.to).toMatch(/^Id_[0-9A-F]+$/);
    }
    // The plate recurs as itself: the same plate in another file is the same pseudonym.
    const plate = (rows[1]?.[2] as string).slice("blue Civic ".length);
    const again = applySpec([{ path: "visits.csv", bytes: enc(VISITS) }, { path: "n.txt", bytes: enc("Seen: 7ABC123.\n") }], spec, { salt: new Uint8Array(32).fill(7), columns: "scan" });
    expect(dec((again.outputs.find((o) => o.path === "n.txt") as InputFile).bytes)).toBe(`Seen: ${plate}.\n`);
  });

  test("XLSX: a plate cell keeps its descriptive words too", () => {
    const rows = VISITS.trim().split("\n").map((l) => l.split(","));
    const bytes = buildWorkbook({ sheets: [{ name: "Visits", rows }], orphans: [], definedNames: [], core: { title: "", creator: "", modifiedBy: "" } });
    const rule: ColumnRule = { file: "v.xlsx", sheet: "Visits", header: "vehicle", class: "id", treatment: "blind", confidence: 1, source: "heuristic" };
    const r = applySpec([{ path: "v.xlsx", bytes }], { version: 1, columns: [rule], entities: {}, patterns: { ip: false, email: true, host: false, guid: false, mac: false, phone: true }, questions: [] }, { salt: new Uint8Array(32).fill(7), columns: "scan" });
    const wb = readWorkbook((r.outputs[0] as InputFile).bytes);
    const out = sheetRows(wb.sheets[0] as (typeof wb.sheets)[number], wb.sharedStrings);
    expect(out.slice(1).map((row) => (row[2] as string).replace(/Id_[0-9A-F]+$/, "Id_"))).toEqual(["blue Civic Id_", "red Focus Id_", "grey Golf Id_"]);
  });

  test("the audit reports a plate or handle column written in clear as a leak, and not once blinded", () => {
    const spec = planned();
    const entry = (path: string, s: string): TreeEntry => ({ path, kind: "file", bytes: enc(s) });
    // As written with no shape rule: what the scan default alone would have written.
    const unruled: Spec = { ...spec, columns: spec.columns.filter((c) => c.header !== "vehicle" && c.header !== "login") };
    const leaked = auditTree([entry("visits.csv", VISITS)], unruled, { version: 1, entries: [] } as never);
    const shaped = leaked.files.flatMap((f) => f.findings).filter((f) => f.source === "scan" && f.class === "id");
    expect(shaped.map((f) => f.severity)).toEqual(["leak", "leak"]);
    expect(shaped.map((f) => f.reason).join("\n")).toMatch(/shape: plate, 100%[\s\S]*shape: handle, 100%/);
    expect(shaped.every((f) => !f.reason.includes("7ABC123") && !f.masked.includes("7ABC123"))).toBe(true);

    const r = applySpec([{ path: "visits.csv", bytes: enc(VISITS) }], spec, { salt: new Uint8Array(32).fill(7), columns: "scan" });
    const written = dec((r.outputs[0] as InputFile).bytes);
    const clean = auditTree([entry("visits.csv", written)], spec, r.map);
    expect(clean.files.flatMap((f) => f.findings).filter((f) => f.source === "scan" && f.class === "id")).toEqual([]);
    // A column the spec keeps is the owner's decision, not a leak.
    const kept: Spec = { ...spec, columns: [...unruled.columns, { file: "visits.csv", header: "login", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" }] };
    const keptReport = auditTree([entry("visits.csv", VISITS)], kept, { version: 1, entries: [] } as never);
    expect(keptReport.files.flatMap((f) => f.findings).filter((f) => f.source === "scan" && f.class === "id").length).toBe(1);
  });
});
