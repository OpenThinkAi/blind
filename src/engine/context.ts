// Context-keyword redaction: the token(s) after a trigger word ("gate code 4471", "pw: hunter2",
// "acct ending 0042", "DOB 04/12/1980") are secrets no name or shape detector targets. This module
// finds them; the caller (text.ts) turns each into a `redact` span, a fixed placeholder, and the
// trigger words themselves stay as written. Pure and deterministic; no model.
//
// A trigger is a word or short phrase, matched whole-word and case-insensitively. After it come
// optional separators and filler ("is", "#", ":", "number", "ending in"), then the value:
// - `secret` triggers (password, gate code, combo): the next token, whatever it is, unless it is an
//   ordinary word ("the password is reset" redacts nothing);
// - `number` triggers (account, plate, card, license): the next token only when it holds a digit
//   and is at least three characters, so "account manager" and "plate 2" stay;
// - `date` (DOB): a date written numerically, "April 12, 1980" or "12 April 1980".
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
}

const DEFAULTS: readonly Trigger[] = [
  { kind: "date", source: "dob|d\\.o\\.b\\.?|date of birth|birth ?date" },
  { kind: "number", source: "dl|d\\/l|driver['’]?s? licen[sc]e|driving licen[sc]e" },
  { kind: "number", source: "(?:licen[sc]e )?plate" },
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
  "DOB / date of birth", "DL / driver's license", "plate", "gate code (door, garage, alarm, entry, access, keypad)",
  "password / passcode / pw", "combo / combination", "routing", "account / acct", "card / visa / mastercard / amex ... ending",
  "CVV / CVC", "policy #",
];

/** What the finder needs: the master switch is the caller's, so this holds only the extra triggers. */
export interface ContextOptions {
  triggers: readonly ContextTriggerSpec[];
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_RES: readonly RegExp[] = [
  /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}(?![\p{L}\p{N}])/iu,
  new RegExp(`^${MONTH}\\.?[ \\t]+\\d{1,2}(?:st|nd|rd|th)?(?:,?[ \\t]+\\d{4})?(?![\\p{L}\\p{N}])`, "iu"),
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?${MONTH}\\.?(?:,?[ \\t]+\\d{4})?(?![\\p{L}\\p{N}])`, "iu"),
];

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
    return {
      t,
      re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`, "giu"),
      label: new RegExp(`^((?:[\\p{L}\\p{N}'’/-]+[ \\t]+){0,3}?)(?:${src})(?:[ \\t]+(?:number|num|no\\.?|nr|code|#))?[ \\t]*[:：]?[ \\t]*$`, "iu"),
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
function skipFiller(text: string, from: number): { at: number; marked: boolean } {
  let i = from;
  let marked = false;
  for (let guard = 0; guard < 6; guard++) {
    const m = FILLER_RE.exec(text.slice(i, i + 12));
    if (m === null) break;
    if (MARKER_RE.test(m[0].toLowerCase())) marked = true;
    i += m[0].length;
  }
  return { at: i, marked };
}

/** The value after `pos` for trigger `t`, as [start, end), or null. */
function valueAfter(text: string, pos: number, t: Trigger): [number, number] | null {
  const first = skipFiller(text, pos);
  let i = first.at;
  let marked = first.marked;
  if (i === pos && !SEP_AFTER_RE.test(text.slice(pos, pos + 1)) && !/^[:=#]/.test(text.slice(pos, pos + 1))) return null;

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
    const rest = text.slice(i, i + 40);
    for (const re of DATE_RES) {
      const d = re.exec(rest);
      if (d !== null) return [i, i + d[0].length];
    }
  }

  const quoted = open === null ? null : /^[^"'“”‘’\n]{1,100}/u.exec(text.slice(i, i + 101));
  const tok = quoted ?? /^[^\s]+/u.exec(text.slice(i, i + 200));
  if (tok === null) return null;
  const word = tok[0].replace(TRAILING_PUNCT_RE, "");
  if (word === "" || !/[\p{L}\p{N}]/u.test(word)) return null;
  const hasDigit = /\d/.test(word);
  if (t.kind === "secret") {
    if (!hasDigit && (PROSE.has(word.toLowerCase()) || word.length < 2)) return null;
    // Past skipped words a plain word is prose unless it follows "to": "reset to swordfish".
    if (skipped > 0 && /^[\p{L}'’]+$/u.test(word) && last !== "to") return null;
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

/** The spans to redact in `text`: sorted, non-overlapping. */
export function findContextSpans(text: string, opts: ContextOptions = { triggers: [] }): ContextSpan[] {
  const found: ContextSpan[] = [];
  for (const { t, re } of compiledFor(opts.triggers)) {
    for (const m of text.matchAll(re)) {
      const v = valueAfter(text, m.index + m[0].length, t);
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
    for (const re of DATE_RES) {
      const d = re.exec(core);
      if (d !== null) return [start, start + d[0].length];
    }
    return null;
  }
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
