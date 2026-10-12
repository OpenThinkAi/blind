// Context-keyword redaction: the token(s) after a trigger word ("gate code 4471", "pw: hunter2",
// "acct ending 0042", "DOB 04/12/1980") are secrets no name or shape detector targets. This module
// finds them; the caller (text.ts) turns each into a `redact` span, a fixed placeholder, and the
// trigger words themselves stay as written. Pure and deterministic; no model.
//
// A trigger is a word or short phrase, matched whole-word and case-insensitively. After it come
// optional separators and filler ("is", "#", ":", "number", "ending in"), then the value:
// - `secret` triggers (password, gate code, combo): the next token, whatever it is, unless it is an
//   ordinary word ("the password is reset" redacts nothing), or a plain lowercase or capitalised word
//   straight after the trigger with no separator or filler ("its password rotated yet");
// - `number` triggers (account, plate, card, license): the next token only when it holds a digit
//   and is at least three characters, so "account manager" and "plate 2" stay;
// - `date` (DOB): a date written numerically, "April 12, 1980", "12 April 1980" or spoken ("June third
//   forty-two", "the third of June nineteen forty-two", "June 3rd '42");
// - plates (`shape: plate`): up to three tokens, an optional uppercase two-letter region and one or two
//   groups of 2-4 characters that together hold a digit ("ST 7AB C12", "ST 12-3456");
// - handles (`shape: handle`: username, login): one token of 3+ characters, letters and digits or
//   dotted/underscored ("dana42", "d.quill");
// - hiding spots (`shape: hiding`: "spare key under the green mat"): from the preposition to the end of
//   the clause, at most eight words.
// A run of digit groups after a card, account, routing or combination number is one value
// ("4111 1111 1111 1111", "12 34 56").
// Extra triggers from blind.toml are `secret` triggers unless they name a kind:
// `{ word = "license", kind = "number" }`.
//
// The value need not follow at once: up to MAX_SKIP ordinary words may sit between ("combo changed to
// 47-11-09", "password was reset to Example!42", "license on file is ST 123"). A sentence end (`.`, `;`,
// `!`, `?`, a line break) stops the search. After skipped words a secret must look like one (a digit or
// a symbol), or follow "to": "password was reset and then we left" redacts nothing.
//
// In a table the label and the value sit in different cells (`| Owner DOB | 01/02/1960 |`). pairCells
// finds a cell that ends in a trigger phrase (alone, with an optional ":" or "number") and names the
// cell that holds its value: the one to its right, or, for a label in the header row whose right
// neighbour is no value, the cells below it.

import {
  SPOKEN_ORDINAL_TEENS, SPOKEN_ORDINAL_TENS, SPOKEN_ORDINAL_UNITS, SPOKEN_TEENS, SPOKEN_TENS, SPOKEN_UNITS,
} from "./spelled.ts";

export type ContextKind = "secret" | "number" | "date";
export const CONTEXT_KINDS: readonly ContextKind[] = ["secret", "number", "date"];

/** A blind.toml trigger: a bare word (a `secret` trigger) or a word with the kind of value it expects. */
export type ContextTriggerSpec = string | { word: string; kind: ContextKind };
const specWord = (t: ContextTriggerSpec): string => (typeof t === "string" ? t : t.word);
const specKind = (t: ContextTriggerSpec): ContextKind => (typeof t === "string" ? "secret" : t.kind);

interface Trigger {
  kind: ContextKind;
  /** Regex source, whole-word; spaces inside it match any run of spaces or tabs. */
  source: string;
  /** Digit groups after the first token join the value (card, account, routing, combination). */
  groups?: "long" | "short";
  /** The value must follow a number marker (`#`, `number`, `no.`, `:`, `=`): "policy 2024 update" is prose. */
  marker?: boolean;
  /** A value shape of its own: a plate, a handle (username, login), or a hiding spot for a key. */
  shape?: "plate" | "handle" | "hiding";
  /** Regex source of a table label for the trigger, when the trigger phrase alone is too broad a label. */
  label?: string;
}

const DEFAULTS: readonly Trigger[] = [
  { kind: "date", source: "dob|d\\.o\\.b\\.?|date of birth|birth(?: )?date|birthday" },
  { kind: "number", source: "dl|d\\/l|driver['’]?s? licen[sc]e|driving licen[sc]e" },
  { kind: "number", source: "(?:licen[sc]e )?plate", shape: "plate" },
  { kind: "number", source: "user(?: )?name|login|handle|screen name", shape: "handle" },
  { kind: "number", source: "badge|employee id|member id|staff id" },
  {
    kind: "secret",
    source: "(?:(?:spare|house|door) )?keys?(?: (?:is|are))?(?: (?:kept|left|hidden))?",
    shape: "hiding",
    label: "(?:spare|house|door) keys?(?: (?:location|spot|hidden|hiding (?:spot|place)))?|keys? (?:location|hiding (?:spot|place))",
  },
  { kind: "secret", source: "(?:gate|door|garage|alarm|entry|access|lockbox|keypad) (?:code|pin)" },
  { kind: "secret", source: "pass(?:word|wd|code|phrase)|pwd|pw" },
  { kind: "secret", source: "combo|combination", groups: "short" },
  { kind: "number", source: "routing", groups: "long" },
  { kind: "number", source: "acct|account", groups: "long" },
  { kind: "number", source: "card|visa|mastercard|amex", groups: "long" },
  { kind: "number", source: "cvv|cvc|cid" },
  { kind: "number", source: "policy", marker: true, groups: "long" },
];

/** The words the default triggers cover, for docs and `blind init`. */
export const DEFAULT_CONTEXT_TRIGGERS: readonly string[] = [
  "DOB / date of birth / birthday (numeric or spoken dates)", "DL / driver's license", "plate (region and groups)",
  "username / user name / login / handle / screen name", "badge / employee id / member id / staff id",
  "spare / house / door key under, in, behind ... (where a key is hidden)", "gate code (door, garage, alarm, entry, access, keypad)",
  "password / passcode / pw", "combo / combination", "routing", "account / acct", "card / visa / mastercard / amex ... ending",
  "CVV / CVC", "policy #",
];

/** What the finder needs: the master switch is the caller's, so this holds only the extra triggers. */
export interface ContextOptions {
  triggers: readonly ContextTriggerSpec[];
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// Spoken days and years, from the word tables in spelled.ts.
const alt = (words: readonly string[]): string => words.join("|");
const TENS_SEP = "(?:[ \\t]+|-)";
const UNIT = alt(SPOKEN_UNITS);
const TEEN = alt(SPOKEN_TEENS);
const TENS = alt(SPOKEN_TENS);
const ORD_DAY = `(?:(?:twenty|thirty)${TENS_SEP}(?:${alt(SPOKEN_ORDINAL_UNITS)})|${alt(SPOKEN_ORDINAL_TENS)}|${alt(SPOKEN_ORDINAL_TEENS)}|${alt(SPOKEN_ORDINAL_UNITS)})`;
const CARD_DAY = `(?:(?:twenty|thirty)${TENS_SEP}(?:${UNIT})|twenty|thirty|${TEEN}|${UNIT})`;
const DAY = `(?:the[ \\t]+)?(?:${ORD_DAY}|${CARD_DAY}|\\d{1,2}(?:st|nd|rd|th)?)(?![\\p{L}\\p{N}])`;
// A year needs two parts when spoken ("forty-two", "nineteen forty"): "June third forty people" is no year.
const YEAR = `(?:,?[ \\t]+(?:\\d{4}(?![\\p{L}\\p{N}])|['’]\\d{2}(?![\\p{L}\\p{N}])`
  + `|(?:nineteen|eighteen|twenty)${TENS_SEP}(?:oh${TENS_SEP}(?:${UNIT})|(?:${TENS})(?:${TENS_SEP}(?:${UNIT}))?|${TEEN}|hundred)(?![\\p{L}\\p{N}])`
  + `|two${TENS_SEP}thousand(?:[ \\t]+and)?(?:[ \\t]+(?:${TENS}(?:${TENS_SEP}(?:${UNIT}))?|${TEEN}|${UNIT}))?(?![\\p{L}\\p{N}])`
  + `|(?:${TENS})${TENS_SEP}(?:${UNIT})(?![\\p{L}\\p{N}])|oh${TENS_SEP}(?:${UNIT})(?![\\p{L}\\p{N}])))`;
const DATE_RES: readonly RegExp[] = [
  /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}(?![\p{L}\p{N}])/iu,
  new RegExp(`^${MONTH}\\.?[ \\t]+${DAY}(?:${YEAR})?`, "iu"),
  new RegExp(`^${DAY}[ \\t]+(?:of[ \\t]+)?${MONTH}\\.?(?:${YEAR})?(?![\\p{L}\\p{N}])`, "iu"),
];

/** The longest date, written or spoken, at the start of `rest`, or null. */
function dateAt(rest: string): number | null {
  let best: number | null = null;
  for (const re of DATE_RES) {
    const d = re.exec(rest);
    if (d !== null && (best === null || d[0].length > best)) best = d[0].length;
  }
  return best;
}

// Between the trigger and the value: spaces, one separator, filler words. Matched repeatedly.
const FILLER_RE = /^(?:[ \t]+|[:=#]|-(?=[ \t])|(?:is|number|num|nr|no\.|ending|ends|in|on|code|pin|at)(?![\p{L}\p{N}]))/iu;
const MARKER_RE = /^(?:[:=#]|number|num|nr|no\.)$/i;

// Ordinary words that follow a secret trigger in prose, never the secret itself.
const PROSE = new Set([
  "a", "an", "the", "to", "for", "of", "and", "or", "but", "not", "no", "so", "if", "as", "at", "by", "in", "on", "it",
  "is", "are", "was", "were", "be", "been", "will", "would", "can", "could", "should", "must", "may", "might", "has", "have", "had",
  "this", "that", "these", "those", "there", "here", "with", "without", "from", "into", "than", "then", "when", "which", "who",
  "my", "your", "our", "his", "her", "their", "its", "you", "we", "they", "he", "she", "i", "me", "us",
  "reset", "resets", "changed", "change", "expired", "expires", "required", "requires", "needed", "stored", "saved", "shared",
  "manager", "policy", "protected", "lock", "locked", "unlock", "unlocked", "please", "now", "again", "also", "only", "never",
  "longer", "okay", "ok", "yes", "none", "n/a", "na", "unknown", "known", "given", "provided", "sent", "set", "used", "works", "worked",
  "file", "currently", "current", "listed", "recorded", "updated", "new", "still", "just", "already", "today", "yet",
]);
/** Ordinary words that may sit between a trigger and its value. */
const MAX_SKIP = 4;

const SEP_AFTER_RE = /^[ \t]+/;
// "!" and "?" stay: passwords end in them.
const TRAILING_PUNCT_RE = /[.,;:)\]}"'”’»]+$/u;
const OPEN_PUNCT_RE = /^["'“‘(\[{«]+/u;

interface Compiled {
  t: Trigger;
  re: RegExp;
  /** A table cell that is a label for this trigger: up to three words, the trigger phrase, "number", ":". */
  label: RegExp;
}

function compile(triggers: readonly Trigger[]): Compiled[] {
  return triggers.map((t) => {
    const src = t.source.replace(/ /g, "[ \\t]+");
    const labelSrc = (t.label ?? t.source).replace(/ /g, "[ \\t]+");
    return {
      t,
      re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`, "giu"),
      label: new RegExp(`^((?:[\\p{L}\\p{N}'’/-]+[ \\t]+){0,3}?)(?:${labelSrc})(?:[ \\t]+(?:number|num|no\\.?|nr|code|#))?[ \\t]*[:：]?[ \\t]*$`, "iu"),
    };
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEFAULT_COMPILED = compile(DEFAULTS);
const extraCache = new Map<string, Compiled[]>();

function compiledFor(extra: readonly ContextTriggerSpec[]): Compiled[] {
  // One entry per word and kind; the same word as two kinds is two triggers.
  const byKey = new Map<string, { word: string; kind: ContextKind }>();
  for (const e of extra) {
    const word = specWord(e).trim().replace(/\s+/g, " ");
    if (word !== "") byKey.set(`${specKind(e)}\0${word}`, { word, kind: specKind(e) });
  }
  if (byKey.size === 0) return DEFAULT_COMPILED;
  const key = [...byKey.keys()].sort().join("\u0001");
  let c = extraCache.get(key);
  if (c === undefined) {
    const extras = [...byKey.values()].sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : x.kind < y.kind ? -1 : 1));
    c = [...DEFAULT_COMPILED, ...compile(extras.map((w): Trigger => ({ kind: w.kind, source: escapeRe(w.word) })))];
    extraCache.set(key, c);
  }
  return c;
}

export interface ContextSpan {
  start: number;
  end: number;
}

/** Spaces, one separator, filler words, matched repeatedly from `i`; returns the new offset and whether a number marker was seen. */
function skipFiller(text: string, from: number): { at: number; marked: boolean; filled: boolean } {
  let i = from;
  let marked = false;
  // Anything but spaces between the trigger and the value: ":", "=", "is", "#" ...
  let filled = false;
  for (let guard = 0; guard < 6; guard++) {
    const m = FILLER_RE.exec(text.slice(i, i + 12));
    if (m === null) break;
    const piece = m[0].toLowerCase();
    if (MARKER_RE.test(piece)) marked = true;
    if (!/^[ \t]+$/.test(piece)) filled = true;
    i += m[0].length;
  }
  return { at: i, marked, filled };
}

// A plate: an optional uppercase two-letter region, then one or two groups of 2-4 characters (the second
// has a digit or is capitalised, so "7AB was" is not one plate); a digit somewhere past the region.
const PLATE_RE = /^(?:([A-Z]{2})[ \t-])?([A-Za-z0-9]{2,4})(?:[ \t-]([A-Za-z0-9]{2,4}))?(?![\p{L}\p{N}])/u;

/** The length of the plate at the start of `text` from `at`, or null; a single longer token is the caller's. */
function plateAt(text: string, at: number): number | null {
  const rest = text.slice(at, at + 24);
  const m = PLATE_RE.exec(rest);
  if (m === null) return null;
  const [whole, , g1 = "", g2] = m;
  let len = whole.length;
  let groups = g1;
  if (g2 !== undefined) {
    if (/\d/.test(g2) || /^[A-Z]+$/.test(g2)) groups += g2;
    else len -= g2.length + 1;
  }
  if (!/\d/.test(groups) || !(/\d/.test(g1) || /^[A-Z]+$/.test(g1))) return null;
  return len >= 3 ? len : null;
}

/** A username, login or screen name: 3+ characters, letters with digits or dotted/underscored; `loose` also takes a plain word. */
function isHandle(word: string, loose = false): boolean {
  const w = word.startsWith("@") ? word.slice(1) : word;
  if (w.length < 3) return false;
  // After a separator or filler ("login: admin", "username is root") a plain word of 3+ letters counts.
  if (loose && /^\p{L}+$/u.test(w) && !PROSE.has(w.toLowerCase())) return true;
  return (/\p{L}/u.test(w) && /\d/.test(w) && /^[\p{L}\p{N}._-]+$/u.test(w)) || /^[\p{L}\p{N}]+(?:[._][\p{L}\p{N}]+)+$/u.test(w);
}

/** The value after `pos` for trigger `t`, as [start, end), or null. */
function valueAfter(text: string, pos: number, t: Trigger): [number, number] | null {
  const first = skipFiller(text, pos);
  let i = first.at;
  // A region code can read as an ordinary word ("OR", "IN", "ME"), so a plate is tried before any skipping.
  if (t.shape === "plate" && (i > pos || /^[ \t]/.test(text.slice(pos, pos + 1)))) {
    const p = plateAt(text, i);
    if (p !== null) return [i, i + p];
  }
  let marked = first.marked;
  if (i === pos && !SEP_AFTER_RE.test(text.slice(pos, pos + 1)) && !/^[:=#]/.test(text.slice(pos, pos + 1))) return null;

  // A month can read as an ordinary word ("may"), so a date is tried before any skipping.
  if (t.kind === "date") {
    const len = dateAt(text.slice(i, i + 80));
    if (len !== null) return [i, i + len];
  }
  // Ordinary words between the trigger and the value ("changed to", "was reset to", "on file is").
  let skipped = 0;
  let last = "";
  for (;;) {
    const m = /^[^\s]+/u.exec(text.slice(i, i + 60));
    if (m === null) break;
    const word = m[0].replace(TRAILING_PUNCT_RE, "").toLowerCase();
    if (word === "" || /\d/.test(word) || !PROSE.has(word)) break;
    if (skipped >= MAX_SKIP || /[.;!?]$/.test(m[0])) return null;
    i += m[0].length;
    skipped++;
    last = word;
    const more = skipFiller(text, i);
    i = more.at;
    marked = marked || more.marked;
  }
  if (t.marker === true && !marked) return null;
  const open = OPEN_PUNCT_RE.exec(text.slice(i, i + 4));
  if (open !== null) i += open[0].length;

  if (t.kind === "date") {
    const len = dateAt(text.slice(i, i + 80));
    if (len !== null) return [i, i + len];
  }
  if (t.shape === "plate") {
    const p = plateAt(text, i);
    if (p !== null) return [i, i + p];
  }

  const quoted = open === null ? null : /^[^"'“”‘’\n]{1,100}/u.exec(text.slice(i, i + 101));
  const tok = quoted ?? /^[^\s]+/u.exec(text.slice(i, i + 200));
  if (tok === null) return null;
  const word = tok[0].replace(TRAILING_PUNCT_RE, "");
  if (word === "" || !/[\p{L}\p{N}]/u.test(word)) return null;
  const hasDigit = /\d/.test(word);
  if (t.kind === "secret") {
    if (!hasDigit && (PROSE.has(word.toLowerCase()) || word.length < 2)) return null;
    // A plain word ends a sentence with "!" or "?" too ("has the password been rotated?").
    const plain = word.replace(/[!?]+$/u, "");
    // Past skipped words a plain word is prose unless it follows "to": "reset to swordfish".
    if (skipped > 0 && /^[\p{L}'’]+$/u.test(plain) && last !== "to") return null;
    // "its password rotated yet": a plain word straight after the trigger, with nothing between
    // ("password: dragon", "password is dragon" still count), is the sentence going on.
    if (skipped === 0 && !first.filled && /^(?:\p{Lu}?\p{Ll}+)$/u.test(plain)) return null;
  } else if (t.shape === "handle") {
    if (!isHandle(word, first.filled || ["was", "were", "are", "be", "been"].includes(last))) return null;
  } else if (!hasDigit || word.length < 3) return null;
  let end = i + word.length;
  if (t.groups !== undefined && /^[\d*xX•-]+$/.test(word)) {
    const min = t.groups === "long" ? 3 : 1;
    const max = t.groups === "long" ? 6 : 4;
    for (let n = 0; n < 6; n++) {
      const g = new RegExp(`^[ \\t]\\d{${min},${max}}(?![\\p{L}\\p{N}])`, "u").exec(text.slice(end, end + 12));
      if (g === null) break;
      end += g[0].length;
    }
  }
  return [i, end];
}

// Where a key is hidden: from the preposition to the end of the clause. "key under review" is no hiding spot.
const HIDE_PREP_RE = /^[ \t]+(under|in|inside|behind|above|on top of|beneath)(?![\p{L}\p{N}_])/iu;
const NOT_A_KEY_BEFORE = new Set([
  "primary", "foreign", "api", "public", "private", "sort", "hash", "encryption", "ssh", "secret", "access", "master", "shift",
  "function", "arrow", "space", "tab", "caps", "enter", "escape", "delete", "piano", "music", "major", "minor", "composite", "unique",
]);
const NOT_A_PLACE = new Set([
  "review", "reviews", "consideration", "discussion", "development", "construction", "control", "pressure", "investigation", "scrutiny",
  "warranty", "contract", "way", "question", "case", "sense", "order", "general", "particular", "fact", "addition", "short", "summary",
  "conclusion", "mind", "process", "progress", "table", "database", "column", "field", "document", "report", "sentence", "paragraph",
  "code", "list", "dictionary", "map", "object", "array", "schema", "spec", "file", "row", "record", "use", "effect", "place",
]);
const MAX_HIDE_WORDS = 8;

function hidingSpot(text: string, matchStart: number, matchEnd: number): [number, number] | null {
  const prep = HIDE_PREP_RE.exec(text.slice(matchEnd, matchEnd + 24));
  if (prep === null) return null;
  const bare = !/^(?:spare|house|door)\b/i.test(text.slice(matchStart, matchEnd));
  if (bare) {
    const before = /([\p{L}]+)[ \t]+$/u.exec(text.slice(Math.max(0, matchStart - 24), matchStart));
    if (before !== null && NOT_A_KEY_BEFORE.has((before[1] as string).toLowerCase())) return null;
  }
  const start = matchEnd + prep[0].length - prep[1]!.length;
  const obj = /^[ \t]+(?:(?:the|a|an|this|that|these|those|our|my|your|his|her|their)[ \t]+)?([\p{L}]+)/iu.exec(text.slice(start + prep[1]!.length, start + prep[1]!.length + 40));
  if (obj === null || NOT_A_PLACE.has((obj[1] as string).toLowerCase())) return null;
  // Up to eight words, ending at a comma, full stop, semicolon, "!" or "?" or the line end.
  let end = start;
  for (let n = 0; n < MAX_HIDE_WORDS; n++) {
    const w = /^[ \t]*[^\s]+/u.exec(text.slice(end, end + 80));
    if (w === null) break;
    const word = w[0].trimStart();
    const stop = /[,.;!?:]+$/u.exec(word);
    end += w[0].length - (stop === null ? 0 : stop[0].length);
    if (stop !== null) break;
  }
  return end > start + prep[1]!.length ? [start, end] : null;
}

/** The spans to redact in `text`: sorted, non-overlapping. */
export function findContextSpans(text: string, opts: ContextOptions = { triggers: [] }): ContextSpan[] {
  const found: ContextSpan[] = [];
  for (const { t, re } of compiledFor(opts.triggers)) {
    for (const m of text.matchAll(re)) {
      const v = t.shape === "hiding" ? hidingSpot(text, m.index, m.index + m[0].length) : valueAfter(text, m.index + m[0].length, t);
      if (v !== null) found.push({ start: v[0], end: v[1] });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: ContextSpan[] = [];
  let taken = 0;
  for (const s of found) {
    if (s.start < taken) continue;
    out.push(s);
    taken = s.end;
  }
  return out;
}

// ---------------------------------------------------------------- label and value in different cells

/** What a value cell must hold: the rule of the label that names it. Opaque outside this module. */
export type CellRule = Trigger;

/** The trigger a table cell is a label for, or null: "DOB", "Owner DOB:", "Account number". */
export function labelTrigger(cell: string, opts: ContextOptions = { triggers: [] }): CellRule | null {
  const text = cell.trim();
  if (text === "" || text.length > 60 || /[\r\n]/.test(text)) return null;
  for (const { t, label } of compiledFor(opts.triggers)) {
    const m = label.exec(text);
    if (m === null) continue;
    // "reset your password" is a sentence, not a label.
    const prefix = (m[1] ?? "").toLowerCase().split(/[ \t]+/).filter((w) => w !== "");
    if (prefix.some((w) => PROSE.has(w))) continue;
    return t;
  }
  return null;
}

/** The part of a value cell to redact under `rule` (the trimmed cell, or its leading date), as [start, end), or null. */
export function cellValueSpan(cell: string, rule: CellRule): [number, number] | null {
  const core = cell.trim();
  if (core === "") return null;
  const start = cell.indexOf(core);
  if (rule.kind === "date") {
    const len = dateAt(core);
    return len === null ? null : [start, start + len];
  }
  if (rule.shape === "handle") return isHandle(core, true) ? [start, start + core.length] : null;
  if (rule.kind === "number") return /\d/.test(core) && core.length >= 3 ? [start, start + core.length] : null;
  if (!/[\p{L}\p{N}]/u.test(core) || core.length < 2) return null;
  if (!/\d/.test(core) && PROSE.has(core.toLowerCase())) return null;
  return [start, start + core.length];
}

export interface CellMark {
  row: number;
  col: number;
  rule: CellRule;
}

/**
 * The cells of a table that hold the value of a label in another cell. A label's value is the cell
 * to its right when that is a value for the label's rule; a label in `headerRow` whose right
 * neighbour is no value (or, for a secret, a plain word, which reads as the next header) heads a
 * column, and the cells below it are its values. A cell that is itself a label is never a value.
 * `grid` is rows of cell text; a ragged row is fine.
 */
export function pairCells(grid: readonly (readonly string[])[], opts: ContextOptions, headerRow = 0): CellMark[] {
  const labels = new Map<string, CellRule | null>();
  const labelAt = (r: number, c: number): CellRule | null => {
    const text = grid[r]?.[c];
    if (text === undefined) return null;
    const k = `${r}:${c}`;
    let l = labels.get(k);
    if (l === undefined) {
      l = labelTrigger(text, opts);
      labels.set(k, l);
    }
    return l;
  };
  const out = new Map<string, CellMark>();
  const mark = (row: number, col: number, rule: CellRule): void => {
    if (!out.has(`${row}:${col}`)) out.set(`${row}:${col}`, { row, col, rule });
  };
  const valueAt = (r: number, c: number, rule: CellRule): boolean => {
    const text = grid[r]?.[c];
    return text !== undefined && labelAt(r, c) === null && cellValueSpan(text, rule) !== null;
  };
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] as readonly string[];
    for (let c = 0; c < row.length; c++) {
      const rule = labelAt(r, c);
      if (rule === null) continue;
      const header = r === headerRow && grid.length > r + 1;
      const right = row[c + 1];
      const readsAsHeader = header && rule.kind === "secret" && right !== undefined && /^[\p{L}'’ \t]+$/u.test(right.trim());
      if (valueAt(r, c + 1, rule) && !readsAsHeader) mark(r, c + 1, rule);
      else if (header) for (let rr = r + 1; rr < grid.length; rr++) if (valueAt(rr, c, rule)) mark(rr, c, rule);
    }
  }
  return [...out.values()].sort((a, b) => a.row - b.row || a.col - b.col);
}
