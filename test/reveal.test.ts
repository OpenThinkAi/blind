import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { runReveal } from "../src/reveal.ts";

// Synthetic corpus only (invented names, example.com, RFC 5737 IPs).
const SPEC = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Box", class: "host", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Status", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: [] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const STAFF = 'Owner,Box,Status\n"Quill, Robin",192.0.2.10,open\nAvery Quill,app01.corp.example.com,closed\n';
const NOTE = "Avery Quill checked 192.0.2.10 today.\n";

let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "blind-reveal-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 9)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
  mkdirSync(join(dir, "in", "Avery Quill"), { recursive: true });
  writeFileSync(join(dir, "in", "staff.csv"), STAFF);
  writeFileSync(join(dir, "in", "Avery Quill", "Avery Quill.md"), NOTE);
  const out = new PassThrough();
  const err = new PassThrough();
  expect(await runApply(["in", "-o", "out"], { out, err, cwd: dir })).toBe(0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function reveal(...argv: string[]) {
  const out = new PassThrough();
  const err = new PassThrough();
  let o = "";
  let e = "";
  out.on("data", (d) => (o += d));
  err.on("data", (d) => (e += d));
  const code = await runReveal(argv, { out, err, cwd: dir });
  return { code, out: o, err: e };
}

const mode = (p: string) => statSync(p).mode & 0o777;
const blindedNote = () => {
  const folder = readdirSync(join(dir, "out")).find((n) => n.startsWith("Person_")) as string;
  return `out/${folder}/${readdirSync(join(dir, "out", folder))[0]}`;
};

test("a blinded CSV reveals back byte for byte, written 0600 under .blind/revealed", async () => {
  expect(readFileSync(join(dir, "out", "staff.csv"), "utf8")).not.toContain("Quill");
  const r = await reveal("out/staff.csv");
  expect(r.code).toBe(0);
  const dest = join(dir, ".blind", "revealed", "staff.csv");
  expect(readFileSync(dest, "utf8")).toBe(STAFF);
  expect(mode(dest)).toBe(0o600);
  expect(mode(join(dir, ".blind", "revealed"))).toBe(0o700);
  // The report never prints original values.
  expect(r.out).not.toContain("Quill");
  expect(r.out).toContain("mode 0600");
});

test("a blinded tree reveals with its folder and file names restored", async () => {
  expect(blindedNote()).not.toContain("Avery");
  const r = await reveal("out", "-o", "../revealed-elsewhere");
  expect(r.code).toBe(0);
  expect(r.out).toContain("(name restored too)");
  const root = join(dir, "..", "revealed-elsewhere");
  try {
    expect(readFileSync(join(root, "Avery Quill", "Avery Quill.md"), "utf8")).toBe(NOTE);
    expect(readFileSync(join(root, "staff.csv"), "utf8")).toBe(STAFF);
    expect(mode(join(root, "Avery Quill"))).toBe(0o700);
    expect(mode(join(root, "Avery Quill", "Avery Quill.md"))).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to write beside the blinded file, inside or around the blinded tree, or in place", async () => {
  for (const args of [
    ["out/staff.csv", "-o", "out/revealed"],
    ["out/staff.csv", "-o", "out"],
    ["out", "-o", "out/revealed"],
    ["out", "-o", "."],
    ["out", "-o", "out"],
  ]) {
    const r = await reveal(...args);
    expect({ args, code: r.code }).toEqual({ args, code: 2 });
    expect(r.err).toContain("must not sit with blinded output");
  }
  expect(existsSync(join(dir, "out", "revealed"))).toBe(false);
  expect(existsSync(join(dir, ".blind", "revealed"))).toBe(false);
});

test("an existing revealed copy is not replaced without --force", async () => {
  expect((await reveal("out/staff.csv")).code).toBe(0);
  const again = await reveal("out/staff.csv");
  expect(again.code).toBe(2);
  expect(again.err).toContain("--force");
  expect((await reveal("out/staff.csv", "--force")).code).toBe(0);
});

test("a format with no reversal path: refused for a file (2), listed for a tree (1)", async () => {
  writeFileSync(join(dir, "out", "book.xlsx"), "PK");
  const one = await reveal("out/book.xlsx");
  expect(one.code).toBe(2);
  expect(one.err).toContain("no reversal path for .xlsx files");
  expect(existsSync(join(dir, ".blind", "revealed"))).toBe(false);
  const tree = await reveal("out");
  expect(tree.code).toBe(1);
  expect(tree.err).toContain("book.xlsx: no reversal path");
  expect(existsSync(join(dir, ".blind", "revealed", "staff.csv"))).toBe(true);
  expect(existsSync(join(dir, ".blind", "revealed", "book.xlsx"))).toBe(false);
});

test("a missing or invalid map, a missing input and usage errors exit 2", async () => {
  expect((await reveal("out/staff.csv", "--map", "nope.json")).code).toBe(2);
  writeFileSync(join(dir, "bad.json"), "{}");
  expect((await reveal("out/staff.csv", "--map", "bad.json")).code).toBe(2);
  expect((await reveal("out/missing.csv")).code).toBe(2);
  expect((await reveal()).code).toBe(2);
  expect((await reveal("a", "b")).code).toBe(2);
  expect((await reveal("--help")).code).toBe(0);
});
