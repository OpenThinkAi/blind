// Transcripts, detected by content shape rather than by extension: WebVTT (a
// WEBVTT header and cue timing), SRT (numbered cues with timing), and DOCX or
// text files whose paragraphs follow a timestamp, speaker, text pattern
// (TRANSCRIPT_SHARE of the non-empty paragraphs, and at least MIN_ENTRIES).
// Pure and deterministic; the engine (apply.ts) and the profiler share it, so a
// file the profile calls a transcript is the file apply treats as one.
//
// What a transcript adds to free-text blinding:
// - Speaker tags and prefixes (`<v Avery Quill>`, `Avery Quill: ...`, and the
//   speaker of a timestamped paragraph) are always replaced with that person's
//   `Person_` pseudonym, whatever the spec lists. A tag equal to a keep-list
//   term or a spec vocabulary form is kept as written.
// - Each speaker's name, its parts (given name, surname) and the spoken words
//   within one edit of a part (speech-to-text misspellings) become person forms
//   of the corpus-wide TextScanner (speakerForms), so they are replaced with the
//   speaker's one pseudonym in every file, not only in the transcript.
// - GUIDs in cue identifiers (Teams writes `<guid>/<n>-<m>`) are replaced with
//   GUID-shaped pseudonyms even when the spec's guid pattern is off.
// - Cue timing lines, SRT cue numbers and paragraph timestamps are never
//   scanned, so they stay byte-identical.

import { DICTIONARY } from "../profile/words.ts";
import { nameParts, recurrenceExclusion } from "./recur.ts";
import type { ExtraForm, Span } from "./text.ts";

export type TranscriptKind = "vtt" | "srt" | "text";

/** The share of non-empty paragraphs that must be timestamp, speaker, text entries. */
export const TRANSCRIPT_SHARE = 0.8;
/** The fewest timestamped speaker entries a DOCX or text transcript has. */
export const MIN_ENTRIES = 2;
/** The longest speaker label read as one (characters). */
export const MAX_SPEAKER = 60;
/** Parts and spoken words shorter than this are not matched within one edit. */
export const MIN_FUZZY_LENGTH = 4;

export interface Region {
  start: number;
  end: number;
}

/** A speaker name in the text: the span replaced with that speaker's pseudonym. */
export interface Tag extends Region {
  /** The name, trimmed, whitespace collapsed: what the pseudonym is derived from. */
  name: string;
}

/** One spoken turn: its speaker (null when the line names none) and its text. */
export interface Entry {
  speaker: string | null;
  text: string;
}

export interface TranscriptPlan {
  kind: TranscriptKind;
  tags: Tag[];
  /** GUIDs in cue identifiers. */
  guids: Region[];
  /** Timing lines, cue numbers and timestamps: never changed. */
  fixed: Region[];
  entries: Entry[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const normName = (s: string): string => s.trim().replace(/\s+/g, " ");
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

// A name: up to five words, the first capitalised. Words are letters, digits, apostrophes and
// hyphens, or a short abbreviation ending in a dot ("Dr.", "A."); "Quill, Avery" is one name.
const WORD = "(?:[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}'’\\-]*|\\p{Lu}\\p{L}{0,2}\\.)";
const FIRST = "(?:\\p{Lu}[\\p{L}\\p{M}\\p{N}'’\\-]*|\\p{Lu}\\p{L}{0,2}\\.)";
const NAME = `${FIRST}(?:,?[ \\t]+${WORD}){0,4}`;
const PAREN = "(?:[ \\t]*\\([^()\\r\\n]{1,40}\\))?";
const TS_CORE = "\\d{1,2}(?::\\d{1,2}){1,2}(?:[.,]\\d{1,3})?";
const TS = `[\\[(]?${TS_CORE}(?:[ \\t]*-->[ \\t]*${TS_CORE})?[\\])]?`;
const EOL = "(?=\\r?\\n|\\r|$)";
const AFTER = `(?:[ \\t]*:(?=[ \\t]|\\r?\\n|\\r|$)|[ \\t]*${EOL})`;

// "00:03 Avery Quill: text", "[00:00:03] Avery Quill\ntext", "00:00:03.120 --> 00:00:05.480\nAvery Quill\ntext".
const TS_FIRST = new RegExp(`^[ \\t]*(${TS})(?:[ \\t]*[-–—|][ \\t]*|[ \\t]+|[ \\t]*(?:\\r?\\n|\\r)[ \\t]*)(${NAME})${PAREN}${AFTER}`, "du");
// "Avery Quill   0:03\ntext", "Avery Quill (0:03): text".
const NAME_FIRST = new RegExp(`^[ \\t]*(${NAME})${PAREN}(?:[ \\t]*[-–—|][ \\t]*|[ \\t]+)(${TS})(?:${AFTER}|[ \\t]+(?=\\S))`, "du");
const TS_START = new RegExp(`^[ \\t]*${TS}(?:[ \\t]|$)`, "u");
// A speaker prefix on a caption line: "Avery Quill: text", "- Avery: text", ">> Avery: text".
const PREFIX = new RegExp(`^[ \\t]*(?:(?:-|>>)[ \\t]*)?(${NAME})${PAREN}[ \\t]*:(?=[ \\t]|$)`, "du");

const CUE_TIME = "(?:\\d+:)?\\d{1,2}:\\d{2}[.,]\\d{1,3}";
const TIMING = new RegExp(`^[ \\t]*${CUE_TIME}[ \\t]+-->[ \\t]+${CUE_TIME}(?:[ \\t].*)?$`);
const SRT_INDEX = /^[ \t]*\d+[ \t]*$/;
const VOICE = /<v(?:\.[^\s>]*)?[ \t]+([^>]*)>/g;
const INLINE_TIME = /<(?:\d+:)?\d{2}:\d{2}\.\d{3}>/g;
const GUID = /(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])/g;

/**
 * Whether `name` reads as a speaker: at most MAX_SPEAKER characters, two or more letters, and no
 * lowercase dictionary word ("Meeting at" is not a name). `strict` (a caption prefix, with no
 * timestamp to back it) also rejects a name made only of dictionary words ("Note:", "Action:").
 */
function plausible(name: string, strict: boolean): boolean {
  if ([...name].length > MAX_SPEAKER || (name.match(/\p{L}/gu) ?? []).length < 2) return false;
  const words = name.split(/[\s,]+/).map((w) => w.replace(/\.$/, "")).filter((w) => w !== "");
  if (words.some((w) => /^\p{Ll}/u.test(w) && DICTIONARY.has(w))) return false;
  return !(strict && words.every((w) => DICTIONARY.has(w.toLowerCase())));
}

/** A timestamp, speaker, text paragraph: offsets into the paragraph. */
export interface EntryMatch {
  ts: Region;
  tag: Tag;
  /** Where the spoken text starts. */
  textStart: number;
  /** Nothing follows the header in this paragraph: the text is the next paragraph. */
  headerOnly: boolean;
}

/** Reads `para` as a transcript entry, or returns null. */
export function parseEntry(para: string): EntryMatch | null {
  for (const [re, tsGroup, nameGroup] of [[TS_FIRST, 1, 2], [NAME_FIRST, 2, 1]] as const) {
    const m = re.exec(para);
    if (m === null) continue;
    const ts = m.indices?.[tsGroup];
    const nm = m.indices?.[nameGroup];
    const raw = m[nameGroup] as string;
    if (ts === undefined || nm === undefined || !plausible(normName(raw), false)) continue;
    const textStart = m.index + m[0].length;
    return {
      ts: { start: ts[0], end: ts[1] },
      tag: { start: nm[0], end: nm[1], name: normName(raw) },
      textStart,
      headerOnly: para.slice(textStart).trim() === "",
    };
  }
  return null;
}

/** A caption line's speaker prefix ("Avery Quill: ..."), or null. */
function parsePrefix(line: string): { tag: Tag; textStart: number } | null {
  const m = PREFIX.exec(line);
  const nm = m?.indices?.[1];
  if (m === null || nm === undefined) return null;
  const name = normName(m[1] as string);
  if (!plausible(name, true)) return null;
  return { tag: { start: nm[0], end: nm[1], name }, textStart: m.index + m[0].length };
}

/** The result of reading a list of paragraphs as a transcript. */
export interface Shape {
  shaped: boolean;
  /** Per paragraph, its entry match (null for text and continuation paragraphs). */
  matches: (EntryMatch | null)[];
  entries: Entry[];
}

/**
 * Whether `paragraphs` (a DOCX's body paragraphs, or a text file's) are a transcript: at least
 * TRANSCRIPT_SHARE of the non-empty ones are entries, and at least MIN_ENTRIES are. A header-only
 * entry ("Avery Quill   0:03") takes the next non-empty paragraph as its text, and both count.
 */
export function shapeParagraphs(paragraphs: readonly string[]): Shape {
  const matches: (EntryMatch | null)[] = [];
  const entries: Entry[] = [];
  let nonEmpty = 0;
  let matched = 0;
  let headers = 0;
  let open: Entry | null = null;
  for (const p of paragraphs) {
    const m = parseEntry(p);
    matches.push(m);
    if (p.trim() === "") continue;
    nonEmpty++;
    if (m !== null) {
      matched++;
      headers++;
      const entry: Entry = { speaker: m.tag.name, text: squash(p.slice(m.textStart)) };
      entries.push(entry);
      open = m.headerOnly ? entry : null;
    } else if (open !== null) {
      matched++;
      open.text = squash(`${open.text} ${p}`);
      open = null;
    } else entries.push({ speaker: null, text: squash(p) });
  }
  return { shaped: headers >= MIN_ENTRIES && nonEmpty > 0 && matched / nonEmpty >= TRANSCRIPT_SHARE, matches, entries };
}

interface Line extends Region {
  text: string;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const m of text.matchAll(/\r\n|\n|\r/g)) {
    out.push({ start, end: m.index, text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  out.push({ start, end: text.length, text: text.slice(start) });
  return out;
}

/** Runs of non-blank lines. */
function blocks(lines: readonly Line[]): Line[][] {
  const out: Line[][] = [];
  let cur: Line[] = [];
  for (const l of lines) {
    if (l.text.trim() === "") {
      if (cur.length > 0) out.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const empty = (kind: TranscriptKind): TranscriptPlan => ({ kind, tags: [], guids: [], fixed: [], entries: [] });

/** One caption line: its voice tags or speaker prefix, inline timestamps, and the spoken text. */
function captionLine(plan: TranscriptPlan, line: Line): Entry {
  let speaker: string | null = null;
  for (const m of line.text.matchAll(VOICE)) {
    const raw = m[1] as string;
    const name = normName(raw);
    if (name === "") continue;
    const start = line.start + m.index + m[0].length - 1 - raw.length + (raw.length - raw.trimStart().length);
    plan.tags.push({ start, end: start + raw.trim().length, name });
    speaker ??= name;
  }
  for (const m of line.text.matchAll(INLINE_TIME)) plan.fixed.push({ start: line.start + m.index, end: line.start + m.index + m[0].length });
  let text = line.text;
  if (speaker === null) {
    const p = parsePrefix(line.text);
    if (p !== null) {
      plan.tags.push({ start: line.start + p.tag.start, end: line.start + p.tag.end, name: p.tag.name });
      speaker = p.tag.name;
      text = line.text.slice(p.textStart);
    }
  }
  return { speaker, text: squash(text.replace(/<[^>]*>/g, "")) };
}

/** A cue's caption lines: a line naming a speaker starts a turn, other lines continue the current one. */
function captionCue(plan: TranscriptPlan, lines: readonly Line[]): void {
  let current: Entry | null = null;
  for (const l of lines) {
    const e = captionLine(plan, l);
    if (e.speaker !== null || current === null) {
      plan.entries.push(e);
      current = e;
    } else current.text = squash(`${current.text} ${e.text}`);
  }
}

function planVtt(text: string): TranscriptPlan | null {
  const lines = splitLines(text);
  if (!/^\uFEFF?WEBVTT(?:[ \t]|$)/.test(lines[0]?.text ?? "") || !lines.some((l) => TIMING.test(l.text))) return null;
  const plan = empty("vtt");
  // The WEBVTT line is free text (it may carry a title); so are header metadata, NOTE, STYLE and REGION blocks.
  for (const block of blocks(lines.slice(1))) {
    if (/^(?:NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0]?.text ?? "")) continue;
    const t = block.findIndex((l) => TIMING.test(l.text));
    if (t < 0) continue;
    for (const id of block.slice(0, t)) {
      for (const m of id.text.matchAll(GUID)) plan.guids.push({ start: id.start + m.index, end: id.start + m.index + m[0].length });
    }
    const timing = block[t] as Line;
    plan.fixed.push({ start: timing.start, end: timing.end });
    captionCue(plan, block.slice(t + 1));
  }
  return plan;
}

function planSrt(text: string): TranscriptPlan | null {
  const all = blocks(splitLines(text));
  const isCue = (b: readonly Line[]) => b.length >= 2 && SRT_INDEX.test((b[0] as Line).text) && TIMING.test((b[1] as Line).text);
  if (all.length === 0 || !isCue(all[0] as Line[])) return null;
  if (all.filter(isCue).length / all.length < TRANSCRIPT_SHARE) return null;
  const plan = empty("srt");
  for (const b of all) {
    if (!isCue(b)) continue;
    for (const l of b.slice(0, 2)) plan.fixed.push({ start: l.start, end: l.end });
    captionCue(plan, b.slice(2));
  }
  return plan;
}

/**
 * A text file's paragraphs: runs of non-blank lines, also split before every line that starts with
 * a timestamp or is itself an entry, so a transcript with one turn per line has one paragraph per turn.
 */
function textParagraphs(text: string): Region[] {
  const out: Region[] = [];
  let cur: Region | null = null;
  for (const l of splitLines(text)) {
    if (l.text.trim() === "") {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    if (cur !== null && (TS_START.test(l.text) || parseEntry(l.text) !== null)) {
      out.push(cur);
      cur = null;
    }
    if (cur === null) cur = { start: l.start, end: l.end };
    else cur.end = l.end;
  }
  if (cur !== null) out.push(cur);
  return out;
}

function planText(text: string): TranscriptPlan | null {
  const paras = textParagraphs(text);
  const shape = shapeParagraphs(paras.map((p) => text.slice(p.start, p.end)));
  if (!shape.shaped) return null;
  const plan = empty("text");
  plan.entries = shape.entries;
  shape.matches.forEach((m, i) => {
    if (m === null) return;
    const at = (paras[i] as Region).start;
    plan.fixed.push({ start: at + m.ts.start, end: at + m.ts.end });
    plan.tags.push({ start: at + m.tag.start, end: at + m.tag.end, name: m.tag.name });
  });
  return plan;
}

/** Reads decoded text as a VTT, SRT or text transcript, or returns null when it is none of them. */
export function planTranscript(text: string): TranscriptPlan | null {
  return planVtt(text) ?? planSrt(text) ?? planText(text);
}

/** Distinct speaker names of `entries`, in first-appearance order. */
export function speakersOf(entries: readonly Entry[]): string[] {
  return [...new Set(entries.flatMap((e) => (e.speaker === null ? [] : [e.speaker])))];
}

/** The keep test for speaker tags: keep-list terms and spec vocabulary forms, folded. */
export function keptSpeakers(keepTerms: readonly string[], vocabulary: readonly string[]): (name: string) => boolean {
  const kept = new Set([...keepTerms, ...vocabulary].map(fold));
  return (name) => kept.has(fold(name));
}

/**
 * The spans of a transcript's text: speaker tags (unless kept) and cue GUIDs as given, and `free`
 * (TextScanner.free) on everything else outside the fixed regions and the tags.
 */
export function transcriptSpans(text: string, plan: TranscriptPlan, free: (s: string) => Span[], kept: (name: string) => boolean): Span[] {
  const forced: Span[] = [
    ...plan.tags.filter((t) => !kept(t.name)).map((t): Span => ({ start: t.start, end: t.end, cls: "person", value: t.name, source: "speaker" })),
    ...plan.guids.map((g): Span => ({ start: g.start, end: g.end, cls: "id", value: text.slice(g.start, g.end), source: "pattern" })),
  ];
  return scanAround(text, [...plan.fixed, ...plan.tags, ...plan.guids], forced, free);
}

/** One paragraph of a DOCX transcript: an entry's tag forced and its timestamp left alone, or plain free text. */
export function entrySpans(para: string, free: (s: string) => Span[], kept: (name: string) => boolean): Span[] {
  const m = parseEntry(para);
  if (m === null) return free(para);
  const forced: Span[] = kept(m.tag.name) ? [] : [{ start: m.tag.start, end: m.tag.end, cls: "person", value: m.tag.name, source: "speaker" }];
  return scanAround(para, [m.ts, m.tag], forced, free);
}

/** `forced` spans plus `free` run on each gap between the `holes`. */
function scanAround(text: string, holes: readonly Region[], forced: readonly Span[], free: (s: string) => Span[]): Span[] {
  const sorted = [...holes].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [...forced];
  let at = 0;
  const gap = (end: number) => {
    if (end > at) for (const s of free(text.slice(at, end))) out.push({ ...s, start: s.start + at, end: s.end + at });
  };
  for (const h of sorted) {
    gap(h.start);
    at = Math.max(at, h.end);
  }
  gap(text.length);
  return out.sort((a, b) => a.start - b.start);
}

/** Exactly one insertion, deletion or substitution apart. */
export function oneEdit(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.length === l.length ? s.slice(i + 1) === l.slice(i + 1) : s.slice(i) === l.slice(i + 1);
}

/**
 * Person forms for the corpus-wide TextScanner: each speaker's name, its parts (nameParts in
 * recur.ts), and the capitalised spoken words within one edit of a part, each with the speaker's
 * name as the value (so all of them share the speaker's pseudonym). A part or misspelling that fits
 * two people (speakers, or `others`: the people blinded in a column or held by the map) is its own
 * value instead. Names recurrenceExclusion leaves out (short, dictionary-only, vocabulary), and parts
 * partExclusion leaves out (also keep terms), are not added; a speaker's tag is still replaced.
 * Sorted by form, then value.
 */
export function speakerForms(
  speakers: Iterable<string>,
  spoken: Iterable<string>,
  vocabulary: ReadonlySet<string>,
  others: Iterable<string> = [],
  keep: ReadonlySet<string> = new Set(),
): ExtraForm[] {
  const names = [...new Set([...speakers].map(normName))].filter((n) => n !== "").sort(cmp);
  const out = new Map<string, ExtraForm>();
  const add = (form: string, value: string) => {
    if (!out.has(form)) out.set(form, { cls: "person", value, form, source: "speaker" });
  };
  for (const name of names) if (recurrenceExclusion(name, vocabulary) === null) add(name, name);
  // "Speaker 2" has only the dictionary word "Speaker" as a part, which is excluded.
  const parts = nameParts(names, others, vocabulary, keep);
  for (const p of parts) if (p.exclusion === null) add(p.form, p.value);
  // Misspellings: capitalised spoken words one edit from a part (an excluded part too: "Rosy" for "Rose").
  const byFold = new Map(parts.map((p) => [fold(p.form), p]));
  const fuzzy = parts.filter((p) => [...fold(p.form)].length >= MIN_FUZZY_LENGTH);
  const words = new Set<string>();
  for (const s of spoken) for (const w of s.match(/\p{Lu}[\p{L}\p{M}'’]*/gu) ?? []) words.add(w);
  for (const w of [...words].sort(cmp)) {
    const k = fold(w);
    if ([...k].length < MIN_FUZZY_LENGTH || byFold.has(k) || DICTIONARY.has(k)) continue;
    if (recurrenceExclusion(w, vocabulary) !== null) continue;
    // null stands for a shared part, which no one person owns.
    const owners = new Set(fuzzy.filter((p) => oneEdit(k, fold(p.form))).map((p) => (p.shared ? null : p.value)));
    if (owners.size === 0) continue;
    const [sole] = owners;
    add(w, owners.size === 1 && typeof sole === "string" ? sole : w);
  }
  return [...out.values()].sort((a, b) => cmp(a.form as string, b.form as string) || cmp(a.value, b.value));
}
