// AGT-2739: auditOutputs in the library entry. For the same blinded files, spec, map, blind.toml and salt
// its report is the one `blind audit --no-model --json` prints (the CLI is run here, in the test, never by
// the library); a value put back by hand is a leak; an Office file with no zip codec is never clean.
// Synthetic data only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { runAudit } from "../src/audit/command.ts";
import { generateKit, kitFileBytes } from "../src/bench/synth.ts";
import { redactEntry } from "../src/engine/redactlist.ts";
import {
  applySpec,
  auditOutputs,
  type AuditReport,
  type BlindMap,
  type BlindPolicy,
  InputError,
  NO_ZIP_CODEC_REASON,
  type InputFile,
  PolicyError,
  serializeMap,
  setZipCodec,
  type Spec,
  type ZipCodec,
  zipCodec,
} from "../src/lib.ts";
import { parsePolicy, POLICY_FILE } from "../src/policy.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-libaudit-"));
  mkdirSync(join(dir, ".blind"), { mode: 0o700 });
  writeFileSync(join(dir, ".blind", "salt"), SALT, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const kit = generateKit(undefined, { version: 2 });
const kitFiles = (): InputFile[] => kit.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) }));

/** Writes the blinded files, spec, map and blind.toml, and runs `blind audit out --no-model --json`. */
async function cliAudit(files: readonly InputFile[], spec: Spec, map: BlindMap, toml: string | null): Promise<{ code: number; report: AuditReport }> {
  for (const f of files) {
    const p = join(dir, "out", ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  writeFileSync(join(dir, ".blind", "spec.json"), JSON.stringify(spec));
  writeFileSync(join(dir, ".blind", "map.json"), serializeMap(map), { mode: 0o600 });
  if (toml !== null) writeFileSync(join(dir, POLICY_FILE), toml);
  const out = new PassThrough();
  const err = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  err.resume();
  const code = await runAudit(["out", "--no-model", "--json"], { out, err, cwd: dir });
  return { code, report: JSON.parse(Buffer.concat(chunks).toString("utf8")) as AuditReport };
}

const EXIT = { clean: 0, candidates: 1, leak: 2 } as const;

/** Blinds `inputs` with the library, then audits the output both ways and expects the same report. */
async function compare(inputs: InputFile[], spec: Spec, toml: string | null, edit?: (outputs: InputFile[]) => InputFile[], policy?: BlindPolicy): Promise<AuditReport> {
  const blinded = applySpec(inputs, spec, { salt: SALT, policy });
  const outputs = edit === undefined ? blinded.outputs : edit(blinded.outputs);
  const cli = await cliAudit(outputs, spec, blinded.map, toml);
  const lib = auditOutputs(outputs, spec, blinded.map, { policy, salt: SALT });
  expect(lib).toEqual(cli.report);
  expect(cli.code).toBe(EXIT[lib.status]);
  return lib;
}

const MODELS = '[models.analyst]\nbackend = "openai-compatible"\nurl = ""\nmodel = ""\nkey_env = ""\n';
const toml = (extra: string): string =>
  `[sensitive]\nclasses = ["person", "org", "host", "email", "id", "location", "secret"]\ndescription = "d"\nexamples = []\n${MODELS}[profile]\n[privacy]\nmode = "local-only"\n${extra}`;

describe("auditOutputs equals `blind audit --no-model --json` on the same blinded files", () => {
  test("the synthetic kit, no blind.toml", async () => {
    const r = await compare(kitFiles(), kit.spec, null);
    expect(r.layers).toEqual(["mechanical", "semantic"]);
    expect(r.modelLayer).toEqual({ status: "skipped", host: null, reason: "--no-model" });
    expect(r.summary.files).toBe(kit.files.length);
  });

  test("the synthetic kit with keep terms, placeholders off and pattern switches", async () => {
    const policy: BlindPolicy = { keep: { terms: ["example.test", "North"], placeholders: false }, patterns: { phone: true, ip: false } };
    const text = toml('[keep]\nterms = ["example.test", "North"]\nplaceholders = false\n[patterns]\nphone = true\nip = false\n');
    // The object is what blind.toml says, by blind.toml's own reading.
    expect(parsePolicy(text)).toMatchObject(policy);
    const r = await compare(kitFiles(), kit.spec, text, undefined, policy);
    // The settings change the report: it is not the one with no blind.toml.
    expect(r).not.toEqual(auditOutputs(applySpec(kitFiles(), kit.spec, { salt: SALT }).outputs, kit.spec, applySpec(kitFiles(), kit.spec, { salt: SALT }).map));
  });

  test("the synthetic kit with one original value put back by hand", async () => {
    const value = kit.spec.entities.person?.[0]?.canonical as string;
    const r = await compare(kitFiles(), kit.spec, null, (outs) => [...outs, { path: "notes/added.txt", bytes: new TextEncoder().encode(`Signed off by ${value}.\n`) }]);
    expect(r.status).toBe("leak");
    expect(r.files.find((f) => f.path === "notes/added.txt")?.status).toBe("leak");
  });

  test("a spec with values to redact: the salt checks the output for them", async () => {
    const spec: Spec = { ...kit.spec, redact: [redactEntry(SALT, "Zq-synthetic-secret-77")] };
    const r = await compare(kitFiles(), spec, null, (outs) => [...outs, { path: "leak.txt", bytes: new TextEncoder().encode("code Zq-synthetic-secret-77\n") }]);
    expect(r.files.find((f) => f.path === "leak.txt")?.status).toBe("leak");
  });
});

const SPEC: Spec = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "name", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "email", class: "email", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "team", class: "vocabulary", treatment: "keep", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }, { canonical: "Rowan Pike", aliases: [], parts: ["Rowan", "Pike"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
} as Spec;
const CSV = "name,email,team\nAvery Quill,avery.quill@example-corp.test,North\nRowan Pike,rowan.pike@example-corp.test,South\n";

describe("a blinded CSV", () => {
  test("has no leak; with one original value put back by hand it is a leak", async () => {
    const r = applySpec([{ path: "staff.csv", bytes: new TextEncoder().encode(CSV) }], SPEC, { salt: SALT });
    expect(auditOutputs(r.outputs, SPEC, r.map).summary.leaks).toBe(0);
    const text = new TextDecoder().decode(r.outputs[0]?.bytes);
    const pseudonym = r.map.entries.find((e) => e.value === "Rowan Pike")?.pseudonym as string;
    expect(text).toContain(pseudonym);
    const edited = [{ path: "staff.csv", bytes: new TextEncoder().encode(text.replace(pseudonym, "Rowan Pike")) }];
    const report = auditOutputs(edited, SPEC, r.map);
    expect(report.status).toBe("leak");
    expect(report.files[0]?.findings.some((f) => f.severity === "leak" && f.masked.startsWith("Ro"))).toBe(true);
    // The value itself is never in the report.
    expect(JSON.stringify(report)).not.toContain("Rowan Pike");
    // The same report the CLI prints for that file.
    expect(report).toEqual((await cliAudit(edited, SPEC, r.map, null)).report);
  });
});

/** A one-member zip whose member is deflated (method 8). The audit's reader does not check the CRC, so it is left 0. */
function deflatedZip(name: string, text: string): Uint8Array {
  const n = new TextEncoder().encode(name);
  const raw = new TextEncoder().encode(text);
  const data = new Uint8Array(deflateRawSync(raw));
  const local = new Uint8Array(30 + n.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, n.length, true);
  local.set(n, 30);
  const cen = new Uint8Array(46 + n.length);
  const cv = new DataView(cen.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, n.length, true);
  cv.setUint32(42, 0, true);
  cen.set(n, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cen.length, true);
  ev.setUint32(16, local.length + data.length, true);
  const out = new Uint8Array(local.length + data.length + cen.length + eocd.length);
  out.set(local, 0);
  out.set(data, local.length);
  out.set(cen, local.length + data.length);
  out.set(eocd, local.length + data.length + cen.length);
  return out;
}

describe("inputs and options", () => {
  const map: BlindMap = { version: 1, entries: [] } as unknown as BlindMap;
  const f = (path: string): InputFile => ({ path, bytes: new TextEncoder().encode("x\n") });

  test("a bad or repeated path is refused", () => {
    for (const bad of [[f("a.txt"), f("a.txt")], [f("/a.txt")], [f("a//b.txt")], [f("../a.txt")], [f("./a.txt")], [f("")], [f("a"), f("a/b.txt")]]) {
      expect(() => auditOutputs(bad, SPEC, map)).toThrow(InputError);
    }
  });

  test("directories above a file are audited by name, as the CLI walks them", () => {
    const r = auditOutputs([f("Avery Quill/notes.txt")], SPEC, map);
    expect(r.files.find((x) => x.path === "Avery Quill")?.kind).toBe("dir");
    expect(r.status).toBe("leak");
    expect(r.summary.files).toBe(1);
  });

  test("an invalid policy is refused by blind.toml's rules", () => {
    expect(() => auditOutputs([f("a.txt")], SPEC, map, { policy: { keep: { terms: "North" } } as unknown as BlindPolicy })).toThrow(PolicyError);
  });

  test("with no zip codec a deflated archive member is reported unread, never clean", () => {
    const book = { path: "book.xlsx", bytes: deflatedZip("xl/sharedStrings.xml", "<sst><si><t>Quarterly</t></si></sst>") };
    expect(auditOutputs([book], SPEC, map).status).toBe("clean");
    const saved: ZipCodec | null = zipCodec();
    setZipCodec(null);
    try {
      const report = auditOutputs([book], SPEC, map);
      expect(report.status).toBe("candidates");
      expect(report.files[0]?.findings.some((x) => x.class === "unscanned" && x.part === "xl/sharedStrings.xml" && x.reason.includes(NO_ZIP_CODEC_REASON))).toBe(true);
    } finally {
      setZipCodec(saved);
    }
  });
});
