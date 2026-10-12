// People named only in prose (AGT-1830). With no model and no spec entities, the engine knew a
// person only from a column a rule pseudonymised, a transcript speaker or an earlier map, so a
// client named only in a visit note survived. This finds them, model-free and deterministic, in
// the same text the engine scans, and hands them to the corpus-wide scanner as person values: the
// whole name is replaced wherever it appears, and its parts recur alone as any person's do
// (recur.ts nameParts, with the usual exclusions).
//
// It reads Title-Case runs, as the audit's semantic layer does (src/audit/semantic.ts), but asks
// for positive evidence before calling a run a person, because a false positive here rewrites
// ordinary prose:
// - an honorific before it ("Dr. Okonkwo", "Mrs Avery Quill"): the one to three name words
//   after it; or
// - a given name from the gazetteer (gazetteer.ts) followed by one or two more name words
//   ("Avery Quill", "Marisol J. Okonkwo"). A given name that is also a dictionary word ("Will")
//   needs a gazetteer surname after it and must not start the sentence.
// A lone given name is never enough: "Bella" or "Max" alone is as likely a pet as a person.
//
// A name word is a Title-Case word of two or more letters that is not an honorific or role word
// (honorifics.ts), not a function word, not a month or weekday, not a place, organisation,
// species, breed or heading word (NON_PERSON), not a policy keep term and not a spec vocabulary
// form. A run that goes on into a place, organisation or breed word ("Jordan River",
// "Jack Russell Terrier", "Logan Animal Clinic") is not a person. A candidate that is wholly
// part of a value in a `keep` column ("Okonkwo" when the Vet column, kept, says
// "Dr. Marisol Okonkwo") is kept too, so a policy that keeps a column keeps its names in prose.

import { DICTIONARY } from "./words.ts";
import { isDateWord } from "./datecontext.ts";
import { isGivenName, isSurname } from "./gazetteer.ts";
import { isHonorificOrRole } from "./honorifics.ts";

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Titles that put a person's name after them. Role words ("Nurse", "Front Desk") do not. */
const TITLES = new Set(["mr", "mrs", "ms", "mx", "miss", "mister", "dr", "doctor", "prof", "professor", "rev", "sir", "madam", "dame"]);

/** Words that start or join a Title-Case run without being part of a name ("The", "And"). */
const FUNCTION_WORDS = new Set(
  "a an the this that these those and or but nor so if when then as is are was were be in on at for from to with by of per via our my your their his her its we all any no not thanks thank hi hello dear re fw fwd cc attn".split(" "),
);

/**
 * Words that make a Title-Case run a place, an organisation, a species or breed, or a heading,
 * not a person. Lowercase. Places and streets, organisations, animals and breeds, record headings,
 * US states.
 */
const NON_PERSON = new Set(
  `
street st road rd avenue ave boulevard blvd drive lane ln way court ct circle cir place pl parkway pkwy
highway hwy route trail terrace square plaza loop row city town county village valley canyon river
lake creek mountain mountains mount mt peak hill hills heights park ridge springs spring falls bay beach
island point harbor port fork hollow meadow meadows grove wood woods forest landing junction crossing
station airport north south east west downtown uptown center centre
inc llc llp ltd corp corporation co company group holdings partners associates clinic clinics hospital
animal animals veterinary vet vets pet pets services service supply supplies foods labs lab laboratory
laboratories bank insurance university college school academy church foundation society shelter
rescue farm farms ranch kennel kennels hotel pharmacy market store shop studio studios media systems
solutions technologies consulting enterprises industries international global medical health care
canine feline equine bovine porcine ovine caprine avian lapine murine dog dogs cat cats puppy kitten
horse pony rabbit bunny ferret parrot bird retriever shepherd terrier spaniel collie poodle bulldog
hound beagle pointer setter labrador husky mastiff boxer pug dachshund chihuahua schnauzer pinscher
corgi doodle shorthair longhair tabby siamese persian ragdoll bengal sphynx coon mix breed
dose weight date time total amount note notes name number phone address status type level score
rate count value plan report summary history exam visit result results test tests day week month
year morning afternoon evening record records chart invoice account balance payment
alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii
idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan
minnesota mississippi missouri montana nebraska nevada ohio oklahoma oregon pennsylvania tennessee
texas utah vermont virginia washington wisconsin wyoming
`
    .split(/\s+/)
    .filter((w) => w !== ""),
);

/** Two-word phrases made of name words that are breeds, not people. */
const NON_PERSON_PHRASES = new Set(["jack russell", "king charles", "bichon frise", "shih tzu", "lhasa apso", "shiba inu"]);

/** Word endings of common drug names ("Carprofen", "Rimadyl"): a medication after a pet's name is not a surname. */
const DRUG_ENDING_RE = /(?:cillin|profen|oxicam|azole|mycin|cycline|floxacin|pril|olol|dyl|sone|pam|lam|zine|mab|nib|statin|prazole|tidine|vir)$/;

/** Whether a word (already Title-Case) can stand in a person's name. */
function isNameWord(word: string, ctx: Context): boolean {
  const f = fold(word);
  if ((f.match(/\p{L}/gu) ?? []).length < 2) return false;
  if (isHonorificOrRole(f) || FUNCTION_WORDS.has(f) || NON_PERSON.has(f) || isDateWord(f)) return false;
  if (DRUG_ENDING_RE.test(f)) return false;
  if (ctx.keep.has(f) || ctx.vocabulary.has(f)) return false;
  return true;
}

export interface ProseOptions {
  /** The policy keep list, folded (recur.ts keepForms). */
  keep: ReadonlySet<string>;
  /** Spec vocabulary forms, folded (recur.ts vocabularyForms). */
  vocabulary: ReadonlySet<string>;
  /** Values of cells under `keep`: a name wholly inside one is kept. */
  kept?: Iterable<string>;
}

interface Context {
  keep: ReadonlySet<string>;
  vocabulary: ReadonlySet<string>;
  /** Folded word → the indexes of the kept values holding it. */
  keptWords: Map<string, Set<number>>;
}

interface Token {
  word: string;
  start: number;
  end: number;
  /** A single capital letter with its dot: a middle initial ("J."). */
  initial: boolean;
  /** Written with a dot right after it ("Dr."). */
  dotted: boolean;
}

// A Title-Case word (an upper-case letter, a lower-case letter, then letters and marks, joined by
// an inner apostrophe or hyphen: "O'Brien", "Rose-May", "McDonald"), or a capital letter and a dot.
const TOKEN_RE = /(?<![\p{L}\p{M}\p{N}_'\u2019-])(?:\p{Lu}\p{M}*\p{Ll}[\p{L}\p{M}]*(?:['\u2019-][\p{L}\p{M}]+)*|\p{Lu}(?=\.))(?![\p{L}\p{M}\p{N}_])/gu;

/** The Title-Case runs of `text`: tokens one space apart (after a dotted title or initial, too). */
function runs(text: string): Token[][] {
  const out: Token[][] = [];
  let run: Token[] = [];
  let lastEnd = -1;
  for (const m of text.matchAll(TOKEN_RE)) {
    let word = m[0];
    const start = m.index;
    // A possessive ends the name: "Quill's" is "Quill".
    const possessive = /['\u2019]s$/u.test(word);
    if (possessive) word = word.slice(0, -2);
    const end = start + word.length;
    const dotted = text[start + m[0].length] === ".";
    const tok: Token = { word, start, end, initial: [...word].length === 1, dotted };
    const gap = lastEnd < 0 ? "" : text.slice(lastEnd, start);
    const prev = run[run.length - 1];
    // A dot ends the run unless it belongs to a title or an initial ("Dr. Avery", "Avery J. Quill").
    const abbreviated = prev !== undefined && prev.dotted && (prev.initial || TITLES.has(fold(prev.word)));
    const joins = prev !== undefined && (/^[ \u00a0]$/.test(gap) || (abbreviated && /^\.[ \u00a0]$/.test(gap)));
    if (!joins && run.length > 0) {
      out.push(run);
      run = [];
    }
    run.push(tok);
    lastEnd = possessive ? -1 : end;
    if (possessive) {
      out.push(run);
      run = [];
    }
  }
  if (run.length > 0) out.push(run);
  return out;
}

/** The word at `s` starts a sentence, a line or the text. */
function sentenceInitial(text: string, s: number): boolean {
  let j = s - 1;
  while (j >= 0 && /[ \t\u00a0"'\u201c\u2018(\[*\-\u2022#>]/u.test(text[j] as string)) j--;
  if (j < 0) return true;
  const ch = text[j] as string;
  if (ch === "\n" || ch === "\r" || ch === "!" || ch === "?" || ch === ":") return true;
  if (ch === ".") {
    const before = /\p{L}+$/u.exec(text.slice(Math.max(0, j - 10), j))?.[0] ?? "";
    return !TITLES.has(before.toLowerCase());
  }
  return false;
}

/** A candidate wholly inside one kept value (every word of it in that value). */
function insideKept(words: readonly string[], ctx: Context): boolean {
  const first = ctx.keptWords.get(fold(words[0] as string));
  if (first === undefined) return false;
  for (const id of first) if (words.every((w) => ctx.keptWords.get(fold(w))?.has(id) === true)) return true;
  return false;
}

/** The people in one run, appended to `out`; a name found after a title gets that title as written ("Dr.") in `titles`. */
function fromRun(text: string, run: readonly Token[], ctx: Context, out: Set<string>, titles: Map<string, Set<string>>): void {
  const isName = (t: Token | undefined): t is Token => t !== undefined && !t.initial && isNameWord(t.word, ctx);
  /** Name words from `i`: up to `max` words, middle initials allowed between them. Returns the end index. */
  const collect = (i: number, max: number): number => {
    let j = i;
    let words = 0;
    while (j < run.length && words < max) {
      const t = run[j] as Token;
      if (t.initial && t.dotted && isName(run[j + 1])) {
        j++;
        continue;
      }
      if (!isName(t)) break;
      j++;
      words++;
    }
    // Never end on an initial.
    while (j > i && (run[j - 1] as Token).initial) j--;
    return j;
  };
  const accept = (from: number, to: number): string | undefined => {
    const toks = run.slice(from, to).filter((t) => !t.initial);
    if (toks.length === 0) return undefined;
    // The run goes on into a place, organisation or breed word: "Jordan River", "Jack Russell Terrier".
    const next = run[to];
    if (next !== undefined && NON_PERSON.has(fold(next.word))) return undefined;
    const words = toks.map((t) => t.word);
    if (NON_PERSON_PHRASES.has(fold(words.join(" ")))) return undefined;
    if (ctx.keep.has(fold(words.join(" "))) || ctx.vocabulary.has(fold(words.join(" ")))) return undefined;
    if (insideKept(words, ctx)) return undefined;
    const name = text.slice((run[from] as Token).start, (run[to - 1] as Token).end);
    out.add(name);
    return name;
  };
  let i = 0;
  while (i < run.length) {
    const t = run[i] as Token;
    const f = fold(t.word);
    if (TITLES.has(f)) {
      const j = collect(i + 1, 3);
      if (j > i + 1) {
        const name = accept(i + 1, j);
        if (name !== undefined) {
          const set = titles.get(name) ?? new Set<string>();
          set.add(text.slice(t.start, t.end + (t.dotted ? 1 : 0)));
          titles.set(name, set);
        }
        i = j;
      } else i++;
      continue;
    }
    if (!t.initial && isGivenName(t.word) && isName(t)) {
      const j = collect(i, 3);
      const toks = run.slice(i, j).filter((x) => !x.initial);
      if (toks.length >= 2) {
        const last = toks[toks.length - 1] as Token;
        const lastOk = isSurname(last.word) || (!DICTIONARY.has(fold(last.word)) && [...last.word].length >= 3);
        // "Will Carter" mid-sentence is a name; "Will" starting a sentence is a verb.
        const dictionaryGiven = DICTIONARY.has(f);
        const givenOk = !dictionaryGiven || (isSurname(last.word) && !sentenceInitial(text, t.start));
        if (lastOk && givenOk) {
          accept(i, j);
          i = j;
          continue;
        }
      }
    }
    i++;
  }
}

/** Build the matching context once for a corpus. */
function context(opts: ProseOptions): Context {
  const keptWords = new Map<string, Set<number>>();
  let id = 0;
  for (const v of opts.kept ?? []) {
    for (const w of v.match(/[\p{L}\p{M}]+(?:['\u2019-][\p{L}\p{M}]+)*/gu) ?? []) {
      const k = fold(w);
      const set = keptWords.get(k) ?? new Set<number>();
      set.add(id);
      keptWords.set(k, set);
    }
    id++;
  }
  return { keep: opts.keep, vocabulary: opts.vocabulary, keptWords };
}

/** The people named in `texts` (each name as written, deduplicated by case-folded form), sorted. */
export function proseNames(texts: Iterable<string>, opts: ProseOptions): string[] {
  return proseNamesWithTitles(texts, opts).names;
}

/**
 * proseNames, with the titles each name was found after: `titles` maps a returned name to the
 * titles as written before any spelling of it ("Dr.", "Mrs"), sorted. A name never found after a
 * title is not in it.
 */
export function proseNamesWithTitles(texts: Iterable<string>, opts: ProseOptions): { names: string[]; titles: Map<string, string[]> } {
  const ctx = context(opts);
  const found = new Set<string>();
  const seen = new Map<string, Set<string>>();
  for (const text of texts) for (const run of runs(text)) fromRun(text, run, ctx, found, seen);
  // One spelling per folded form, the smallest, so the result does not depend on input order.
  const byFold = new Map<string, string>();
  for (const v of found) {
    const k = fold(v);
    const prior = byFold.get(k);
    if (prior === undefined || v < prior) byFold.set(k, v);
  }
  const titles = new Map<string, string[]>();
  for (const [v, set] of seen) {
    const name = byFold.get(fold(v)) as string;
    titles.set(name, [...new Set([...(titles.get(name) ?? []), ...set])].sort(cmp));
  }
  return { names: [...byFold.values()].sort(cmp), titles };
}

const NO_CONTEXT: Context = { keep: new Set(), vocabulary: new Set(), keptWords: new Map() };

/**
 * Whether a cell value reads as a person's name: two to four Title-Case words with a gazetteer given
 * name first or surname last ("Avery Quill", "Marisol J. Okonkwo"), or "Surname, Given" with one of
 * them in the gazetteer, and no place, organisation, breed or role word in it.
 */
export function looksLikePersonName(value: string): boolean {
  const v = value.trim();
  if (v === "" || /\d/.test(v)) return false;
  const comma = /^([^,]+),\s*([^,]+)$/u.exec(v);
  const parts = comma !== null ? [comma[1] as string, comma[2] as string] : [v];
  const tokens = parts.flatMap((p) => p.trim().split(/\s+/));
  if (tokens.length < 2 || tokens.length > 4) return false;
  const words: string[] = [];
  for (const raw of tokens) {
    if (/^\p{Lu}\.$/u.test(raw)) continue;
    if (!/^\p{Lu}\p{M}*\p{Ll}[\p{L}\p{M}]*(?:['\u2019-][\p{L}\p{M}]+)*$/u.test(raw)) return false;
    if (!isNameWord(raw, NO_CONTEXT)) return false;
    words.push(raw);
  }
  if (words.length < 2) return false;
  if (NON_PERSON_PHRASES.has(fold(words.join(" ")))) return false;
  const given = comma !== null ? (comma[2] as string).trim().split(/\s+/)[0] as string : (words[0] as string);
  const surname = comma !== null ? (comma[1] as string).trim().split(/\s+/).pop() as string : (words[words.length - 1] as string);
  return isGivenName(given) || isSurname(surname);
}

/** A column of people: at least this share of its values read as a person's name. */
export const PERSON_COLUMN_RATIO = 0.5;

/** Whether a column's values are mostly people's names (looksLikePersonName). */
export function isPersonColumn(values: readonly string[]): boolean {
  const filled = values.map((v) => v.trim()).filter((v) => v !== "");
  if (filled.length === 0) return false;
  return filled.filter(looksLikePersonName).length / filled.length >= PERSON_COLUMN_RATIO;
}
