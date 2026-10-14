// AGT-1934: the readable pseudonym format end to end on synthetic kit 2. The CLI does not forward
// `[pseudonyms] style` yet (AGT-1931), so this drives the engine (applySpec with pseudonymStyle
// "readable"), the audit command (runAudit) and the reveal engine (Revealer, revealFile).
//
// Deviation from the ticket's literal ACs (orchestrator decision): on kit 2 an audit exit 0 and a
// byte-exact reveal of every file are unattainable in COMPACT mode too (the kit plants a secret-shaped
// decoy the audit flags; context-keyword redaction is irreversible; reveal restores aliases to the
// recorded canonical form). So AC2 asserts the readable audit is never worse than compact, and AC3
// asserts byte-exact reveal wherever compact is, and readable == compact reveal everywhere else.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAudit } from "../../src/audit/command.ts";
import type { AuditReport } from "../../src/audit/mechanical.ts";
import { generateKit, kitFileBytes, writeKit } from "../../src/bench/synth.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { writeMap } from "../../src/engine/map.ts";
import { Revealer, revealFile } from "../../src/engine/reveal.ts";
import { BLIND_DIR } from "../../src/init.ts";
import { defaultPolicy, POLICY_FILE, renderPolicy } from "../../src/policy.ts";
import { readZip } from "../formats/zipfixture.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const SALT_2 = Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + 5) & 0xff);
// `[Client A #7F3A]`: label words, letters, 4 hex.
const READABLE = /\[[A-Z][A-Za-z ]*? [A-Z]{1,3} #[0-9A-F]{4}\]/g;
const unxml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

class Capture {
  text = "";
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

const kit = generateKit(undefined, { version: 2 });
const policy = defaultPolicy();
const inputs: InputFile[] = kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) }));
const run = (salt: Uint8Array, map?: ApplyResult["map"], style: "readable" | "compact" = "readable"): ApplyResult =>
  applySpec(inputs, kit.spec, { salt, map, keep: policy.keep.terms, placeholders: policy.keep.placeholders, context: policy.context, columns: policy.defaults.columns, pseudonymStyle: style });

let ws: string;
let first: ApplyResult;

beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "blind-readable-"));
  first = run(SALT);
  writeFileSync(join(ws, POLICY_FILE), renderPolicy(policy));
  mkdirSync(join(ws, BLIND_DIR), { recursive: true });
  writeFileSync(join(ws, BLIND_DIR, "spec.json"), `${JSON.stringify(kit.spec, null, 2)}\n`);
  writeMap(join(ws, BLIND_DIR, "map.json"), first.map);
  for (const o of first.outputs) {
    const p = join(ws, "out", ...o.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, o.bytes);
  }
});
afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe("readable pseudonyms on synthetic kit 2", () => {
  test("applies the kit's spec to every file, writing readable forms", () => {
    expect(first.skipped).toEqual([]);
    expect(first.outputs.length).toBe(inputs.length);
    const all = first.outputs.map((o) => dec(o.bytes)).join("\n");
    expect(all.match(READABLE)?.length ?? 0).toBeGreaterThan(0);
  });

  const auditOf = async (r: ApplyResult, tag: string) => {
    const d = mkdtempSync(join(tmpdir(), `blind-readable-${tag}-`));
    try {
      writeFileSync(join(d, POLICY_FILE), renderPolicy(policy));
      mkdirSync(join(d, BLIND_DIR), { recursive: true });
      writeFileSync(join(d, BLIND_DIR, "spec.json"), `${JSON.stringify(kit.spec, null, 2)}\n`);
      writeMap(join(d, BLIND_DIR, "map.json"), r.map);
      for (const o of r.outputs) {
        const p = join(d, "out", ...o.path.split("/"));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, o.bytes);
      }
      const out = new Capture();
      const code = await runAudit(["out", "--json", "--no-model"], { out: out as unknown as NodeJS.WritableStream, err: new Capture() as unknown as NodeJS.WritableStream, cwd: d });
      const report = JSON.parse(out.text) as AuditReport;
      const leaks = report.files.flatMap((f) => f.findings.filter((x) => x.severity === "leak"));
      return { code, report, leaks, shape: leaks.map((l) => `${l.file} ${l.class} ${l.source}`).sort() };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };

  test("the audit of the readable output is never worse than compact's, and leaks only the planted decoy", async () => {
    const compact = run(SALT, undefined, "compact");
    const [r, c] = [await auditOf(first, "r"), await auditOf(compact, "c")];
    expect(r.code).toBe(c.code);
    expect(r.report.status).toBe(c.report.status);
    expect(r.shape).toEqual(c.shape);
    expect(r.report.summary.leaks).toBe(c.report.summary.leaks);
    expect(r.report.summary.candidates).toBe(c.report.summary.candidates);
    expect(r.shape).toEqual(["meetings/renewal-call.docx pattern:secret pattern", "meetings/renewal-call.vtt pattern:secret pattern"]);
    for (const l of r.leaks) expect(JSON.stringify(l)).not.toMatch(READABLE);
  }, 30_000);

  test("reveal is byte-exact where compact's is, and readable's reveal equals compact's elsewhere", () => {
    const compact = run(SALT, undefined, "compact");
    const reveal = (res: ApplyResult, path: string): Uint8Array => {
      const out = res.outputs.find((o) => o.path === (res.files.find((f) => f.path === path)?.outputPath as string)) as InputFile;
      return revealFile(out.path, out.bytes, new Revealer(res.map)).bytes;
    };
    const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
    const exact: string[] = [];
    for (const input of inputs) {
      const cr = reveal(compact, input.path);
      const rr = reveal(first, input.path);
      if (same(cr, input.bytes)) {
        exact.push(input.path);
        expect({ path: input.path, same: same(rr, input.bytes) }).toEqual({ path: input.path, same: true });
      } else {
        expect({ path: input.path, same: same(rr, cr) }).toEqual({ path: input.path, same: true });
      }
    }
    for (const p of ["accounts.csv", "exports/scopes.json", "sync.log"]) expect(exact).toContain(p);
    // The container log differs from its input only by the context-keyword redactions.
    const log = inputs.find((i) => i.path === "logs/agent-container.log") as InputFile;
    const want = dec(log.bytes).replace(/(in account )\d{12}/g, "$1REDACTED");
    expect(dec(reveal(first, log.path))).toBe(want);
    // Names come back too.
    for (const input of inputs) expect(new Revealer(first.map).path(first.files.find((f) => f.path === input.path)?.outputPath as string).text).toBe(input.path);
  });

  test("no readable form appears in a file or folder name, an XLSX name or a URL", () => {
    const bad = (s: string): boolean => new RegExp(READABLE.source).test(s) || / #[0-9A-F]{4}\b/.test(s);
    for (const o of first.outputs) {
      expect({ name: o.path, bad: bad(o.path) }).toEqual({ name: o.path, bad: false });
      const isZip = /\.(xlsx|docx)$/.test(o.path);
      const parts = isZip ? readZip(o.bytes).map((e) => ({ name: e.name, text: unxml(e.text) })) : [{ name: "", text: dec(o.bytes) }];
      for (const p of parts) {
        expect({ file: o.path, member: p.name, bad: bad(p.name) }).toEqual({ file: o.path, member: p.name, bad: false });
        for (const url of p.text.match(/(?:https?|ftp|file):\/\/[^\s"'<>]+/gi) ?? []) expect({ file: o.path, member: p.name, url, bad: /[\[\]]|%5B|%23|#/i.test(url) }).toEqual({ file: o.path, member: p.name, url, bad: false });
        if (p.name === "xl/workbook.xml") {
          const names = [...p.text.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1] as string);
          const defined = [...p.text.matchAll(/<definedName\b[^>]*\bname="([^"]*)"/g)].map((m) => m[1] as string);
          expect(names.length).toBeGreaterThan(0);
          for (const n of [...names, ...defined]) expect({ file: o.path, n, bad: bad(n) }).toEqual({ file: o.path, n, bad: false });
        }
        if (p.name === "docProps/app.xml") {
          for (const m of p.text.matchAll(/<vt:lpstr>([^<]*)<\/vt:lpstr>/g)) expect({ file: o.path, member: p.name, n: m[1], bad: bad(m[1] as string) }).toEqual({ file: o.path, member: p.name, n: m[1], bad: false });
        }
      }
    }
  });

  test("a second apply with the written map is byte-identical", () => {
    // A different salt: every pseudonym comes from the map, so the letters and tags stay.
    const again = run(SALT_2, first.map);
    expect(again.outputs.map((o) => o.path)).toEqual(first.outputs.map((o) => o.path));
    for (const [i, o] of first.outputs.entries()) {
      const other = again.outputs[i] as InputFile;
      expect({ path: o.path, same: Buffer.from(other.bytes).equals(Buffer.from(o.bytes)) }).toEqual({ path: o.path, same: true });
    }
    expect(again.map).toEqual(first.map);
  });

  test("a role label from a column header appears in the CSV output", () => {
    const csv = first.outputs.filter((o) => o.path.endsWith(".csv")).map((o) => dec(o.bytes)).join("\n");
    const labels = new Set([...csv.matchAll(/\[([A-Z][A-Za-z ]*?) [A-Z]{1,3} #[0-9A-F]{4}\]/g)].map((m) => m[1] as string));
    const roles = [...labels].filter((l) => !["Person", "Org", "Id", "Value", "Place"].includes(l));
    expect({ labels: [...labels], roles: roles.length > 0 }).toEqual({ labels: [...labels], roles: true });
  });
});
