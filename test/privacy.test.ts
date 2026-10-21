import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AskOptions,
  MAX_DATA_STRING,
  ModelRefusal,
  type SpawnFn,
  ask,
  modelsEnabled,
  profilePayload,
  splitText,
} from "../src/model.ts";
import { type ModelConfig, type Policy, PolicyError, type PrivacyMode, defaultPolicy, parsePolicy, renderPolicy } from "../src/policy.ts";
import { buildProfile, forPrivacyMode } from "../src/profile/profile.ts";
import { tokeniseProfile } from "../src/profile/tokens.ts";
import type { Profile } from "../src/schema.ts";

// Privacy modes (AGT-1741). Synthetic data only; nothing reaches the network or a real `claude`.

const SCHEMA = {
  type: "object",
  required: ["label"],
  additionalProperties: false,
  properties: { label: { enum: ["person", "unknown"] } },
} as const;
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "profile.valid.json"), "utf8")) as Profile;
/** The fixture as a profile-only call sends it: no samples, outlines or speaker labels, names as tokens. */
const PROFILE_ONLY = tokeniseProfile(forPrivacyMode({ profile: FIXTURE, skipped: [], notes: [] }, "profile-only").profile).profile;
const REMOTE: ModelConfig = { backend: "openai-compatible", url: "https://models.example.com/v1", model: "m", key_env: "" };

function policyWith(mode: PrivacyMode, cfg: Partial<ModelConfig> = {}): Policy {
  const p = defaultPolicy();
  p.models.analyst = { ...p.models.analyst, ...cfg };
  p.privacy.mode = mode;
  return p;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ModelRefusal);
    return (e as Error).message;
  }
  throw new Error("expected a ModelRefusal");
}

const noFetch: AskOptions["fetch"] = () => {
  throw new Error("a request was sent");
};
const noSpawn: SpawnFn = () => {
  throw new Error("a process was spawned");
};

/** A fetch that records each request in `events` (after any announce lines) and answers like a chat server. */
function recorder(events: string[], bodies: string[]): AskOptions["fetch"] {
  return async (input, init) => {
    events.push(`fetch ${String(input)}`);
    bodies.push(String(init?.body ?? ""));
    return Response.json({ choices: [{ message: { content: '{"label":"unknown"}' }, finish_reason: "stop" }] });
  };
}

/** The JSON quoted inside the <data> block of an openai-compatible request body. */
function sentData(body: string): unknown {
  const user = JSON.parse(body).messages[1].content as string;
  const m = /<data>\n([\s\S]*)\n<\/data>/.exec(user);
  if (m?.[1] === undefined) throw new Error("no <data> block");
  return JSON.parse(m[1]);
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (typeof v === "object" && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("local-only", () => {
  const data = { task: "t", data: { header: "contact_name" } };

  test("is the default mode", () => {
    expect(defaultPolicy().privacy.mode).toBe("local-only");
    expect(parsePolicy(renderPolicy(defaultPolicy())).privacy.mode).toBe("local-only");
  });

  test.each([
    ["a non-loopback URL", { url: "https://models.example.com/v1" }],
    ["an RFC 5737 address", { url: "http://192.0.2.10:8000/v1" }],
    ["the anthropic backend", { backend: "anthropic", url: "", model: "m", key_env: "K" }],
    ["claude-cli", { backend: "claude-cli", url: "" }],
  ] as const)("refuses %s before any send", async (_name, cfg) => {
    const msg = await refusal(
      ask("analyst", "s", data, SCHEMA, { policy: policyWith("local-only", cfg), fetch: noFetch, spawn: noSpawn, env: { K: "k" } }),
    );
    expect(msg).toStartWith("privacy.mode is local-only: ");
  });

  test("allows a loopback server", async () => {
    const events: string[] = [];
    const bodies: string[] = [];
    await ask("analyst", "s", data, SCHEMA, {
      policy: policyWith("local-only", { url: "http://127.0.0.1:8000/v1", model: "m" }),
      fetch: recorder(events, bodies),
      stderr: (l) => events.push(l),
    });
    expect(events).toEqual([
      `analyst · openai-compatible · m · local-only · ${Buffer.byteLength(bodies[0] ?? "")} bytes sent`,
      "fetch http://127.0.0.1:8000/v1/chat/completions",
    ]);
  });
});

describe("profile-only", () => {
  const payload = () => profilePayload(PROFILE_ONLY, defaultPolicy());

  test("sends exactly the profile and the policy, and prints the mode and sample count first", async () => {
    const events: string[] = [];
    const bodies: string[] = [];
    await ask("analyst", "s", { task: "t", data: payload() }, SCHEMA, {
      policy: policyWith("profile-only", REMOTE),
      fetch: recorder(events, bodies),
      stderr: (l) => events.push(l),
      quiet: true, // ignored: a call that may leave the machine is always announced
    });
    const size = Buffer.byteLength(bodies[0] ?? "");
    expect(events).toEqual([
      `analyst · openai-compatible · m · profile-only · samples 0 · ${size} bytes sent`,
      "fetch https://models.example.com/v1/chat/completions",
    ]);
    expect(sentData(bodies[0] ?? "")).toEqual(payload());
  });

  test("the policy view carries the classes, description, examples and (outside profile-only) the keep list", () => {
    const p = defaultPolicy();
    p.keep.terms = ["Widget"];
    const view = profilePayload(FIXTURE, p).policy;
    expect(view.classes).toEqual(p.sensitive.classes);
    expect(view.examples).toEqual(p.sensitive.examples);
    expect(view.keep).toEqual(["Widget"]);
    expect(view.description.join("")).toBe(p.sensitive.description);
    expect(p.sensitive.description.length).toBeGreaterThan(MAX_DATA_STRING);
    for (const piece of view.description) expect([...piece].length).toBeLessThanOrEqual(MAX_DATA_STRING);
  });

  test("under profile-only the policy view carries no keep term, and ask() sends none (AGT-1996)", async () => {
    const p = policyWith("profile-only", REMOTE);
    p.keep.terms = ["Avery Quill", "10.2.0.0/16", "build-07.corp.example.net"];
    expect(profilePayload(PROFILE_ONLY, p).policy.keep).toEqual([]);
    const bodies: string[] = [];
    await ask("analyst", "s", { task: "t", data: profilePayload(PROFILE_ONLY, p) }, SCHEMA, { policy: p, fetch: recorder([], bodies), stderr: () => {} });
    for (const term of p.keep.terms) expect(bodies[0]).not.toContain(term);
  });

  test("a profile-only payload that carries keep terms is refused before anything is sent (AGT-1996)", async () => {
    const p = policyWith("profile-only", REMOTE);
    const leaky = { ...payload(), policy: { ...payload().policy, keep: ["Avery Quill"] } };
    const why = await refusal(ask("analyst", "s", { task: "t", data: leaky }, SCHEMA, { policy: p, fetch: noFetch, spawn: noSpawn }));
    expect(why).toContain("$.policy.keep is not empty");
  });

  const bad: Array<[string, () => unknown, string]> = [
    ["data that is not a payload", () => ({ header: "contact_name", samples: ["Ada Example"] }), 'has keys ["header","samples"]'],
    ["an extra key", () => ({ ...payload(), document: "x" }), 'has keys ["document","policy","profile"]'],
    ["the profile alone", () => ({ profile: FIXTURE }), 'has keys ["profile"]'],
    ["an invalid profile", () => ({ ...payload(), profile: { ...FIXTURE, version: 2 } }), "the profile is not valid"],
    ["a policy with an extra field", () => ({ ...payload(), policy: { ...payload().policy, salt: "x" } }), "the policy is not valid"],
    ["a non-object", () => "Ada Example", "the data is not an object"],
    // AGT-1778: document text that sampleCount does not bound.
    ["a document outline", () => profilePayload(FIXTURE, defaultPolicy()), "$.profile.documents[0].outline"],
    [
      "a speaker list",
      () => ({ ...payload(), profile: { ...PROFILE_ONLY, transcripts: PROFILE_ONLY.transcripts.map((t, i) => ({ ...t, speakers: FIXTURE.transcripts[i]?.speakers ?? [] })) } }),
      "$.profile.transcripts[0].speakers",
    ],
    // AGT-1782: names that must go out as tokens.
    ["real file paths", () => ({ ...payload(), profile: forPrivacyMode({ profile: FIXTURE, skipped: [], notes: [] }, "profile-only").profile }), "$.profile.files[0].path"],
    [
      "a real sheet name",
      () => ({ ...payload(), profile: { ...PROFILE_ONLY, tables: PROFILE_ONLY.tables.map((t) => ({ ...t, sheet: "Avery Quill" })) } }),
      "$.profile.tables[0].sheet",
    ],
    [
      "value-like headers",
      () => ({
        ...payload(),
        profile: { ...PROFILE_ONLY, tables: PROFILE_ONLY.tables.map((t) => ({ ...t, columns: t.columns.map((c, i) => ({ ...c, header: ["Avery Quill", "Robin Example"][i] ?? "x" })) })) },
      }),
      "$.profile.tables[0].columns[0].header, $.profile.tables[0].columns[1].header",
    ],
    // AGT-1832: every header, even a dictionary word, and any sample at all.
    [
      "a dictionary-word header",
      () => ({ ...payload(), profile: { ...PROFILE_ONLY, tables: PROFILE_ONLY.tables.map((t) => ({ ...t, columns: t.columns.map((c, i) => (i === 0 ? { ...c, header: "Status" } : c)) })) } }),
      "$.profile.tables[0].columns[0].header",
    ],
    ["sample values", () => ({ ...payload(), profile: { ...tokeniseProfile(FIXTURE).profile, documents: PROFILE_ONLY.documents, transcripts: PROFILE_ONLY.transcripts } }), "$.profile.sampleCount, $.profile.tables[0].columns[0].stats.samples"],
    [
      "a name-like JSON key",
      () => ({ ...payload(), profile: { ...PROFILE_ONLY, jsonKeys: PROFILE_ONLY.jsonKeys.map((j) => ({ ...j, path: '$["Avery Quill"].role' })) } }),
      "$.profile.jsonKeys[0].path",
    ],
  ];
  for (const [name, data, message] of bad) {
    test(`refuses ${name} before any send`, async () => {
      const msg = await refusal(ask("analyst", "s", { task: "t", data: data() }, SCHEMA, { policy: policyWith("profile-only", REMOTE), fetch: noFetch }));
      expect(msg).toStartWith("privacy.mode is profile-only: only the profile and the policy may be sent");
      expect(msg).toContain(message);
    });
  }

  test("still refuses plain http to a remote host", async () => {
    const msg = await refusal(
      ask("analyst", "s", { task: "t", data: payload() }, SCHEMA, {
        policy: policyWith("profile-only", { ...REMOTE, url: "http://models.example.com/v1" }),
        fetch: noFetch,
      }),
    );
    expect(msg).toContain("must use https");
  });
});

describe("profile-only sends no value (AGT-1832)", () => {
  test("forPrivacyMode leaves out every sample, sample sentence, sample line, outline and speaker, and says so", () => {
    const { profile, notes } = forPrivacyMode({ profile: FIXTURE, skipped: [], notes: [] }, "profile-only");
    expect(profile.sampleCount).toBe(0);
    for (const t of profile.tables) for (const c of t.columns) expect(c.stats.samples).toEqual([]);
    for (const k of profile.jsonKeys) expect(k.stats.samples).toEqual([]);
    for (const d of profile.documents) expect(d).toMatchObject({ outline: [], sampleSentences: [] });
    for (const t of profile.transcripts) expect(t).toMatchObject({ speakers: [], sampleLines: [] });
    expect(notes.some((n) => n.includes("the samples of") && n.includes("are left out"))).toBe(true);
    // Statistics are kept: they are what the model classifies from.
    expect(profile.tables[0]?.columns[0]?.stats.distinctRatio).toBe(FIXTURE.tables[0]?.columns[0]?.stats.distinctRatio as number);
  });

  test("other modes are unchanged", () => {
    expect(forPrivacyMode({ profile: FIXTURE, skipped: [], notes: [] }, "local-only").profile).toBe(FIXTURE);
  });
});

describe("samples default to the mode", () => {
  const withMode = (mode: PrivacyMode, samples?: number) => {
    const text = renderPolicy(defaultPolicy()).replace('mode = "local-only"', `mode = "${mode}"`);
    return parsePolicy(samples === undefined ? text : text.replace("# samples = 5", `samples = ${samples}`));
  };

  test("unset: 5 under local-only and none, 0 under profile-only", () => {
    expect(withMode("local-only").profile).toEqual({ samples: 5, samplesExplicit: false });
    expect(withMode("none").profile).toEqual({ samples: 5, samplesExplicit: false });
    expect(withMode("profile-only").profile).toEqual({ samples: 0, samplesExplicit: false });
  });

  test("set explicitly, the count is kept under local-only and none", () => {
    expect(withMode("local-only", 0).profile).toEqual({ samples: 0, samplesExplicit: true });
    expect(withMode("local-only", 9).profile).toEqual({ samples: 9, samplesExplicit: true });
    expect(withMode("none", 2).profile).toEqual({ samples: 2, samplesExplicit: true });
  });

  test("profile-only refuses any sample count above 0 (AGT-1832); 0 set explicitly is fine", () => {
    for (const n of [1, 5]) {
      expect(() => withMode("profile-only", n)).toThrow(PolicyError);
      expect(() => withMode("profile-only", n)).toThrow(`profile.samples must be 0 under privacy.mode = "profile-only" (got ${n})`);
    }
    expect(withMode("profile-only", 0).profile).toEqual({ samples: 0, samplesExplicit: true });
  });

  test("the default policy leaves samples unset, so changing the mode changes the count", () => {
    const text = renderPolicy(defaultPolicy());
    expect(text).toContain("\n# samples = 5\n");
    expect(text).not.toMatch(/^samples = /m);
  });

  test("a count that differs from the mode's default is always written out", () => {
    const p = defaultPolicy();
    p.profile.samples = 2;
    expect(parsePolicy(renderPolicy(p)).profile).toEqual({ samples: 2, samplesExplicit: true });
  });
});

describe("none", () => {
  test("calls no model for either role, whatever the backend", async () => {
    for (const backend of ["openai-compatible", "anthropic", "claude-cli"] as const) {
      const p = policyWith("none", { backend });
      p.models.auditor = { ...p.models.analyst };
      for (const role of ["analyst", "auditor"] as const) {
        const msg = await refusal(
          ask(role, "s", { task: "t", data: profilePayload(FIXTURE, p) }, SCHEMA, { policy: p, fetch: noFetch, spawn: noSpawn }),
        );
        expect(msg).toStartWith("privacy.mode is none: ");
      }
    }
  });

  test("modelsEnabled tells callers to take the model-free path", () => {
    expect(modelsEnabled(policyWith("none"))).toBe(false);
    expect(modelsEnabled(policyWith("local-only"))).toBe(true);
    expect(modelsEnabled(policyWith("profile-only"))).toBe(true);
  });
});

describe("every sample in a payload is at most 120 characters", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "blind-privacy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a profile built from a 10 kB cell sends nothing longer to a loopback model", async () => {
    const big = `Ada Example ${"lorem ipsum ".repeat(900)}`.slice(0, 10_240);
    expect(big.length).toBe(10_240);
    writeFileSync(join(dir, "staff.csv"), `owner,notes\nAda Example,"${big}"\nBen Sample,short\n`);
    writeFileSync(join(dir, "notes.txt"), `${big}.\nSecond line.\n`);
    const { profile, skipped } = buildProfile(["."], 5, dir);
    expect(skipped).toEqual([]);

    const bodies: string[] = [];
    const p = policyWith("local-only", { url: "http://127.0.0.1:8000/v1", model: "m" });
    await ask("analyst", "s", { task: "t", data: profilePayload(profile, p) }, SCHEMA, { policy: p, fetch: recorder([], bodies), quiet: true });
    const sent = strings(sentData(bodies[0] ?? ""));
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect([...s].length).toBeLessThanOrEqual(MAX_DATA_STRING);
    expect(sent.some((s) => s.startsWith("Ada Example lorem"))).toBe(true);
  });

  test("under profile-only none of the cell is sent at all, even from a profile built with samples", async () => {
    const big = `Ada Example ${"lorem ipsum ".repeat(900)}`.slice(0, 10_240);
    writeFileSync(join(dir, "staff.csv"), `owner,notes\nAda Example,"${big}"\nBen Sample,short\n`);
    const { profile } = forPrivacyMode(buildProfile(["."], 5, dir), "profile-only");
    const bodies: string[] = [];
    const p = policyWith("profile-only", REMOTE);
    await ask("analyst", "s", { task: "t", data: profilePayload(tokeniseProfile(profile).profile, p) }, SCHEMA, { policy: p, fetch: recorder([], bodies), stderr: () => {} });
    // The policy's own invented examples ("Ada Example") are the owner's words; the profile carries nothing of the file.
    const sent = JSON.stringify((sentData(bodies[0] ?? "") as { profile: unknown }).profile);
    for (const text of ["Ada", "Ben", "lorem", "short", "owner", "notes", "staff"]) expect(sent).not.toContain(text);
  });

  test("a hand-made profile carrying the 10 kB cell is refused, not truncated", async () => {
    const profile = structuredClone(FIXTURE);
    const column = profile.tables[0]?.columns[0];
    if (column === undefined) throw new Error("fixture has no column");
    column.stats.samples = ["x".repeat(10_240)];
    for (const mode of ["local-only", "profile-only"] as const) {
      const cfg = mode === "local-only" ? { url: "http://127.0.0.1:8000/v1", model: "m" } : REMOTE;
      const msg = await refusal(
        ask("analyst", "s", { task: "t", data: profilePayload(profile, defaultPolicy()) }, SCHEMA, { policy: policyWith(mode, cfg), fetch: noFetch }),
      );
      expect(msg).toMatch(mode === "local-only" ? /10240 characters, over the 120-character limit/ : /the profile is not valid/);
    }
  });
});

describe("splitText", () => {
  test("splits at spaces without dropping anything", () => {
    const text = "one two three ".repeat(30).trim();
    const parts = splitText(text, 20);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect([...p].length).toBeLessThanOrEqual(20);
  });

  test("cuts a word longer than the limit, still losslessly", () => {
    const text = `short ${"é".repeat(45)} tail`;
    const parts = splitText(text, 20);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect([...p].length).toBeLessThanOrEqual(20);
  });

  test("empty text is no pieces", () => {
    expect(splitText("")).toEqual([]);
  });
});
