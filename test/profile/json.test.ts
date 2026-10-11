import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runProfile } from "../../src/profile/command.ts";
import { buildProfile } from "../../src/profile/profile.ts";
import { validateProfile } from "../../src/validate.ts";

// Synthetic corpus only: invented names, example.com, obviously fake IDs.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-profile-json-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const TICKETS = {
  records: [
    { ticket_ref: "a3f9c2e1", client_scope_name: "Example Widgets", assignee: "Avery Quill", tags: ["vpn", "urgent"], open: true },
    { ticket_ref: "b47d01f9", client_scope_name: "Sample Holdings", assignee: "Robin Example", tags: ["vpn"], open: false },
    { ticket_ref: 4471, client_scope_name: "Example Widgets", assignee: null, tags: [], open: true },
  ],
  owners: { "u-1001": { name: "Avery Quill" }, "u-1002": { name: "Robin Example" } },
};

describe("JSON profiling", () => {
  test("every key path is a column with stats and samples", () => {
    put("kit/tickets.json", `${JSON.stringify(TICKETS, null, 2)}\n`);
    const { profile, skipped } = buildProfile(["kit"], 5, dir);
    expect(skipped).toEqual([]);
    expect(profile.files).toEqual([{ path: "tickets.json", format: "json", size: expect.any(Number) }]);
    expect(profile.jsonKeys.map((j) => j.path)).toEqual([
      "$.records[*].ticket_ref",
      "$.records[*].client_scope_name",
      "$.records[*].assignee",
      "$.records[*].tags[*]",
      "$.records[*].open",
      "$.owners.*~",
      "$.owners.*.name",
    ]);
    const by = (p: string) => profile.jsonKeys.find((j) => j.path === p)?.stats;
    // A string and a number under one key are both values; the number as written.
    expect(by("$.records[*].ticket_ref")).toMatchObject({ count: 3, distinctRatio: 1, samples: ["a3f9c2e1", "b47d01f9", "4471"] });
    expect(by("$.records[*].client_scope_name")).toMatchObject({ count: 3, samples: ["Example Widgets", "Sample Holdings"] });
    expect(by("$.records[*].assignee")?.count).toBe(2);
    expect(by("$.records[*].tags[*]")).toMatchObject({ count: 3, samples: ["vpn", "urgent"] });
    expect(by("$.records[*].open")?.count).toBe(0);
    // Record-ID keys are the values of the .*~ column, so the IDs never become key paths.
    expect(by("$.owners.*~")).toMatchObject({ count: 2, samples: ["u-1001", "u-1002"] });
    expect(profile.jsonKeys.some((j) => j.path.includes("1001"))).toBe(false);
    expect(validateProfile(profile).ok).toBe(true);
  });

  test("k = 0 carries key paths and statistics, no samples", () => {
    put("t.json", JSON.stringify(TICKETS));
    const { profile } = buildProfile(["t.json"], 0, dir);
    expect(profile.jsonKeys.every((j) => j.stats.samples.length === 0)).toBe(true);
  });

  test("JSONL records share key paths rooted at $", () => {
    put("events.jsonl", '{"host": "db01.example.com", "user": "avery"}\n\n{"host": "db02.example.com"}\n');
    const { profile } = buildProfile(["events.jsonl"], 5, dir);
    expect(profile.files[0]?.format).toBe("jsonl");
    expect(profile.jsonKeys).toMatchObject([
      { file: "events.jsonl", path: "$.host", stats: { count: 2, detectorRates: { host: 1 } } },
      { file: "events.jsonl", path: "$.user", stats: { count: 1 } },
    ]);
  });

  test("a JSON key path and a CSV column that share values co-occur", () => {
    put("staff.csv", "Owner\nAvery Quill\nRobin Example\n");
    put("t.json", JSON.stringify(TICKETS));
    const { profile } = buildProfile(["staff.csv", "t.json"], 5, dir);
    expect(profile.cooccurrence).toContainEqual({
      a: { file: "staff.csv", header: "Owner" },
      b: { file: "t.json", jsonPath: "$.records[*].assignee" },
      shared: 2,
    });
    expect(validateProfile(profile).ok).toBe(true);
  });

  test("samples are excerpts; a key path over 120 characters leaves the file out, never cut", () => {
    put("long.json", JSON.stringify({ note: "word ".repeat(100) }));
    put("deep.json", JSON.stringify({ [`k${"_".repeat(130)}`]: "x" }));
    const { profile, skipped } = buildProfile(["long.json", "deep.json"], 5, dir);
    expect([...(profile.jsonKeys[0]?.stats.samples[0] ?? "")].length).toBe(120);
    expect(profile.files.map((f) => f.path)).toEqual(["long.json"]);
    expect(skipped).toEqual([{ path: "deep.json", reason: "a key path is 133 characters, over the 120-character limit" }]);
  });

  test("the same corpus gives byte-identical profiles", () => {
    put("t.json", JSON.stringify(TICKETS));
    expect(JSON.stringify(buildProfile(["t.json"], 5, dir).profile)).toBe(JSON.stringify(buildProfile(["t.json"], 5, dir).profile));
  });

  test("blind profile prints every key path, quoted as data", async () => {
    put("blind.toml", "");
    put("t.json", JSON.stringify(TICKETS));
    put("empty.json", "{}");
    const output = new PassThrough();
    const err = new PassThrough();
    let o = "";
    output.on("data", (d) => (o += d));
    err.on("data", () => {});
    expect(await runProfile(["t.json", "empty.json", "--samples", "2"], { output, err }, dir)).toBe(0);
    expect(o).toContain('"t.json"  json');
    expect(o).toMatch(/key path\s+count/);
    expect(o).toMatch(/"\$\.owners\.\*~"\s+2 .* "u-1001", "u-1002"/);
    expect(o).toContain('"empty.json"  json  2 bytes\n  no key paths');
  });
});
