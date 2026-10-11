// A lossless JSON / JSONL scanner. It does not build a tree: it lists every
// key and scalar with its exact span in the text and the key path ("column")
// it belongs to, so a rewrite splices replacements into the original text and
// everything else (indentation, separators, key order, escapes, the trailing
// newline, one record per line) stays byte for byte. The profiler and the
// engine both use it, so a key path in the profile is the key path a spec rule
// names at apply time.
//
// Key paths:
// - `$` is the document root (each line's root, for JSONL).
// - `.name` for a key made of letters, digits and `_` that does not start with a digit,
//   `["any key"]` (JSON-quoted) for any other key.
// - `[*]` for every element of an array: an array of scalars is one column.
// - `.*` for a member whose key is itself a record identifier (see isRecordKey), so an
//   object keyed by record IDs is one set of columns, not one per record. The keys
//   themselves are the column `.*~` under the same parent.
//
// Dependency-free and deterministic, like csv.ts.

export type JsonFormat = "json" | "jsonl";

export interface JsonToken {
  /** `key`: an object key. `literal`: true, false or null (present, but not a value). */
  kind: "key" | "string" | "number" | "literal";
  /** Span in the text, quotes included for strings and keys. */
  start: number;
  end: number;
  /** The decoded string, or the number or literal exactly as written. */
  value: string;
  /**
   * The key path the token is a value of. A key has one only when it is a record identifier
   * (the `.*~` column); other keys are structure, written into their members' paths, and have null.
   */
  column: string | null;
  /** Keys only: the object the key belongs to, numbered in document order. */
  object?: number;
}

export class JsonError extends Error {
  override name = "JsonError";
}

/** Nesting deeper than this is refused rather than risking the stack. */
export const MAX_DEPTH = 512;

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WHOLE_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const PLAIN_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GUID_RE = /^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** True when `text` is a valid JSON number, so a replacement can stay a bare number. */
export function isJsonNumber(text: string): boolean {
  return WHOLE_NUMBER_RE.test(text);
}

/**
 * A key that is itself a record identifier rather than a field name: all digits, 4 or more
 * digits anywhere (`u-1001`, `ACCT-000123`, a date), hex of 6 or more with a digit (`a3f9c2`),
 * a GUID, an email address or an IPv4 address. Field names such as `sha256`, `line1` or
 * `client_scope_name` are not.
 */
export function isRecordKey(key: string): boolean {
  const k = key.trim();
  if (k === "") return false;
  if (/^\d+$/.test(k)) return true;
  if ((k.match(/\d/g) ?? []).length >= 4) return true;
  if (/^[0-9A-Fa-f]{6,}$/.test(k) && /\d/.test(k)) return true;
  return GUID_RE.test(k) || EMAIL_RE.test(k) || IPV4_RE.test(k);
}

/** The path segment for a structural (non-record) key. */
export function keySegment(key: string): string {
  return PLAIN_KEY_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

class Scanner {
  readonly tokens: JsonToken[] = [];
  private pos: number;
  private objects = 0;

  constructor(
    private readonly text: string,
    from: number,
    private readonly end: number,
    private readonly objectBase: number,
    private readonly where: (at: number) => string,
  ) {
    this.pos = from;
  }

  get objectCount(): number {
    return this.objects;
  }

  private fail(message: string, at = this.pos): never {
    throw new JsonError(`${message} at ${this.where(at)}`);
  }

  private ws(): void {
    while (this.pos < this.end) {
      const c = this.text.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.pos++;
    }
  }

  /** One whole document: a value surrounded by optional whitespace. */
  document(): void {
    this.ws();
    if (this.pos >= this.end) this.fail("no JSON value");
    this.value("$", 0);
    this.ws();
    if (this.pos < this.end) this.fail("unexpected text after the JSON value");
  }

  private value(path: string, depth: number): void {
    if (depth > MAX_DEPTH) this.fail(`nested deeper than ${MAX_DEPTH} levels`);
    const c = this.text[this.pos];
    if (c === "{") return this.object(path, depth);
    if (c === "[") return this.array(path, depth);
    if (c === '"') {
      const start = this.pos;
      const value = this.string();
      this.tokens.push({ kind: "string", start, end: this.pos, value, column: path });
      return;
    }
    for (const lit of ["true", "false", "null"]) {
      if (this.text.startsWith(lit, this.pos) && this.pos + lit.length <= this.end) {
        this.tokens.push({ kind: "literal", start: this.pos, end: this.pos + lit.length, value: lit, column: path });
        this.pos += lit.length;
        return;
      }
    }
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.text);
    if (m === null || m[0] === "" || this.pos + m[0].length > this.end) {
      this.fail(this.pos >= this.end ? "unexpected end of input" : "unexpected character");
    }
    this.tokens.push({ kind: "number", start: this.pos, end: this.pos + m[0].length, value: m[0], column: path });
    this.pos += m[0].length;
  }

  private object(path: string, depth: number): void {
    const id = this.objectBase + this.objects++;
    this.pos++;
    this.ws();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return;
    }
    for (;;) {
      this.ws();
      if (this.text[this.pos] !== '"') this.fail("expected a key");
      const start = this.pos;
      const key = this.string();
      const record = isRecordKey(key);
      this.tokens.push({ kind: "key", start, end: this.pos, value: key, column: record ? `${path}.*~` : null, object: id });
      this.ws();
      if (this.text[this.pos] !== ":") this.fail("expected ':'");
      this.pos++;
      this.ws();
      this.value(record ? `${path}.*` : path + keySegment(key), depth + 1);
      this.ws();
      const c = this.text[this.pos];
      this.pos++;
      if (c === "}") return;
      if (c !== ",") this.fail("expected ',' or '}'", this.pos - 1);
    }
  }

  private array(path: string, depth: number): void {
    this.pos++;
    this.ws();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return;
    }
    for (;;) {
      this.ws();
      this.value(`${path}[*]`, depth + 1);
      this.ws();
      const c = this.text[this.pos];
      this.pos++;
      if (c === "]") return;
      if (c !== ",") this.fail("expected ',' or ']'", this.pos - 1);
    }
  }

  /** A string literal starting at the opening quote; returns its decoded value. */
  private string(): string {
    let out = "";
    let i = this.pos + 1;
    for (;;) {
      if (i >= this.end) this.fail("unterminated string", this.pos);
      const c = this.text[i] as string;
      if (c === '"') break;
      if (c === "\\") {
        const e = this.text[i + 1];
        if (e === "u") {
          const hex = this.text.slice(i + 2, i + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex) || i + 6 > this.end) this.fail("bad \\u escape", i);
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
        } else {
          const ch = e === undefined ? undefined : ESCAPES[e];
          if (ch === undefined || i + 2 > this.end) this.fail("bad escape", i);
          out += ch;
          i += 2;
        }
        continue;
      }
      if (c.charCodeAt(0) < 0x20) this.fail("control character in a string", i);
      out += c;
      i++;
    }
    this.pos = i + 1;
    return out;
  }
}

/** Line and column (both 1-based) of an offset, for error messages that never quote content. */
function lineCol(text: string, at: number): string {
  let line = 1;
  let col = 1;
  for (let i = 0; i < at && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      col = 1;
    } else col++;
  }
  return `line ${line}, column ${col}`;
}

/** Every key and scalar of a JSON document (RFC 8259), in document order. */
export function scanJson(text: string): JsonToken[] {
  const s = new Scanner(text, 0, text.length, 0, (at) => lineCol(text, at));
  s.document();
  return s.tokens;
}

/** Every key and scalar of a JSONL file: one document per line, blank lines allowed. Each line's root is `$`. */
export function scanJsonl(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let objects = 0;
  let line = 0;
  let from = 0;
  while (from <= text.length) {
    const nl = text.indexOf("\n", from);
    const to = nl < 0 ? text.length : nl;
    line++;
    if (text.slice(from, to).trim() !== "") {
      const lineNo = line;
      const lineStart = from;
      const s = new Scanner(text, from, to, objects, (at) => `line ${lineNo}, column ${at - lineStart + 1}`);
      s.document();
      objects += s.objectCount;
      for (const t of s.tokens) tokens.push(t);
    }
    if (nl < 0) break;
    from = nl + 1;
  }
  return tokens;
}

/**
 * For a string literal as written (quotes included): the offset in `raw` where each code unit
 * of the decoded value starts, plus one final entry at the closing quote. Lets a rewrite replace
 * part of a string while every untouched character keeps its original escaping.
 */
export function stringOffsets(raw: string): number[] {
  const offs: number[] = [];
  let i = 1;
  while (i < raw.length - 1) {
    offs.push(i);
    if (raw[i] === "\\") i += raw[i + 1] === "u" ? 6 : 2;
    else i++;
  }
  offs.push(raw.length - 1);
  return offs;
}

/** A decoded value written back as a JSON string literal; pseudonyms are ASCII, so nothing new is escaped. */
export const quote = (value: string): string => JSON.stringify(value);
