// The walking skeleton, end to end on synthetic kit v1 through the real CLI:
// init --defaults → profile → plan --no-model → the reviewer's hand edits to
// the spec → apply → audit. Formats covered are the ones the engine handles
// (CSV and text); XLSX and DOCX join the kit when their handlers land.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditReport } from "../../src/audit/mechanical.ts";
import { ACCOUNTS_CSV, type Kit, generateKit, ORGS, PEOPLE, writeKit } from "../../src/bench/synth.ts";
import { parseTable } from "../../src/profile/table.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

const BIN = join(import.meta.dir, "../../bin/blind.js");

function blind(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Columns the reviewer decides; everything else keeps the heuristic rule `blind plan` wrote. */
const REVIEW: Record<string, Pick<ColumnRule, "class" | "treatment">> = {
  "Counterparty Label": { class: "org", treatment: "blind" },
  "Ledger Ref": { class: "id", treatment: "blind" },
  Owner: { class: "person", treatment: "blind" },
  Status: { class: "vocabulary", treatment: "keep" },
  Region: { class: "vocabulary", treatment: "keep" },
  Amount: { class: "vocabulary", treatment: "keep" },
  Opened: { class: "vocabulary", treatment: "keep" },
  // client_scope_code is left as the plan wrote it: unknown/value, a declared unknown.
};

/** The reviewer's spec: the planned columns with their decisions, plus the cast as entities. */
function reviewed(planned: Spec): Spec {
  return {
    ...planned,
    columns: planned.columns.map((c) => {
      const d = REVIEW[c.header as string];
      return d === undefined ? c : { ...c, ...d, confidence: 1, source: "human" };
    }),
    entities: {
      person: PEOPLE.map((p) => ({ canonical: p.canonical, aliases: [...p.aliases], parts: [p.given, p.surname] })),
      org: ORGS.map((o) => ({ canonical: o.canonical, aliases: [o.acronym], parts: [o.short] })),
      // The decoys, as a reviewer would mark them: ordinary words that only look like the given names.
      vocabulary: [
        { canonical: "Jan.", aliases: [], parts: [] },
        { canonical: "SAM", aliases: [], parts: [] },
      ],
    },
  };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Oracle values found in `text` as whole words, in any case. Decoy texts (exact case) are masked first. */
function oracleHits(kit: Kit, text: string): string[] {
  let masked = text;
  for (const d of kit.oracle.decoys) masked = masked.replaceAll(d.text, " ".repeat(d.text.length));
  const hits: string[] = [];
  for (const v of kit.oracle.values) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(v.value)}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(masked)) hits.push(v.value);
  }
  return hits;
}

/** Run the skeleton on `kit` in a fresh directory; returns what each step produced. */
function runSkeleton(kit: Kit) {
  const dir = mkdtempSync(join(tmpdir(), "blind-skeleton-"));
  writeKit(dir, kit);
  const started = performance.now();
  const init = blind(dir, "init", "--defaults");
  const profile = blind(dir, "profile", "input");
  const plan = blind(dir, "plan", "input", "--no-model");
  const specPath = join(dir, ".blind", "spec.json");
  const planned = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
  // The review step: the spec file is edited in place (it stays mode 0600).
  writeFileSync(specPath, `${JSON.stringify(reviewed(planned), null, 2)}\n`);
  const apply = blind(dir, "apply", "input", "-o", "out");
  const audit = blind(dir, "audit", "out", "--json", "--no-model");
  const seconds = (performance.now() - started) / 1000;
  const output = Object.fromEntries(kit.files.map((f) => [f.path, readFileSync(join(dir, "out", ...f.path.split("/")), "utf8")]));
  return { dir, init, profile, plan, planned, apply, audit, seconds, output, specMode: statSync(specPath).mode & 0o777 };
}

describe("walking skeleton on synthetic kit v1", () => {
  const kit = generateKit();
  let run: ReturnType<typeof runSkeleton>;
  let report: AuditReport;

  beforeAll(() => {
    run = runSkeleton(kit);
    report = JSON.parse(run.audit.out) as AuditReport;
  });
  afterAll(() => rmSync(run.dir, { recursive: true, force: true }));

  test("every step succeeds, and the whole run takes under 10 seconds", () => {
    expect(run.init.code).toBe(0);
    expect(run.profile.code).toBe(0);
    expect(run.plan.code).toBe(0);
    expect(run.apply.err).toBe("");
    expect(run.apply.code).toBe(0);
    expect(run.specMode).toBe(0o600);
    expect(run.seconds).toBeLessThan(10);
  });

  test("plan --no-model classifies only the detector-shaped columns and leaves the rest unknown", () => {
    const byHeader = Object.fromEntries(run.planned.columns.map((c) => [c.header, `${c.class}/${c.treatment}`]));
    expect(byHeader["Tenant Host"]).toBe("host/blind");
    expect(byHeader["Acct No"]).toBe("id/blind");
    // The unseen header wording and the snake_case column give the heuristic nothing to go on.
    expect(byHeader["Counterparty Label"]).toBe("unknown/value");
    expect(byHeader.client_scope_code).toBe("unknown/value");
  });

  test("no oracle value survives anywhere in the output", () => {
    for (const [path, text] of Object.entries(run.output)) expect({ path, hits: oracleHits(kit, text) }).toEqual({ path, hits: [] });
  });

  test("no cell changes outside the blinded and declared-unknown columns", () => {
    const before = parseTable(kit.files.find((f) => f.path === ACCOUNTS_CSV)?.text as string, "csv");
    const after = parseTable(run.output[ACCOUNTS_CSV] as string, "csv");
    expect(after.length).toBe(before.length);
    const header = before[0] as string[];
    expect(after[0]).toEqual(header);
    const spec = reviewed(run.planned);
    const changes = (col: number) => before.slice(1).filter((row, r) => row[col] !== (after[r + 1] as string[])[col]).length;
    header.forEach((h, col) => {
      const rule = spec.columns.find((c) => c.header === h) as ColumnRule;
      const changed = changes(col);
      if (rule.treatment === "blind" || rule.class === "unknown") expect({ h, all: changed === before.length - 1 }).toEqual({ h, all: true });
      else expect({ h, changed }).toEqual({ h, changed: 0 });
    });
  });

  test("the month decoy survives: Jan. is not taken for the given name Jan", () => {
    const md = run.output["notes/review.md"] as string;
    const expected = (kit.files.find((f) => f.path === "notes/review.md")?.text?.match(/\bJan\./g) ?? []).length;
    expect(expected).toBeGreaterThan(0);
    expect((md.match(/\bJan\./g) ?? []).length).toBe(expected);
  });

  test("the audit reports candidates, never clean: the declared unknown column is one, and there is no leak", () => {
    expect(run.audit.code).toBe(1);
    expect(report.status).toBe("candidates");
    expect(report.summary.leaks).toBe(0);
    const findings = [...report.files.flatMap((f) => f.findings), ...report.general];
    expect(findings.filter((f) => f.severity === "leak")).toEqual([]);
    // Exactly one candidate, the declared unknown: the audit explains everything else it read.
    expect(findings.map((f) => ({ file: f.file, source: f.source, class: f.class }))).toEqual([{ file: ACCOUNTS_CSV, source: "spec", class: "unknown" }]);
    expect(report.files.find((f) => f.path === ACCOUNTS_CSV)?.status).toBe("candidates");
    for (const f of report.files.filter((x) => x.path !== ACCOUNTS_CSV && x.kind === "file")) expect({ path: f.path, status: f.status }).toEqual({ path: f.path, status: "clean" });
  });

  // Found by this kit (AGT-1739), fixed in AGT-1783: the person part "Sam" also matches the text
  // "SAM", and an equal-length vocabulary entry "SAM" used to lose the tie to person. Vocabulary now
  // wins equal-length ties, so the acronym decoy survives.
  test("the acronym decoy survives: SAM, marked vocabulary, is not taken for the given name Sam", () => {
    const md = run.output["notes/review.md"] as string;
    const expected = (kit.files.find((f) => f.path === "notes/review.md")?.text?.match(/\bSAM\b/g) ?? []).length;
    expect(expected).toBeGreaterThan(0);
    expect((md.match(/\bSAM\b/g) ?? []).length).toBe(expected);
  });
});

// AGT-1779: values from blinded columns that recur in free text (neither spec entities nor
// pattern matches) are replaced there too, by src/engine/recur.ts.
test("AGT-1779: blinded column values cited in prose are replaced there too", () => {
  const kit = generateKit(undefined, { recurInProse: true });
  const run = runSkeleton(kit);
  try {
    expect(run.apply.code).toBe(0);
    const report = JSON.parse(run.audit.out) as AuditReport;
    expect(report.summary.leaks).toBe(0);
    expect(oracleHits(kit, run.output["notes/review.md"] as string)).toEqual([]);
  } finally {
    rmSync(run.dir, { recursive: true, force: true });
  }
});
