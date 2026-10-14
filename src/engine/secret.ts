// The `secret` pattern (AGT-1844): credential-shaped tokens (passwords, API keys, tokens) that no
// trigger word introduces, or that a trigger introduced a sentence or a turn earlier. Each match is
// written as the fixed REDACTED placeholder (text.ts gives it the `redact` class): no pseudonym, no
// map entry. Pure and deterministic; no model.
//
// A token is a run of text between whitespace and the boundary characters ("'()[]{}<>|,;= and
// their typographic forms), with opening and closing punctuation trimmed; "!" and "?" stay, since
// passwords end in them. "key:value" is read as its value. A token is a secret when:
// - strict (anywhere): 8 to 64 characters mixing at least three of {lowercase, uppercase, digit,
//   symbol}, where a symbol is one of !@#$%^&*~?|` inside the token (a trailing ! or ? does not
//   count, nor do the separators - _ . / : \ +), and the token is not a "natural" word such as
//   "Windows11", "FY2026Budget" or "iPhone15Pro" (capitalised words, all-caps runs and digit runs);
// - long (anywhere): 20 to 512 characters of the base64 / base64url alphabet that mix at least two
//   of {lowercase, uppercase, digit} with high entropy (at least 4 bits a character and 6 changes of
//   character class), and is not natural;
// - boosted: in the sentence (or turn) of a secret trigger or in the next two, 6 to 64 characters
//   mixing at least two classes, one of them a digit or a symbol inside the token ("Example2031!",
//   "hunter22"; never "Thanks!"). After a password trigger (password, passwd, pwd, pw, passcode,
//   passphrase, combo, combination) a natural word with a number counts ("Summer2024"); after the
//   commoner "key", "api key" and "token" it must not be natural ("x9k2m7q4" counts, "Windows11"
//   in "the key point ... Windows11" does not).
// Never a secret: a URL, email, user@host, @handle, #tag or #123 reference, a path or file name, a
// dotted member path, a regex range, a date or time, a version string, a spreadsheet reference
// ("!$B$2:$B$5"), a pseudonym or the placeholder,
// an amount or measure ("38.6lb", "Amoxi500mg"), a known id shape (all digits, hex, a GUID,
// "AB-2026-0001", "web-7d4b9c8f6-x2k9p", "INC0012345"), a phone, IP, MAC or host, or a short
// technical term ("sha256", "base64"). Hex is never a secret, so hashes and ids in logs stay.
//
// Sentences and turns: a text is cut into units at line breaks and after ., ! or ? followed by
// space and a capital, a digit or an opening quote. A caller that scans one document in several
// calls (a transcript turn by turn, a DOCX paragraph by paragraph) passes the same SecretCarry to
// each, so a trigger near the end of one turn still boosts the next two; each call ends a unit.

/** How far each kind of trigger's boost still reaches into the next call, in units (sentences or turns). */
export interface SecretCarry {
  strong: number;
  weak: number;
}

export const newSecretCarry = (): SecretCarry => ({ strong: 0, weak: 0 });

/** No trigger nearby; after key / token; after a password-family trigger. */
export type Boost = "none" | "weak" | "strong";

export interface SecretSpan {
  start: number;
  end: number;
}

export interface SecretOptions {
  /** Run the trigger boost. Off reads strict and long shapes only. Default on. */
  boost?: boolean;
  /** Boost state shared across calls over one document; absent = this text alone. */
  carry?: SecretCarry;
}

/** Units a trigger boosts after its own: "the same or next 2 sentences/turns". */
const BOOST_UNITS = 2;

const STRONG_TRIGGER_RE =
  /(?<![\p{L}\p{N}_])(?:pass(?:words?|wds?|codes?|phrases?)|pwds?|pws?|combos?|combinations?)(?![\p{L}\p{N}_])/giu;
const WEAK_TRIGGER_RE = /(?<![\p{L}\p{N}_])(?:api[ \t_-]?keys?|keys?|tokens?)(?![\p{L}\p{N}_])/giu;

// Characters that end a token, as whitespace does.
const BOUNDARY = "\"'“”‘’«»()\\[\\]{}<>|,;=";
const TOKEN_RE = new RegExp(`[^\\s${BOUNDARY}]+`, "gu");
const LEAD_RE = /^[*_~`¿¡]+/u;
const TRAIL_RE = /[.,;:*_~`]+$/u;
const TRAIL_BANG_RE = /[!?]+$/u;
const STRONG = "!@#$%^&*~?|`";
const STRONG_RE = /[!@#$%^&*~?|`]/u;
const UPPER_RE = /\p{Lu}/u;
const LOWER_RE = /\p{Ll}/u;
const DIGIT_RE = /\p{N}/u;

const UNITS =
  "mg|mcg|µg|ug|g|kg|lb|lbs|oz|ml|l|cc|iu|units?|mmol|meq|mm|cm|m|km|in|ft|mi|mph|kph|°c|°f|c|f|k|h|hr|hrs|min|mins|s|sec|secs|ms|" +
  "d|wk|wks|mo|mos|y|yr|yrs|yo|st|nd|rd|th|x|px|pt|em|hz|khz|mhz|ghz|kb|mb|gb|tb|bit|bits|bps|kbps|mbps|gbps|fps|am|pm|v|kv|w|kw|kwh|a|ma|mah|b|bn|mm2|m2|m3";
const UNIT_SET = new Set(UNITS.split("|").flatMap((u) => (u.endsWith("s?") ? [u.slice(0, -2), u.slice(0, -1)] : [u])));

// Technical terms with a digit that read like a short password but are vocabulary.
const TECH = new Set([
  "sha1", "sha224", "sha256", "sha384", "sha512", "md4", "md5", "base32", "base64", "base64url", "utf8", "utf16", "utf32",
  "x86", "x64", "i386", "amd64", "arm64", "aarch64", "ipv4", "ipv6", "mp3", "mp4", "m4a", "h264", "h265", "aes128",
  "aes192", "aes256", "rsa2048", "rsa4096", "ed25519", "p256", "p384", "pbkdf2", "bcrypt", "argon2", "argon2id", "hmac256",
  "oauth2", "http2", "http3", "tls12", "tls13", "s3", "ec2", "win32", "win64", "x509", "pkcs12", "pkcs7", "ascii85",
]);

const PSEUDONYM_RE = /(?:Person|Org|Host|Id|Value|Loc)_[0-9A-F]{4}|user_[0-9a-f]{4}@|host-[0-9a-f]{4}|REDACTED|Redacted/u;
const URL_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|urn:|file:)/iu;
const PATH_RE = /^(?:\/|~\/|\.\.?\/|\\\\|[A-Za-z]:[\\/])/u;
const DATE_RE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[T _]?\d{1,2}(?::\d{2}){1,2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/iu;
const TIME_RE = /^(?:T)?\d{1,2}(?::\d{2}){1,2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2}|am|pm|a\.m\.|p\.m\.)?$/iu;
const VERSION_RE = /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/iu;
const VERSION_WORD_RE = /^[A-Za-z]+[-_]?v\d+(?:\.\d+)*$/u;
const AMOUNT_RE = /^[~≈±+-]?(?:[A-Z]{0,3}[$€£¥₹])?[~≈±+-]?\d[\d,]*(?:\.\d+)?(?:[kKmMbB]|bn)?$/u;
const MEASURE_RE = new RegExp(`^[~≈±+-]?\\d[\\d,]*(?:\\.\\d+)?[-]?(?:${UNITS}|%)(?:\\/(?:${UNITS}))?$`, "iu");
// A drug or product word with a dose: "Amoxi500mg", "Cefa-250mg", "Doxy100mg".
const DOSES = "mg|mcg|µg|ug|g|kg|ml|l|cc|iu|units?|mmol|meq|%";
const DOSE_RE = new RegExp(`^\\p{Lu}?\\p{Ll}{2,}(?:-\\p{Lu}?\\p{L}*)?-?\\d+(?:\\.\\d+)?(?:${DOSES})(?:\\/(?:${UNITS}))?$`, "u");
const HEX_RE = /^(?:0x)?[0-9a-f]+$|^(?:0x)?[0-9A-F]+$/u;
// Ids of one case: letters and digits joined by separators ("AB-2026-0001", "web-7d4b9c8f6-x2k9p").
const CODE_UPPER_RE = /^[A-Z0-9]+(?:[-_./:][A-Z0-9]+)+$/u;
const CODE_LOWER_RE = /^[a-z0-9]+(?:[-_./:][a-z0-9]+)+$/u;
// A letter prefix and a number, or a number and a short letter suffix: "INC0012345", "2026Q3".
const PREFIXED_ID_RE = /^[A-Z]{1,6}[-_]?\d+$|^\d+[A-Z]{1,3}\d*$/u;
// "#42", "Issue#42", "policy.md#columns", "String#toLowerCase".
const REF_RE = /^[\p{L}]*#\d+$|^[\w./-]+\.[A-Za-z]{1,5}#[\w.-]+$|^\p{Lu}[\p{L}\p{N}]*#\p{Ll}[\p{L}\p{N}]*$/u;
// A regex character class or range list: "A-Za-z0-9", "0-9A-Fa-f:-".
const RANGES_RE = /^(?=.*[\p{L}\p{N}]-[\p{L}\p{N}])(?:[\p{L}\p{N}]-[\p{L}\p{N}]|[\\._%+$:/!#*-])+$/u;
// A dotted member path: "specSchema.$defs.entity", "tokens?.profile".
const MEMBER_RE = /^\.*[\p{L}_$][\p{L}\p{N}_$]*(?:\??\.[\p{L}_$][\p{L}\p{N}_$]*)+$/u;
// A spreadsheet reference: "$B$2", "!$B$2:$B$5", "Sheet1!A1:C9", "R1C1".
const CELL_REF = "\\$?[A-Z]{1,3}\\$?\\d+|R\\d+C\\d+|\\$?[A-Z]{1,3}|\\$?\\d+";
// It must hold a "$" or a ":", so "Welcome!2026" is not one.
const CELL_REF_RE = new RegExp(`^(?=.*[$:])(?:[\\p{L}\\p{N}_ :]*!)?!?(?:${CELL_REF})(?::(?:${CELL_REF}))?$`, "u");
const FILE_RE = /\.[A-Za-z][A-Za-z0-9]{0,4}$/u;
const LONG_RE = /^[A-Za-z0-9+/_.-]+={0,2}$/u;

/**
 * Units of `text`: [start, end) ranges between line breaks and sentence ends. Only a range with a
 * word in it (two letters together) counts, so a cue number, a closing "</v>" or a blank line between
 * turns does not use up a trigger's reach.
 */
function unitsOf(text: string): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  const push = (end: number) => {
    if (/\p{L}{2}/u.test(text.slice(at, end))) out.push([at, end]);
    at = end;
  };
  for (const m of text.matchAll(/\r?\n|[.!?]+(?=[ \t]+["'“‘(]?[\p{Lu}\p{N}])/gu)) push(m.index + m[0].length);
  push(text.length);
  return out;
}

/** The runs of a run of letters and digits: digit runs, all-caps runs and words ("HTMLParser" is HTML, Parser). */
// "IPv4": an all-caps run with one lowercase letter is one acronym run.
const RUN_RE = /\p{N}+|\p{Lu}{2,}\p{Ll}(?!\p{Ll})|\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{L}+/gu;
// Capitalised two-letter words that are words ("paraId", "getUserById"), not a password's "Tr" or "Zx".
const TWO_LETTER = new Set(["Id", "Of", "By", "To", "Is", "On", "Up", "In", "At", "My", "No", "Go", "Do", "Be", "He", "We", "It", "As", "An", "Or", "If", "So", "Me", "Us", "Ok", "Db", "Js", "Ui", "Ux", "Os", "Io"]);
// A numeronym: "i18n", "l10n", "a11y", "k8s".
const NUMERONYM_RE = /^\p{Ll}\d{1,2}\p{Ll}{1,3}$/u;

/**
 * Natural: every run of letters and digits reads as words and numbers — a capitalised word of three
 * or more letters, an all-caps run, a digit run, a lowercase word at the start ("iPhone15Pro",
 * "x509Cert") or a unit or ordinal after a number ("3rd", "500mg"). "Tr0ub4dor", "P4ssw0rd" and
 * "Zx9Qw7Lp" are not natural: a lowercase run follows a digit, or a capital has one lowercase letter.
 */
function natural(core: string): boolean {
  for (const chunk of core.split(/[^\p{L}\p{N}]+/u)) {
    if (chunk === "" || NUMERONYM_RE.test(chunk)) continue;
    const runs = chunk.match(RUN_RE) ?? [];
    if (runs.join("") !== chunk) return false;
    for (const [i, r] of runs.entries()) {
      if (DIGIT_RE.test(r[0] as string)) continue;
      const prev = i > 0 ? (runs[i - 1] as string) : undefined;
      if (UPPER_RE.test(r[0] as string)) {
        if (LOWER_RE.test(r) && r.length < 3 && !TWO_LETTER.has(r)) return false;
        continue;
      }
      // A lowercase run: the chunk's first, or a unit after a number.
      if (prev === undefined) continue;
      if (DIGIT_RE.test(prev[0] as string) && UNIT_SET.has(r.toLowerCase())) continue;
      return false;
    }
  }
  return true;
}

/** A strong symbol between letters or digits: "Tr0ub4dor&3", "P@ss". "&" between capitals (R&D, AT&T) is not one. */
function interiorSymbol(core: string): boolean {
  const inner = core.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (!STRONG.includes(ch)) continue;
    if (ch === "&" && /\p{Lu}/u.test(inner[i - 1] ?? "") && /\p{Lu}/u.test(inner[i + 1] ?? "")) continue;
    return true;
  }
  return false;
}

function classes(s: string): { upper: boolean; lower: boolean; digit: boolean; symbol: boolean; count: number } {
  const upper = UPPER_RE.test(s);
  const lower = LOWER_RE.test(s);
  const digit = DIGIT_RE.test(s);
  const symbol = STRONG_RE.test(s);
  return { upper, lower, digit, symbol, count: [upper, lower, digit, symbol].filter(Boolean).length };
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function classSwitches(s: string): number {
  const kind = (ch: string): number => (DIGIT_RE.test(ch) ? 0 : UPPER_RE.test(ch) ? 1 : LOWER_RE.test(ch) ? 2 : 3);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (kind(s[i] as string) !== kind(s[i - 1] as string)) n++;
  return n;
}

/**
 * A shape that is never a secret, whatever its character classes. `others` says whether another
 * free-text pattern (email, IP, MAC, GUID, phone, host) matches the whole token.
 */
function excluded(core: string, others: (s: string) => boolean): boolean {
  const bare = core.replace(TRAIL_BANG_RE, "");
  if (bare === "") return true;
  if (PSEUDONYM_RE.test(core)) return true;
  if (URL_RE.test(core) || core.includes("://")) return true;
  if (/^[@#]/u.test(core)) return true;
  if (/@[^@]*\./u.test(core)) return true;
  // user@host with no domain ("admin@srv01"): a natural host after a user name of two or more characters.
  const at = /^([\w.-]{2,})@([A-Za-z][\w-]*)$/u.exec(core);
  if (at !== null && (natural(at[2] as string) || CODE_LOWER_RE.test(at[2] as string))) return true;
  if (PATH_RE.test(core) || core.includes("\\")) return true;
  if (core.includes("/") && core.split("/").every((seg) => seg === "" || natural(seg) || CODE_UPPER_RE.test(seg) || CODE_LOWER_RE.test(seg))) return true;
  if (DATE_RE.test(bare) || TIME_RE.test(bare) || VERSION_RE.test(bare) || VERSION_WORD_RE.test(bare)) return true;
  if (AMOUNT_RE.test(bare) || MEASURE_RE.test(bare) || DOSE_RE.test(bare)) return true;
  if (HEX_RE.test(bare) || CODE_UPPER_RE.test(bare) || CODE_LOWER_RE.test(bare) || PREFIXED_ID_RE.test(bare) || REF_RE.test(bare)) return true;
  if (TECH.has(bare.toLowerCase()) || CELL_REF_RE.test(bare) || RANGES_RE.test(bare)) return true;
  if (MEMBER_RE.test(bare) && bare.split(/\??\./u).every((seg) => seg === "" || natural(seg.replace(/\$/gu, "")))) return true;
  // A file name: a natural stem and a short extension ("Report_Q3_v2.docx").
  const ext = FILE_RE.exec(bare);
  if (ext !== null && natural(bare.slice(0, ext.index))) return true;
  return others(bare);
}

/** Whether a token (trimmed) is a secret, strictly, by the long rule, or under a trigger's boost. */
export function isSecretToken(core: string, boost: Boost, others: (s: string) => boolean = () => false): boolean {
  const len = [...core].length;
  if (len < 6 || len > 512) return false;
  if (excluded(core, others)) return false;
  // A trailing ! or ? counts only under a trigger, and only alongside a digit.
  const strictCore = core.replace(TRAIL_BANG_RE, "");
  const inner = interiorSymbol(strictCore);
  const c = classes(strictCore);
  if (len >= 8 && len <= 64 && c.count >= 3 && (inner || !natural(strictCore))) return true;
  if (len >= 20 && LONG_RE.test(core) && !natural(core)) {
    const letters = [c.upper, c.lower, c.digit].filter(Boolean).length;
    if (letters >= 2 && entropy(core) >= 4 && classSwitches(core) >= 6) return true;
  }
  if (boost === "none" || len > 64) return false;
  const all = classes(core);
  if (all.count < 2 || !(all.digit || inner)) return false;
  return boost === "strong" || inner || !natural(strictCore);
}

/** One token at text[start, end): leading and trailing punctuation trimmed, "key:value" read as its value. */
function trimToken(text: string, start: number, end: number): [number, number] | null {
  let s = start;
  let e = end;
  const lead = LEAD_RE.exec(text.slice(s, e));
  if (lead !== null) s += lead[0].length;
  const trail = TRAIL_RE.exec(text.slice(s, e));
  if (trail !== null) e -= trail[0].length;
  if (e <= s) return null;
  const tok = text.slice(s, e);
  // "pw:Tr0ub4dor&3", "token:abc": a word, a colon, then the value. Times and URLs are left whole.
  const kv = /^([\p{L}][\p{L}_-]*):(?!\/\/)(?=\S)/u.exec(tok);
  if (kv !== null) s += kv[0].length;
  return e > s ? [s, e] : null;
}

/**
 * Secret spans in `text`, sorted, non-overlapping. `others` reports whether another free-text
 * pattern matches a whole token (so an email or phone is never read as a secret).
 */
export function findSecretSpans(text: string, others: (s: string) => boolean = () => false, opts: SecretOptions = {}): SecretSpan[] {
  const boostOn = opts.boost !== false;
  const units = unitsOf(text);
  const carry = opts.carry ?? newSecretCarry();
  /** Units each trigger kind boosts here, from the carry and from this text's own triggers. */
  const reach = (re: RegExp, carried: number): { on: boolean[]; next: number } => {
    const on = units.map((_, i) => i < carried);
    let next = carried;
    if (!boostOn) return { on: on.fill(false), next: 0 };
    let u = 0;
    for (const m of text.matchAll(re)) {
      while (u < units.length && (units[u] as [number, number])[1] <= m.index) u++;
      for (let k = u; k <= u + BOOST_UNITS && k < units.length; k++) on[k] = true;
      next = Math.max(next, u + BOOST_UNITS + 1);
    }
    // What reaches the next call: units still boosted past this text's last one.
    return { on, next: Math.max(0, next - units.length) };
  };
  const strong = reach(STRONG_TRIGGER_RE, carry.strong);
  const weak = reach(WEAK_TRIGGER_RE, carry.weak);
  carry.strong = strong.next;
  carry.weak = weak.next;
  const out: SecretSpan[] = [];
  // Every token in the text; one outside every counted unit (a range with no word) has no boost.
  let u = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    while (u < units.length && (units[u] as [number, number])[1] <= m.index) u++;
    const inUnit = u < units.length && (units[u] as [number, number])[0] <= m.index;
    const boost: Boost = !inUnit ? "none" : strong.on[u] === true ? "strong" : weak.on[u] === true ? "weak" : "none";
    const t = trimToken(text, m.index, m.index + m[0].length);
    if (t === null) continue;
    if (isSecretToken(text.slice(t[0], t[1]), boost, others)) out.push({ start: t[0], end: t[1] });
  }
  return out;
}
