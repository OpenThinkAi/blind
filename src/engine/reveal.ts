// Reveal: the way back for whoever holds the map. Every pseudonym the map
// records is replaced with the original value it records, in file content and
// in folder and file names, so a blinded file reads as it did before `blind
// apply`. Deterministic and model-free, like the rest of the engine: the only
// inputs are the blinded bytes, their path and the map.
//
// A pseudonym is matched as a whole token: not next to a letter or digit, and
// not inside a dotted name (so a host or IPv4 pseudonym is never matched as
// part of a longer one). "_" separates tokens, as it does in blinded file names
// (`Person_1E95_user_559f@host-f3ce.com.md`). The longest pseudonym wins at each
// position. The value restored is the one the map records for the pseudonym, so
// an alias or a case variant comes back as that recorded form.
//
// Formats: CSV/TSV cell by cell (a restored value that needs quoting is quoted),
// JSON/JSONL string by string (spliced into the original text, escaped as JSON),
// and text. Anything else has no reversal path yet and is refused.

import { guidCore } from "./canonical.ts";
import { CsvError, parseCsv, renderCell, serializeCsv, sniffDelimiter } from "./csv.ts";
import { decode, EncodingError, encode } from "./encoding.ts";
import { engineFormat } from "./apply.ts";
import { isJsonNumber, JsonError, quote, scanJson, scanJsonl, stringOffsets } from "./json.ts";
import type { BlindMap } from "./map.ts";
import { splitExtension } from "./names.ts";

/** A file that cannot be revealed: no reversal path for its format, or it does not parse. */
export class RevealError extends Error {
  override name = "RevealError";
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Target {
  value: string;
  /** GUID pseudonyms: the original's bare core, written back in the case the pseudonym was written in. */
  guid?: string;
}

export interface Revealed {
  text: string;
  restored: number;
}

export class Revealer {
  private readonly targets = new Map<string, Target>();
  private readonly re: RegExp | null;

  constructor(map: BlindMap) {
    for (const e of map.entries) {
      // Host labels and email local parts are components of the host and email pseudonyms,
      // which have entries of their own; apply never writes a component on its own.
      if (e.kind === "host-label" || e.kind === "email-local") continue;
      const core = e.kind === "id" ? guidCore(e.pseudonym) : undefined;
      if (core !== undefined) {
        const target = { value: e.value, guid: guidCore(e.value) };
        this.targets.set(core, target);
        this.targets.set(core.toUpperCase(), target);
      } else this.targets.set(e.pseudonym, { value: e.value });
    }
    const forms = [...this.targets.keys()].sort((a, b) => b.length - a.length || cmp(a, b));
    this.re =
      forms.length === 0
        ? null
        : new RegExp(`(?<![\\p{L}\\p{N}]|[\\p{L}\\p{N}]\\.)(?:${forms.map(escapeRe).join("|")})(?![\\p{L}\\p{N}]|\\.[\\p{L}\\p{N}])`, "gu");
  }

  private original(match: string): string {
    const t = this.targets.get(match) as Target;
    if (t.guid === undefined) return t.value;
    return match === match.toUpperCase() ? t.guid.toUpperCase() : t.guid;
  }

  /** Every pseudonym in `text` replaced with its original. */
  text(text: string): Revealed {
    if (this.re === null) return { text, restored: 0 };
    let restored = 0;
    const out = text.replace(this.re, (m) => {
      restored++;
      return this.original(m);
    });
    return { text: out, restored };
  }

  /** Spans of pseudonyms in `text`, in order: [start, end, original]. */
  spans(text: string): [number, number, string][] {
    if (this.re === null) return [];
    return [...text.matchAll(this.re)].map((m) => [m.index, m.index + m[0].length, this.original(m[0])]);
  }

  /**
   * A "/"-separated path with its folder names and its file name (without the extension) revealed,
   * the parts `blind apply` blinds. Throws RevealError when a restored part is not a usable name.
   */
  path(path: string): Revealed {
    const segments = path.split("/");
    const [stem, ext] = splitExtension(segments.pop() as string);
    let restored = 0;
    const named = (s: string): string => {
      const r = this.text(s);
      restored += r.restored;
      if (r.restored > 0 && (r.text === "" || r.text === "." || r.text === ".." || /[/\\\0]/.test(r.text))) {
        throw new RevealError("a restored folder or file name is not a usable name (it is empty or contains a path separator)");
      }
      return r.text;
    };
    const out = [...segments.map(named), named(stem) + ext].join("/");
    return { text: out, restored };
  }
}

function revealTable(text: string, delim: string, rv: Revealer): Revealed {
  const rows = parseCsv(text, delim);
  let restored = 0;
  for (const row of rows) {
    for (const cell of row.cells) {
      const r = rv.text(cell.value);
      if (r.restored === 0) continue;
      restored += r.restored;
      cell.raw = renderCell(r.text, cell.quoted, delim);
    }
  }
  return { text: serializeCsv(rows, delim), restored };
}

function revealJson(text: string, jsonl: boolean, rv: Revealer): Revealed {
  const tokens = jsonl ? scanJsonl(text) : scanJson(text);
  const edits: { start: number; end: number; text: string }[] = [];
  const keys = new Set<string>();
  let restored = 0;
  for (const t of tokens) {
    if (t.kind === "literal") continue;
    const raw = text.slice(t.start, t.end);
    if (t.kind === "number") {
      const r = rv.text(t.value);
      if (r.restored === 0) continue;
      restored += r.restored;
      edits.push({ start: t.start, end: t.end, text: isJsonNumber(r.text) ? r.text : quote(r.text) });
      continue;
    }
    const spans = rv.spans(t.value);
    let value = t.value;
    if (spans.length > 0) {
      // Splice into the literal as written, so untouched characters keep their escaping.
      const offs = stringOffsets(raw);
      let out = "";
      let at = 0;
      value = "";
      let from = 0;
      for (const [s, e, orig] of spans) {
        out += raw.slice(at, offs[s]) + quote(orig).slice(1, -1);
        at = offs[e] as number;
        value += t.value.slice(from, s) + orig;
        from = e;
      }
      value += t.value.slice(from);
      restored += spans.length;
      edits.push({ start: t.start, end: t.end, text: out + raw.slice(at) });
    }
    if (t.kind === "key") {
      const k = `${t.object}\0${value}`;
      if (keys.has(k)) throw new RevealError("two keys of one object would get the same name when revealed");
      keys.add(k);
    }
  }
  let out = "";
  let at = 0;
  for (const e of edits) {
    out += text.slice(at, e.start) + e.text;
    at = e.end;
  }
  return { text: out + text.slice(at), restored };
}

export interface RevealedFile {
  bytes: Uint8Array;
  restored: number;
}

/** The blinded file at `path` (its extension decides the format) with every pseudonym restored. */
export function revealFile(path: string, bytes: Uint8Array, rv: Revealer): RevealedFile {
  const format = engineFormat(path);
  // Only formats with a reversal path below; anything apply learns later is refused until it gets one.
  if (format !== "csv" && format !== "tsv" && format !== "json" && format !== "jsonl" && format !== "text") {
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "(no extension)";
    throw new RevealError(`no reversal path for ${ext} files yet; reveal handles CSV/TSV, JSON/JSONL and text (.txt, .md, .log)`);
  }
  try {
    const { encoding, text } = decode(bytes);
    const r =
      format === "csv" || format === "tsv"
        ? revealTable(text, format === "tsv" ? "\t" : sniffDelimiter(text), rv)
        : format === "json" || format === "jsonl"
          ? revealJson(text, format === "jsonl", rv)
          : rv.text(text);
    return { bytes: r.restored === 0 ? bytes : encode(r.text, encoding), restored: r.restored };
  } catch (e) {
    if (e instanceof CsvError || e instanceof JsonError || e instanceof EncodingError) {
      throw new RevealError(`cannot read it as ${format}: ${e.message}`);
    }
    throw e;
  }
}
