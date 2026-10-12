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
// Extra triggers from blind.toml are `secret` triggers.

export type ContextKind = "secret" | "number" | "date";

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
  triggers: readonly string[];
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
]);

const SEP_AFTER_RE = /^[ \t]+/;
// "!" and "?" stay: passwords end in them.
const TRAILING_PUNCT_RE = /[.,;:)\]}"'”’»]+$/u;
const OPEN_PUNCT_RE = /^["'“‘(\[{«]+/u;

function compile(triggers: readonly Trigger[]): { t: Trigger; re: RegExp }[] {
  return triggers.map((t) => ({
    t,
    re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${t.source.replace(/ /g, "[ \\t]+")})(?![\\p{L}\\p{N}_])`, "giu"),
  }));
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEFAULT_COMPILED = compile(DEFAULTS);
const extraCache = new Map<string, { t: Trigger; re: RegExp }[]>();

function compiledFor(extra: readonly string[]): { t: Trigger; re: RegExp }[] {
  const words = [...new Set(extra.map((w) => w.trim().replace(/\s+/g, " ")).filter((w) => w !== ""))].sort();
  if (words.length === 0) return DEFAULT_COMPILED;
  const key = words.join("\0");
  let c = extraCache.get(key);
  if (c === undefined) {
    c = [...DEFAULT_COMPILED, ...compile(words.map((w): Trigger => ({ kind: "secret", source: escapeRe(w) })))];
    extraCache.set(key, c);
  }
  return c;
}

export interface ContextSpan {
  start: number;
  end: number;
}

/** The value after `pos` for trigger `t`, as [start, end), or null. */
function valueAfter(text: string, pos: number, t: Trigger): [number, number] | null {
  let i = pos;
  let marked = false;
  for (let guard = 0; guard < 6; guard++) {
    const m = FILLER_RE.exec(text.slice(i, i + 12));
    if (m === null) break;
    const piece = m[0].toLowerCase();
    if (MARKER_RE.test(piece)) marked = true;
    i += m[0].length;
  }
  if (i === pos && !SEP_AFTER_RE.test(text.slice(pos, pos + 1)) && !/^[:=#]/.test(text.slice(pos, pos + 1))) return null;
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
