// AGT-1940: `[pseudonyms] style` in blind.toml drives the CLI (apply, audit, reveal). Synthetic data only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { runApply } from "../src/apply.ts";
import { runAudit } from "../src/audit/command.ts";
import type { AuditReport } from "../src/audit/mechanical.ts";
import { generateKit, kitFileBytes } from "../src/bench/synth.ts";
import { defaultPolicy, POLICY_FILE, renderPolicy } from "../src/policy.ts";
import { runReveal } from "../src/reveal.ts";

const SPEC = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const NOTE = "Avery Quill said hi from 192.0.2.10.\n";
const READABLE = /\[[A-Z][A-Za-z ]*? [A-Z]{1,3} #[0-9A-F]{4}\]/;
const COMPACT = /Person_[0-9A-F]{4}/;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-fwd-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 9)), { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const policyText = (style: "readable" | "compact" | "absent"): string => {
  const t = renderPolicy({ ...defaultPolicy(), pseudonyms: { style: style === "readable" ? "readable" : "compact" } });
  return style === "absent" ? t.replace(/\[pseudonyms\][\s\S]*$/, "") : t;
};

async function cli(fn: typeof runApply, argv: string[]) {
  const out = new PassThrough();
  const err = new PassThrough();
  let o = "";
  out.on("data", (d) => (o += d));
  err.on("data", () => {});
  const code = await fn(argv, { out, err, cwd: dir } as never);
  return { code, out: o };
}

describe("[pseudonyms] style is forwarded to the engine", () => {
  const setup = (style: "readable" | "compact" | "absent", spec: unknown = SPEC) => {
    writeFileSync(join(dir, POLICY_FILE), policyText(style));
    writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec));
    mkdirSync(join(dir, "in"), { recursive: true });
    writeFileSync(join(dir, "in", "note.md"), NOTE);
  };

  test("readable writes a readable pseudonym, audits clean and reveals byte-exact", async () => {
    setup("readable");
    expect((await cli(runApply, ["in", "-o", "out"])).code).toBe(0);
    const text = readFileSync(join(dir, "out", "note.md"), "utf8");
    expect(text).toMatch(READABLE);
    expect(text).not.toMatch(COMPACT);
    const a = await cli(runAudit as never, ["out", "--json", "--no-model"]);
    const report = JSON.parse(a.out) as AuditReport;
    expect(a.code).toBe(0);
    expect(report.summary.leaks).toBe(0);
    expect(report.summary.candidates).toBe(0);
    expect((await cli(runReveal as never, ["out"])).code).toBe(0);
    expect(readFileSync(join(dir, ".blind", "revealed", "note.md"), "utf8")).toContain("Avery Quill said hi from");
  });

  for (const style of ["compact", "absent"] as const) {
    test(`${style} writes Person_XXXX`, async () => {
      setup(style);
      expect((await cli(runApply, ["in", "-o", "out"])).code).toBe(0);
      const text = readFileSync(join(dir, "out", "note.md"), "utf8");
      expect(text).toMatch(COMPACT);
      expect(text).not.toMatch(READABLE);
    });
  }

  test("kit 2 through apply, audit and reveal: readable is never worse than compact", async () => {
    const kit = generateKit(undefined, { version: 2 });
    const flow = async (style: "readable" | "compact") => {
      rmSync(join(dir, "in"), { recursive: true, force: true });
      rmSync(join(dir, "out"), { recursive: true, force: true });
      rmSync(join(dir, ".blind", "map.json"), { force: true });
      rmSync(join(dir, ".blind", "revealed"), { recursive: true, force: true });
      writeFileSync(join(dir, POLICY_FILE), policyText(style));
      writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(kit.spec));
      for (const f of kit.files) {
        const p = join(dir, "in", ...f.path.split("/"));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, kitFileBytes(f));
      }
      expect((await cli(runApply, ["in", "-o", "out"])).code).toBe(0);
      const a = await cli(runAudit as never, ["out", "--json", "--no-model"]);
      const report = JSON.parse(a.out) as AuditReport;
      expect((await cli(runReveal as never, ["out"])).code).toBe(0);
      return {
        code: a.code,
        status: report.status,
        leaks: report.summary.leaks,
        candidates: report.summary.candidates,
        accounts: readFileSync(join(dir, ".blind", "revealed", "accounts.csv"), "utf8"),
      };
    };
    const c = await flow("compact");
    const r = await flow("readable");
    expect(r).toEqual(c);
    expect(r.accounts).toBe(Buffer.from(kitFileBytes(kit.files.find((f) => f.path === "accounts.csv") as never)).toString("utf8"));
  }, 60_000);
});
