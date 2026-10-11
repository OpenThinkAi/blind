// Text views of raw bytes for the mechanical audit. The audit does not trust
// any one decoding: the same bytes are read as Latin-1 (every byte one code
// unit, so ASCII and 8-bit text), UTF-8, and UTF-16 in both byte orders and
// both alignments, and each of those again with common escapes undone (XML
// character references, percent-encoding, JSON/JS backslash escapes). Every
// character of every view maps back to the byte offset it came from.

export interface View {
  /** Which decoding produced the view, e.g. "utf-8" or "utf-16le+unescape". */
  encoding: string;
  text: string;
  /** Byte offset (in the scanned part) of the code unit at index i. */
  byteAt(i: number): number;
}

function latin1View(b: Buffer): View {
  return { encoding: "latin-1", text: b.toString("latin1"), byteAt: (i) => i };
}

/** UTF-8 with an offset per code unit; an invalid byte becomes U+FFFD and maps to itself. */
function utf8View(b: Buffer): View {
  const units: number[] = [];
  const offsets: number[] = [];
  let i = 0;
  const cont = (k: number): boolean => k < b.length && ((b[k] as number) & 0xc0) === 0x80;
  while (i < b.length) {
    const x = b[i] as number;
    let cp = 0xfffd;
    let n = 1;
    if (x < 0x80) cp = x;
    else if (x >= 0xc2 && x <= 0xdf && cont(i + 1)) {
      cp = ((x & 0x1f) << 6) | ((b[i + 1] as number) & 0x3f);
      n = 2;
    } else if (x >= 0xe0 && x <= 0xef && cont(i + 1) && cont(i + 2)) {
      cp = ((x & 0x0f) << 12) | (((b[i + 1] as number) & 0x3f) << 6) | ((b[i + 2] as number) & 0x3f);
      if (cp >= 0x800) n = 3;
      else cp = 0xfffd;
    } else if (x >= 0xf0 && x <= 0xf4 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      cp =
        ((x & 0x07) << 18) | (((b[i + 1] as number) & 0x3f) << 12) | (((b[i + 2] as number) & 0x3f) << 6) | ((b[i + 3] as number) & 0x3f);
      if (cp >= 0x10000 && cp <= 0x10ffff) n = 4;
      else cp = 0xfffd;
    }
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      offsets.push(i, i);
    } else {
      units.push(cp);
      offsets.push(i);
    }
    i += n;
  }
  let text = "";
  for (let k = 0; k < units.length; k += 8192) text += String.fromCharCode(...units.slice(k, k + 8192));
  return { encoding: "utf-8", text, byteAt: (k) => offsets[k] ?? b.length };
}

function utf16View(b: Buffer, littleEndian: boolean, align: 0 | 1): View {
  const units: number[] = [];
  for (let i = align; i + 1 < b.length; i += 2) {
    units.push(littleEndian ? (b[i] as number) | ((b[i + 1] as number) << 8) : ((b[i] as number) << 8) | (b[i + 1] as number));
  }
  let text = "";
  for (let k = 0; k < units.length; k += 8192) text += String.fromCharCode(...units.slice(k, k + 8192));
  const name = `utf-16${littleEndian ? "le" : "be"}${align === 1 ? " (odd offset)" : ""}`;
  return { encoding: name, text, byteAt: (k) => align + 2 * k };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", "/": "/", '"': '"', "'": "'" };

const isHex = (s: string): boolean => /^[0-9A-Fa-f]+$/.test(s);

/**
 * The view with XML character references and named entities, %XX runs
 * (decoded as UTF-8) and backslash escapes (\uXXXX, \xXX, \n, ...) undone.
 * Null when the view has nothing to undo.
 */
export function unescapeView(v: View): View | null {
  const t = v.text;
  if (!/&|%[0-9A-Fa-f]{2}|\\/.test(t)) return null;
  let out = "";
  const map: number[] = [];
  const emit = (s: string, at: number) => {
    out += s;
    for (let k = 0; k < s.length; k++) map.push(at);
  };
  let i = 0;
  let changed = false;
  while (i < t.length) {
    const c = t[i] as string;
    if (c === "&") {
      const m = /^&(?:#[xX]([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([a-zA-Z]+));/.exec(t.slice(i, i + 12));
      if (m) {
        const cp = m[1] !== undefined ? Number.parseInt(m[1], 16) : m[2] !== undefined ? Number(m[2]) : -1;
        const named = m[3] !== undefined ? NAMED[m[3]] : undefined;
        if ((cp >= 0 && cp <= 0x10ffff) || named !== undefined) {
          emit(named ?? String.fromCodePoint(cp), i);
          i += m[0].length;
          changed = true;
          continue;
        }
      }
    } else if (c === "%" && isHex(t.slice(i + 1, i + 3)) && t.slice(i + 1, i + 3).length === 2) {
      const start = i;
      const bytes: number[] = [];
      while (t[i] === "%" && t.slice(i + 1, i + 3).length === 2 && isHex(t.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(t.slice(i + 1, i + 3), 16));
        i += 3;
      }
      emit(new TextDecoder("utf-8").decode(new Uint8Array(bytes)), start);
      changed = true;
      continue;
    } else if (c === "\\") {
      const n = t[i + 1];
      if (n === "u" && t.slice(i + 2, i + 6).length === 4 && isHex(t.slice(i + 2, i + 6))) {
        emit(String.fromCharCode(Number.parseInt(t.slice(i + 2, i + 6), 16)), i);
        i += 6;
        changed = true;
        continue;
      }
      if (n === "x" && t.slice(i + 2, i + 4).length === 2 && isHex(t.slice(i + 2, i + 4))) {
        emit(String.fromCharCode(Number.parseInt(t.slice(i + 2, i + 4), 16)), i);
        i += 4;
        changed = true;
        continue;
      }
      const simple = n === undefined ? undefined : SIMPLE_ESCAPES[n];
      if (simple !== undefined) {
        emit(simple, i);
        i += 2;
        changed = true;
        continue;
      }
    }
    emit(c, i);
    i++;
  }
  if (!changed) return null;
  return { encoding: `${v.encoding}+unescape`, text: out, byteAt: (k) => v.byteAt(map[k] ?? t.length) };
}

/** Every view of the bytes the audit scans, each also with escapes undone. */
export function viewsOf(bytes: Uint8Array): View[] {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base: View[] = [latin1View(b)];
  // For pure ASCII the UTF-8 view is the Latin-1 view.
  if (b.some((x) => x >= 0x80)) base.push(utf8View(b));
  if (b.length >= 2) base.push(utf16View(b, true, 0), utf16View(b, false, 0));
  if (b.length >= 3) base.push(utf16View(b, true, 1), utf16View(b, false, 1));
  const out: View[] = [];
  for (const v of base) {
    out.push(v);
    const u = unescapeView(v);
    if (u !== null) out.push(u);
  }
  return out;
}

/** The view an XML document is read in: UTF-16 when it has that byte-order mark, else UTF-8 (Latin-1 for pure ASCII). */
export function xmlBaseView(bytes: Uint8Array): View {
  const views = viewsOf(bytes);
  const le = bytes[0] === 0xff && bytes[1] === 0xfe;
  const be = bytes[0] === 0xfe && bytes[1] === 0xff;
  const want = le ? "utf-16le" : be ? "utf-16be" : bytes.some((x) => x >= 0x80) ? "utf-8" : "latin-1";
  return views.find((v) => v.encoding === want) as View;
}

/** A plain string (a file or member name) as a single view; offsets are code-unit offsets. */
export function stringView(s: string): View[] {
  const v: View = { encoding: "name", text: s, byteAt: (i) => i };
  const u = unescapeView(v);
  return u === null ? [v] : [v, u];
}

/**
 * Comparison form: per code point NFKD, combining marks removed, lower-cased;
 * every run of whitespace becomes one space. Accent, width and case variants
 * of a value all fold to the same string.
 */
export function fold(s: string): string {
  return foldWithMap(s).text.trim();
}

export interface Folded {
  text: string;
  /** Index in the source string of each code unit of `text`. */
  map: Int32Array;
}

const MARK_RE = /\p{M}/gu;
const SPACE_RE = /\s/u;
/** Per-code-point fold results; the fold of a code point never changes. */
const FOLD_CACHE = new Map<number, string>();

export function foldWithMap(s: string): Folded {
  const parts: string[] = [];
  const map: number[] = [];
  let i = 0;
  let lastSpace = false;
  while (i < s.length) {
    const cp = s.codePointAt(i) as number;
    if (cp < 0x80 && cp !== 0x20 && (cp < 0x09 || cp > 0x0d)) {
      // ASCII fast path: NFKD is the identity and nothing is a mark.
      parts.push(cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 32) : String.fromCharCode(cp));
      map.push(i);
      lastSpace = false;
      i++;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    if (SPACE_RE.test(ch)) {
      if (!lastSpace) {
        parts.push(" ");
        map.push(i);
      }
      lastSpace = true;
    } else {
      let f = FOLD_CACHE.get(cp);
      if (f === undefined) {
        f = ch.normalize("NFKD").replace(MARK_RE, "").toLowerCase();
        FOLD_CACHE.set(cp, f);
      }
      for (let k = 0; k < f.length; k++) map.push(i);
      parts.push(f);
      if (f.length > 0) lastSpace = false;
    }
    i += ch.length;
  }
  return { text: parts.join(""), map: Int32Array.from(map) };
}
