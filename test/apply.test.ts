import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { helpText } from "../src/cli.ts";

// Synthetic corpus only.
const SPEC = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Status", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const STAFF = "Owner,Status,Ref Code\nAvery Quill,open,ZX-4471-Q\nRobin Example,open,ZX-4472-R\nJo Sample,closed,ZX-4473-S\n";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-apply-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
  mkdirSync(join(dir, "in", "sub"), { recursive: true });
  writeFileSync(join(dir, "in", "staff.csv"), STAFF);
  writeFileSync(join(dir, "in", "sub", "notes.md"), "Avery said hi from 192.0.2.10.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function apply(...argv: string[]) {
  const out = new PassThrough();
  const err = new PassThrough();
  let o = "";
  let e = "";
  out.on("data", (d) => (o += d));
  err.on("data", (d) => (e += d));
  const code = await runApply(argv, { out, err, cwd: dir });
  return { code, out: o, err: e };
}

const read = (...p: string[]) => readFileSync(join(dir, ...p), "utf8");
const mode = (...p: string[]) => statSync(join(dir, ...p)).mode & 0o777;

describe("blind apply", () => {
  test("blinds a directory, writes the map 0600 and reports each file", async () => {
    const r = await apply("in", "-o", "out");
    expect(r.code).toBe(0);
    const staff = read("out", "staff.csv");
    expect(staff).not.toContain("Avery");
    expect(staff).not.toContain("ZX-447");
    expect(staff).toContain(",open,");
    expect(read("out", "sub", "notes.md")).toMatch(/^Person_[0-9A-F]{4} said hi from \d+\.\d+\.\d+\.\d+\.\n$/);
    expect(read("out", "sub", "notes.md")).not.toContain("192.0.2.10");
    expect(mode(".blind", "map.json")).toBe(0o600);
    expect(r.out).toContain('"Ref Code": unknown → pseudonymised');
    expect(r.out).toContain('"Owner": person/blind → blinded');
    expect(r.out).toContain("sub/notes.md (text, utf8)");
  });

  test("--map-out writes the map there, mode 0600", async () => {
    const r = await apply("in", "-o", "out", "--map-out", "secret.map.json");
    expect(r.code).toBe(0);
    expect(mode("secret.map.json")).toBe(0o600);
    expect(existsSync(join(dir, ".blind", "map.json"))).toBe(false);
    expect(JSON.parse(read("secret.map.json")).entries.length).toBeGreaterThan(0);
  });

  test("a file input is named by its file name", async () => {
    const r = await apply("in/staff.csv", "-o", "out");
    expect(r.code).toBe(0);
    expect(read("out", "staff.csv")).not.toContain("Avery");
  });

  test("two runs give byte-identical output; a reused map keeps pseudonyms", async () => {
    await apply("in", "-o", "a", "--map-out", "a.map.json");
    await apply("in", "-o", "b", "--map-out", "b.map.json");
    expect(read("b", "staff.csv")).toBe(read("a", "staff.csv"));
    expect(read("b.map.json")).toBe(read("a.map.json"));
    await apply("in", "-o", "c", "--map-out", "a.map.json");
    expect(read("c", "staff.csv")).toBe(read("a", "staff.csv"));
  });

  test("JSON is blinded by key path and reported per key", async () => {
    const spec = { ...SPEC, columns: [...SPEC.columns, { file: "sub/t.json", jsonPath: "$.items[*].owner", class: "person", treatment: "blind", confidence: 1, source: "human" }] };
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec));
    writeFileSync(join(dir, "in", "sub", "t.json"), '{\n  "items": [{"owner": "Avery Quill"}, {"owner": "Robin Example"}]\n}\n');
    const r = await apply("in", "-o", "out");
    expect(r.code).toBe(0);
    expect(read("out", "sub", "t.json")).toMatch(/^\{\n {2}"items": \[\{"owner": "Person_[0-9A-F]{4}"\}, \{"owner": "Person_[0-9A-F]{4}"\}\]\n\}\n$/);
    expect(r.out).toContain("sub/t.json (json, utf8)");
    expect(r.out).toContain('key "$.items[*].owner": person/blind → blinded, 2 values changed');
  });

  test("unsupported files are listed and not written; exit 1", async () => {
    writeFileSync(join(dir, "in", "data.pdf"), "%PDF-1.7 Avery Quill");
    const r = await apply("in", "-o", "out");
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "out", "data.pdf"))).toBe(false);
    expect(r.err).toContain("data.pdf: format not supported");
  });

  test("blind's own files inside an input are never copied", async () => {
    mkdirSync(join(dir, "in", ".blind"));
    writeFileSync(join(dir, "in", ".blind", "salt"), "x");
    writeFileSync(join(dir, "in", "blind.toml"), "x");
    const r = await apply("in", "-o", "out");
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "out", ".blind"))).toBe(false);
    expect(existsSync(join(dir, "out", "blind.toml"))).toBe(false);
    expect(r.out).toContain("ignored .blind");
  });

  describe("refuses with exit 2 and writes nothing (AC1)", () => {
    const refuses = async (argv: string[], message: RegExp) => {
      const r = await apply(...argv);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(message);
      expect(existsSync(join(dir, "out"))).toBe(false);
    };

    test("missing spec", async () => {
      rmSync(join(dir, ".blind", "spec.json"));
      await refuses(["in", "-o", "out"], /spec\.json not found/);
    });

    test("invalid spec", async () => {
      writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify({ ...SPEC, version: 2 }));
      await refuses(["in", "-o", "out"], /invalid spec/);
    });

    test("spec that is not JSON", async () => {
      writeFileSync(join(dir, ".blind", "spec.json"), "{");
      await refuses(["in", "-o", "out"], /not valid JSON/);
    });

    test("spec pairing unknown with keep", async () => {
      const bad = { ...SPEC, columns: [{ ...SPEC.columns[0], class: "unknown", treatment: "keep" }] };
      writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(bad));
      await refuses(["in", "-o", "out"], /cannot use treatment "keep"/);
    });

    test("missing salt", async () => {
      rmSync(join(dir, ".blind", "salt"));
      await refuses(["in", "-o", "out"], /salt not found; run `blind init`/);
    });

    test("a spec rule for a column the file lacks", async () => {
      const bad = { ...SPEC, columns: [{ ...SPEC.columns[0], header: "Ownr" }] };
      writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(bad));
      await refuses(["in", "-o", "out"], /"Ownr", which is not in the header row/);
    });

    test("no -o", async () => {
      await refuses(["in"], /-o <out> is required/);
    });

    test("no inputs", async () => {
      await refuses(["-o", "out"], /no inputs/);
    });

    test("missing input", async () => {
      await refuses(["nope", "-o", "out"], /does not exist/);
    });

    test("output inside an input", async () => {
      const r = await apply("in", "-o", "in/out");
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/overlaps input/);
    });

    test("map inside the output directory", async () => {
      await refuses(["in", "-o", "out", "--map-out", "out/map.json"], /inside the output directory/);
    });

    test("map inside an input", async () => {
      await refuses(["in", "-o", "out", "--map-out", "in/map.json"], /inside an input/);
    });
  });

  test("apply is wired into the CLI", () => {
    const line = helpText().split("\n").find((l) => l.trimStart().startsWith("apply"));
    expect(line).not.toContain("not implemented");
  });
});
