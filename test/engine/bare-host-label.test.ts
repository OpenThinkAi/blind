// AGT-2082: a digit-bearing host label (a 12-digit account number in a registry hostname) written bare
// in prose is a known original and is replaced with the label's pseudonym, in every file of a run, with
// a columns-only spec, whichever comes first. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { Spec } from "../../src/schema.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
const ACCT = "210987654321";
const spec: Spec = {
  version: 1,
  columns: [],
  entities: {},
  patterns: { ip: false, email: false, host: true, guid: false, mac: false },
  questions: [],
};
const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => Buffer.from((r.outputs.find((o) => o.path === path) as { bytes: Uint8Array }).bytes).toString("utf8");

describe("bare host label in prose", () => {
  const host = `${ACCT}.dkr.registry.cloudvendor.example`;
  const r = applySpec(
    [
      file("a.log", `pull ${host}/agent:1 ok\nrole sync-reader used by ${ACCT} again\n`),
      file("b.log", `owner of ${ACCT}, then ${ACCT}.\n`),
      file("c.log", `the 2025 and 2026 releases\n`),
    ],
    spec,
    { salt: SALT },
  );
  const label = out(r, "a.log").split("/")[0]?.split(" ")[1]?.split(".")[0] as string;

  test("no file keeps the number, and it takes the label's pseudonym", () => {
    expect(label).toMatch(/^host-[0-9a-f]{4}$/);
    for (const p of ["a.log", "b.log"]) expect(out(r, p)).not.toContain(ACCT);
    expect(out(r, "a.log")).toContain(`used by ${label} again`);
    expect(out(r, "b.log")).toBe(`owner of ${label}, then ${label}.\n`);
    expect(r.map.entries.some((e) => e.kind === "host-label" && e.canonical === ACCT && e.pseudonym === label)).toBe(true);
  });

  test("plain digit text is left alone", () => {
    expect(out(r, "c.log")).toBe("the 2025 and 2026 releases\n");
  });

  test("the bare token alone, before its host, is replaced the same way", () => {
    const r2 = applySpec([file("x.log", `ref ${ACCT} failed\npull ${host}/a ok\n`)], spec, { salt: SALT });
    const text = out(r2, "x.log");
    expect(text).not.toContain(ACCT);
    expect(text.split(" ")[1]).toBe(text.split("pull ")[1]?.split(".")[0] as string);
  });
});
