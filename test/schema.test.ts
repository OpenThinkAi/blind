import { describe, expect, test } from "bun:test";
import profileSchema from "../schema/profile.schema.json" with { type: "json" };
import specSchema from "../schema/spec.schema.json" with { type: "json" };
import { MAX_EXCERPT, type Profile, type Spec } from "../src/schema.ts";
import { parseProfile, parseSpec, SchemaError, validateProfile, validateSpec } from "../src/validate.ts";
import profileFixture from "./fixtures/profile.valid.json" with { type: "json" };
import specFixture from "./fixtures/spec.valid.json" with { type: "json" };

type Json = any; // test-only: fixtures are mutated freely to build invalid documents

function mutated(base: unknown, edit: (doc: Json) => void): unknown {
  const doc = structuredClone(base) as Json;
  edit(doc);
  return doc;
}

function issuesOf(result: { ok: true } | { ok: false; issues: { path: string; message: string }[] }) {
  return result.ok ? [] : result.issues;
}

describe("spec", () => {
  test("the synthetic fixture is valid", () => {
    expect(validateSpec(specFixture)).toEqual({ ok: true, value: specFixture as Spec });
  });

  test("a typed minimal spec is valid", () => {
    const minimal: Spec = {
      version: 1,
      columns: [{ file: "a.csv", header: "", class: "id", treatment: "value", confidence: 0, source: "human" }],
      entities: {},
      patterns: { ip: false, email: false, host: false, guid: false, mac: false },
      questions: [],
    };
    expect(validateSpec(minimal).ok).toBe(true);
  });

  const cases: [string, (d: Json) => void, string, RegExp][] = [
    ["unknown top-level field", (d) => (d.extra = 1), "$.extra", /unknown field/],
    ["version", (d) => (d.version = 2), "$.version", /must be 1/],
    ["columns not an array", (d) => (d.columns = {}), "$.columns", /must be array, got object/],
    ["column class", (d) => (d.columns[0].class = "manager"), "$.columns[0].class", /must be one of "person"/],
    ["column treatment", (d) => (d.columns[1].treatment = "hide"), "$.columns[1].treatment", /must be one of "blind", "keep", "value"/],
    ["column confidence", (d) => (d.columns[0].confidence = 1.5), "$.columns[0].confidence", /must be <= 1/],
    ["column confidence type", (d) => (d.columns[0].confidence = "high"), "$.columns[0].confidence", /must be number, got string/],
    ["unknown column kept", (d) => (d.columns[3].treatment = "keep"), "$.columns[3].treatment", /class "unknown" cannot use treatment "keep"/],
    ["column source", (d) => (d.columns[0].source = "model"), "$.columns[0].source", /must be one of/],
    ["column unknown field", (d) => (d.columns[0].note = "x"), "$.columns[0].note", /unknown field/],
    ["column missing file", (d) => delete d.columns[0].file, "$.columns[0].file", /is required/],
    ["column empty sheet", (d) => (d.columns[1].sheet = ""), "$.columns[1].sheet", /must not be empty/],
    ["column with neither header nor jsonPath", (d) => delete d.columns[0].header, "$.columns[0]", /must have one of: header, jsonPath/],
    ["column with both header and jsonPath", (d) => (d.columns[3].header = "ref"), "$.columns[3]", /must have only one of: header, jsonPath/],
    ["duplicate column rule", (d) => d.columns.push({ ...d.columns[0], treatment: "keep" }), "$.columns[4]", /same column as \$\.columns\[0\]/],
    ["entities unknown class", (d) => (d.entities.unknown = []), "$.entities.unknown", /unknown field/],
    ["entity aliases type", (d) => (d.entities.person[0].aliases = "A. Quill"), "$.entities.person[0].aliases", /must be array, got string/],
    ["entity unknown field", (d) => (d.entities.org[0].nickname = "EW"), "$.entities.org[0].nickname", /unknown field/],
    ["entity empty canonical", (d) => (d.entities.host[0].canonical = ""), "$.entities.host[0].canonical", /must not be empty/],
    ["entity part type", (d) => (d.entities.person[0].parts[1] = 7), "$.entities.person[0].parts[1]", /must be string, got integer/],
    ["pattern type", (d) => (d.patterns.ip = "yes"), "$.patterns.ip", /must be boolean, got string/],
    ["pattern missing", (d) => delete d.patterns.mac, "$.patterns.mac", /is required/],
    ["pattern unknown", (d) => (d.patterns.phone = true), "$.patterns.phone", /unknown field/],
    ["question options too few", (d) => (d.questions[0].options = ["blind"]), "$.questions[0].options", /at least 2 items/],
    ["question options duplicate", (d) => (d.questions[0].options = ["keep", "keep"]), "$.questions[0].options[1]", /duplicate item "keep"/],
    ["question answer not an option", (d) => (d.questions[1].answer = "maybe"), "$.questions[1].answer", /must be null or one of "yes", "no"/],
    ["question answer type", (d) => (d.questions[1].answer = true), "$.questions[1].answer", /must be string or null, got boolean/],
    ["question duplicate id", (d) => (d.questions[1].id = "q1"), "$.questions[1].id", /duplicate id "q1"/],
    ["question unknown field", (d) => (d.questions[0].hint = "x"), "$.questions[0].hint", /unknown field/],
  ];

  for (const [name, edit, path, message] of cases) {
    test(`rejects: ${name}`, () => {
      const issues = issuesOf(validateSpec(mutated(specFixture, edit)));
      expect(issues.length).toBeGreaterThan(0);
      const hit = issues.find((i) => i.path === path);
      expect(hit, `expected an issue at ${path}, got ${JSON.stringify(issues)}`).toBeDefined();
      expect(hit?.message).toMatch(message);
    });
  }

  test("rejects non-objects at the root", () => {
    expect(issuesOf(validateSpec([]))).toEqual([{ path: "$", message: "must be object, got array" }]);
    expect(issuesOf(validateSpec(null))).toEqual([{ path: "$", message: "must be object, got null" }]);
  });

  test("rejects __proto__ and other inherited names as unknown fields", () => {
    const text = JSON.stringify(specFixture).replace(/^\{/, '{"__proto__":{"x":1},"constructor":1,');
    const issues = issuesOf(validateSpec(JSON.parse(text)));
    expect(issues).toContainEqual({ path: "$.__proto__", message: "unknown field" });
    expect(issues).toContainEqual({ path: "$.constructor", message: "unknown field" });
  });

  test("reports every issue, not just the first", () => {
    const issues = issuesOf(
      validateSpec(mutated(specFixture, (d) => {
        d.columns[0].class = "x";
        d.patterns.ip = 1;
      })),
    );
    expect(issues.map((i) => i.path)).toEqual(["$.columns[0].class", "$.patterns.ip"]);
  });

  test("parseSpec throws a SchemaError naming the source and path", () => {
    const text = JSON.stringify(mutated(specFixture, (d) => (d.columns[2].treatment = "drop")));
    let err: unknown;
    try {
      parseSpec(text, ".blind/spec.json");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchemaError);
    const message = (err as SchemaError).message;
    expect(message).toContain(".blind/spec.json: invalid spec");
    expect(message).toContain("$.columns[2].treatment");
    expect(message).toContain("docs/spec.md");
  });

  test("parseSpec rejects malformed JSON at $", () => {
    expect(() => parseSpec("{ not json")).toThrow(/spec: invalid spec\n {2}\$: not valid JSON/);
  });

  test("parseSpec returns the spec when valid", () => {
    expect(parseSpec(JSON.stringify(specFixture)).columns).toHaveLength(4);
  });
});

describe("profile", () => {
  test("the synthetic fixture is valid", () => {
    expect(validateProfile(profileFixture)).toEqual({ ok: true, value: profileFixture as Profile });
  });

  const long = "x".repeat(MAX_EXCERPT + 1);

  const cases: [string, (d: Json) => void, string, RegExp][] = [
    ["unknown top-level field", (d) => (d.rawText = "..."), "$.rawText", /unknown field/],
    ["version", (d) => (d.version = "1"), "$.version", /must be 1/],
    ["sampleCount negative", (d) => (d.sampleCount = -1), "$.sampleCount", /must be >= 0/],
    ["sampleCount fractional", (d) => (d.sampleCount = 2.5), "$.sampleCount", /must be integer, got number/],
    ["file format", (d) => (d.files[0].format = "pdf"), "$.files[0].format", /must be one of "csv"/],
    ["file size", (d) => (d.files[1].size = -5), "$.files[1].size", /must be >= 0/],
    ["file unknown field", (d) => (d.files[0].content = "..."), "$.files[0].content", /unknown field/],
    ["table headerRow", (d) => (d.tables[0].headerRow = 0), "$.tables[0].headerRow", /must be >= 1/],
    ["table header too long", (d) => (d.tables[0].columns[0].header = long), "$.tables[0].columns[0].header", /at most 120 characters, got 121/],
    ["column ratio", (d) => (d.tables[0].columns[0].stats.distinctRatio = 2), "$.tables[0].columns[0].stats.distinctRatio", /must be <= 1/],
    ["column meanLength", (d) => (d.tables[0].columns[1].stats.meanLength = -1), "$.tables[0].columns[1].stats.meanLength", /must be >= 0/],
    ["detector unknown", (d) => (d.tables[0].columns[0].stats.detectorRates.phone = 0), "$.tables[0].columns[0].stats.detectorRates.phone", /unknown field/],
    ["detector missing", (d) => delete d.tables[0].columns[0].stats.detectorRates.guid, "$.tables[0].columns[0].stats.detectorRates.guid", /is required/],
    ["column sample too long", (d) => (d.tables[0].columns[0].stats.samples[0] = long), "$.tables[0].columns[0].stats.samples[0]", /at most 120 characters/],
    ["column samples over sampleCount", (d) => d.tables[0].columns[0].stats.samples.push("Extra Person"), "$.tables[0].columns[0].stats.samples", /at most sampleCount \(3\) items, got 4/],
    ["column stats unknown field", (d) => (d.tables[0].columns[0].stats.values = []), "$.tables[0].columns[0].stats.values", /unknown field/],
    ["json key stats missing", (d) => delete d.jsonKeys[0].stats, "$.jsonKeys[0].stats", /is required/],
    ["json key sample too long", (d) => (d.jsonKeys[0].stats.samples[1] = long), "$.jsonKeys[0].stats.samples[1]", /at most 120 characters/],
    ["document sentence too long", (d) => (d.documents[0].sampleSentences[0] = long), "$.documents[0].sampleSentences[0]", /at most 120 characters/],
    ["document outline too long", (d) => (d.documents[0].outline[1] = long), "$.documents[0].outline[1]", /at most 120 characters/],
    ["document sentences over sampleCount", (d) => (d.documents[0].sampleSentences = ["a", "b", "c", "d"]), "$.documents[0].sampleSentences", /at most sampleCount/],
    ["document unknown field", (d) => (d.documents[0].body = "..."), "$.documents[0].body", /unknown field/],
    ["transcript speaker type", (d) => (d.transcripts[0].speakers[0] = 3), "$.transcripts[0].speakers[0]", /must be string, got integer/],
    ["transcript line too long", (d) => (d.transcripts[0].sampleLines[0] = long), "$.transcripts[0].sampleLines[0]", /at most 120 characters/],
    ["transcript unknown field", (d) => (d.transcripts[0].lines = []), "$.transcripts[0].lines", /unknown field/],
    ["cooccurrence shared", (d) => (d.cooccurrence[0].shared = 0), "$.cooccurrence[0].shared", /must be >= 1/],
    ["cooccurrence location shape", (d) => (d.cooccurrence[0].b.header = "Assignee"), "$.cooccurrence[0].b", /must have only one of: header, jsonPath/],
    ["file path duplicate", (d) => (d.files[1].path = "staff.csv"), "$.files[1].path", /duplicate path "staff.csv"/],
    ["table file not listed", (d) => (d.tables[0].file = "other.csv"), "$.tables[0].file", /"other.csv" is not listed in \$\.files/],
    ["document file not listed", (d) => (d.documents[0].file = "other.md"), "$.documents[0].file", /is not listed/],
    ["cooccurrence file not listed", (d) => (d.cooccurrence[0].b.file = "other.json"), "$.cooccurrence[0].b.file", /is not listed/],
    ["cooccurrence values carried", (d) => (d.cooccurrence[0].values = ["Avery Quill"]), "$.cooccurrence[0].values", /unknown field/],
  ];

  for (const [name, edit, path, message] of cases) {
    test(`rejects: ${name}`, () => {
      const issues = issuesOf(validateProfile(mutated(profileFixture, edit)));
      expect(issues.length).toBeGreaterThan(0);
      const hit = issues.find((i) => i.path === path);
      expect(hit, `expected an issue at ${path}, got ${JSON.stringify(issues)}`).toBeDefined();
      expect(hit?.message).toMatch(message);
    });
  }

  test("excerpt length counts code points, so exactly 120 passes", () => {
    const ok = mutated(profileFixture, (d) => {
      d.documents[0].sampleSentences[0] = "x".repeat(MAX_EXCERPT);
      d.transcripts[0].sampleLines[0] = "\u{1F600}".repeat(MAX_EXCERPT); // 240 UTF-16 units, 120 code points
    });
    expect(validateProfile(ok).ok).toBe(true);
  });

  test("errors never echo a rejected excerpt in full", () => {
    const secret = `Synthetic Person ${"y".repeat(200)}`;
    const issues = issuesOf(validateProfile(mutated(profileFixture, (d) => (d.files[0].format = secret))));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).not.toContain(secret);
    expect(issues[0]?.message).toContain("(217 characters)");
  });

  test("sampleCount 0 allows no samples", () => {
    const issues = issuesOf(validateProfile(mutated(profileFixture, (d) => (d.sampleCount = 0))));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => /at most sampleCount \(0\)/.test(i.message))).toBe(true);
  });

  test("parseProfile throws SchemaError with paths", () => {
    const text = JSON.stringify(mutated(profileFixture, (d) => (d.files[0].format = "pdf")));
    expect(() => parseProfile(text, ".blind/profile.json")).toThrow(/\.blind\/profile\.json: invalid profile\n {2}\$\.files\[0\]\.format/);
  });
});

describe("schema files", () => {
  // Strictness is structural: every object in both schemas must forbid unknown fields.
  function objectNodes(node: unknown, at: string, out: [string, Record<string, unknown>][]) {
    if (Array.isArray(node)) node.forEach((n, i) => objectNodes(n, `${at}[${i}]`, out));
    else if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (rec.type === "object") out.push([at, rec]);
      for (const [k, v] of Object.entries(rec)) objectNodes(v, `${at}/${k}`, out);
    }
    return out;
  }

  for (const [name, schema] of [["spec", specSchema], ["profile", profileSchema]] as const) {
    test(`${name}.schema.json forbids unknown fields on every object`, () => {
      const nodes = objectNodes(schema, "#", []);
      expect(nodes.length).toBeGreaterThan(3);
      for (const [at, node] of nodes) expect([at, node.additionalProperties]).toEqual([at, false]);
    });
  }

  test("profile excerpt limit matches MAX_EXCERPT", () => {
    expect(profileSchema.$defs.excerpt.maxLength).toBe(MAX_EXCERPT);
  });
});

test("the examples in docs/spec.md are valid", async () => {
  const doc = await Bun.file(new URL("../docs/spec.md", import.meta.url)).text();
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1] ?? ""));
  expect(blocks).toHaveLength(2);
  expect(issuesOf(validateSpec(blocks[0]))).toEqual([]);
  expect(issuesOf(validateProfile(blocks[1]))).toEqual([]);
});
