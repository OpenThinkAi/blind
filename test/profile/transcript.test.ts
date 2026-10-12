import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristicSpec } from "../../src/analyst/heuristic.ts";
import { assertProfilePayload, ModelRefusal, profilePayload } from "../../src/model.ts";
import { renderProfile } from "../../src/profile/command.ts";
import { buildProfile, forPrivacyMode } from "../../src/profile/profile.ts";
import { tokeniseProfile } from "../../src/profile/tokens.ts";
import { defaultPolicy } from "../../src/policy.ts";
import { validateProfile } from "../../src/validate.ts";
import { buildZip } from "../formats/zipfixture.ts";

// Synthetic transcripts only: invented speakers.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blind-transcript-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel: string, content: string | Uint8Array): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const VTT = [
  "WEBVTT",
  "00:01.000 --> 00:03.000\n<v Avery Quill>Morning Teagan, the deck is ready.</v>",
  "00:03.500 --> 00:05.000\n<v Teagan Marlow>Thanks Avary.</v>",
  "00:05.500 --> 00:07.000\n<v Avery Quill>Next item.</v>",
].join("\n\n");

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return buildZip([
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "_rels/.rels",
      data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    { name: "word/document.xml", data: `${DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ]);
}

describe("profiling transcripts", () => {
  test("VTT, SRT, text and DOCX transcripts list their speakers and sample lines", () => {
    put("kit/standup.vtt", `${VTT}\n`);
    put("kit/call.srt", "1\n00:00:01,000 --> 00:00:02,000\nKestrel Oduya: Hello.\n\n2\n00:00:02,500 --> 00:00:04,000\nBrisco Lantry: Hi Kestrel.\n");
    put("kit/notes.txt", "[00:00:01] Avery Quill: Start.\n[00:00:04] Brisco Lantry: Done.\n");
    put("kit/sync.docx", docx(["Teagan Marlow   0:03", "Welcome all.", "Avery Quill   0:09", "Thanks."]));
    put("kit/memo.docx", docx(["Just a memo."]));
    put("kit/fake.vtt", "WEBVTT\n");
    const { profile, skipped } = buildProfile(["kit"], 5, dir);
    expect(validateProfile(profile).ok).toBe(true);
    expect(profile.files).toEqual([
      { path: "call.srt", format: "srt", size: expect.any(Number) },
      { path: "memo.docx", format: "docx", size: expect.any(Number) },
      { path: "notes.txt", format: "text", size: expect.any(Number) },
      { path: "standup.vtt", format: "vtt", size: expect.any(Number) },
      { path: "sync.docx", format: "docx", size: expect.any(Number) },
    ]);
    expect(profile.transcripts).toEqual([
      { file: "call.srt", speakers: ["Kestrel Oduya", "Brisco Lantry"], sampleLines: ["Kestrel Oduya: Hello.", "Brisco Lantry: Hi Kestrel."] },
      { file: "notes.txt", speakers: ["Avery Quill", "Brisco Lantry"], sampleLines: ["Avery Quill: Start.", "Brisco Lantry: Done."] },
      {
        file: "standup.vtt",
        speakers: ["Avery Quill", "Teagan Marlow"],
        sampleLines: ["Avery Quill: Morning Teagan, the deck is ready.", "Teagan Marlow: Thanks Avary.", "Avery Quill: Next item."],
      },
      { file: "sync.docx", speakers: ["Teagan Marlow", "Avery Quill"], sampleLines: ["Teagan Marlow: Welcome all.", "Avery Quill: Thanks."] },
    ]);
    // A transcript-shaped text file is a document too, and a prose DOCX is a document (AGT-1833).
    expect(profile.documents.map((d) => d.file)).toEqual(["memo.docx", "notes.txt"]);
    expect(profile.documents[0]).toEqual({ file: "memo.docx", outline: ["Just a memo."], sampleSentences: ["Just a memo."] });
    expect(skipped).toEqual([
      { path: "fake.vtt", reason: "not a WebVTT transcript (no cue timing found)" },
    ]);
    const shown = renderProfile(profile, skipped, []);
    expect(shown).toContain('"standup.vtt"  vtt');
    expect(shown).toContain('speakers: "Avery Quill", "Teagan Marlow"');
  });

  test("a prose DOCX is profiled as a document with an outline and sample sentences", () => {
    put("memo.docx", docx(["Quarterly Notes", "Reggie Hollis met Ines Varga on Monday. They agreed on the plan.", "", "Reggie Hollis will follow up."]));
    const { profile, skipped } = buildProfile(["memo.docx"], 5, dir);
    expect(validateProfile(profile).ok).toBe(true);
    expect(skipped).toEqual([]);
    expect(profile.transcripts).toEqual([]);
    expect(profile.documents).toEqual([
      {
        file: "memo.docx",
        outline: ["Quarterly Notes"],
        sampleSentences: ["Quarterly Notes", "Reggie Hollis met Ines Varga on Monday.", "They agreed on the plan.", "Reggie Hollis will follow up."],
      },
    ]);
  });

  test("sample lines respect sampleCount", () => {
    put("standup.vtt", `${VTT}\n`);
    expect(buildProfile(["standup.vtt"], 1, dir).profile.transcripts[0]?.sampleLines).toEqual(["Avery Quill: Morning Teagan, the deck is ready."]);
    expect(buildProfile(["standup.vtt"], 0, dir).profile.transcripts[0]?.sampleLines).toEqual([]);
  });

  test("profile-only leaves the speakers out, and a profile carrying them is refused before sending", () => {
    put("standup.vtt", `${VTT}\n`);
    const local = buildProfile(["standup.vtt"], 2, dir);
    const remote = forPrivacyMode(local, "profile-only");
    expect(remote.profile.transcripts[0]?.speakers).toEqual([]);
    expect(remote.notes).toContain("privacy.mode is profile-only: the speaker list of 1 transcript(s) is left out");
    const policy = defaultPolicy();
    expect(() => assertProfilePayload(profilePayload(tokeniseProfile(remote.profile).profile, policy))).not.toThrow();
    expect(() => assertProfilePayload(profilePayload(tokeniseProfile(local.profile).profile, policy))).toThrow(ModelRefusal);
    expect(() => assertProfilePayload(profilePayload(tokeniseProfile(local.profile).profile, policy))).toThrow("$.profile.transcripts[0].speakers");
  });

  test("the heuristic analyst proposes each speaker as a person, leaving out keep terms", () => {
    put("standup.vtt", `${VTT}\n\n00:08.000 --> 00:09.000\n<v Helpdesk Bot>Logged.</v>\n`);
    const { profile } = buildProfile(["standup.vtt"], 2, dir);
    const policy = defaultPolicy();
    policy.keep.terms = ["Helpdesk Bot"];
    expect(heuristicSpec(profile, policy).entities).toEqual({
      person: [
        { canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] },
        { canonical: "Teagan Marlow", aliases: [], parts: ["Teagan", "Marlow"] },
      ],
    });
    policy.sensitive.classes = policy.sensitive.classes.filter((c) => c !== "person");
    expect(heuristicSpec(profile, policy).entities).toEqual({});
  });
});
