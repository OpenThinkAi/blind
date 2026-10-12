// Spoken forms of values: digits read out one by one ("eight oh one, five five five, zero one four
// two") and email addresses read aloud ("avery dot quill at example dot com"). Neither matches any
// shape pattern as written, so transcripts carried them through untouched. This module finds such
// spans and gives each its normalised written form ("8015550142", "avery.quill@example.com"); the
// caller (text.ts) runs the normal patterns on that form and replaces the original span whole.
// Pure and deterministic; no model.

/** A spoken value: where it is in the text and the written form it stands for. */
export interface SpelledSpan {
  start: number;
  end: number;
  kind: "digits" | "email";
  /** The written form: the digit string, or the lowercased email address. */
  normalised: string;
}

/** A run needs at least this many digits to count: "two dogs, one cat" is prose, "four zero one two" is a value. */
export const MIN_SPELLED_DIGITS = 4;

const DIGIT_WORDS: ReadonlyMap<string, string> = new Map([
  ["zero", "0"], ["oh", "0"], ["one", "1"], ["two", "2"], ["three", "3"], ["four", "4"],
  ["five", "5"], ["six", "6"], ["seven", "7"], ["eight", "8"], ["nine", "9"],
]);
/** "double five" is "55", "triple oh" is "000". */
const REPEATS: ReadonlyMap<string, number> = new Map([["double", 2], ["triple", 3]]);

// Words are runs of letters; anything with a digit or a letter glued on ("someone", "one's") is not a
// digit word. Between two words of a run: spaces, at most one punctuation mark (a comma, a full
// stop, a dash) and at most one line break, so "eight-oh-one" and "five five five. zero one" join.
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;
const RUN_GAP_RE = /^[ \t]*[,.\-–—]?[ \t]*(?:\r?\n[ \t]*)?$/;

/** Runs of at least MIN_SPELLED_DIGITS spelled digits, as digit strings. */
export function findSpelledDigits(text: string): SpelledSpan[] {
  const out: SpelledSpan[] = [];
  let run: { start: number; end: number; digits: string } | null = null;
  let pending: number | null = null; // a "double"/"triple" waiting for its digit
  let pendingStart = 0;
  const close = (): void => {
    if (run !== null && run.digits.length >= MIN_SPELLED_DIGITS) out.push({ start: run.start, end: run.end, kind: "digits", normalised: run.digits });
    run = null;
    pending = null;
  };
  let prevEnd = -1;
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0].toLowerCase();
    const start = m.index;
    const end = start + m[0].length;
    const joined = prevEnd >= 0 && start > prevEnd && RUN_GAP_RE.test(text.slice(prevEnd, start));
    const digit = DIGIT_WORDS.get(word);
    const repeat = REPEATS.get(word);
    if (digit === undefined && repeat === undefined) {
      close();
      prevEnd = end;
      continue;
    }
    if (!joined && (run !== null || pending !== null)) close();
    if (repeat !== undefined) {
      if (pending !== null) close(); // "double double": not a number
      pending = repeat;
      pendingStart = start;
      prevEnd = end;
      continue;
    }
    const digits = (digit as string).repeat(pending ?? 1);
    const runStart = pending !== null ? pendingStart : start;
    if (run === null) run = { start: runStart, end, digits };
    else {
      run.end = end;
      run.digits += digits;
    }
    pending = null;
    prevEnd = end;
  }
  close();
  return out;
}

// A spoken email: a local part of words joined by "dot", "underscore" or "dash" (or a written ".",
// "_" or "-"), the word "at", then two or more domain labels joined by "dot" (or a written ".").
// Case-insensitive. Retried one position on whenever a candidate is rejected.
const W = "[A-Za-z0-9]+";
const LOCAL_SEP = "(?:\\s+(?:dot|underscore|dash|hyphen)\\s+|[._-])";
const LABEL = `${W}(?:(?:\\s+(?:dash|hyphen)\\s+|-)${W})*`;
const DOMAIN_SEP = "(?:\\s+dot\\s+|\\.)";
const SPOKEN_EMAIL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.@'’-])(${W}(?:${LOCAL_SEP}${W})*)\\s+at\\s+(${LABEL}(?:${DOMAIN_SEP}${LABEL})+)(?![\\p{L}\\p{N}@]|[._-][A-Za-z0-9])`,
  "giu",
);

// A one-word local part is the word before "at" in ordinary prose far more often than a mailbox
// ("look at example dot com", "reach me at ..."). These are refused; a local part with a joiner
// ("jane dot doe") is never refused.
const PROSE_BEFORE_AT = new Set([
  "a", "an", "and", "are", "be", "been", "check", "contact", "email", "find", "found", "go", "here", "him",
  "her", "hosted", "is", "it", "live", "log", "logged", "look", "looked", "looking", "mail", "me", "online",
  "or", "out", "page", "posted", "reach", "registered", "signed", "site", "that", "them", "there", "this",
  "up", "us", "visit", "was", "website", "were", "write", "you",
]);

const spokenToWritten = (s: string, joiners: RegExp): string => s.trim().toLowerCase().replace(joiners, (j) => {
  const w = j.trim();
  return w === "dot" ? "." : w === "underscore" ? "_" : w === "dash" || w === "hyphen" ? "-" : w;
});

/**
 * Spoken email addresses. `tld` decides whether the last domain label is a top-level domain: a
 * spoken domain must end in one ("example dot com"), so "at this dot point" is never an address.
 * Only spans that use a spoken word ("at" always, so every match) are returned; an address written
 * out ("a@b.com") is the email pattern's.
 */
export function findSpokenEmails(text: string, tld: (label: string) => boolean): SpelledSpan[] {
  const out: SpelledSpan[] = [];
  const re = new RegExp(SPOKEN_EMAIL_RE.source, SPOKEN_EMAIL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [whole, rawLocal, rawDomain] = m as unknown as [string, string, string];
    const local = spokenToWritten(rawLocal, /\s+(?:dot|underscore|dash|hyphen)\s+/gi);
    const domain = spokenToWritten(rawDomain, /\s+(?:dot|dash|hyphen)\s+/gi);
    const labels = domain.split(".");
    const oneWord = !/[._-]/.test(local);
    if (!tld(labels[labels.length - 1] as string) || (oneWord && PROSE_BEFORE_AT.has(local))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + whole.length, kind: "email", normalised: `${local}@${domain}` });
  }
  return out;
}
