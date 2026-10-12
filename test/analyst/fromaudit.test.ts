import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { proposalSchema } from "../../src/analyst/analyst.ts";
import {
  applyDecisions,
  type Candidate,
  collectCandidates,
  FromAuditError,
  LEAK_FALLBACK_CLASS,
  keptValues,
  leakDecisions,
  parseAuditReport,
  parseDecisions,
  type ReportFinding,
} from "../../src/analyst/fromaudit.ts";
import { type PlanIO, runPlan } from "../../src/analyst/plan.ts";
import { runApply } from "../../src/apply.ts";
import { collectTree, runAudit } from "../../src/audit/command.ts";
import { auditTree } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import { generateKit, kitSpec, ORGS, PEOPLE, writeKit } from "../../src/bench/synth.ts";
import { OracleMatcher, parseOracle, scanLeaks } from "../../src/bench/score.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { defaultPolicy, renderPolicy } from "../../src/policy.ts";
import type { Spec } from "../../src/schema.ts";
import { parseSpec, validateSchema } from "../../src/validate.ts";
import { makeZip } from "../audit/zipfixture.ts";

// Synthetic corpus only: invented names, example.com hosts, RFC 5737 IPs. No model is ever called:
// every model seam passed in throws, and the from-audit path never reaches one.

const NO_MODEL = {
  fetch: () => Promise.reject(new Error("a test must not call a model")),
  spawn: () => Promise.reject(new Error("a test must not call a model")),
};

const SPEC: Spec = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "Owner", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "Status", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const EMPTY_MAP: BlindMap = { version: 1, entries: [] };

function sink() {
  const s = new PassThrough();
  let text = "";
  s.on("data", (d) => (text += d));
  return { s, text: () => text };
}

let dir: string;

async function run(fn: (argv: string[], io: PlanIO) => Promise<number>, argv: string[], extra: Partial<PlanIO> = {}) {
  const out = sink();
  const err = sink();
  const code = await fn(argv, { out: out.s, err: err.s, cwd: dir, model: NO_MODEL, ...extra });
  return { code, out: out.text(), err: err.text() };
}

const plan = (argv: string[], extra: Partial<PlanIO> = {}) => run(runPlan, argv, extra);
const apply = (argv: string[]) => run((a, io) => runApply(a, io), argv);
const audit = (argv: string[]) => run((a, io) => runAudit(a, io), argv);

/** apply in → out, then audit out --json --no-model into report.json. */
async function round(out: string, tamper?: () => void): Promise<{ code: number; report: { status: string } }> {
  rmSync(join(dir, out), { recursive: true, force: true });
  expect((await apply(["in", "-o", out])).code).toBe(0);
  tamper?.();
  const r = await audit([out, "--json", "--no-model"]);
  writeFileSync(join(dir, "report.json"), r.out);
  return { code: r.code, report: JSON.parse(r.out) };
}

const savedSpec = (): Spec => parseSpec(readFileSync(join(dir, ".blind", "spec.json"), "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-fromaudit-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 9)), { mode: 0o600 });
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(SPEC), { mode: 0o600 });
  writeFileSync(join(dir, "blind.toml"), renderPolicy(defaultPolicy()));
  mkdirSync(join(dir, "in"));
  writeFileSync(join(dir, "in", "staff.csv"), "Owner,Status\nAvery Quill,open\n");
  writeFileSync(
    join(dir, "in", "notes.md"),
    "Avery met Harbour Lane Partners at the Quarterly Planning Review.\nTicket ZX-4471-Q is closed.\n",
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("reading the report", () => {
  test("anything that is not a blind audit --json report is refused", () => {
    expect(() => parseAuditReport("not json", "r.json")).toThrow(/not JSON/);
    expect(() => parseAuditReport('{"version": 2, "files": [], "general": []}', "r.json")).toThrow(/not a blind audit report/);
    const bad = { version: 1, files: [{ path: "a", findings: [{ file: "a", part: "", in: "content", offset: -1 }] }], general: [] };
    expect(() => parseAuditReport(JSON.stringify(bad), "r.json")).toThrow(FromAuditError);
  });
});

describe("mapping findings back to their values", () => {
  test("values are read from the output, never from the report, and each distinct value is one candidate", async () => {
    expect((await round("out")).code).toBe(1);
    const findings = parseAuditReport(readFileSync(join(dir, "report.json"), "utf8"), "report.json");
    // The report itself carries masked values only.
    expect(JSON.stringify(findings)).not.toContain("Harbour Lane Partners");
    const { candidates, unmapped } = collectCandidates(findings, join(dir, "out"), EMPTY_MAP);
    expect(unmapped).toEqual([]);
    const byValue = new Map(candidates.map((c) => [c.value, c]));
    expect([...byValue.keys()].sort()).toEqual(["Harbour Lane Partners", "Quarterly Planning Review", "ZX-4471-Q"]);
    expect(byValue.get("ZX-4471-Q")?.suggested).toBe("id");
    expect(byValue.get("Harbour Lane Partners")?.suggested).toBeNull();
    expect(candidates.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });

  test("a finding whose place no longer holds a value that masks the same is not mapped back", async () => {
    await round("out");
    const findings = parseAuditReport(readFileSync(join(dir, "report.json"), "utf8"), "report.json");
    // The output changed after the audit: the report is stale.
    writeFileSync(join(dir, "out", "notes.md"), "Nothing to see here at all, nothing at all, really nothing.\n");
    const { candidates, unmapped } = collectCandidates(findings, join(dir, "out"), EMPTY_MAP);
    expect(candidates).toEqual([]);
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped[0]?.why).toMatch(/audit the output again/);
  });

  test("a path that leaves the output tree is never read", () => {
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "secret.txt"), "Harbour Lane Partners\n");
    const f: ReportFinding = {
      file: "../secret.txt", part: "", in: "content", offset: 0, line: 1, class: "semantic:phrase", source: "semantic",
      severity: "candidate", masked: "Ha***21", reason: "x", encoding: "latin-1",
    };
    const { candidates, unmapped } = collectCandidates([f], join(dir, "out"), EMPTY_MAP);
    expect(candidates).toEqual([]);
    expect(unmapped[0]?.why).toMatch(/not a path inside the output tree/);
  });

  test("a folder on the path that is a symbolic link is never followed out of the tree", () => {
    mkdirSync(join(dir, "out"));
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "elsewhere", "secret.txt"), "Harbour Lane Partners\n");
    symlinkSync(join(dir, "elsewhere"), join(dir, "out", "link"));
    const f: ReportFinding = {
      file: "link/secret.txt", part: "", in: "content", offset: 0, line: 1, class: "semantic:phrase", source: "semantic",
      severity: "candidate", masked: "Ha***21", reason: "x", encoding: "latin-1",
    };
    const { candidates, unmapped } = collectCandidates([f], join(dir, "out"), EMPTY_MAP);
    expect(candidates).toEqual([]);
    expect(unmapped[0]?.why).toMatch(/is not a directory \(symbolic links are never followed\)/);
  });

  test("a pseudonym at the place means the report is older than the output", () => {
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "a.txt"), "Owner Person_1A2B here\n");
    const map: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "jo sample", value: "Jo Sample", pseudonym: "Person_1A2B" }] };
    const f: ReportFinding = {
      file: "a.txt", part: "", in: "content", offset: 6, line: 1, class: "person", source: "map",
      severity: "leak", masked: "Pe***11", reason: "x", encoding: "latin-1",
    };
    expect(collectCandidates([f], join(dir, "out"), map).unmapped[0]?.why).toMatch(/is a pseudonym/);
  });

  test("a value split across XML runs inside a zip member is read back joined, as the semantic layer read it", () => {
    mkdirSync(join(dir, "out"));
    const xml = '<?xml version="1.0"?><w:document xmlns:w="urn:x"><w:p><w:r><w:t>met with Harb</w:t></w:r><w:r><w:t>our Lane Partners today</w:t></w:r></w:p></w:document>';
    writeFileSync(join(dir, "out", "memo.docx"), makeZip([{ name: "word/document.xml", data: xml }]));
    const entries = collectTree(join(dir, "out"));
    const report = addSemanticLayer(auditTree(entries, SPEC, EMPTY_MAP), entries, SPEC, EMPTY_MAP, { keep: [] });
    const findings = parseAuditReport(JSON.stringify(report), "report");
    const { candidates, unmapped } = collectCandidates(findings, join(dir, "out"), EMPTY_MAP);
    expect(unmapped).toEqual([]);
    expect(candidates.map((c) => [c.value, c.places[0]?.part])).toEqual([["Harbour Lane Partners", "word/document.xml"]]);
  });

  test("a spec value found inside a longer word is decided as that whole word, which can be rejected", () => {
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "a.txt"), "the Averyson report\n");
    const f: ReportFinding = {
      file: "a.txt", part: "", in: "content", offset: 4, line: 1, class: "person", source: "entity",
      severity: "candidate", masked: "Av***5", reason: "x", encoding: "latin-1",
    };
    const [c] = collectCandidates([f], join(dir, "out"), EMPTY_MAP).candidates;
    expect(c?.value).toBe("Averyson");
    expect(c?.known).toBe(false);
    expect(c?.suggested).toBe("person");
    const exact: ReportFinding = { ...f, offset: 0, masked: "Av***5" };
    writeFileSync(join(dir, "out", "a.txt"), "Avery wrote\n");
    expect(collectCandidates([exact], join(dir, "out"), EMPTY_MAP).candidates[0]?.known).toBe(true);
  });

  test("findings that are not one value are kept apart, not turned into candidates", () => {
    const general: ReportFinding = {
      file: "(spec)", part: "", in: "content", offset: null, line: null, class: "unknown", source: "spec",
      severity: "candidate", masked: "", reason: 'spec question "q1" is unanswered', encoding: null,
    };
    mkdirSync(join(dir, "out"));
    const { candidates, other } = collectCandidates([general], join(dir, "out"), EMPTY_MAP);
    expect(candidates).toEqual([]);
    expect(other).toEqual([general]);
  });
});

describe("decisions", () => {
  const cand = (over: Partial<Candidate>): Candidate => ({
    id: "c1", value: "Harbour Lane Partners", kinds: ["semantic:phrase"], suggested: null, pattern: null, known: false,
    severity: "candidate", places: [{ file: "notes.md", part: "", in: "content", offset: 0, line: 1 }], ...over,
  });

  test("parseDecisions takes comma lists and classes, and refuses bad ids, classes and repeats", () => {
    expect(parseDecisions(["c1,c2=org", "c3=pattern"], ["c4"])).toEqual([
      { id: "c1", action: "accept", as: null },
      { id: "c2", action: "accept", as: "org" },
      { id: "c3", action: "accept", as: "pattern" },
      { id: "c4", action: "reject" },
    ]);
    expect(() => parseDecisions(["q1"], [])).toThrow(/candidate ids/);
    expect(() => parseDecisions(["c1=vocabulary"], [])).toThrow(/--reject c1/);
    expect(() => parseDecisions(["c1"], ["c1"])).toThrow(/given twice/);
  });

  test("accepted values become human entities, rejected ones human vocabulary; saved entries stay the same objects", () => {
    const cs = [cand({}), cand({ id: "c2", value: "ZX-4471-Q", kinds: ["semantic:alnum-id"], suggested: "id" }), cand({ id: "c3", value: "Quarterly Planning Review" })];
    const { spec, changes } = applyDecisions(SPEC, cs, parseDecisions(["c1=org", "c2"], ["c3"]), EMPTY_MAP);
    expect(spec.entities.org).toEqual([{ canonical: "Harbour Lane Partners", aliases: [], parts: [], source: "human" }]);
    expect(spec.entities.id).toEqual([{ canonical: "ZX-4471-Q", aliases: [], parts: [], source: "human" }]);
    expect(spec.entities.vocabulary).toEqual([{ canonical: "Quarterly Planning Review", aliases: [], parts: [], source: "human" }]);
    expect(spec.entities.person?.[0]).toBe(SPEC.entities.person?.[0] as never);
    expect(spec.columns).toBe(SPEC.columns);
    expect(spec.patterns).toBe(SPEC.patterns);
    expect(changes.map((c) => c.result)).toEqual(["entity", "entity", "vocabulary"]);
  });

  test("a candidate with no suggested class needs one named", () => {
    expect(() => applyDecisions(SPEC, [cand({})], parseDecisions(["c1"], []), EMPTY_MAP)).toThrow(/needs a class/);
  });

  test("=pattern turns the value's shape pattern on, and only for a value with a shape", () => {
    const host = cand({ value: "build07.example.com", kinds: ["semantic:host"], suggested: "host", pattern: "host" });
    const off = { ...SPEC, patterns: { ...SPEC.patterns, host: false } };
    expect(applyDecisions(off, [host], parseDecisions(["c1=pattern"], []), EMPTY_MAP).spec.patterns.host).toBe(true);
    const already = applyDecisions(SPEC, [host], parseDecisions(["c1=pattern"], []), EMPTY_MAP);
    expect(already.spec).toBe(SPEC);
    expect(already.changes[0]?.note).toMatch(/already on/);
    expect(() => applyDecisions(SPEC, [cand({})], parseDecisions(["c1=pattern"], []), EMPTY_MAP)).toThrow(/no shape pattern/);
  });

  test("a value the spec or map knows cannot be rejected, nor a phrase that contains one", () => {
    const known = cand({ value: "Avery", kinds: ["person"], suggested: "person", known: true });
    expect(() => applyDecisions(SPEC, [known], parseDecisions([], ["c1"]), EMPTY_MAP)).toThrow(/cannot be rejected/);
    const around = cand({ value: "Avery Planning Group" });
    expect(() => applyDecisions(SPEC, [around], parseDecisions([], ["c1"]), EMPTY_MAP)).toThrow(/contains a spec entity form/);
    const map: BlindMap = { version: 1, entries: [{ kind: "org", canonical: "harbour lane", value: "Harbour Lane", pseudonym: "Org_1A2B" }] };
    expect(() => applyDecisions(SPEC, [cand({})], parseDecisions([], ["c1"]), map)).toThrow(/value from the map/);
  });

  test("an accepted value that is already an entity form changes nothing; a vocabulary form is refused", () => {
    const same = applyDecisions(SPEC, [cand({ value: "Avery", suggested: "person" })], parseDecisions(["c1"], []), EMPTY_MAP);
    expect(same.spec).toBe(SPEC);
    expect(same.changes[0]?.note).toMatch(/already a form of the person entity/);
    const vocab = { ...SPEC, entities: { ...SPEC.entities, vocabulary: [{ canonical: "Harbour Lane Partners", aliases: [], parts: [] }] } };
    expect(() => applyDecisions(vocab, [cand({})], parseDecisions(["c1=org"], []), EMPTY_MAP)).toThrow(/vocabulary form/);
  });

  test("leakDecisions accepts every leak at its suggested class (id when none), and leaves candidates and given decisions alone", () => {
    const cs = [
      cand({}),
      cand({ id: "c2", value: "ZX-4471-Q", kinds: ["pattern:guid"], suggested: "id", severity: "leak" }),
      cand({ id: "c3", value: "Quillhaven Annex", kinds: ["value"], suggested: null, severity: "leak" }),
      cand({ id: "c4", value: "Harbour Lane", kinds: ["org"], suggested: "org", severity: "leak" }),
    ];
    const { decisions, skipped } = leakDecisions(SPEC, cs, parseDecisions(["c4=location"], []), EMPTY_MAP);
    expect(skipped).toEqual([]);
    expect(decisions).toEqual([
      { id: "c4", action: "accept", as: "location" },
      { id: "c2", action: "accept", as: "id" },
      { id: "c3", action: "accept", as: LEAK_FALLBACK_CLASS },
    ]);
    const { spec } = applyDecisions(SPEC, cs, decisions, EMPTY_MAP);
    expect(spec.entities.id?.map((e) => [e.canonical, e.source])).toEqual([["ZX-4471-Q", "human"], ["Quillhaven Annex", "human"]]);
    expect(spec.entities.location?.map((e) => e.canonical)).toEqual(["Harbour Lane"]);
    expect(spec.entities.vocabulary).toBeUndefined();
  });

  test("leakDecisions leaves out a leak that cannot be accepted, with why, and still accepts the rest", () => {
    const vocab = { ...SPEC, entities: { ...SPEC.entities, vocabulary: [{ canonical: "Quillhaven Annex", aliases: [], parts: [] }] } };
    const cs = [
      cand({ value: "Quillhaven Annex", kinds: ["value"], severity: "leak" }),
      cand({ id: "c2", value: "ZX-4471-Q", kinds: ["pattern:guid"], suggested: "id", severity: "leak" }),
    ];
    const { decisions, skipped } = leakDecisions(vocab, cs, [], EMPTY_MAP);
    expect(decisions.map((d) => d.id)).toEqual(["c2"]);
    expect(skipped.map((x) => x.id)).toEqual(["c1"]);
    expect(skipped[0]?.why).toMatch(/vocabulary form/);
  });

  test("leakDecisions leaves out a leak that is not sensitive, with why, and still accepts the rest", () => {
    const cs = [
      cand({ value: "Main Office", kinds: ["value"], severity: "leak" }),
      cand({ id: "c2", value: "41,7", kinds: ["value"], severity: "leak" }),
      cand({ id: "c3", value: "2024", kinds: ["value"], severity: "leak" }),
      cand({ id: "c4", value: "555-0199", kinds: ["pattern:phone"], suggested: "id", severity: "leak", pattern: "phone" }),
      cand({ id: "c5", value: "Blue House", kinds: ["value"], severity: "leak" }),
      cand({ id: "c6", value: "Quillhaven Annex", kinds: ["value"], severity: "leak" }),
      cand({ id: "c7", value: "Ridgeway Clinic", kinds: ["value"], severity: "leak" }),
      cand({ id: "c8", value: "help@example.com", kinds: ["pattern:email"], suggested: "email", severity: "leak", pattern: "email" }),
    ];
    const kept = { values: new Set(["blue house", "555-0199"]), terms: new Set(["ridgeway clinic"]) };
    const { decisions, skipped } = leakDecisions(SPEC, cs, [], EMPTY_MAP, kept);
    expect(decisions.map((d) => d.id)).toEqual(["c6", "c8"]);
    const why = Object.fromEntries(skipped.map((x) => [x.id, x.why]));
    expect(Object.keys(why)).toEqual(["c1", "c2", "c3", "c4", "c5", "c7"]);
    expect(why.c1).toMatch(/dictionary word/);
    expect(why.c2).toMatch(/measure/);
    expect(why.c3).toMatch(/short number/);
    expect(why.c4).toMatch(/column the spec keeps/);
    expect(why.c5).toMatch(/column the spec keeps/);
    expect(why.c7).toMatch(/\[keep\]\.terms/);
  });

  test("keptValues reads the cells of the keep columns of the output, and the policy terms, folded", () => {
    mkdirSync(join(dir, "kept"));
    writeFileSync(join(dir, "kept", "clinic.csv"), 'name,clinic_phone\n"Ann, B",555-0199\nCy,\n');
    const spec: Spec = { ...SPEC, columns: [{ file: "clinic.csv", header: "clinic_phone", class: "vocabulary", treatment: "keep", confidence: 1, source: "policy" }] };
    const k = keptValues(join(dir, "kept"), spec, ["ER Line"]);
    expect([...k.values]).toEqual(["555-0199"]);
    expect([...k.terms]).toEqual(["er line"]);
  });

  test("an unknown id is refused", () => {
    expect(() => applyDecisions(SPEC, [cand({})], parseDecisions(["c9"], []), EMPTY_MAP)).toThrow(/no candidate c9/);
  });

  test("the analyst cannot pass its entities off as human: source is not in its reply schema", () => {
    const reply = { ...SPEC, entities: { org: [{ canonical: "Example Widgets", aliases: [], parts: [], source: "human" }] } };
    expect(validateSchema(proposalSchema, reply).length).toBeGreaterThan(0);
    expect(validateSchema(proposalSchema, { ...reply, entities: { org: [{ canonical: "Example Widgets", aliases: [], parts: [] }] } })).toEqual([]);
  });
});

describe("blind plan --from-audit", () => {
  test("usage: -o is required, inputs and --answer do not mix, and -o/--accept need --from-audit", async () => {
    expect((await plan(["--from-audit", "report.json"])).err).toMatch(/needs -o <out>/);
    expect((await plan(["--from-audit", "report.json", "-o", "out", "in"])).code).toBe(2);
    expect((await plan(["in", "--accept", "c1"])).err).toMatch(/go with --from-audit/);
  });

  test("without decisions or a terminal it lists the candidates and writes nothing", async () => {
    await round("out");
    const before = readFileSync(join(dir, ".blind", "spec.json"), "utf8");
    const r = await plan(["--from-audit", "report.json", "-o", "out"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"Harbour Lane Partners"');
    expect(r.out).toContain("undecided (3)");
    expect(r.out).toContain("the spec was not changed");
    expect(readFileSync(join(dir, ".blind", "spec.json"), "utf8")).toBe(before);
  });

  test("a refused decision writes nothing and exits 2", async () => {
    await round("out");
    const before = readFileSync(join(dir, ".blind", "spec.json"), "utf8");
    const r = await plan(["--from-audit", "report.json", "-o", "out", "--accept", "c1"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/needs a class/);
    expect(r.err).toContain("no spec was written");
    expect(readFileSync(join(dir, ".blind", "spec.json"), "utf8")).toBe(before);
  });

  test("on a terminal it asks about each candidate and re-asks after a refused answer", async () => {
    await round("out");
    const answers = ["a", "org", "r", ""];
    const asked: string[] = [];
    const prompt = async (q: string) => {
      asked.push(q);
      return answers.shift() ?? null;
    };
    const r = await plan(["--from-audit", "report.json", "-o", "out"], { prompt });
    expect(r.code).toBe(0);
    // c1 (Harbour Lane Partners) has no suggested class: "a" is refused, then "org" is taken.
    expect(r.out).toContain("needs a class");
    expect(asked.length).toBe(4);
    const spec = savedSpec();
    expect(spec.entities.org?.map((e) => e.canonical)).toEqual(["Harbour Lane Partners"]);
    expect(spec.entities.vocabulary?.map((e) => e.canonical)).toEqual(["Quarterly Planning Review"]);
    expect(r.out).toContain("undecided (1): c3");
  });

  test("the spec is written mode 0600, and --json reports candidates, changes and what stays undecided", async () => {
    await round("out");
    const r = await plan(["--from-audit", "report.json", "-o", "out", "--json", "--accept", "c1=org", "--reject", "c2"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.spec).toBe(join(".blind", "spec.json"));
    expect(j.changes.map((c: { result: string }) => c.result)).toEqual(["entity", "vocabulary"]);
    expect(j.undecided).toEqual(["c3"]);
    expect(statSync(join(dir, ".blind", "spec.json")).mode & 0o777).toBe(0o600);
  });

  test("findings it cannot read back are listed on stderr and exit 1", async () => {
    await round("out");
    writeFileSync(join(dir, "out", "notes.md"), "rewritten after the audit, so nothing matches here anymore at all\n");
    const r = await plan(["--from-audit", "report.json", "-o", "out"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not read back: notes\.md line 1/);
    expect(r.err).not.toContain("Harbour");
  });

  test("--accept-leaks accepts the leaks without asking, leaves the other candidates undecided, and the next round has no leak", async () => {
    const spec: Spec = { ...SPEC, columns: [...SPEC.columns, { file: "sites.csv", header: "Site", class: "unknown", treatment: "blind", confidence: 1, source: "human" }] };
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec), { mode: 0o600 });
    // Invented sites, blinded in their column and in prose; two are written back into the output, as a missed value would be.
    writeFileSync(join(dir, "in", "sites.csv"), "Site\nQuillhaven Annex\nMarrowdale Depot\nOrchard Point\n");
    writeFileSync(join(dir, "in", "visit.txt"), "Met at Quillhaven Annex, then Marrowdale Depot.\n");
    const first = await round("out", () => appendFileSync(join(dir, "out", "visit.txt"), "Again: Quillhaven Annex and Marrowdale Depot.\n"));
    expect(first.code).toBe(2);
    const asked: string[] = [];
    const r = await plan(["--from-audit", "report.json", "-o", "out", "--accept-leaks"], { prompt: async (q) => (asked.push(q), null) });
    expect(r.code).toBe(0);
    expect(asked).toEqual([]);
    expect(r.out).toMatch(/accepted "Quillhaven Annex": added id entity \(source human\)/);
    expect(r.out).toMatch(/accepted "Marrowdale Depot": added id entity/);
    expect(r.out).toContain("undecided (3)");
    expect(savedSpec().entities.vocabulary).toBeUndefined();
    const second = await round("out2");
    expect(second.code).toBe(1);
    expect(readFileSync(join(dir, "out2", "visit.txt"), "utf8")).not.toMatch(/Quillhaven|Marrowdale/);
  });

  test("decided candidates are not raised again: the next round is clean", async () => {
    expect((await round("out")).code).toBe(1);
    expect((await plan(["--from-audit", "report.json", "-o", "out", "--accept", "c1=org,c3", "--reject", "c2"])).code).toBe(0);
    const second = await round("out2");
    expect(second.report.status).toBe("clean");
    expect(second.code).toBe(0);
  });
});

describe("convergence on the synthetic kit", () => {
  // Kit v1 (kit v2 is AGT-1753), with the reviewed spec made deliberately incomplete: every
  // person and organisation entity removed, and client_scope_code decided so no column stays a
  // declared unknown. A non-sensitive Title-Case agenda is added so the round has false
  // candidates to reject.
  test("run, accept every true candidate and reject the rest, run again: clean in two rounds, no oracle value left", async () => {
    const kit = generateKit();
    const kitDir = join(dir, "kit");
    writeKit(kitDir, kit);
    rmSync(join(dir, "in"), { recursive: true });
    const input = join(kitDir, "input");
    writeFileSync(join(input, "notes", "agenda.txt"), "Agenda for the Quarterly Planning Review in the Main Conference Room.\n");
    const spec = kitSpec();
    spec.columns = spec.columns.map((c) => (c.class === "unknown" ? { ...c, class: "id", treatment: "blind" } : c));
    spec.entities = {
      ...spec.entities,
      person: (spec.entities.person ?? []).map((e) => ({ ...e, aliases: e.aliases.filter((a) => !a.includes(" ")) })),
      org: (spec.entities.org ?? []).map((e) => ({ ...e, parts: [] })),
    };
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec), { mode: 0o600 });
    // Run the rounds on the kit's input.
    const roundOn = async (out: string) => {
      rmSync(join(dir, out), { recursive: true, force: true });
      expect((await apply([input, "-o", out])).code).toBe(0);
      const a = await audit([out, "--json", "--no-model"]);
      writeFileSync(join(dir, "report.json"), a.out);
      return { code: a.code, report: JSON.parse(a.out) as { status: string } };
    };

    const oracle = parseOracle(readFileSync(join(kitDir, "oracle.json"), "utf8"));
    const truth = new Map(oracle.values.map((v) => [v.value, v.class]));
    expect(PEOPLE.length + ORGS.length).toBeGreaterThan(0);

    let rounds = 0;
    let status = "";
    while (rounds < 5) {
      rounds++;
      const r = await roundOn(`out${rounds}`);
      status = r.report.status;
      if (status === "clean") break;
      const listed = JSON.parse((await plan(["--from-audit", "report.json", "-o", `out${rounds}`, "--json"])).out) as { candidates: Candidate[]; unmapped: unknown[]; other: unknown[] };
      expect(listed.unmapped).toEqual([]);
      expect(listed.other).toEqual([]);
      const accept = listed.candidates.filter((c) => truth.has(c.value)).map((c) => `${c.id}=${truth.get(c.value)}`);
      const reject = listed.candidates.filter((c) => !truth.has(c.value)).map((c) => c.id);
      expect(accept.length).toBeGreaterThan(0);
      expect(reject.length).toBeGreaterThan(0);
      const decided = await plan(["--from-audit", "report.json", "-o", `out${rounds}`, ...(accept.length ? ["--accept", accept.join(",")] : []), ...(reject.length ? ["--reject", reject.join(",")] : [])]);
      expect(decided.code).toBe(0);
    }
    expect(status).toBe("clean");
    expect(rounds).toBe(2);
    // The audit is not the only judge: no planted value survives in the final output.
    const { leaks, unscored } = scanLeaks(collectTree(join(dir, `out${rounds}`)), new OracleMatcher(oracle));
    expect(leaks).toEqual([]);
    expect(unscored).toEqual([]);
    // Every decision is recorded as the human's.
    const final = savedSpec();
    for (const cls of ["person", "org", "vocabulary"] as const) {
      const before = spec.entities[cls] ?? [];
      const after = final.entities[cls] ?? [];
      expect(after.slice(0, before.length)).toEqual(before);
      for (const e of after.slice(before.length)) expect(e.source).toBe("human");
    }
    expect((final.entities.vocabulary ?? []).map((e) => e.canonical)).toContain("Quarterly Planning Review");
    expect(existsSync(join(dir, ".blind", "spec.json.tmp"))).toBe(false);
  });
});
