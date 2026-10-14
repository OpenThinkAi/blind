import { describe, expect, test } from "bun:test";
import { ApplyError, type ApplyOptions, type ApplyResult, applySpec } from "../../src/engine/apply.ts";
import type { Spec } from "../../src/schema.ts";
import { workbookEntries } from "../formats/xlsxfixture.ts";
import { buildZip } from "../formats/zipfixture.ts";

// AGT-1933: under pseudonymStyle "readable", an input that already contains readable-shaped text
// (`[Client A #7F3A]`) is refused before anything is written, so reveal can never rewrite author text.
// Refusal contract these tests assume: applySpec throws ApplyError (the CLI maps it to exit 2) whose
// message names the file and the position (`file:line` for text and CSV rows, the sheet and cell for
// XLSX) and never contains the matched value. Synthetic data only.

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const SHAPED = "[Client A #7F3A]";
// Excel sheet names cannot hold brackets, so the sheet carries the name-safe twin of the same shape.
const SAFE = "Client_A_7F3A";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }], org: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const run = (path: string, bytes: Uint8Array, opts: Partial<ApplyOptions> = {}): ApplyResult =>
  applySpec([{ path, bytes }], SPEC, { salt: SALT, ...opts });

function refusal(path: string, bytes: Uint8Array): ApplyError {
  try {
    run(path, bytes, { pseudonymStyle: "readable" });
  } catch (e) {
    expect(e).toBeInstanceOf(ApplyError);
    return e as ApplyError;
  }
  throw new Error("expected a refusal, but applySpec returned");
}

const masked = (e: ApplyError): void => {
  expect(e.message).not.toContain("7F3A");
  expect(e.message).not.toContain("Client A");
  expect(e.message).not.toContain(SAFE);
  expect(e.message).not.toContain(SHAPED);
};

const TXT = "notes\nAvery Quill met the team.\nSee " + SHAPED + " for details.\n";
const CSV = "Name,Notes\nAvery Quill,fine\nBlake Example,tagged " + SHAPED + " here\n";

const xlsx = (): Uint8Array =>
  buildZip(
    workbookEntries().map((e) =>
      e.name === "xl/workbook.xml" ? { ...e, data: String(e.data).replace('name="Staff"', 'name="' + SAFE + '"').replaceAll("Avery Quill", "Team").replaceAll("Avery_Total", "Team_Total") } : e,
    ),
  );

describe("readable style refuses input already shaped like a pseudonym", () => {
  test("a txt file: refused with file:line, value masked, nothing written", () => {
    const e = refusal("notes.txt", enc(TXT));
    expect(e.message).toContain("notes.txt:3");
    masked(e);
  });

  test("a CSV cell: refused with file:line, value masked, nothing written", () => {
    const e = refusal("people.csv", enc(CSV));
    expect(e.message).toContain("people.csv:3");
    masked(e);
  });

  test("an XLSX sheet name: refused naming the file and sheet, value masked, nothing written", () => {
    const e = refusal("staff.xlsx", xlsx());
    expect(e.message).toContain("staff.xlsx");
    expect(e.message).toMatch(/sheet/i);
    masked(e);
  });

  test("a clean txt is not refused under readable", () => {
    const r = run("clean.txt", enc("Avery Quill met the team.\n"), { pseudonymStyle: "readable" });
    expect(r.outputs).toHaveLength(1);
  });
});

describe("compact style is unchanged", () => {
  test.each([
    ["notes.txt", () => enc(TXT)],
    ["people.csv", () => enc(CSV)],
    ["staff.xlsx", xlsx],
  ] as const)("%s is not refused and is written", (path, bytes) => {
    for (const opts of [{ pseudonymStyle: "compact" as const }, {}]) {
      const r = run(path, bytes(), opts);
      expect(r.outputs.map((o) => o.path)).toContain(path);
    }
  });
});
