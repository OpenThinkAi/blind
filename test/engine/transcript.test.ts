import { describe, expect, test } from "bun:test";
import { renderReport } from "../../src/apply.ts";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { oneEdit, parseEntry, planTranscript, shapeParagraphs, speakerForms } from "../../src/engine/transcript.ts";
import type { Spec } from "../../src/schema.ts";
import { buildZip, type FixtureEntry, readZip } from "../formats/zipfixture.ts";

// Generated transcripts. Every name is invented; nothing comes from a real meeting.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 41);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const PSEUDO = /^Person_[0-9A-F]{4}$/;
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function spec(over: Partial<Spec> = {}): Spec {
  return {
    version: 1,
    columns: [],
    entities: {},
    patterns: { ip: true, email: true, host: true, guid: false, mac: true },
    questions: [],
    ...over,
  };
}

const apply = (files: Record<string, string | Uint8Array>, s: Spec = spec(), keep: string[] = []): ApplyResult =>
  applySpec(
    Object.entries(files).map(([path, v]): InputFile => ({ path, bytes: typeof v === "string" ? enc(v) : v })),
    s,
    { salt: SALT, keep },
  );
const out = (r: ApplyResult, path: string) => dec((r.outputs.find((o) => o.path === path) as InputFile).bytes);

interface Speaker {
  name: string;
  parts: string[];
  /** Speech-to-text misspellings, one edit from a part. */
  typos: string[];
}

const SPEAKERS: Speaker[] = [
  { name: "Avery Quill", parts: ["Avery", "Quill"], typos: ["Avary", "Quil"] },
  { name: "Teagan Marlow", parts: ["Teagan", "Marlow"], typos: ["Teagen", "Marlowe"] },
  { name: "Kestrel Oduya", parts: ["Kestrel", "Oduya"], typos: ["Kestral", "Oduyah"] },
  { name: "Brisco Lantry", parts: ["Brisco", "Lantry"], typos: ["Brisko", "Lantrey"] },
];
const OPENERS = ["Thanks", "Right", "Okay", "Good point", "Agreed"];
const CLOSERS = ["can you take the next item", "the numbers look fine", "please send the notes", "we can move on"];

/** A small deterministic generator (an LCG), so the fixture is the same on every run. */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

interface Turn {
  speaker: Speaker;
  mention: string;
  about: Speaker;
  text: string;
}

function turns(n: number, seed: number): Turn[] {
  const r = rng(seed);
  const pickOf = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  return Array.from({ length: n }, (_, i) => {
    const speaker = SPEAKERS[i % SPEAKERS.length] as Speaker;
    const about = SPEAKERS[(i + 1 + Math.floor(r() * 3)) % SPEAKERS.length] as Speaker;
    const mention = pickOf([about.name, ...about.parts, ...about.typos]);
    return { speaker, about, mention, text: `${pickOf(OPENERS)} ${mention}, ${pickOf(CLOSERS)}.` };
  });
}

const hex = (r: () => number, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
const time = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;

/** A Teams-style WebVTT: a GUID cue identifier per utterance, voice tags. */
function teamsVtt(ts: readonly Turn[]): string {
  const r = rng(7);
  const guids = Array.from({ length: 5 }, () => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`);
  const cues = ts.map((t, i) => `${guids[i % guids.length]}/${i + 10}-0\n${time(i * 4)} --> ${time(i * 4 + 3)}\n<v ${t.speaker.name}>${t.text}</v>`);
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** Whole-word occurrences of `word` in `text`. */
const occurrences = (text: string, word: string): number =>
  (text.match(new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, "gu")) ?? []).length;

describe("detection by content", () => {
  test("WebVTT needs the header and cue timing; SRT needs numbered cues", () => {
    expect(planTranscript("WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n")?.kind).toBe("vtt");
    expect(planTranscript("WEBVTT\n")).toBeNull();
    expect(planTranscript("1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n")?.kind).toBe("srt");
    expect(planTranscript("00:00:01,000 --> 00:00:02,000\nHello\n")).toBeNull();
  });

  test("text is a transcript when at least 80% of its non-empty paragraphs are timestamp, speaker, text entries", () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => `[00:00:0${i}] Avery Quill: point ${i}`);
    expect(planTranscript([...entries(4), "", "A closing remark."].join("\n"))?.kind).toBe("text"); // 4 of 5
    expect(planTranscript([...entries(3), "", "One remark.", "", "Another remark."].join("\n"))).toBeNull(); // 3 of 5
    expect(planTranscript(entries(1).join("\n"))).toBeNull(); // too few entries
    expect(planTranscript("Meeting notes\n\nWe agreed on the plan.\n")).toBeNull();
  });

  test("entry shapes: timestamp first, speaker first, header-only and VTT-style ranges", () => {
    expect(parseEntry("[00:00:03] Avery Quill: hello")?.tag.name).toBe("Avery Quill");
    expect(parseEntry("00:03 - Teagan Marlow: hi")?.tag.name).toBe("Teagan Marlow");
    expect(parseEntry("0:00:03.120 --> 0:00:05.480\nKestrel Oduya\nhello")?.tag.name).toBe("Kestrel Oduya");
    const teams = parseEntry("Brisco Lantry   0:03");
    expect(teams?.tag.name).toBe("Brisco Lantry");
    expect(teams?.headerOnly).toBe(true);
    expect(parseEntry("Meeting at 10:30 in room 4")).toBeNull(); // "at" is a lowercase dictionary word
    expect(parseEntry("We agreed on the plan.")).toBeNull();
    const shape = shapeParagraphs(["Brisco Lantry   0:03", "Hello all.", "Avery Quill   0:09", "Morning."]);
    expect(shape.shaped).toBe(true);
    expect(shape.entries).toEqual([
      { speaker: "Brisco Lantry", text: "Hello all." },
      { speaker: "Avery Quill", text: "Morning." },
    ]);
  });

  test("one edit means one insertion, deletion or substitution", () => {
    expect(oneEdit("avery", "avary")).toBe(true);
    expect(oneEdit("quill", "quil")).toBe(true);
    expect(oneEdit("marlow", "marlowe")).toBe(true);
    expect(oneEdit("avery", "avery")).toBe(false);
    expect(oneEdit("avery", "evary")).toBe(false);
    expect(oneEdit("quill", "qu")).toBe(false);
  });
});

describe("generated Teams VTT", () => {
  const ts = turns(80, 1749);
  const input = teamsVtt(ts);
  const r = apply({ "standup.vtt": input });
  const text = out(r, "standup.vtt");

  test("every speaker tag is replaced, one speaker one pseudonym", () => {
    const tags = [...text.matchAll(/<v ([^>]*)>/g)].map((m) => m[1] as string);
    expect(tags.length).toBe(ts.length);
    expect(tags.every((t) => PSEUDO.test(t))).toBe(true);
    const bySpeaker = new Map<string, Set<string>>();
    ts.forEach((t, i) => bySpeaker.set(t.speaker.name, (bySpeaker.get(t.speaker.name) ?? new Set()).add(tags[i] as string)));
    for (const set of bySpeaker.values()) expect(set.size).toBe(1);
    expect(new Set([...bySpeaker.values()].map((s) => [...s][0])).size).toBe(SPEAKERS.length);
  });

  test("at least 95% of spoken mentions (names, parts, misspellings) are replaced, with the speaker's pseudonym", () => {
    const tags = [...text.matchAll(/<v ([^>]*)>/g)].map((m) => m[1] as string);
    const pseudonymOf = new Map(ts.map((t, i) => [t.speaker.name, tags[i] as string]));
    const payloads = [...text.matchAll(/<v [^>]*>([^<]*)<\/v>/g)].map((m) => m[1] as string);
    let replaced = 0;
    ts.forEach((t, i) => {
      if ((payloads[i] as string).includes(`${pseudonymOf.get(t.about.name)},`)) replaced++;
    });
    expect(replaced / ts.length).toBeGreaterThanOrEqual(0.95);
    for (const s of SPEAKERS) for (const w of [...s.parts, ...s.typos]) expect(occurrences(text, w)).toBe(0);
  });

  test("timing lines are byte-identical and cue GUIDs become GUIDs, the same GUID the same pseudonym", () => {
    const timing = (s: string) => s.split("\n").filter((l) => l.includes("-->"));
    expect(timing(text)).toEqual(timing(input));
    const ids = (s: string) => s.split("\n").filter((l) => /\/\d+-0$/.test(l));
    const before = ids(input);
    const after = ids(text);
    expect(after.length).toBe(before.length);
    const mapping = new Map<string, string>();
    before.forEach((b, i) => {
      const a = after[i] as string;
      expect(a).toMatch(new RegExp(`^${GUID.source}/${b.split("/")[1]}$`, "i"));
      const from = (GUID.exec(b) as RegExpExecArray)[0];
      const to = (GUID.exec(a) as RegExpExecArray)[0];
      expect(to).not.toBe(from);
      expect(mapping.get(from) ?? to).toBe(to);
      mapping.set(from, to);
    });
    expect(text.startsWith("WEBVTT\n\n")).toBe(true);
  });

  test("the report says how the file was read and what was replaced", () => {
    const f = r.files[0];
    expect(f?.format).toBe("vtt");
    expect(f?.transcript).toEqual({ kind: "vtt", speakers: 4, speakerTags: 80, keptTags: 0, spokenMentions: 80 });
    expect(renderReport(r)).toContain("transcript (WebVTT): 4 speakers; 80 speaker tags and 80 spoken mentions replaced");
  });

  test("the result does not depend on input order and is reversible through the map", () => {
    const again = applySpec([{ path: "z.txt", bytes: enc("Avery Quill here.") }, { path: "standup.vtt", bytes: enc(input) }], spec(), { salt: SALT });
    expect(out(again, "standup.vtt")).toBe(text);
    const people = r.map.entries.filter((e) => e.kind === "person").map((e) => e.value);
    for (const s of SPEAKERS) expect(people).toContain(s.name);
  });
});

describe("SRT and text transcripts", () => {
  test("SRT: speaker prefixes are replaced; cue numbers and timing stay; a dictionary-word prefix is not a speaker", () => {
    const srt = [
      "1\n00:00:01,000 --> 00:00:03,000\nAvery Quill: Morning, Teagan.",
      "2\n00:00:03,500 --> 00:00:06,000\n- Teagan Marlow: Hi Avary.\n- Avery Quill: Ready?",
      "3\n00:00:06,500 --> 00:00:08,000\nNote: the agenda moved.",
    ].join("\n\n");
    const r = apply({ "call.srt": `${srt}\n` });
    const text = out(r, "call.srt");
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["1", "00:00:01,000 --> 00:00:03,000"]);
    expect(lines[2]).toMatch(/^Person_[0-9A-F]{4}: Morning, Person_[0-9A-F]{4}\.$/);
    expect(lines[6]).toMatch(/^- Person_[0-9A-F]{4}: Hi Person_[0-9A-F]{4}\.$/);
    expect(text).toContain("Note: the agenda moved.");
    const avery = (lines[2] as string).slice(0, 11);
    expect(lines[6]?.endsWith(`${avery}.`)).toBe(true); // "Avary" is Avery
    expect(lines[7]?.startsWith(`- ${avery}:`)).toBe(true);
    expect(r.files[0]?.transcript?.kind).toBe("srt");
  });

  test("text: timestamps stay, speakers are replaced, a .txt holding WebVTT is read as WebVTT", () => {
    const txt = "[00:00:01] Avery Quill: Over to Kestrel.\n[00:00:05] Kestrel Oduya: Thanks, Quill.\n";
    const vttInTxt = "WEBVTT\n\n00:01.000 --> 00:02.000\nBrisco Lantry: hello\n";
    const r = apply({ "a.txt": txt, "b.txt": vttInTxt });
    expect(out(r, "a.txt")).toMatch(/^\[00:00:01\] (Person_[0-9A-F]{4}): Over to (Person_[0-9A-F]{4})\.\n\[00:00:05\] \2: Thanks, \1\.\n$/);
    expect(r.files.map((f) => f.format)).toEqual(["text", "vtt"]);
    expect(out(r, "b.txt")).toMatch(/^WEBVTT\n\n00:01\.000 --> 00:02\.000\nPerson_[0-9A-F]{4}: hello\n$/);
  });

  test("a .vtt or .srt that is not a transcript is listed and not written", () => {
    const r = apply({ "bad.vtt": "just some text\n", "bad.srt": "WEBVTT\n" });
    expect(r.outputs).toEqual([]);
    expect(r.skipped.map((s) => s.path)).toEqual(["bad.srt", "bad.vtt"]);
    expect(r.skipped[1]?.reason).toContain("not a WebVTT transcript");
  });

  test("speakers are blinded consistently across the corpus: CSV cells, other documents and file names", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Avery Quill>Hello.</v>\n";
    const r = apply({ "call.vtt": vtt, "notes.md": "Avery said Quill would call.\n", "people.csv": "Role,Comment\nlead,Avery Quill approved\n", "Avery Quill.txt": "x\n" });
    const p = (/<v (Person_[0-9A-F]{4})>/.exec(out(r, "call.vtt")) as RegExpExecArray)[1] as string;
    expect(out(r, "notes.md")).toBe(`${p} said ${p} would call.\n`);
    expect(out(r, "people.csv")).toBe(`Role,Comment\nlead,${p} approved\n`);
    expect(r.outputs.map((o) => o.path)).toContain(`${p}.txt`);
    expect(r.files.find((f) => f.path === "notes.md")?.speakerMentions).toBe(2);
    expect(renderReport(r)).toContain("2 transcript speaker names replaced");
  });

  test("a spec entity for the speaker shares the pseudonym", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Avery Quill>Hello AQ.</v>\n";
    const r = apply({ "call.vtt": vtt }, spec({ entities: { person: [{ canonical: "Avery Quill", aliases: ["AQ"], parts: ["Avery"] }] } }));
    expect(out(r, "call.vtt")).toMatch(/<v (Person_[0-9A-F]{4})>Hello \1\.<\/v>/);
  });

  test("keep-list and vocabulary speakers are kept and counted", () => {
    const vtt = "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Moderator>Welcome.</v>\n\n00:03.000 --> 00:04.000\n<v Helpdesk Bot>Ticket opened.</v>\n\n00:05.000 --> 00:06.000\n<v Avery Quill>Thanks.</v>\n";
    const r = apply({ "call.vtt": vtt }, spec({ entities: { vocabulary: [{ canonical: "Moderator", aliases: [], parts: [] }] } }), ["Helpdesk Bot"]);
    const text = out(r, "call.vtt");
    expect(text).toContain("<v Moderator>Welcome.");
    expect(text).toContain("<v Helpdesk Bot>Ticket opened.");
    expect(text).toMatch(/<v Person_[0-9A-F]{4}>Thanks\./);
    expect(r.files[0]?.transcript).toMatchObject({ speakerTags: 1, keptTags: 2 });
    expect(renderReport(r)).toContain("2 tags kept (keep list or spec vocabulary)");
  });

  test("a part two speakers share gets its own pseudonym; the guid pattern stays off outside cue identifiers", () => {
    const vtt = [
      "WEBVTT",
      "00:01.000 --> 00:02.000\n<v Avery Quill>Avery, see 0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f.</v>",
      "00:03.000 --> 00:04.000\n<v Avery Stone>Noted.</v>",
    ].join("\n\n");
    const text = out(apply({ "call.vtt": `${vtt}\n` }), "call.vtt");
    const tags = [...text.matchAll(/<v (Person_[0-9A-F]{4})>/g)].map((m) => m[1]);
    const mention = (/>(Person_[0-9A-F]{4}), see/.exec(text) as RegExpExecArray)[1];
    expect(new Set([...tags, mention]).size).toBe(3);
    expect(text).toContain("0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f");
  });

  test("speakerForms: parts and misspellings carry the speaker's name; dictionary parts are left out", () => {
    const forms = speakerForms(["Avery Quill", "Will Brisco"], ["Hi Avary and Brisko, see Will."], new Set());
    const by = Object.fromEntries(forms.map((f) => [f.form, f.value]));
    expect(by).toEqual({ Avary: "Avery Quill", Avery: "Avery Quill", "Avery Quill": "Avery Quill", Brisco: "Will Brisco", Brisko: "Will Brisco", Quill: "Avery Quill", "Will Brisco": "Will Brisco" });
    expect(forms.every((f) => f.cls === "person" && f.source === "speaker")).toBe(true);
  });
});

// A transcript saved as Word: Teams writes each turn as a speaker-and-time paragraph followed by its text.
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (text: string) => `<w:r><w:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ""}>${text}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p>${runs.join("")}</w:p>`;

function docx(body: string): Uint8Array {
  const entries: FixtureEntry[] = [
    { name: "[Content_Types].xml", data: `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "_rels/.rels",
      data: `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    { name: "word/document.xml", data: `${DECL}<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>` },
  ];
  return buildZip(entries);
}

/** The visible text of each paragraph of the output's word/document.xml. */
function paragraphs(bytes: Uint8Array): string[] {
  const xml = (readZip(bytes).find((e) => e.name === "word/document.xml") as { text: string }).text;
  return [...xml.matchAll(/<w:p>(.*?)<\/w:p>/g)].map((m) =>
    [...(m[1] as string).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\/>/g)].map((t) => (t[0] === "<w:br/>" ? "\n" : t[1])).join(""),
  );
}

describe("generated transcript-shaped DOCX", () => {
  const ts = turns(60, 99);
  const clock = (i: number) => `${Math.floor(i / 6)}:${String((i * 10) % 60).padStart(2, "0")}`;
  const body = [
    para(run("Weekly sync")),
    ...ts.flatMap((t, i) => {
      // Odd turns split the speaker's name across runs, as Word does after an edit.
      const head = i % 2 === 1 ? [run(t.speaker.name.slice(0, 3)), run(`${t.speaker.name.slice(3)}   ${clock(i)}`)] : [run(`${t.speaker.name}   ${clock(i)}`)];
      return [para(...head), para(run(t.text))];
    }),
    // The timestamp-first shape, with line breaks inside one paragraph.
    para(run("0:10:00.120 --> 0:10:03.480"), "<w:r><w:br/></w:r>", run("Avery Quill"), "<w:r><w:br/></w:r>", run("That wraps it up, Teagen.")),
  ].join("");
  const input = docx(body);
  const r = apply({ "sync.docx": input });
  const before = paragraphs(input);
  const after = paragraphs((r.outputs[0] as InputFile).bytes);

  test("the DOCX is read as a transcript, and every speaker is replaced", () => {
    expect(r.files[0]?.transcript?.kind).toBe("docx");
    expect(r.files[0]?.transcript?.speakers).toBe(4);
    expect(after.length).toBe(before.length);
    const pseudonymOf = new Map<string, string>();
    ts.forEach((t, i) => {
      const head = after[1 + 2 * i] as string;
      const m = /^(Person_[0-9A-F]{4})   (\d+:\d{2})$/.exec(head);
      expect(m).not.toBeNull();
      expect(m?.[2]).toBe(clock(i)); // the timestamp is unchanged
      expect(pseudonymOf.get(t.speaker.name) ?? m?.[1]).toBe(m?.[1] as string);
      pseudonymOf.set(t.speaker.name, m?.[1] as string);
    });
    expect(new Set(pseudonymOf.values()).size).toBe(SPEAKERS.length);
    const last = after[after.length - 1] as string;
    expect(last).toBe(`0:10:00.120 --> 0:10:03.480\n${pseudonymOf.get("Avery Quill")}\nThat wraps it up, ${pseudonymOf.get("Teagan Marlow")}.`);
    expect(after[0]).toBe("Weekly sync");
  });

  test("at least 95% of spoken mentions are replaced with the speaker's pseudonym", () => {
    const pseudonymOf = new Map(ts.map((t, i) => [t.speaker.name, (after[1 + 2 * i] as string).slice(0, 11)]));
    let replaced = 0;
    ts.forEach((t, i) => {
      if ((after[2 + 2 * i] as string).includes(`${pseudonymOf.get(t.about.name)},`)) replaced++;
    });
    expect(replaced / ts.length).toBeGreaterThanOrEqual(0.95);
    const all = after.join("\n");
    for (const s of SPEAKERS) for (const w of [...s.parts, ...s.typos]) expect(occurrences(all, w)).toBe(0);
  });

  test("a DOCX that is not transcript-shaped is not read as one", () => {
    const plain = docx([para(run("Avery Quill   0:03")), para(run("Notes from the call.")), para(run("More notes.")), para(run("Even more."))].join(""));
    const p = apply({ "notes.docx": plain });
    expect(p.files[0]?.transcript).toBeUndefined();
    expect(paragraphs((p.outputs[0] as InputFile).bytes)[0]).toBe("Avery Quill   0:03");
  });
});
