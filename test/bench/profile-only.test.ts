// profile-only is the "model never sees a value" mode (AGT-1832), checked on kit v2: every CSV,
// XLSX, DOCX, JSON, VTT and log shape the bench knows. Whatever reaches a model under profile-only,
// through `blind plan` and the auditor's path, must carry no cell value, no header and no key: the
// only strings left in the profile are counter tokens and file-format names. Kit v2 is invented
// data; nothing here leaves the process (fetch is injected).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runPlan } from "../../src/analyst/plan.ts";
import { DEFAULT_SEED, generateKit, kitFileBytes, writeKit } from "../../src/bench/synth.ts";
import { parseCsv } from "../../src/engine/csv.ts";
import { readWorkbook, sheetRows } from "../../src/formats/xlsx.ts";
import { type AskOptions, assertProfilePayload, profilePayload } from "../../src/model.ts";
import { defaultPolicy, renderPolicy } from "../../src/policy.ts";
import { buildProfile, forPrivacyMode } from "../../src/profile/profile.ts";
import { tokeniseProfile } from "../../src/profile/tokens.ts";
import type { Profile, Spec } from "../../src/schema.ts";
import { parseSpec } from "../../src/validate.ts";

const kit = generateKit(DEFAULT_SEED, { version: 2 });

/** Every cell of every CSV and worksheet, every JSON leaf, and every planted value the oracle lists. */
function cellValues(): Set<string> {
  const out = new Set<string>(kit.oracle.values.map((v) => v.value));
  for (const f of kit.files) {
    if (f.path.endsWith(".csv")) for (const row of parseCsv(f.text as string, ",")) for (const c of row.cells) out.add(c.value);
    if (f.path.endsWith(".xlsx")) {
      const wb = readWorkbook(kitFileBytes(f));
      for (const sheet of wb.sheets) for (const row of sheetRows(sheet, wb.sharedStrings)) for (const c of row ?? []) if (c !== undefined) out.add(c);
    }
    if (f.path.endsWith(".json")) {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
        else out.add(String(v));
      };
      walk(JSON.parse(f.text as string));
    }
  }
  out.delete("");
  return out;
}

/** Every header, sheet name, JSON key, and file or folder name in the kit. */
function rawNames(): Set<string> {
  const out = new Set<string>();
  for (const c of kit.oracle.columns) {
    if (c.header !== undefined) out.add(c.header);
    if (c.sheet !== undefined) out.add(c.sheet);
  }
  for (const f of kit.files) {
    for (const part of f.path.split("/")) out.add(part);
    if (f.path.endsWith(".xlsx")) for (const s of readWorkbook(kitFileBytes(f)).sheets) out.add(s.name);
    if (f.path.endsWith(".csv")) for (const c of parseCsv(f.text as string, ",")[0]?.cells ?? []) out.add(c.value);
    if (f.path.endsWith(".json")) {
      const keys = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(keys);
        else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) (out.add(k), keys(x));
      };
      keys(JSON.parse(f.text as string));
    }
  }
  out.delete("");
  return out;
}

/** Every string value in `v` (object keys are the profile schema's own field names, not data). */
function stringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringValues(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) stringValues(x, out);
  return out;
}

const FORMATS = new Set(["csv", "tsv", "json", "jsonl", "xlsx", "docx", "text", "markdown", "log", "vtt", "srt"]);
const TOKEN = /^(?:(?:dir_\d+\/)*file_\d+|sheet_\d+|col_\d+)$/;
/** A key path whose every key segment is a token: `$`, then `["key_N"]`, `[*]`, `.*` or `.*~` only. */
const TOKEN_PATH = /^\$(?:\["key_\d+"\]|\[\*\]|\.\*~?)*$/;

function expectValueFree(profile: Profile): void {
  const strings = stringValues(profile);
  expect(strings.length).toBeGreaterThan(0);
  // A whitelist: anything that is not a token or a format name fails, whatever it is.
  expect(strings.filter((s) => !TOKEN.test(s) && !TOKEN_PATH.test(s) && !FORMATS.has(s))).toEqual([]);
  expect(profile.sampleCount).toBe(0);
  // String values only: the schema's own field names ("jsonPath", "headerRow") are not data.
  const text = strings.join("\n");
  const values = cellValues();
  const names = rawNames();
  expect(values.size).toBeGreaterThan(100);
  expect(names.size).toBeGreaterThan(20);
  expect([...values].filter((v) => v.length >= 3 && text.includes(v))).toEqual([]);
  expect(strings.filter((s) => values.has(s) || names.has(s))).toEqual([]);
}

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-profile-only-"));
  writeKit(dir, kit);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a profile-only payload on kit v2 carries no cell value, header or key (AGT-1832)", () => {
  test("the kit has the shapes this is about: tables, sheets, JSON keys, documents and transcripts", () => {
    const { profile } = buildProfile([join(dir, "input")], 5, dir);
    expect(profile.tables.some((t) => t.sheet !== undefined)).toBe(true);
    expect(profile.jsonKeys.length).toBeGreaterThan(0);
    expect(profile.documents.length).toBeGreaterThan(0);
    expect(profile.transcripts.length).toBeGreaterThan(0);
    // Built with samples, the local profile is full of values: the check below is not vacuous.
    expect(JSON.stringify(profile)).toContain(kit.oracle.values.find((v) => v.class === "person")?.value as string);
  });

  test("even from a profile built with samples, what profile-only would send is statistics and tokens only", () => {
    const sent = tokeniseProfile(forPrivacyMode(buildProfile([join(dir, "input")], 5, dir), "profile-only").profile).profile;
    expect(() => assertProfilePayload(profilePayload(sent, defaultPolicy()))).not.toThrow();
    expectValueFree(sent);
  });

  test("through `blind plan`: the request body holds no value, and the analyst's column rules land on the real headers", async () => {
    const work = mkdtempSync(join(tmpdir(), "blind-profile-only-plan-"));
    try {
      const p = defaultPolicy();
      p.privacy.mode = "profile-only";
      p.profile = { samples: 0, samplesExplicit: false };
      p.models.analyst = { backend: "openai-compatible", url: "https://analyst.example.com/v1", model: "m", key_env: "" };
      // A blind.toml rule decides one column locally, ahead of the model, as in any mode.
      p.columns = [{ header: ["Role"], treatment: "keep", class: "vocabulary" }];
      writeFileSync(join(work, "blind.toml"), renderPolicy(p));
      writeKit(join(work, "kit"), kit);

      const bodies: string[] = [];
      const fetch: AskOptions["fetch"] = async (_input, init) => {
        const body = String(init?.body);
        bodies.push(body);
        const user = JSON.parse(body).messages[1].content as string;
        const data = JSON.parse(user.slice(user.indexOf("<data>\n") + 7, user.indexOf("\n</data>"))) as { profile: Profile };
        // A value-free analyst: it can only answer by token, so it marks every column "unknown"/"value".
        const reply: Spec = {
          version: 1,
          columns: data.profile.tables.flatMap((t) =>
            t.columns.map((c) => ({ file: t.file, ...(t.sheet === undefined ? {} : { sheet: t.sheet }), header: c.header, class: "unknown" as const, treatment: "value" as const, confidence: 0.5, source: "analyst" as const })),
          ),
          entities: {},
          patterns: { ip: true, email: true, host: true, guid: true, mac: true },
          questions: [],
        };
        return Response.json({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }] });
      };
      const out = new PassThrough();
      const err = new PassThrough();
      let errText = "";
      err.on("data", (d) => (errText += d));
      out.resume();
      const code = await runPlan([join("kit", "input")], { out, err, cwd: work, model: { fetch, env: {} } });
      expect(errText).toContain("profile-only · samples 0 · ");
      expect(code).toBe(0);
      expect(bodies).toHaveLength(1);

      const user = JSON.parse(bodies[0] as string).messages[1].content as string;
      const sent = JSON.parse(user.slice(user.indexOf("<data>\n") + 7, user.indexOf("\n</data>"))) as { profile: Profile };
      expectValueFree(sent.profile);

      const spec = parseSpec(readFileSync(join(work, ".blind", "spec.json"), "utf8"));
      const access = spec.columns.filter((c) => c.file.endsWith("tenant-access.xlsx") && c.sheet === "Access");
      expect(access.map((c) => c.header)).toEqual(["User", "Booked Under", "Email", "Employee No", "Path", "Role", "Last Login"]);
      expect(access.find((c) => c.header === "User")).toMatchObject({ source: "analyst", class: "unknown", treatment: "value" });
      expect(access.find((c) => c.header === "Role")).toMatchObject({ source: "policy", treatment: "keep" });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
