// AGT-2768: explainProposal in the library entry. For every table column and JSON key it says what is proposed,
// who decided it (a blind.toml rule or the detectors) and why; where `blind plan --no-model` prints a note beside
// a column, the reason is that note's text, and the plan-wide notes (rules decided, keep rules that decide nothing)
// are the CLI's lines. The CLI is run here, in the test, never by the library. Synthetic data only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { runPlan } from "../src/analyst/plan.ts";
import { generateKit, kitFileBytes } from "../src/bench/synth.ts";
import { type BlindPolicy, explainProposal, type InputFile, profileInputs, type ProposalEntry, proposeSpec } from "../src/lib.ts";
import { POLICY_FILE } from "../src/policy.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-libreasons-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const kit = generateKit(undefined, { version: 2 });
const kitFiles = (): InputFile[] => kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) }));

/** Runs `blind plan --no-model --show-values in` and returns its printed lines and the spec it wrote. */
async function cliPlan(files: readonly InputFile[], toml: string): Promise<{ code: number; lines: string[]; spec: unknown }> {
  for (const f of files) {
    const p = join(dir, "in", ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  writeFileSync(join(dir, POLICY_FILE), toml);
  const out = new PassThrough();
  const err = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  err.resume();
  const code = await runPlan(["in", "--no-model", "--show-values"], { out, err, cwd: dir });
  const spec: unknown = JSON.parse(readFileSync(join(dir, ".blind", "spec.json"), "utf8"));
  return { code, lines: Buffer.concat(chunks).toString("utf8").split("\n"), spec };
}

const MODELS = '[models.analyst]\nbackend = "openai-compatible"\nurl = ""\nmodel = ""\nkey_env = ""\n';
const HEAD = (classes: string) => `[sensitive]\nclasses = ${classes}\ndescription = "d"\nexamples = []\n`;

const CASES: { name: string; toml: string; policy: BlindPolicy }[] = [
  {
    name: "the classes `blind init` writes, nothing else",
    toml: `${HEAD('["person", "org", "host", "email", "id", "location", "secret"]')}[keep]\nterms = []\n${MODELS}[profile]\n[privacy]\nmode = "local-only"\n`,
    policy: {},
  },
  {
    name: "overlapping rules, a shadowed keep, a keep term and a pattern on for an unlisted class",
    toml:
      `${HEAD('["person", "id"]')}[keep]\nterms = ["Status"]\n${MODELS}[profile]\n[privacy]\nmode = "local-only"\n[patterns]\nemail = true\n` +
      `[[columns]]\nheader = "Counterparty*"\ntreatment = "keep"\n` +
      `[[columns]]\nheader = "Counterparty Label"\ntreatment = "blind"\nclass = "org"\n` +
      `[[columns]]\nheader = "Owner"\ntreatment = "keep"\n` +
      `[[columns]]\nheader = "Own*"\ntreatment = "blind"\nclass = "person"\n` +
      `[[columns]]\npath = "scopes.granted_on"\ntreatment = "drop"\n`,
    policy: {
      sensitive: { classes: ["person", "id"] },
      keep: { terms: ["Status"] },
      patterns: { email: true },
      columns: [
        { header: "Counterparty*", treatment: "keep" },
        { header: "Counterparty Label", treatment: "blind", class: "org" },
        { header: "Owner", treatment: "keep" },
        { header: "Own*", treatment: "blind", class: "person" },
        { path: "scopes.granted_on", treatment: "drop" },
      ],
    },
  },
];

/** How the CLI writes an entry's location in front of a note, with --show-values. */
const where = (e: ProposalEntry): string => `${JSON.stringify(e.file)}${e.sheet === undefined ? "" : ` [${JSON.stringify(e.sheet)}]`} ${JSON.stringify(e.header ?? e.jsonPath ?? "")}`;

describe("explainProposal says what `blind plan --no-model` says, for the synthetic kit", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const cli = await cliPlan(kitFiles(), c.toml);
      expect(cli.code).toBe(0);
      const { profile } = profileInputs(kitFiles(), { policy: c.policy });
      const r = explainProposal(profile, c.policy);
      // The spec is proposeSpec's, and the CLI's.
      expect(r.spec).toEqual(proposeSpec(profile, c.policy));
      expect(r.spec).toEqual(cli.spec as typeof r.spec);
      // One entry per spec column, in order, agreeing with its rule.
      expect(r.columns.length).toBe(r.spec.columns.length);
      r.columns.forEach((e, i) => {
        const rule = r.spec.columns[i];
        expect(rule).toMatchObject({ file: e.file, class: e.class, treatment: e.treatment, source: e.source });
        expect(rule?.sheet).toBe(e.sheet);
        expect(rule?.header).toBe(e.header);
        expect(rule?.jsonPath).toBe(e.jsonPath);
        expect(e.reason).not.toBe("");
      });
      // Every note the CLI prints about a column is that entry's reason, word for word; every such note is claimed.
      const columnLines = cli.lines.filter((l) => l.startsWith('note: "'));
      const claimed = new Set<string>();
      for (const e of r.columns) {
        const prefix = `note: ${where(e)}: `;
        const said = columnLines.filter((l) => l.startsWith(prefix));
        for (const l of said) claimed.add(l);
        if (said.length > 0) expect(e.reason).toBe(said.map((l) => l.slice(prefix.length)).join("; "));
      }
      expect(columnLines.filter((l) => !claimed.has(l))).toEqual([]);
      // The policy case has notes to compare: two overlaps and an email pattern blind at least.
      if (c.policy.columns !== undefined) expect(claimed.size).toBeGreaterThanOrEqual(3);
      // The plan-wide notes are the CLI's lines.
      for (const n of r.notes) expect(cli.lines).toContain(n.startsWith("warning: ") ? n : `note: ${n}`);
    });
  }

  test("an overlap, a shadowed keep, a pattern and the deciding rule are in the reasons", () => {
    const c = CASES[1] as (typeof CASES)[number];
    const r = explainProposal(profileInputs(kitFiles(), { policy: c.policy }).profile, c.policy);
    const at = (file: string, key: string) => r.columns.find((e) => e.file === file && (e.header === key || e.jsonPath === key)) as ProposalEntry;
    expect(at("accounts.csv", "Owner")).toMatchObject({ treatment: "keep", source: "policy" });
    expect(at("accounts.csv", "Owner").reason).toBe(
      '2 blind.toml rules match: columns[2] (header "Owner", keep/vocabulary); columns[3] (header "Own*", blind/person); columns[2] wins (an exact name beats a glob)',
    );
    expect(at("accounts.csv", "Status")).toMatchObject({ class: "vocabulary", treatment: "keep", source: "policy", reason: "decided by blind.toml: its name is a [keep] term" });
    expect(at("exports/scopes.json", "$.scopes[*].granted_on")).toMatchObject({ treatment: "drop", source: "policy", reason: 'decided by blind.toml columns[4] (path "scopes.granted_on", drop/unknown)' });
    expect(at("workbooks/tenant-access.xlsx", "Email")).toMatchObject({
      class: "email",
      treatment: "blind",
      source: "heuristic",
      reason: "blind, because policy pattern email on (its class is not in [sensitive].classes)",
    });
    expect(r.notes).toContain(
      'warning: blind.toml columns[0] (header "Counterparty*", keep) decides nothing: at all 1 column(s) and key(s) it matches, columns[1] wins instead',
    );
    expect(r.columns.filter((e) => e.source === "heuristic" && e.class === "unknown").every((e) => e.reason.startsWith("no blind.toml rule or detector decides it"))).toBe(true);
  });

  test("reasons carry no sample value", () => {
    for (const c of CASES) {
      const { profile } = profileInputs(kitFiles(), { policy: c.policy });
      const samples = new Set<string>();
      for (const t of profile.tables) for (const col of t.columns) for (const s of col.stats.samples) if (s.length >= 4) samples.add(s);
      for (const j of profile.jsonKeys) for (const s of j.stats.samples) if (s.length >= 4) samples.add(s);
      const r = explainProposal(profile, c.policy);
      for (const e of r.columns) for (const s of samples) expect(e.reason.includes(s)).toBe(false);
    }
  });
});
