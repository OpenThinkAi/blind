import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { renderDiff, renderSpec } from "../src/analyst/plan.ts";
import { runApply } from "../src/apply.ts";
import { maskQuoted, maskValue, shownValue } from "../src/mask.ts";
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
