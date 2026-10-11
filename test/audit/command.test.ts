import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../../src/apply.ts";
import { runAudit } from "../../src/audit/command.ts";
import { helpText } from "../../src/cli.ts";
import { makeZip } from "./zipfixture.ts";

// Synthetic corpus only.
const SPEC = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Status", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Ref Code", class: "id", treatment: "blind", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "blind-audit-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 5)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
  mkdirSync(join(dir, "in"));
  writeFileSync(join(dir, "in", "staff.csv"), "Owner,Status,Ref Code\nAvery Quill,open,ZX-4471-Q\n");
  writeFileSync(join(dir, "in", "notes.md"), "Avery wrote from 192.0.2.10.\n");
  const sink = new PassThrough();
  sink.resume();
  expect(await runApply(["in", "-o", "out"], { out: sink, err: sink, cwd: dir })).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function audit(...argv: string[]) {
  const out = new PassThrough();
  const err = new PassThrough();
  let o = "";
  let e = "";
  out.on("data", (d) => (o += d));
  err.on("data", (d) => (e += d));
  const code = await runAudit(argv, { out, err, cwd: dir });
  return { code, out: o, err: e };
}

describe("blind audit", () => {
  test("a clean output tree exits 0 and says what clean does and does not mean", async () => {
    const r = await audit("out");
    expect(r.code).toBe(0);
    expect(r.out).toContain("status: clean (2 files; 0 leaks, 0 candidates; layers run: mechanical)");
    expect(r.out).toContain("not a guarantee");
    expect(r.err).toContain("mechanical layer only");
  });

  test("--no-model runs the mechanical layer without the note", async () => {
    const r = await audit("out", "--no-model");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  test("a candidate exits 1", async () => {
    writeFileSync(join(dir, "out", "extra.txt"), "see averyville\n");
    const r = await audit("out");
    expect(r.code).toBe(1);
    expect(r.out).toContain("status: candidates");
    expect(r.out).toContain("candidates  extra.txt");
  });

  test("a leak exits 2, with a masked value and its location", async () => {
    writeFileSync(join(dir, "out", "extra.zip"), makeZip([{ name: "doc.xml", data: "<t>Avery Quill</t>" }]));
    const r = await audit("out", "--json");
    expect(r.code).toBe(2);
    const report = JSON.parse(r.out);
    expect(report.status).toBe("leak");
    expect(report.files.find((f: { path: string }) => f.path === "extra.zip").findings).toEqual([
      expect.objectContaining({ part: "doc.xml", offset: 3, line: 1, class: "person", masked: "Av***11", severity: "leak" }),
    ]);
    expect(r.out).not.toContain("Avery Quill");
  });

  test("a survivor in a file name is found", async () => {
    writeFileSync(join(dir, "out", "Avery Quill notes.txt"), "nothing\n");
    const r = await audit("out");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Avery Quill notes.txt [name]@0");
  });

  test("a symbolic link is a candidate, never followed", async () => {
    symlinkSync(join(dir, "in", "staff.csv"), join(dir, "out", "link.csv"));
    const r = await audit("out");
    expect(r.code).toBe(1);
    expect(r.out).toContain("symbolic link, not followed");
  });

  test("a single file can be audited", async () => {
    const r = await audit("out/notes.md");
    expect(r.code).toBe(0);
    expect(r.out).toContain("clean       notes.md");
  });

  test("refuses with exit 3 (never 2, which means leak) when the spec, the map or the output tree is missing", async () => {
    const noTree = await audit("nope");
    expect(noTree.code).toBe(3);
    expect(noTree.err).toContain("does not exist");
    const noMap = await audit("out", "--map", "missing.json");
    expect(noMap.code).toBe(3);
    expect(noMap.err).toContain("missing.json not found");
    expect(noMap.err).toContain("nothing was audited");
    rmSync(join(dir, ".blind", "spec.json"));
    const noSpec = await audit("out");
    expect(noSpec.code).toBe(3);
    expect(noSpec.err).toContain("spec.json not found");
  });

  test("usage errors exit 3; --help exits 0", async () => {
    expect((await audit()).code).toBe(3);
    expect((await audit("a", "b")).code).toBe(3);
    expect((await audit("out", "--bogus")).code).toBe(3);
    const h = await audit("--help");
    expect(h.code).toBe(0);
    expect(h.out).toContain("Exit status: 0 clean, 1 candidates, 2 leak, 3 the audit could not run");
  });

  test("audit is listed as implemented", () => {
    expect(helpText()).toMatch(/audit <out>\s+Independently audit a blinded output tree\n/);
  });
});
