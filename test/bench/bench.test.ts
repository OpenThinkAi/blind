// `blind bench` on synthetic kit v1, end to end in process, and the scorers on hand-made inputs.
// Timing is the only thing allowed to differ between runs; it is left out of every comparison.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditReport, TreeEntry } from "../../src/audit/mechanical.ts";
import { type BenchReport, REPORT_FILE, runBench } from "../../src/bench/command.ts";
import { parseCsv, serializeCsv } from "../../src/engine/csv.ts";
import { OracleError, OracleMatcher, parseOracle, scanLeaks, scoreDamage, scoreHonesty } from "../../src/bench/score.ts";
import { buildWorkbook } from "../../src/bench/office.ts";
import { generateKit, type Kit, type KitOptions, writeKit } from "../../src/bench/synth.ts";
import type { FileReport } from "../../src/engine/apply.ts";
import type { Spec } from "../../src/schema.ts";
import { makeZip } from "../audit/zipfixture.ts";

class Sink {
  text = "";
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

interface Run {
  code: number;
  out: string;
  err: string;
  report: BenchReport | null;
  /** The report file's permission bits, when it was written. */
  mode: number | null;
}

/** Writes a kit (optionally with an edited spec), runs `blind bench` on it, and deletes it. */
async function bench(opts: { kit?: KitOptions; seed?: number; edit?: (spec: Spec) => void; args?: string[]; prepare?: (dir: string) => void; tmpRoot?: string } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "blind-bench-test-"));
  try {
    const kit: Kit = generateKit(opts.seed, opts.kit);
    opts.edit?.(kit.spec);
    writeKit(dir, kit);
    opts.prepare?.(dir);
    const out = new Sink();
    const err = new Sink();
    const code = await runBench([dir, ...(opts.args ?? [])], { out: out as unknown as NodeJS.WritableStream, err: err as unknown as NodeJS.WritableStream, cwd: dir, tmpRoot: opts.tmpRoot });
    const path = join(dir, REPORT_FILE);
    const report = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BenchReport) : null;
    return { code, out: out.text, err: err.text, report, mode: existsSync(path) ? statSync(path).mode & 0o777 : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The report and table with timing taken out: what must be identical run to run. */
const untimed = (r: Run) => {
  const { timing, ...rest } = r.report as BenchReport;
  expect(Object.keys(timing).sort()).toEqual(["applyMs", "auditMs", "totalMs"]);
  return { code: r.code, report: rest, table: r.out.split("\n").filter((l) => !l.startsWith("speed: ")) };
};

describe("blind bench on synthetic kit v1", () => {
  test("the report is written 0600, replacing an earlier one, since names in it are unmasked", async () => {
    const r = await bench({ prepare: (dir) => writeFileSync(join(dir, REPORT_FILE), "{}\n", { mode: 0o644 }) });
    expect(r.report?.result).toBe("pass");
    expect(r.mode).toBe(0o600);
  });

  test("the default kit passes: leaks 0, damage 0, honesty 0, everything scored", async () => {
    const r = await bench();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const rep = r.report as BenchReport;
    expect(rep.result).toBe("pass");
    expect({ leaks: rep.leaks.count, damage: rep.damage.count, honesty: rep.honesty.count, unscored: rep.unscored, notWritten: rep.apply.notWritten }).toEqual({
      leaks: 0,
      damage: 0,
      honesty: 0,
      unscored: [],
      notWritten: [],
    });
    expect(rep.spec).toBe("kit");
    expect(rep.kit).toMatchObject({ version: 1, seed: 1739, rows: 60, files: 4, decoys: 2 });
    // The audit is honest about the declared unknown column: candidates, never clean.
    expect(rep.audit).toMatchObject({ exit: 1, status: "candidates", leaks: 0, candidates: 1 });
    expect(rep.audit.modelLayer).toEqual({ status: "skipped", host: null, reason: "--no-model" });
    expect(r.out).toContain("layers run: mechanical, semantic; model: skipped (--no-model))");
    expect(r.out).toContain("result: pass");
    expect(r.out).toMatch(/^speed: apply \d+\.\d\d s, audit \d+\.\d\d s, total \d+\.\d\d s$/m);
  });

  test("a pipe-delimited .tab file is split on the pipe by the profiler, engine and both audit layers (AGT-1818)", async () => {
    // accounts.csv is re-delimited with "|" and renamed accounts.tab. Before the fix, .tab forced a tab,
    // so the engine saw one column and the spec's column rules matched nothing.
    const r = await bench({
      edit: (spec) => {
        for (const c of spec.columns) if (c.file === "accounts.csv") c.file = "accounts.tab";
      },
      prepare: (dir) => {
        const inDir = join(dir, "input");
        const rows = parseCsv(readFileSync(join(inDir, "accounts.csv"), "utf8"), ",");
        writeFileSync(join(inDir, "accounts.tab"), serializeCsv(rows, "|"));
        rmSync(join(inDir, "accounts.csv"));
        const oracle = join(dir, "oracle.json");
        writeFileSync(oracle, readFileSync(oracle, "utf8").replaceAll("accounts.csv", "accounts.tab"));
      },
    });
    expect(r.err).toBe("");
    const rep = r.report as BenchReport;
    expect({ result: rep.result, leaks: rep.leaks.count, damage: rep.damage.count, honesty: rep.honesty.count }).toEqual({ result: "pass", leaks: 0, damage: 0, honesty: 0 });
  });

  test("the kit with column values cited in prose passes too", async () => {
    const r = await bench({ kit: { recurInProse: true } });
    expect(r.code).toBe(0);
    expect(r.report?.leaks.count).toBe(0);
  });

  test("output is identical for a fixed seed, apart from the timing fields", async () => {
    const a = await bench({ seed: 42, kit: { rows: 30 } });
    const b = await bench({ seed: 42, kit: { rows: 30 } });
    expect(untimed(b)).toEqual(untimed(a));
    // And the failing shape is stable too, item for item.
    const c = await bench({ seed: 42, kit: { rows: 30 }, args: ["--plan"] });
    const d = await bench({ seed: 42, kit: { rows: 30 }, args: ["--plan"] });
    expect(untimed(d)).toEqual(untimed(c));
  });

  test("a leak the audit flags only as a candidate is scored as a leak, not as dishonesty", async () => {
    // The reviewer forgot the nickname "Iggy": it stays in the notes. The audit no longer calls that
    // file clean (AGT-1801): the lone capitalised word is a semantic:name candidate, so the bench
    // scores the leak but no dishonesty. (Dishonesty itself is unit-tested under "honesty:" below.)
    const r = await bench({
      edit: (s) => {
        s.entities.person = s.entities.person?.map((p) => ({ ...p, aliases: p.aliases.filter((a) => a !== "Iggy") }));
      },
    });
    expect(r.code).toBe(1);
    const rep = r.report as BenchReport;
    expect(rep.result).toBe("fail");
    expect(rep.leaks.items).toEqual([{ file: "notes/review.md", part: "", in: "content", class: "person", masked: "Ig***4" }]);
    expect(rep.honesty.items).toEqual([]);
    // Masked: the table never shows the value.
    expect(r.out).not.toContain("Iggy");
    expect(r.out).toContain("Ig***4");
  });

  test("no rule for the amount and date columns: they are measures, so nothing is damaged (AGT-1822)", async () => {
    const r = await bench({ edit: (s) => void (s.columns = s.columns.filter((c) => c.header !== "Amount" && c.header !== "Opened")) });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const rep = r.report as BenchReport;
    expect({ leaks: rep.leaks.count, damage: rep.damage.count }).toEqual({ leaks: 0, damage: 0 });
  });

  test("a decoy that does not survive is damage", async () => {
    const r = await bench({ edit: (s) => void (s.entities.vocabulary = s.entities.vocabulary?.filter((v) => v.canonical !== "SAM")) });
    expect(r.code).toBe(1);
    const rep = r.report as BenchReport;
    expect(rep.damage.items).toHaveLength(1);
    expect(rep.damage.items[0]).toMatchObject({ kind: "decoy", file: "notes/review.md", masked: "S***3" });
  });

  test("--plan scores the heuristic first try instead of the kit's spec, without a model", async () => {
    const r = await bench({ args: ["--plan"], prepare: (dir) => rmSync(join(dir, "spec.json")) });
    expect(r.code).toBe(1);
    const rep = r.report as BenchReport;
    expect(rep.spec).toBe("heuristic");
    // No entities in a heuristic spec: names in the prose survive, and the audit says so.
    expect(rep.leaks.count).toBeGreaterThan(0);
    expect(rep.audit.status).not.toBe("clean");
  });

  test("--report writes the report elsewhere; inside input/ is refused", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "blind-bench-report-"));
    try {
      const r = await bench({ args: ["--report", join(elsewhere, "r.json")] });
      expect(r.code).toBe(0);
      expect(r.report).toBeNull();
      expect((JSON.parse(readFileSync(join(elsewhere, "r.json"), "utf8")) as BenchReport).result).toBe("pass");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    const inside = await bench({ args: ["--report", "input/r.json"] });
    expect(inside.code).toBe(2);
    expect(inside.err).toContain("inside the kit's input/");
  });

  test("refuses with exit 2 when the kit is incomplete or invalid, and scores nothing", async () => {
    const noSpec = await bench({ prepare: (dir) => rmSync(join(dir, "spec.json")) });
    expect(noSpec.code).toBe(2);
    expect(noSpec.err).toContain("spec.json not found");
    expect(noSpec.report).toBeNull();
    const noOracle = await bench({ prepare: (dir) => rmSync(join(dir, "oracle.json")) });
    expect(noOracle.code).toBe(2);
    expect(noOracle.err).toContain("oracle.json not found");
    const badOracle = await bench({ prepare: (dir) => writeFileSync(join(dir, "oracle.json"), '{"values": [{"value": ""}]}') });
    expect(badOracle.code).toBe(2);
    expect(badOracle.err).toContain("values[0]");
    // A stale spec rule makes apply refuse; the bench refuses with it.
    const stale = await bench({ edit: (s) => s.columns.push({ file: "accounts.csv", header: "No Such Column", class: "id", treatment: "blind", confidence: 1, source: "human" }) });
    expect(stale.code).toBe(2);
    expect(stale.err).toContain("blind apply refused");
    const noInput = await bench({ prepare: (dir) => rmSync(join(dir, "input"), { recursive: true }) });
    expect(noInput.code).toBe(2);
    expect(noInput.err).toContain("input/");
  });

  test("usage errors exit 2", async () => {
    const err = new Sink();
    const io = { out: new Sink() as unknown as NodeJS.WritableStream, err: err as unknown as NodeJS.WritableStream, cwd: tmpdir() };
    expect(await runBench([], io)).toBe(2);
    expect(await runBench(["a", "b"], io)).toBe(2);
    expect(await runBench(["--nope"], io)).toBe(2);
    expect(err.text).toContain("Usage: blind bench");
  });
});

describe("scoring", () => {
  const oracle = parseOracle(
    JSON.stringify({
      values: [
        { value: "Wrexley", class: "person" },
        { value: "Sam", class: "person" },
        { value: "4417", class: "id" },
      ],
      decoys: [{ text: "SAM" }],
    }),
  );
  const m = new OracleMatcher(oracle);

  test("parseOracle sorts values by class then value and rejects malformed entries", () => {
    expect(oracle.values.map((v) => v.value)).toEqual(["4417", "Sam", "Wrexley"]);
    expect(() => parseOracle("[]")).toThrow(OracleError);
    expect(() => parseOracle('{"values": []}')).toThrow(/empty/);
    expect(() => parseOracle('{"values": [{"value": "x", "class": "id", "files": [1]}]}')).toThrow(/files/);
    expect(() => parseOracle('{"values": [{"value": "x", "class": "id"}], "decoys": [{}]}')).toThrow(/decoys\[0\]/);
  });

  test("the matcher finds whole words in any case, and sets decoys (exact case) aside", () => {
    expect(m.contains("met wrexley today")).toBe(true);
    expect(m.contains("Wrexleyville")).toBe(false);
    expect(m.contains("the SAM report")).toBe(false);
    expect(m.contains("sam ran it")).toBe(true);
    expect(m.contains("id 44170")).toBe(false);
  });

  test("scanLeaks reads names, zip members and XML text split across runs, and lists what it cannot read", () => {
    const docx = makeZip([
      { name: "word/document.xml", data: "<w:p><w:r><w:t>Wrex</w:t></w:r><w:r><w:t>ley</w:t></w:r></w:p>" },
      { name: "4417.txt", data: "nothing here" },
      { name: "bad.bin", data: "x", method: 99 },
    ]);
    const entries: TreeEntry[] = [
      { path: "Sam", kind: "dir" },
      { path: "Sam/a.docx", kind: "file", bytes: docx },
      { path: "link", kind: "symlink", target: "elsewhere" },
    ];
    const { leaks, unscored } = scanLeaks(entries, m);
    expect(leaks).toEqual([
      { file: "Sam", part: "", in: "name", class: "person", masked: "S***3" },
      { file: "Sam/a.docx", part: "4417.txt", in: "name", class: "id", masked: "44***4" },
      { file: "Sam/a.docx", part: "word/document.xml", in: "content", class: "person", masked: "Wr***7" },
    ]);
    expect(unscored.map((u) => `${u.file}!${u.part}`)).toEqual(["Sam/a.docx!bad.bin", "link!"]);
  });

  const report = (over: Partial<FileReport>): FileReport => ({
    path: "t.csv",
    outputPath: "t.csv",
    format: "csv",
    encoding: "utf8",
    delimiter: ",",
    headerRow: 1,
    columns: [
      { index: 0, header: "Who", class: "person", treatment: "blind", outcome: "blinded", changed: 1, flagged: 0 },
      { index: 1, header: "Note", class: "vocabulary", treatment: "keep", outcome: "kept", changed: 0, flagged: 0 },
    ],
    entityReplacements: 0,
    patternReplacements: 0,
    mappedReplacements: 0,
    keptHosts: 0,
    changed: true,
    ...over,
  });
  const enc = (s: string) => new TextEncoder().encode(s);

  test("damage: a kept cell changed is damage unless it held an oracle value; a blinded column may change", () => {
    const input = enc("Who,Note\nWrexley,fine\nSam,ask Wrexley\n");
    const output = enc("Who,Note\nPerson_A,FINE\nPerson_B,ask Person_A\n");
    const { damage, unscored } = scoreDamage([{ report: report({}), input, output }], oracle, m);
    expect(unscored).toEqual([]);
    expect(damage).toEqual([{ kind: "cell", file: "t.csv", where: "row 2, column 2", masked: "fi***4", detail: "changed, and holds no oracle value" }]);
  });

  test("damage: a header change, a row count change and a rename that holds no oracle value", () => {
    const header = scoreDamage([{ report: report({}), input: enc("Who,Note\nSam,x\n"), output: enc("Person_A,Note\nPerson_B,x\n") }], oracle, m);
    expect(header.damage.map((d) => d.where)).toEqual(["row 1, column 1"]);
    const rows = scoreDamage([{ report: report({}), input: enc("Who,Note\nSam,x\n"), output: enc("Who,Note\n") }], oracle, m);
    expect(rows.damage.map((d) => d.kind)).toEqual(["structure"]);
    const renamed = scoreDamage(
      [
        { report: report({ path: "Sam/t.csv", outputPath: "Person_A/t.csv" }), input: enc("Who\n"), output: enc("Who\n") },
        { report: report({ path: "plain/t.csv", outputPath: "Value_1/t.csv" }), input: enc("Who\n"), output: enc("Who\n") },
      ],
      oracle,
      m,
    );
    expect(renamed.damage).toEqual([{ kind: "rename", file: "plain/t.csv", where: "folder name (segment 1)", masked: "pl***5", detail: "folder name changed, and holds no oracle value" }]);
  });

  test("damage is not claimed for a file it cannot parse", () => {
    const { damage, unscored } = scoreDamage([{ report: report({ path: "a.json", outputPath: "a.json", format: "json" }), input: enc("{"), output: enc("{") }], oracle, m);
    expect(damage).toEqual([]);
    expect(unscored).toHaveLength(1);
    expect(unscored[0]?.reason).toMatch(/^cannot be parsed as json .*; its keys and values were not compared$/);
    const docx = scoreDamage([{ report: report({ path: "a.docx", outputPath: "a.docx", format: "docx" }), input: enc("not a zip"), output: enc("not a zip") }], oracle, m);
    expect(docx.unscored.map((u) => u.reason.split(" (")[0])).toEqual(["cannot be read as a DOCX"]);
    const xlsx = scoreDamage([{ report: report({ path: "a.xlsx", outputPath: "a.xlsx", format: "xlsx" }), input: enc("not a zip"), output: enc("not a zip") }], oracle, m);
    expect(xlsx.unscored.map((u) => u.reason.split(" (")[0])).toEqual(["cannot be read as a workbook"]);
  });

  test("damage in JSON: a kept value or a key changed is damage unless it held an oracle value; a blinded key path may change", () => {
    const json = report({
      path: "a.json",
      outputPath: "a.json",
      format: "json",
      delimiter: undefined,
      headerRow: undefined,
      columns: [
        { index: 0, header: "", jsonPath: "$[*].who", class: "person", treatment: "blind", outcome: "blinded", changed: 1, flagged: 0 },
        { index: 1, header: "", jsonPath: "$[*].note", class: "vocabulary", treatment: "keep", outcome: "kept", changed: 0, flagged: 0 },
      ],
    });
    const input = enc('[{"who": "Sam", "note": "fine"}, {"who": "Avery", "note": "ask Wrexley"}]');
    const output = enc('[{"who": "Person_A", "note": "FINE"}, {"Who": "Person_B", "note": "ask Person_C"}]');
    const { damage, unscored } = scoreDamage([{ report: json, input, output }], oracle, m);
    expect(unscored).toEqual([]);
    expect(damage).toEqual([
      { kind: "cell", file: "a.json", where: "value 1 of $[*].note", masked: "fi***4", detail: "value changed, and holds no oracle value" },
      { kind: "cell", file: "a.json", where: "key 1 of object 1", masked: "w***3", detail: "key changed, and holds no oracle value" },
    ]);
    const shorter = scoreDamage([{ report: json, input, output: enc('[{"who": "Person_A"}]') }], oracle, m);
    expect(shorter.damage.map((d) => d.kind)).toEqual(["structure"]);
  });

  test("damage in XLSX: kept cells per sheet header and rules, sheet and defined names by position, sheet count", () => {
    const wb = (sheets: { name: string; rows: (string | number)[][] }[], names: string[]) =>
      buildWorkbook({ sheets, orphans: [], definedNames: names.map((n) => ({ name: n, formula: "1" })), core: { title: "t", creator: "c", modifiedBy: "c" } });
    const xlsx = report({
      path: "a.xlsx",
      outputPath: "a.xlsx",
      format: "xlsx",
      encoding: undefined,
      delimiter: undefined,
      headerRow: undefined,
      sheets: [
        { name: "Sam", outputName: "Person_A", headerRow: 2, noHeader: false },
        { name: "Plain", outputName: "Value_1", headerRow: 1, noHeader: false },
      ],
      columns: [
        { index: 0, header: "Who", sheet: "Sam", class: "person", treatment: "blind", outcome: "blinded", changed: 2, flagged: 0 },
        { index: 1, header: "Note", sheet: "Sam", class: "vocabulary", treatment: "keep", outcome: "kept", changed: 0, flagged: 0 },
        { index: 0, header: "Code", sheet: "Plain", class: "vocabulary", treatment: "keep", outcome: "kept", changed: 0, flagged: 0 },
      ],
    });
    // Sheet "Sam" has a title row above its header (row 2), so its Who rule starts at row 3.
    const input = wb(
      [
        { name: "Sam", rows: [["Team list", ""], ["Who", "Note"], ["Wrexley", "fine"], ["Sam", "ask Wrexley"]] },
        { name: "Plain", rows: [["Code"], ["x1"]] },
      ],
      ["Sam_Total", "Plain_Total"],
    );
    const output = wb(
      [
        { name: "Person_A", rows: [["Team list", ""], ["Person_B", "Note"], ["Person_B", "FINE"], ["Person_C", "ask Person_B"]] },
        { name: "Value_1", rows: [["Code"], ["x2"]] },
      ],
      ["Person_A_Total", "Value_1_Total"],
    );
    const { damage, unscored } = scoreDamage([{ report: xlsx, input, output }], oracle, m);
    expect(unscored).toEqual([]);
    expect(damage.map((d) => `${d.kind} ${d.where} ${d.masked}`)).toEqual([
      "rename defined name 2 Pl***11",
      "cell sheet 1, row 2, column 1 W***3",
      "cell sheet 1, row 3, column 2 fi***4",
      "rename sheet 2 name Pl***5",
      "cell sheet 2, row 2, column 1 x***2",
    ]);
    const fewer = scoreDamage([{ report: xlsx, input, output: wb([{ name: "Person_A", rows: [["Who"]] }], []) }], oracle, m);
    expect(fewer.damage.map((d) => `${d.kind} ${d.where}`)).toEqual(["structure sheets"]);
  });

  test("honesty: only files the audit called clean that leak", () => {
    const audit = {
      files: [
        { path: "a.txt", kind: "file", status: "clean", findings: [] },
        { path: "b.txt", kind: "file", status: "candidates", findings: [] },
        { path: "c.txt", kind: "file", status: "clean", findings: [] },
      ],
    } as unknown as AuditReport;
    const leak = (file: string) => ({ file, part: "", in: "content" as const, class: "person", masked: "x" });
    expect(scoreHonesty(audit, [leak("a.txt"), leak("a.txt"), leak("b.txt")])).toEqual([{ file: "a.txt", audit: "clean", leaks: 2 }]);
  });
});

test("the bench leaves no workspace behind", async () => {
  // Its own tmp root: sibling worktrees and concurrent runs cannot put workspaces in it.
  const root = mkdtempSync(join(tmpdir(), "blind-bench-root-"));
  try {
    await bench({ tmpRoot: root });
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("bench case: measures under the heuristic plan (AGT-1822)", () => {
  // A hand-made synthetic kit: a visit table with a date, a weight, an amount, a species and a
  // 15-digit chip number (invented). The spec is what `blind plan --no-model` writes for it under the
  // default policy: one rule, the chip as a numericId (`id`, blinded). The other four columns have
  // no rule, so they are scored for damage (an unknown/value rule would not be), and must come
  // through unchanged.
  test("dates, weights, amounts and species are not damaged; the chips are blinded as IDs", async () => {
    const species = ["Canine", "Feline", "Canine", "Feline", "Equine", "Lapine", "Lapine", "Equine"];
    const chips = species.map((_, i) => `98511200020000${i}`);
    const rows = species.map((s, i) => [`2026-0${1 + (i % 9)}-1${i}`, `${(9.5 + i * 6.3).toFixed(1)} lb`, `"$${(1000 + i * 137.25).toLocaleString("en-US", { minimumFractionDigits: 2 })}"`, s, chips[i]].join(","));
    const dir = mkdtempSync(join(tmpdir(), "blind-bench-measures-"));
    try {
      mkdirSync(join(dir, "input"));
      writeFileSync(join(dir, "input", "visits.csv"), `Visit Date,Weight,Amount,Species,Chip\n${rows.join("\n")}\n`);
      writeFileSync(join(dir, "oracle.json"), JSON.stringify({ values: chips.map((value) => ({ value, class: "id" })) }));
      const chipRule = { file: "visits.csv", header: "Chip", class: "id", treatment: "blind", confidence: 1, source: "heuristic" };
      const spec: Spec = { version: 1, columns: [chipRule as Spec["columns"][number]], entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: true }, questions: [] };
      writeFileSync(join(dir, "spec.json"), JSON.stringify(spec));
      const out = new Sink();
      const err = new Sink();
      const code = await runBench([dir], { out: out as unknown as NodeJS.WritableStream, err: err as unknown as NodeJS.WritableStream, cwd: dir });
      const rep = JSON.parse(readFileSync(join(dir, REPORT_FILE), "utf8")) as BenchReport;
      expect(err.text).toBe("");
      expect({ code, leaks: rep.leaks.items, damage: rep.damage.items, notWritten: rep.apply.notWritten }).toEqual({ code: 0, leaks: [], damage: [], notWritten: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
