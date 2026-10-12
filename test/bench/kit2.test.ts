// Synthetic kit v2: its files have the shapes the ticket names, its oracle lists every planted value
// with class and scope, kit v1 stays byte-identical, and `blind bench` passes it with the kit's spec
// (leaks 0, damage 0, honesty 0) while scoring the damage and leaks a wrong spec causes.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BenchReport, REPORT_FILE, runBench } from "../../src/bench/command.ts";
import { ACCESS_XLSX, CALL_DOCX, CALL_VTT, CLOUD_DOMAIN, CONTAINER_LOG, CONTENTS_SHEET, SCOPES_JSON } from "../../src/bench/kit2.ts";
import { COLUMNS, DEFAULT_SEED, generateKit, type Kit, type KitFile, kitFileBytes, writeKit } from "../../src/bench/synth.ts";
import { applySpec } from "../../src/engine/apply.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import type { Spec } from "../../src/schema.ts";
import { parseSpec } from "../../src/validate.ts";
import { readZip } from "../formats/zipfixture.ts";

const digest = (x: unknown): string => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (v: string, flags = "u") => new RegExp(`(?<![\\p{L}\\p{N}])${escape(v)}(?![\\p{L}\\p{N}])`, flags);
const unxml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** A file's readable text: the text itself, or every zip member's XML, and its text with runs joined, entities undone. */
function readable(f: KitFile, joinRuns = true): string {
  if (f.text !== undefined) return f.text;
  return readZip(f.bytes as Uint8Array)
    .flatMap((e) => (joinRuns ? [e.text, e.text.replace(/<\/w:p>/g, "\n").replace(/<[^>]*>/g, "")] : [e.text]).map(unxml))
    .join("\n");
}

const kit = generateKit(DEFAULT_SEED, { version: 2 });
const file = (k: Kit, path: string): KitFile => k.files.find((f) => f.path === path) as KitFile;

describe("kit v1 stays byte-identical for its seed", () => {
  // Pinned before kit v2 existed (main at 8ed3169). A change here changes every v1 kit.
  const V1: [number, Parameters<typeof generateKit>[1], string][] = [
    [1739, {}, "f7007cf34d5e8ff19a893496a530a8c1bb1e973e092d32e92a43eb1a8f4ce498"],
    [42, { rows: 30 }, "48e3f14267b63334f294a26845646424635694d3e0714dc67cbee662db2ca1c0"],
    [1739, { recurInProse: true }, "192ce31f64355b524c0f483113d74c8bd9ad91afde53186ca49b678f5952a542"],
    [7, { rows: 200 }, "b0ae6135f135d585bd7515be61e38bc04d9c9975e828743cd9c52551f32d20f4"],
  ];
  test("files, oracle and spec match the digests pinned before v2", () => {
    for (const [seed, opts, want] of V1) {
      const k = generateKit(seed, opts);
      expect({ seed, opts, d: digest({ files: k.files, oracle: k.oracle, spec: k.spec }) }).toEqual({ seed, opts, d: want });
      expect(digest(generateKit(seed, { ...opts, version: 1 }))).toBe(digest(k));
    }
  });

  test("kit v2 holds kit v1's files byte for byte", () => {
    for (const seed of [DEFAULT_SEED, 3, 77]) {
      const v1 = generateKit(seed);
      const v2 = generateKit(seed, { version: 2 });
      for (const f of v1.files) expect(file(v2, f.path)).toEqual(f);
      expect(v2.files.length).toBe(v1.files.length + 5);
    }
  });

  test("an unknown version is refused", () => {
    expect(() => generateKit(1, { version: 3 as unknown as 1 })).toThrow(RangeError);
  });
});

describe("synthetic kit v2", () => {
  test("is deterministic for a seed, binary files included, and differs across seeds", () => {
    const again = generateKit(DEFAULT_SEED, { version: 2 });
    expect(digest(again)).toBe(digest(kit));
    for (const p of [ACCESS_XLSX, CALL_DOCX]) expect(Buffer.from(kitFileBytes(file(again, p))).equals(Buffer.from(kitFileBytes(file(kit, p))))).toBe(true);
    expect(digest(generateKit(8, { version: 2 }))).not.toBe(digest(generateKit(9, { version: 2 })));
  });

  test("every oracle value has a class and a scope, and is written in each file its scope names", () => {
    expect(kit.oracle.version).toBe(2);
    const text = Object.fromEntries(kit.files.map((f) => [f.path, readable(f)]));
    for (const v of kit.oracle.values) {
      expect(["person", "org", "host", "email", "id"]).toContain(v.class);
      expect(v.scope?.length ?? 0).toBeGreaterThan(0);
      expect([...new Set(v.scope?.map((s) => s.file))].sort()).toEqual(v.files);
      for (const f of v.files) expect({ v: v.value, f, found: wholeWord(v.value).test(text[f] as string) }).toEqual({ v: v.value, f, found: true });
    }
  });

  test("the oracle lists each v2 shape with its scope", () => {
    const scoped = (where: string, file?: string) => kit.oracle.values.filter((v) => v.scope?.some((s) => s.where === where && (file === undefined || s.file === file)));
    const ip = scoped("orphaned shared string");
    expect(ip.map((v) => v.class)).toEqual(["host"]);
    expect(ip[0]?.value).toMatch(/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/);
    expect(scoped("pivot cache").length).toBeGreaterThan(4);
    expect(scoped("sheet name").map((v) => v.class)).toEqual(["org"]);
    expect(scoped("registry host label").map((v) => v.class)).toEqual(["id"]);
    expect(scoped("speaker", CALL_DOCX).map((v) => v.value)).toEqual(scoped("speaker", CALL_VTT).map((v) => v.value));
    for (const k of ["scope_id", "account_no", "org_name", "owner_email", "tenant_host"]) expect(scoped(`key path $.scopes[*].${k}`).length).toBeGreaterThan(0);
    expect(scoped("sheet Access, column Path").every((v) => v.class === "id" && /\/svc-[a-z]+-[a-z]+$/.test(v.value))).toBe(true);
    // Ground truth for every column and key path the v2 files have.
    expect(kit.oracle.columns.filter((c) => c.file === ACCESS_XLSX).length).toBe(11);
    expect(kit.oracle.columns.filter((c) => c.jsonPath !== undefined).length).toBe(9);
  });

  test("the workbook has a Contents sheet, identity columns, a Path column, an orphaned IP string and a pivot cache", () => {
    const bytes = kitFileBytes(file(kit, ACCESS_XLSX));
    const wb = readWorkbook(bytes);
    const [contents, access, orgSheet] = wb.sheets;
    expect(contents?.name).toBe(CONTENTS_SHEET);
    expect(sheetRows(contents!, wb.sharedStrings).map((r) => r[0])).toEqual(["Sheet", "Access", orgSheet?.name]);
    const rows = sheetRows(access!, wb.sharedStrings);
    expect(rows[0]).toEqual(["User", "Booked Under", "Email", "Employee No", "Path", "Role", "Last Login"]);
    // An organisation column under a header kit v1 never uses.
    expect(COLUMNS.map((c) => c.header)).not.toContain("Booked Under");
    expect(rows.slice(1).every((r) => /^\/var\/lib\/tenanthub\/home\/svc-[a-z]+-[a-z]+$/.test(r[4] as string) && /^1\d{3}$/.test(r[3] as string))).toBe(true);
    // The orphan: a shared string no cell refers to, holding an IP address.
    const used = new Set(wb.sheets.flatMap((s) => s.cells.filter((c) => c.type === "s").map((c) => Number(c.v))));
    const orphans = wb.sharedStrings.map((s, i) => ({ i, text: s.runs.join("") })).filter((s) => !used.has(s.i));
    expect(orphans.map((o) => /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(o.text))).toEqual([true]);
    const members = readZip(bytes).map((m) => m.name);
    expect(members).toContain("xl/pivotCache/pivotCacheDefinition1.xml");
    expect(members).toContain("xl/pivotCache/pivotCacheRecords1.xml");
    expect(wb.definedNames).toEqual([`${orgSheet?.name}_Total`]);
  });

  test("the meeting is a Teams transcript as DOCX and the same meeting as WebVTT", () => {
    const empty: Spec = { version: 1, columns: [], entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: true }, questions: [] };
    const r = applySpec(
      [CALL_DOCX, CALL_VTT].map((p) => ({ path: p, bytes: kitFileBytes(file(kit, p)) })),
      empty,
      { salt: new Uint8Array(32) },
    );
    expect(r.skipped).toEqual([]);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f.transcript]));
    expect(by[CALL_DOCX]?.kind).toBe("docx");
    expect(by[CALL_VTT]?.kind).toBe("vtt");
    expect(by[CALL_DOCX]?.speakerTags).toBe(by[CALL_VTT]?.speakerTags as number);
    const vtt = file(kit, CALL_VTT).text as string;
    const vttTurns = [...vtt.matchAll(/<v ([^>]+)>([^<]*)<\/v>/g)].map((m) => `${m[1]}|${m[2]}`);
    const doc = readZip(kitFileBytes(file(kit, CALL_DOCX))).find((e) => e.name === "word/document.xml")?.text as string;
    const paras = [...doc.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((m) => [...(m[1] as string).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => unxml(t[1] as string)).join(""));
    const docTurns = [];
    for (let i = 1; i < paras.length; i += 2) docTurns.push(`${(paras[i] as string).replace(/ {3}\d+:\d{2}$/, "")}|${paras[i + 1]}`);
    expect(docTurns).toEqual(vttTurns);
    expect(doc).toMatch(/<w:p><w:r><w:t>[^<]{4}<\/w:t><\/w:r><w:r><w:t>/); // a speaker name split across runs
  });

  test("the JSON scope list has snake_case keys, hex IDs and 4-digit IDs written as strings", () => {
    const doc = JSON.parse(file(kit, SCOPES_JSON).text as string) as { scopes: Record<string, unknown>[] };
    const keys = new Set(doc.scopes.flatMap((s) => Object.keys(s)));
    expect([...keys].every((k) => /^[a-z]+(?:_[a-z]+)+$/.test(k))).toBe(true);
    expect(doc.scopes.every((s) => typeof s.scope_id === "string" && /^(?=.*\d)(?=.*[a-f])[0-9a-f]{8}$/.test(s.scope_id))).toBe(true);
    expect(doc.scopes.every((s) => typeof s.account_no === "string" && /^\d{4}$/.test(s.account_no))).toBe(true);
  });

  test("the container log carries the cloud account ID inside a vendor host, and on its own", () => {
    const log = file(kit, CONTAINER_LOG).text as string;
    const m = new RegExp(`\\b(\\d{12})\\.dkr\\.${escape(CLOUD_DOMAIN)}/`).exec(log);
    expect(m).not.toBeNull();
    expect(log).toContain(`in account ${m?.[1]}\n`);
    expect(kit.spec.entities.id).toEqual([{ canonical: m?.[1] as string, aliases: [], parts: [] }]);
  });

  test("is synthetic only: .example hosts and email domains, RFC 5737 addresses, in every file and part", () => {
    const all = kit.files.map((f) => readable(f, false)).join("\n").replace(/xmlns(?::\w+)?="[^"]*"|(?:Type|ContentType)="[^"]*"|http:\/\/schemas\.[^"\s<]*|http:\/\/purl\.org[^"\s<]*|http:\/\/www\.w3\.org[^"\s<]*/g, "");
    for (const host of all.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/g) ?? []) expect(host).toMatch(/\.example$/);
    for (const ip of all.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) expect(ip).toMatch(/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./);
  });

  test("the spec is valid and writeKit writes the binary files as built", () => {
    const dir = mkdtempSync(join(tmpdir(), "blind-kit2-"));
    try {
      writeKit(dir, kit);
      expect(parseSpec(readFileSync(join(dir, "spec.json"), "utf8"))).toEqual(kit.spec);
      for (const f of kit.files) expect(Buffer.from(readFileSync(join(dir, "input", ...f.path.split("/")))).equals(Buffer.from(kitFileBytes(f)))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class Sink {
  text = "";
  write(s: string): boolean {
    this.text += s;
    return true;
  }
}

async function bench(edit?: (s: Spec) => void, seed = DEFAULT_SEED): Promise<{ code: number; err: string; report: BenchReport }> {
  const dir = mkdtempSync(join(tmpdir(), "blind-kit2-bench-"));
  try {
    const k = generateKit(seed, { version: 2 });
    edit?.(k.spec);
    writeKit(dir, k);
    const out = new Sink();
    const err = new Sink();
    const code = await runBench([dir], { out: out as unknown as NodeJS.WritableStream, err: err as unknown as NodeJS.WritableStream, cwd: dir });
    const path = join(dir, REPORT_FILE);
    expect(existsSync(path)).toBe(true);
    return { code, err: err.text, report: JSON.parse(readFileSync(path, "utf8")) as BenchReport };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Each test runs apply and audit on the whole kit in process; give them room on a loaded machine.
const BENCH_TIMEOUT = 30_000;

describe("blind bench on kit v2", () => {
  test.each([DEFAULT_SEED, 42])("the kit's spec passes (seed %d): leaks 0, honesty 0, damage 0, every file written and scored", async (seed) => {
    const r = await bench(undefined, seed);
    expect(r.err).toBe("");
    expect({ seed, code: r.code, result: r.report.result }).toEqual({ seed, code: 0, result: "pass" });
    const rep = r.report;
    expect({ leaks: rep.leaks.items, damage: rep.damage.items, honesty: rep.honesty.items, unscored: rep.unscored, notWritten: rep.apply.notWritten }).toEqual({
      leaks: [],
      damage: [],
      honesty: [],
      unscored: [],
      notWritten: [],
    });
    expect(rep.kit).toMatchObject({ version: 2, seed, files: 9 });
    expect(rep.audit.leaks).toBe(0);
  }, BENCH_TIMEOUT);

  test("a wrong spec is scored: damage in a DOCX paragraph, a worksheet name and JSON values", async () => {
    const r = await bench((s) => {
      // A reviewer's mistakes: the meeting title and the sheet list taken for organisations, and no rule for a date key.
      s.entities.org = [...(s.entities.org ?? []), { canonical: "Renewal call", aliases: [], parts: [] }, { canonical: CONTENTS_SHEET, aliases: [], parts: [] }];
      s.columns = s.columns.filter((c) => c.jsonPath !== "$.scopes[*].granted_on");
    });
    expect(r.code).toBe(1);
    expect(r.report.leaks.count).toBe(0);
    const kinds = new Set(r.report.damage.items.map((d) => `${d.kind} ${d.file} ${d.where.replace(/\d+/g, "N")}`));
    expect(kinds).toContain(`paragraph ${CALL_DOCX} paragraph N`);
    expect(kinds).toContain(`rename ${ACCESS_XLSX} sheet N name`);
    expect(kinds).toContain(`cell ${SCOPES_JSON} value N of $.scopes[*].granted_on`);
  }, BENCH_TIMEOUT);

  test("a forgotten rule or entity leaks from the v2 files", async () => {
    const r = await bench((s) => {
      delete s.entities.id;
      const path = s.columns.find((c) => c.header === "Path");
      if (path) Object.assign(path, { class: "vocabulary", treatment: "keep" });
    });
    expect(r.code).toBe(1);
    const where = new Set(r.report.leaks.items.map((l) => `${l.file} ${l.part} ${l.class}`));
    expect(where).toEqual(new Set([`${CONTAINER_LOG}  id`, `${ACCESS_XLSX} xl/sharedStrings.xml id`, `${ACCESS_XLSX} xl/sharedStrings.xml org`]));
  }, BENCH_TIMEOUT);
});

// AGT-1805: a Teams cue GUID is replaced with a GUID drawn from the salt, and a 4-character group
// of it could come out all digits and equal a real 4-digit ID elsewhere in the corpus, which then
// reads as that ID left in the output. The Pseudonymizer now rejects GUID candidates whose groups
// equal an avoided value, as it does for numeric IDs (AGT-1785).
test("GUID pseudonyms never reproduce a real 4-digit ID of the corpus as one of their groups", () => {
  const v1 = generateKit(DEFAULT_SEED);
  const ids = new Set(v1.oracle.values.filter((v) => v.class === "id" && /^\d{4}$/.test(v.value)).map((v) => v.value));
  const hex = (n: number, i: number) => createHash("sha256").update(`cue ${i}`).digest("hex").slice(0, n);
  const vtt = `WEBVTT\n\n${Array.from({ length: 60 }, (_, i) => `${hex(8, i)}-${hex(4, i + 100)}-4${hex(3, i + 200)}-8${hex(3, i + 300)}-${hex(12, i + 400)}/${i + 10}-0\n00:00:${String(i % 60).padStart(2, "0")}.000 --> 00:00:${String(i % 60).padStart(2, "0")}.500\n<v Marisol Penhallow>Next item.</v>`).join("\n\n")}\n`;
  const inputs = [...v1.files.map((f) => ({ path: f.path, bytes: kitFileBytes(f) })), { path: CALL_VTT, bytes: new TextEncoder().encode(vtt) }];
  const collisions: number[] = [];
  for (let salt = 0; salt < 200; salt++) {
    const r = applySpec(inputs, v1.spec, { salt: Uint8Array.from({ length: 32 }, (_, i) => (salt * 31 + i) & 0xff) });
    const out = new TextDecoder().decode(r.outputs.find((o) => o.path === CALL_VTT)?.bytes);
    const groups = [...out.matchAll(/\b[0-9a-f]{8}-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-[0-9a-f]{12}\b/gi)].flatMap((m) => [m[1], m[2], m[3]]);
    if (groups.some((g) => ids.has(g as string))) collisions.push(salt);
  }
  expect(collisions).toEqual([]);
});
