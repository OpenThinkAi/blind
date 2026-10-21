import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { renderDiff, renderSpec } from "../src/analyst/plan.ts";
import { runApply } from "../src/apply.ts";
import { maskQuoted, maskValue, shownValue } from "../src/mask.ts";
import { runProfile } from "../src/profile/command.ts";
import { type RunManifest, writeRunManifest } from "../src/runmanifest.ts";
import type { Spec } from "../src/schema.ts";
import { buildWorkbook } from "./formats/xlsxfixture.ts";

// AGT-1866: the human-facing prints of spec review (renderSpec, renderDiff) and the apply report
// name a value from a document by mask, as `blind audit` does, unless the reviewer asks for the
// originals. Synthetic data only.

const SPEC: Spec = {
  version: 1,
  columns: [{ file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" }],
  entities: { person: [{ canonical: "Avery Quill", aliases: ["A. Quill"], parts: ["Avery", "Quill"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [{ id: "q1", text: "Is Avery Quill the owner of the desk?", options: ["yes", "no"], answer: null, about: { file: "staff.csv", header: "Owner" } }],
};

describe("mask helpers", () => {
  test("maskValue keeps two characters and the length; maskQuoted masks only quoted strings", () => {
    expect(maskValue("Avery Quill")).toBe("Av***11");
    expect(shownValue("Avery Quill", true)).toBe('"Avery Quill"');
    expect(shownValue("Avery Quill", false)).toBe("Av***11");
    expect(maskQuoted('saved person entity "Avery Quill" in a.csv', false)).toBe("saved person entity Av***11 in a.csv");
    expect(maskQuoted('saved person entity "Avery Quill"', true)).toBe('saved person entity "Avery Quill"');
  });
});

describe("renderSpec and renderDiff", () => {
  test("entity names, aliases, parts, headers and question text are masked by default", () => {
    const text = renderSpec(SPEC);
    for (const v of ["Avery", "Quill", "Owner", "desk"]) expect(text).not.toContain(v);
    expect(text).toContain(maskValue("Avery Quill"));
    expect(text).toContain(maskValue("Owner"));
    expect(text).toContain("staff.csv");
    expect(text).toContain("options: yes | no");
  });

  test("with show, the originals appear", () => {
    const text = renderSpec(SPEC, {}, true);
    expect(text).toContain('"Avery Quill"; aliases "A. Quill"; parts "Avery", "Quill"');
    expect(text).toContain('"staff.csv" "Owner"');
    expect(text).toContain("Is Avery Quill the owner of the desk?");
  });

  test("a diff masks entity names, headers and quoted values in reasons", () => {
    const diff = {
      reused: true,
      added: { columns: [{ file: "staff.csv", header: "Region" }], entities: [{ class: "person", canonical: "Robin Example" }], questions: [] },
      classified: [],
      dropped: [{ kind: "entity", class: "person", canonical: "Avery Quill", reason: 'it would change the saved person entity "Avery Quill"' }],
    } as unknown as Parameters<typeof renderDiff>[0];
    const text = renderDiff(diff);
    for (const v of ["Robin", "Avery", "Quill", "Region"]) expect(text).not.toContain(v);
    expect(renderDiff(diff, true)).toContain('added person entity "Robin Example"');
    expect(renderDiff(diff, true)).toContain('saved person entity "Avery Quill"');
  });
});

describe("blind apply report", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-masking-"));
    mkdirSync(join(dir, ".blind"), { mode: 0o700 });
    writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)), { mode: 0o600 });
    const spec = {
      ...SPEC,
      columns: [{ file: "book.xlsx", sheet: "Staff", header: "Name", class: "person", treatment: "blind", confidence: 1, source: "human" }],
    };
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec));
    mkdirSync(join(dir, "wb"));
    writeFileSync(join(dir, "wb", "book.xlsx"), buildWorkbook());
    writeFileSync(join(dir, "wb", "rows.csv"), "Owner,Region Code\nAvery Quill,N1\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function apply(...argv: string[]) {
    const out = new PassThrough();
    let o = "";
    out.on("data", (d) => (o += d));
    const code = await runApply(argv, { out, err: new PassThrough(), cwd: dir });
    return { code, out: o };
  }

  test("sheet names and headers are masked; file paths are not; --show-values shows them", async () => {
    const r = await apply("wb", "-o", "out");
    expect(r.code).toBe(0);
    expect(r.out).toContain("book.xlsx (xlsx)");
    expect(r.out).toContain("rows.csv");
    for (const v of ['"Staff"', '"Name"', '"Owner"', "Region Code", "Avery Quill"]) expect(r.out).not.toContain(v);
    expect(r.out).toContain(`sheet ${maskValue("Avery Quill")} renamed`);
    expect(r.out).toContain(`sheet ${maskValue("Staff")} (header row 1)`);
    expect(r.out).toContain(`${maskValue("Region Code")}: unknown`);

    const shown = await apply("wb", "-o", "out2", "--show-values");
    expect(shown.out).toMatch(/ {2}sheet "Avery Quill" renamed "Person_[0-9A-F]{4}"\n/);
    expect(shown.out).toContain('"Region Code": unknown');
  });

  test("--help documents --show-values", async () => {
    const r = await apply("--help");
    expect(r.out).toContain("--show-values");
  });
});

// AGT-2000: `blind profile` and apply's refusals mask document values when the output is not a
// terminal, as plan, apply and audit reports do. Synthetic data only.
describe("blind profile output", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-masking-profile-"));
    writeFileSync(join(dir, "staff.csv"), "Owner,Region Code\nAvery Quill,N1\nRobin Example,N2\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function profile(argv: string[], isTTY = false) {
    const output = Object.assign(new PassThrough(), isTTY ? { isTTY: true } : {});
    let o = "";
    output.on("data", (d) => (o += d));
    const code = await runProfile(argv, { output, err: new PassThrough() }, dir);
    return { code, out: o };
  }

  test("samples and headers are masked when not a terminal; the file path is not", async () => {
    const r = await profile(["staff.csv", "--samples", "2"]);
    expect(r.code).toBe(0);
    for (const v of ["Avery", "Robin", "Owner", "Region Code"]) expect(r.out).not.toContain(v);
    expect(r.out).toContain(maskValue("Avery Quill"));
    expect(r.out).toContain(maskValue("Region Code"));
    expect(r.out).toContain('"staff.csv"');
  });

  test("--show-values or a terminal shows the originals; --json stays unmasked", async () => {
    expect((await profile(["staff.csv", "--samples", "2", "--show-values"])).out).toContain('"Avery Quill"');
    expect((await profile(["staff.csv", "--samples", "2"], true)).out).toContain('"Avery Quill"');
    expect((await profile(["staff.csv", "--samples", "2", "--json"])).out).toContain("Avery Quill");
  });
});

describe("blind apply refusal", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-masking-refusal-"));
    mkdirSync(join(dir, ".blind"), { mode: 0o700 });
    writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)), { mode: 0o600 });
    // The spec names a header that is really a value.
    const spec = { ...SPEC, columns: [{ ...SPEC.columns[0], header: "Avery Quill" }] };
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "staff.csv"), "Owner\nRobin Example\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function apply(...argv: string[]) {
    const err = new PassThrough();
    let e = "";
    err.on("data", (d) => (e += d));
    const code = await runApply(argv, { out: new PassThrough(), err, cwd: dir });
    return { code, err: e };
  }

  test("the header a rule names is masked on stderr unless --show-values", async () => {
    const r = await apply("in", "-o", "out");
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(`column ${maskValue("Avery Quill")}, which is not in the header row`);
    expect(r.err).toContain("staff.csv");
    expect((await apply("in", "-o", "out", "--show-values")).err).toContain('"Avery Quill"');
  });
});

describe("run manifest", () => {
  test("replaces an existing run.json with a fresh 0600 file", () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-masking-manifest-"));
    try {
      mkdirSync(join(dir, ".blind"), { mode: 0o700 });
      const path = join(dir, ".blind", "run.json");
      writeFileSync(path, "{}\n");
      chmodSync(path, 0o644);
      const m: RunManifest = { version: 1, out: "out", rounds: 1, exit: 0, audit: null, inputs: [{ input: "a.txt", output: "a.txt", audit: null }] };
      expect(writeRunManifest(dir, m)).toBe(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// AGT-2008: every other apply refusal that can quote a document-derived string masks it the same
// way as the AGT-2000 header refusal: a spec that fails validation, a map that fails to parse, and
// a file apply skips. Synthetic data only.
describe("blind apply refusals beyond the spec mismatch", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-masking-refusals-"));
    mkdirSync(join(dir, ".blind"), { mode: 0o700 });
    writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 3)), { mode: 0o600 });
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC));
    mkdirSync(join(dir, "in"));
    writeFileSync(join(dir, "in", "staff.csv"), "Owner\nRobin Example\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function apply(argv: string[], isTTY = false) {
    const out = Object.assign(new PassThrough(), isTTY ? { isTTY: true } : {});
    const err = new PassThrough();
    let e = "";
    err.on("data", (d) => (e += d));
    const code = await runApply(argv, { out, err, cwd: dir });
    return { code, err: e };
  }
  const writeSpec = (spec: unknown) => writeFileSync(join(dir, ".blind", "spec.json"), typeof spec === "string" ? spec : JSON.stringify(spec));

  test("a spec value that fails validation is masked; the schema's own choices are not", async () => {
    writeSpec({ ...SPEC, columns: [{ ...SPEC.columns[0], treatment: "Avery Quill" }] });
    const r = await apply(["in", "-o", "out"]);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(`$.columns[0].treatment: must be one of `);
    expect(r.err).toContain('"blind"');
    expect(r.err).toContain(`got ${maskValue("Avery Quill")}`);
    expect(r.err).toContain("nothing was written");
    expect((await apply(["in", "-o", "out", "--show-values"])).err).toContain('got "Avery Quill"');
    expect((await apply(["in", "-o", "out"], true)).err).toContain('got "Avery Quill"');
  });

  test("an unknown spec key that is a value is masked in the issue's path", async () => {
    writeSpec({ ...SPEC, columns: [{ ...SPEC.columns[0], "Avery Quill": "x" }] });
    const r = await apply(["in", "-o", "out"]);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(`$.columns[0][${maskValue("Avery Quill")}]: unknown field`);
    expect((await apply(["in", "-o", "out", "--show-values"])).err).toContain('$.columns[0]["Avery Quill"]: unknown field');
  });

  test("a long unknown key, which the path cuts short, is masked with its full length", async () => {
    const key = "Avery Quill of the North Ridge Office";
    writeSpec({ ...SPEC, columns: [{ ...SPEC.columns[0], [key]: "x" }] });
    const r = await apply(["in", "-o", "out"]);
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(`$.columns[0][Av***${[...key].length}]: unknown field`);
  });

  test("the token a spec JSON parse error quotes is masked", async () => {
    writeSpec('{"version": Avery}');
    const r = await apply(["in", "-o", "out"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("not valid JSON");
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(maskValue("Avery"));
    expect((await apply(["in", "-o", "out", "--show-values"])).err).toContain('"Avery"');
  });

  test("a map key that is a value is masked in the map error", async () => {
    writeFileSync(join(dir, ".blind", "map.json"), JSON.stringify({ version: 1, entries: [], "Avery Quill": 1 }), { mode: 0o600 });
    const r = await apply(["in", "-o", "out"]);
    expect(r.code).toBe(2);
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(`unknown field ${maskValue("Avery Quill")}`);
    expect(r.err).toContain("map.json");
    expect((await apply(["in", "-o", "out", "--show-values"])).err).toContain('unknown field "Avery Quill"');
  });

  test("a skipped file's reason masks the worksheet name it quotes; the path is not masked", async () => {
    writeSpec({ ...SPEC, columns: [] });
    // Sheet 2 ("Avery Quill") loses its relationship, so the workbook cannot be read.
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      [1, 3].map((n) => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join("") +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
    writeFileSync(join(dir, "in", "book.xlsx"), buildWorkbook({ extra: [{ name: "xl/_rels/workbook.xml.rels", data: rels }] }));
    const r = await apply(["in", "-o", "out"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("blind apply: book.xlsx: cannot read the workbook");
    expect(r.err).not.toContain("Avery");
    expect(r.err).toContain(`sheet ${maskValue("Avery Quill")} has no relationship`);
    expect((await apply(["in", "-o", "out2", "--show-values"])).err).toContain('sheet "Avery Quill" has no relationship');
    expect((await apply(["in", "-o", "out3"], true)).err).toContain('sheet "Avery Quill" has no relationship');
  });
});
