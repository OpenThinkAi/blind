import { describe, expect, test } from "bun:test";
import { MAX_OUTLINE, profileText } from "../../src/profile/text.ts";

const MD = [
  "# Weekly notes",
  "",
  "Avery Quill will migrate db01.example.com on Friday. Robin Example reviewed",
  "the plan!",
  "",
  "## Next steps ##",
  "",
  "```",
  "# not a heading",
  "Not a sentence either.",
  "```",
  "Ask Sam about the budget?",
  "",
].join("\n");

describe("profileText", () => {
  test("Markdown outline: the first line once, then headings; fenced code skipped", () => {
    const d = profileText("notes.md", MD, "markdown", 5);
    expect(d.outline).toEqual(["Weekly notes", "Next steps"]);
    expect(d.sampleSentences).toEqual([
      "Avery Quill will migrate db01.example.com on Friday.",
      "Robin Example reviewed the plan!",
      "Ask Sam about the budget?",
    ]);
  });

  test("plain text: the outline is the first line only; # lines are prose", () => {
    const d = profileText("a.txt", "Memo to the team\n# 1 item\n\nSecond paragraph here.", "text", 5);
    expect(d.outline).toEqual(["Memo to the team"]);
    expect(d.sampleSentences).toEqual(["Memo to the team # 1 item", "Second paragraph here."]);
  });

  test("logs: each line is a sample unit", () => {
    const d = profileText("a.log", "10:00 start\n10:01 user ada@example.com login. ok\n\n10:02 stop\n", "log", 2);
    expect(d.outline).toEqual(["10:00 start"]);
    expect(d.sampleSentences).toEqual(["10:00 start", "10:01 user ada@example.com login. ok"]);
  });

  test("k limits samples, 0 allowed, duplicates collapse", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i % 10}.`).join(" ");
    expect(profileText("a.txt", text, "text", 3).sampleSentences).toEqual(["Sentence 0.", "Sentence 3.", "Sentence 6."]);
    expect(profileText("a.txt", text, "text", 0).sampleSentences).toEqual([]);
  });

  test("every outline entry and sample is at most 120 characters", () => {
    const long = "w".repeat(500);
    const d = profileText("a.md", `${long}\n\n# ${long}\n\n${long}. ${long}!`, "markdown", 5);
    for (const s of [...d.outline, ...d.sampleSentences]) expect([...s].length).toBeLessThanOrEqual(120);
  });

  test("the outline is capped", () => {
    const text = Array.from({ length: 80 }, (_, i) => `# H${i}`).join("\n");
    expect(profileText("a.md", text, "markdown", 0).outline.length).toBe(MAX_OUTLINE);
  });

  test("an empty file has no outline and no samples", () => {
    expect(profileText("e.txt", "", "text", 5)).toEqual({ file: "e.txt", outline: [], sampleSentences: [] });
  });
});
