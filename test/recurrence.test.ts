import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { runAudit } from "../src/audit/command.ts";

// AGT-1779 end to end: a value blinded in one column that recurs in a text file and in a kept
// column is replaced there too, and the audit finds nothing. Synthetic corpus only.
const SPEC = {
  version: 1,
  columns: [
    { file: "projects.csv", header: "Project", class: "id", treatment: "blind", confidence: 1, source: "human" },
    { file: "projects.csv", header: "Phase", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
    { file: "projects.csv", header: "Summary", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
  ],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-recur-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 9)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
  mkdirSync(join(dir, "in"));
  writeFileSync(
    join(dir, "in", "projects.csv"),
    "Project,Phase,Summary\nPRJ-7731,build,depends on Larkspur Ridge\nLarkspur Ridge,design,follows PRJ-7731\n",
  );
  writeFileSync(join(dir, "in", "status.txt"), "PRJ-7731 is late; Larkspur Ridge is on time.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sink(): [PassThrough, () => string] {
  const s = new PassThrough();
  let text = "";
  s.on("data", (d) => (text += d));
  return [s, () => text];
}

describe("a blinded column value recurring elsewhere (AGT-1779)", () => {
  test("blind apply replaces it in the text file and the kept column; blind audit is clean", async () => {
    const [out, outText] = sink();
    const [err] = sink();
    expect(await runApply(["in", "-o", "out"], { out, err, cwd: dir })).toBe(0);
    expect(outText()).toContain("values blinded in a column replaced again where they recur outside it");

    const csv = readFileSync(join(dir, "out", "projects.csv"), "utf8");
    const txt = readFileSync(join(dir, "out", "status.txt"), "utf8");
    for (const t of [csv, txt]) {
      expect(t).not.toContain("PRJ-7731");
      expect(t).not.toContain("Larkspur");
    }
    const [, a, b] = csv.trimEnd().split("\n").map((l) => l.split(","));
    // The kept Summary cells carry the same pseudonyms as the blinded Project cells.
    expect(a?.[2]).toBe(`depends on ${b?.[0]}`);
    expect(b?.[2]).toBe(`follows ${a?.[0]}`);
    expect(txt).toBe(`${a?.[0]} is late; ${b?.[0]} is on time.\n`);

    const [aout, aoutText] = sink();
    const [aerr] = sink();
    expect(await runAudit(["out", "--no-model"], { out: aout, err: aerr, cwd: dir })).toBe(0);
    expect(aoutText()).toContain("status: clean");
  });
});
