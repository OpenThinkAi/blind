// AGT-1823 (B7): honorifics and roles never become name parts. Synthetic: invented people only.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristicSpec, speakerEntities } from "../../src/analyst/heuristic.ts";
import { applySpec } from "../../src/engine/apply.ts";
import { isHonorificOrRole, isOnlyHonorificsOrRoles } from "../../src/engine/honorifics.ts";
import { partExclusion } from "../../src/engine/recur.ts";
import { defaultPolicy } from "../../src/policy.ts";
import { buildProfile } from "../../src/profile/profile.ts";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Dr. A Smith>Please bring Rex back to Highland Dr. next week.</v>

00:00:05.000 --> 00:00:08.000
<v Front Desk>Thanks Smith, the Front Desk will book it.</v>

00:00:09.000 --> 00:00:12.000
<v Dr. A Smith>Dr Smith agrees.</v>
`;

describe("the stoplist", () => {
  test("recognises titles and roles, with or without a dot or case", () => {
    for (const w of ["Dr", "dr.", "MR", "Front", "Desk", "Reception", "Nurse", "Vet", "Tech"]) expect(isHonorificOrRole(w)).toBe(true);
    for (const w of ["Smith", "Highland", "Quill"]) expect(isHonorificOrRole(w)).toBe(false);
  });
  test("a name made only of stoplist words", () => {
    expect(isOnlyHonorificsOrRoles("Front Desk")).toBe(true);
    expect(isOnlyHonorificsOrRoles("Dr.")).toBe(true);
    expect(isOnlyHonorificsOrRoles("Dr. A Smith")).toBe(false);
    expect(isOnlyHonorificsOrRoles("")).toBe(false);
  });
  test("a hand-written spec's part is excluded too", () => {
    expect(partExclusion("Dr", new Set(), new Set())).not.toBeNull();
    expect(partExclusion("Reception", new Set(), new Set())).not.toBeNull();
    expect(partExclusion("Smith", new Set(), new Set())).toBeNull();
  });
});

describe("a VTT with speakers Dr. A Smith and Front Desk", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-honorific-"));
    writeFileSync(join(dir, "call.vtt"), VTT);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("Dr. A Smith is a person with part Smith only; Front Desk is none", () => {
    const { profile } = buildProfile([dir], 5, dir);
    const people = speakerEntities(profile);
    expect(people.map((p) => p.canonical)).toEqual(["Dr. A Smith"]);
    expect(people[0]?.parts).toEqual(["Smith"]);
  });

  test("Smith is blinded; Dr, Front Desk and Highland Dr. survive", () => {
    const { profile } = buildProfile([dir], 5, dir);
    const spec = heuristicSpec(profile, defaultPolicy());
    const inputs = [{ path: "call.vtt", bytes: new TextEncoder().encode(readFileSync(join(dir, "call.vtt"), "utf8")) }];
    const r = applySpec(inputs, spec, { salt: Uint8Array.from({ length: 32 }, (_, i) => i + 1) });
    const out = new TextDecoder().decode(r.outputs.find((o) => o.path === "call.vtt")?.bytes);
    expect(out).not.toContain("Smith");
    expect(out).toContain("Highland Dr.");
    expect(out).toContain("Dr ");
    expect(out).toContain("the Front Desk will book it");
    expect(out).toContain("<v Front Desk>");
  });
});
