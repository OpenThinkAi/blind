import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { maskValue } from "../src/mask.ts";
import { type RunManifest } from "../src/runmanifest.ts";
import { runRun } from "../src/run.ts";
import { buildWorkbook } from "./formats/xlsxfixture.ts";

// AGT-1837: every `blind run` round writes into a fresh staging directory beside -o and only the
// final round's tree reaches -o, so a file an earlier round wrote under a name the later round
// changed cannot survive. Synthetic data only (invented sites and case numbers).

const BIN = join(import.meta.dir, "../bin/blind.js");
const SITES = ["Quillhaven Annex", "Marrowdale Depot", "Orchard Point", "Fennimore Yard", "Tarnwick Lodge"];

function blind(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

const files = (root: string, rel = ""): string[] =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(root, `${rel}${d.name}/`) : [`${rel}${d.name}`])).sort();

describe("blind run stages every round", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-run-stage-"));
    expect(blind(dir, "init", "--defaults").code).toBe(0);
    const toml = join(dir, "blind.toml");
    writeFileSync(toml, readFileSync(toml, "utf8").replace(/^mode = .*$/m, 'mode = "none"'));
    mkdirSync(join(dir, "input", "sites"), { recursive: true });
    mkdirSync(join(dir, "input", "case_9123"));
    const codes = ["K7Q2X9", "M3T8V1", "P9W4R6", "B2N7J5", "H6D1L3"];
    writeFileSync(join(dir, "input", "sites", "sites.csv"), `Site,Code\n${SITES.map((s, i) => `${s},${codes[i]}`).join("\n")}\n`);
    writeFileSync(join(dir, "input", "sites", "visits.txt"), `Visited ${SITES[0]} and ${SITES[1]} on Monday.\n${SITES[2]} next week.\n`);
    writeFileSync(join(dir, "input", "case_ref_9123.txt"), "Case 9123: Dana Example reported the bite.\n");
    writeFileSync(join(dir, "input", "case_9123", "notes.txt"), "Follow-up on 9123.\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Runs in process. Once round 1 is staged, `leak` writes a site name back into the staged tree,
   * the way a missed value would be (the engine itself leaves none); the audit then finds a leak.
   * When round 2 is announced, `between` runs: here it makes "9123", a value in a file name and a
   * folder name, an entity, as accepting a leak on it would (the engine renames names through spec
   * entities), and it reports what round 1 had staged.
   */
  async function run(argv: string[], between?: () => void) {
    const out = new PassThrough();
    const err = new PassThrough();
    let o = "";
    let e = "";
    let staged = false;
    out.on("data", (d) => {
      o += d;
      if (!staged && /^wrote \d+ files? to /m.test(String(d))) {
        staged = true;
        const stage = readdirSync(dir).find((n) => n.startsWith(".out.blind-stage-"));
        if (stage !== undefined) appendFileSync(join(dir, stage, "sites", "visits.txt"), `Back at ${SITES[3]}.\n`);
      }
      if (String(d).includes("round 2: apply and audit again")) between?.();
    });
    err.on("data", (d) => (e += d));
    const code = await runRun(argv, { out, err, cwd: dir });
    return { code, out: o, err: e };
  }

  function addIdEntity(value: string): void {
    const path = join(dir, ".blind", "spec.json");
    const spec = JSON.parse(readFileSync(path, "utf8"));
    (spec.entities.id ??= []).push({ canonical: value, aliases: [], parts: [], source: "human" });
    writeFileSync(path, JSON.stringify(spec, null, 2));
  }

  test("a round that renames a file and a folder leaves no copy under the old names", async () => {
    let staged: string[] = [];
    const r = await run(["input", "-o", "out", "--yes", "--accept-leaks", "--no-model"], () => {
      // Round 1's tree is in the staging directory beside out, under the unblinded names.
      const stage = readdirSync(dir).find((n) => n.startsWith(".out.blind-stage-"));
      staged = stage === undefined ? [] : files(join(dir, stage));
      addIdEntity("9123");
    });
    expect(r.out).toContain("--accept-leaks: round 2");
    expect(staged).toContain("case_ref_9123.txt");
    expect(staged).toContain("case_9123/notes.txt");

    const out = files(join(dir, "out"));
    expect(out.some((p) => p.includes("9123"))).toBe(false);
    expect(out).toHaveLength(4);
    // The staging directory is gone, and the printed report never names it.
    expect(readdirSync(dir).filter((n) => n.includes("blind-stage"))).toEqual([]);
    expect(r.out + r.err).not.toContain("blind-stage");
    expect(r.out).toContain("wrote 4 files to out");

    // One input, one output; the manifest says so and holds no file content.
    const mpath = join(dir, ".blind", "run.json");
    expect(statSync(mpath).mode & 0o777).toBe(0o600);
    const m = JSON.parse(readFileSync(mpath, "utf8")) as RunManifest;
    expect(m.out).toBe("out");
    expect(m.rounds).toBe(2);
    expect(m.exit).toBe(r.code);
    expect(m.audit?.leaks).toBe(0);
    expect(m.inputs.map((i) => i.input).sort()).toEqual(["case_9123/notes.txt", "case_ref_9123.txt", "sites/sites.csv", "sites/visits.txt"]);
    expect(new Set(m.inputs.map((i) => i.input)).size).toBe(m.inputs.length);
    expect(m.inputs.map((i) => i.output).sort()).toEqual(out);
    const renamed = m.inputs.find((i) => i.input === "case_ref_9123.txt");
    expect(renamed?.output).not.toBe("case_ref_9123.txt");
    expect(renamed?.audit).not.toBe("leak");
    expect(readFileSync(mpath, "utf8")).not.toContain("Dana");
    expect(existsSync(join(dir, "out", ".blind-run.json"))).toBe(false);
  });

  test("files already in -o that the run did not write stay, and a stale copy of an input is reported", async () => {
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "keep-me.txt"), "mine\n");
    // An earlier copy of an input sits where its unblinded name would be.
    writeFileSync(join(dir, "out", "case_ref_9123.txt"), "Case 9123: stale\n");
    const r = await run(["input", "-o", "out", "--yes", "--accept-leaks", "--no-model"], () => addIdEntity("9123"));
    expect(readFileSync(join(dir, "out", "keep-me.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, "out", "case_ref_9123.txt"), "utf8")).toBe("Case 9123: stale\n");
    expect(r.err).toContain("case_ref_9123.txt in out was not written by this run");
  });

  test("a run that refuses writes nothing to -o and leaves no staging directory", async () => {
    const r = await run(["input", "-o", "input/out", "--yes", "--no-model"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("apply refused");
    expect(r.err).not.toContain("blind-stage");
    expect(existsSync(join(dir, "input", "out"))).toBe(false);
    expect(readdirSync(join(dir, "input"))).not.toContainEqual(expect.stringContaining("blind-stage"));
    expect(existsSync(join(dir, ".blind", "run.json"))).toBe(false);
  });

  test("an input that is not written is in the manifest with the reason", async () => {
    writeFileSync(join(dir, "input", "photo.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
    const r = await run(["input", "-o", "out", "--yes", "--no-model"]);
    expect(r.code).toBeGreaterThanOrEqual(1);
    const m = JSON.parse(readFileSync(join(dir, ".blind", "run.json"), "utf8")) as RunManifest;
    const png = m.inputs.find((i) => i.input === "photo.png");
    expect(png?.output).toBeNull();
    expect(png?.reason).toBeTruthy();
    expect(existsSync(join(dir, "out", "photo.png"))).toBe(false);
  });

  test("a not-written input's reason in the manifest has the worksheet name it quotes masked, even with --show-values", async () => {
    // Sheet 2 ("Avery Quill") loses its relationship, so apply cannot read the workbook.
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      [1, 3].map((n) => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join("") +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
    writeFileSync(join(dir, "input", "book.xlsx"), buildWorkbook({ extra: [{ name: "xl/_rels/workbook.xml.rels", data: rels }] }));
    const r = await run(["input", "-o", "out", "--yes", "--no-model", "--show-values"]);
    expect(r.code).toBeGreaterThanOrEqual(1);
    const text = readFileSync(join(dir, ".blind", "run.json"), "utf8");
    const book = (JSON.parse(text) as RunManifest).inputs.find((i) => i.input === "book.xlsx");
    expect(book?.output).toBeNull();
    expect(book?.reason).toContain("cannot read the workbook");
    expect(book?.reason).toContain(`sheet ${maskValue("Avery Quill")} has no relationship`);
    expect(text).not.toContain("Avery");
  });

  test("plain apply warns when a file it did not write sits where an input's unblinded name was", () => {
    expect(blind(dir, "run", "input", "-o", "first", "--yes", "--no-model").code).toBeLessThan(3);
    addIdEntity("9123");
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "case_ref_9123.txt"), "stale\n");
    const r = blind(dir, "apply", "input", "-o", "out");
    expect(r.err).toContain("warning: case_ref_9123.txt in out was not written by this apply");
    expect(existsSync(join(dir, "out", "case_ref_9123.txt"))).toBe(true);
  });
});
