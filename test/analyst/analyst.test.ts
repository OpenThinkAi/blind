import { describe, expect, test } from "bun:test";
import { answerQuestion } from "../../src/analyst/analyst.ts";
import { HEURISTIC_RATE, heuristicPatterns, heuristicRule } from "../../src/analyst/heuristic.ts";
import { analystPrompt, systemPrompt } from "../../src/analyst/prompt.ts";
import { profilePayload } from "../../src/model.ts";
import { defaultPolicy } from "../../src/policy.ts";
import type { DetectorName, Profile, Spec, ValueStats } from "../../src/schema.ts";

// Synthetic values only.

function stats(rates: Partial<Record<DetectorName, number>> = {}): ValueStats {
  return {
    count: 10,
    distinctRatio: 1,
    digitRatio: 0,
    dictionaryRatio: 0,
    meanLength: 12,
    detectorRates: { ip: 0, email: 0, host: 0, guid: 0, mac: 0, numericId: 0, ...rates },
    samples: [],
  };
}
const loc = { file: "a.csv", header: "col" };
const policy = defaultPolicy();

describe("heuristic analyst", () => {
  test.each([
    ["email", "email"],
    ["ip", "host"],
    ["host", "host"],
    ["guid", "id"],
    ["numericId", "id"],
  ] as const)("%s at the threshold gives class %s", (detector, cls) => {
    const r = heuristicRule(loc, stats({ [detector]: HEURISTIC_RATE }), policy);
    expect(r).toEqual({ ...loc, class: cls, treatment: "blind", confidence: HEURISTIC_RATE, source: "heuristic" });
  });

  test("just under the threshold, and a mac column, stay unknown", () => {
    expect(heuristicRule(loc, stats({ email: 0.79 }), policy)).toMatchObject({ class: "unknown", treatment: "value", confidence: 0 });
    expect(heuristicRule(loc, stats({ mac: 1 }), policy)).toMatchObject({ class: "unknown" });
  });

  test("a class the policy does not call sensitive is kept, and its patterns are off", () => {
    const p = defaultPolicy();
    p.sensitive.classes = ["person", "host"];
    expect(heuristicRule(loc, stats({ email: 1 }), p)).toMatchObject({ class: "email", treatment: "keep" });
    expect(heuristicPatterns(p)).toEqual({ ip: true, email: false, host: true, guid: false, mac: true });
  });
});

describe("analyst prompt", () => {
  test("the system prompt carries the policy's classes and keep list, quoted", () => {
    const p = defaultPolicy();
    p.sensitive.classes = ["person"];
    p.keep.terms = ["Widgetry Suite"];
    const s = systemPrompt(p);
    expect(s).toContain("- person (sensitive)");
    expect(s).toContain("- org (not sensitive here)");
    expect(s).not.toContain("Widgetry Suite");
    expect(s).toContain("Ask rather than guess");
  });

  test("the profile and the policy go only into data, as the profile payload", () => {
    const profile = { version: 1, sampleCount: 1, files: [], tables: [], jsonKeys: [], documents: [], transcripts: [], cooccurrence: [] } as Profile;
    const prompt = analystPrompt(profile, policy);
    expect(prompt.data).toEqual(profilePayload(profile, policy));
    expect(prompt.task).not.toContain("{");
  });
});

describe("answerQuestion", () => {
  const spec = (): Spec => ({
    version: 1,
    columns: [{ ...loc, class: "unknown", treatment: "value", confidence: 0, source: "analyst" }],
    entities: {},
    patterns: { ip: true, email: true, host: true, guid: true, mac: false },
    questions: [
      { id: "q1", text: "What is col?", options: ["person", "vocabulary", "value"], answer: null, about: loc },
      { id: "q2", text: "Is this a test corpus?", options: ["yes", "no"], answer: null },
    ],
  });

  test.each([
    ["person", { class: "person", treatment: "blind" }],
    ["vocabulary", { class: "vocabulary", treatment: "keep" }],
    ["value", { class: "unknown", treatment: "blind" }],
  ] as const)("%s", (option, expected) => {
    const s = answerQuestion(spec(), "q1", option, policy);
    expect(s.columns[0]).toMatchObject({ ...expected, confidence: 1, source: "human" });
    expect(s.questions[0]?.answer).toBe(option);
  });

  test.each([
    ["value", { class: "person", treatment: "value" }],
    ["blind", { class: "person", treatment: "blind" }],
    ["keep", { class: "person", treatment: "keep" }],
  ] as const)("%s on a classified column keeps its class", (option, expected) => {
    const base = spec();
    base.columns[0] = { ...loc, class: "person", treatment: "blind", confidence: 0.4, source: "analyst" };
    base.questions[0] = { id: "q1", text: "Hide col?", options: ["value", "blind", "keep"], answer: null, about: loc };
    const s = answerQuestion(base, "q1", option, policy);
    expect(s.columns[0]).toMatchObject({ ...expected, confidence: 1, source: "human" });
  });

  test("a class the policy does not call sensitive is kept", () => {
    const p = defaultPolicy();
    p.sensitive.classes = ["host"];
    expect(answerQuestion(spec(), "q1", "person", p).columns[0]).toMatchObject({ class: "person", treatment: "keep" });
  });

  test("a question about no column only records the answer", () => {
    const s = answerQuestion(spec(), "q2", "yes", policy);
    expect(s.columns).toEqual(spec().columns);
    expect(s.questions[1]?.answer).toBe("yes");
  });
});
