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
// text, and the two Office formats at the zip and XML level, in exactly the
// places blinding rewrites: XLSX through `classify` (src/formats/xlsx.ts), DOCX
// through the units and part rules of src/engine/docx.ts. Rich text (shared and
// inline strings, a DOCX paragraph) is matched as one text, so a pseudonym an
// editor split across runs is restored too: the original goes where the
// pseudonym starts and the rest of it is removed from the later runs. Anything
// else has no reversal path and is refused. An Office file is revealed whole or
// not at all: a member that cannot be read refuses the file.

import { type Frame, localName, rewriteOoxml, ZipError } from "../formats/ooxml.ts";
import { classify, needsQuotes, quoteSheet, readWorkbook, type Slot, slotRules, tokenizeFormula, XlsxError } from "../formats/xlsx.ts";
import { guidCore } from "./canonical.ts";
import { CsvError, parseCsv, renderCell, serializeCsv, sniffDelimiter } from "./csv.ts";
import { decode, EncodingError, encode } from "./encoding.ts";
import { engineFormat } from "./apply.ts";
import { isJsonNumber, JsonError, quote, scanJson, scanJsonl, stringOffsets } from "./json.ts";
import type { BlindMap } from "./map.ts";
import { nameSafe } from "./pseudonym.ts";
import { DocxError, type DocxPlan, planDocx, rulesFor } from "./docx.ts";
import { type NameSlot, splitExtension, violation } from "./names.ts";

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
      } else {
        this.targets.set(e.pseudonym, { value: e.value });
        // The name-safe twin (`Client_A_7F3A`) of a readable form, as written in name slots and URLs.
        const twin = nameSafe(e.pseudonym);
        if (twin !== e.pseudonym) this.targets.set(twin, { value: e.value });
      }
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

  /** The original of `form` when the whole of it is a pseudonym the map records. */
  exact(form: string): string | undefined {
    return this.targets.has(form) ? this.original(form) : undefined;
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
  if (format === null) {
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "(no extension)";
    throw new RevealError(`no reversal path for ${ext} files; reveal handles CSV/TSV, JSON/JSONL, text (.txt, .md, .log, .vtt, .srt), XLSX and DOCX`);
  }
  if (format === "xlsx") return revealXlsx(bytes, rv);
  if (format === "docx") return revealDocx(bytes, rv);
  try {
    const { encoding, text } = decode(bytes);
    const r =
      format === "csv" || format === "tsv"
        ? revealTable(text, sniffDelimiter(text, format === "tsv" ? "\t" : undefined), rv)
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

// ---------------------------------------------------------------- runs

/** A cut in one run or text node: [start, end) removed, `insert` written in its place. */
interface Cut {
  start: number;
  end: number;
  insert: string;
}

/** The parts of the joined-text span [s, e) that fall in each segment, in segment offsets. */
function pieces<T>(segments: readonly { key: T; start: number; value: string }[], s: number, e: number): { key: T; start: number; end: number }[] {
  const out: { key: T; start: number; end: number }[] = [];
  for (const g of segments) {
    const a = Math.max(s, g.start) - g.start;
    const b = Math.min(e, g.start + g.value.length) - g.start;
    if (a < b) out.push({ key: g.key, start: a, end: b });
  }
  return out;
}

/** `value` with its cuts (sorted, not overlapping) applied. */
function splice(value: string, cuts: readonly Cut[]): string {
  let out = "";
  let at = 0;
  for (const c of cuts) {
    out += value.slice(at, c.start) + c.insert;
    at = c.end;
  }
  return out + value.slice(at);
}

/** The runs of one rich string, read as one text, with every pseudonym restored in the run where it starts. */
function revealRuns(runs: readonly string[], rv: Revealer): { runs: string[]; restored: number } {
  let at = 0;
  const segments = runs.map((value, key) => {
    const g = { key, start: at, value };
    at += value.length;
    return g;
  });
  const spans = rv.spans(runs.join(""));
  const cuts: Cut[][] = runs.map(() => []);
  for (const [s, e, orig] of spans) {
    pieces(segments, s, e).forEach((p, i) => (cuts[p.key] as Cut[]).push({ start: p.start, end: p.end, insert: i === 0 ? orig : "" }));
  }
  return { runs: runs.map((r, i) => splice(r, cuts[i] as Cut[])), restored: spans.length };
}

// ---------------------------------------------------------------- XLSX

const NUMBER = /^(-?)(\d+)(?:\.(\d+))?([Ee][+-]?\d+)?$/;
const lower = (s: string): string => s.toLowerCase();

/**
 * A restored worksheet, defined or table name. A pseudonym blinded from part of an identity comes
 * back as the whole recorded form, which a defined name may not hold ("Avery_Total" was blinded to
 * "Person_C625_Total", whose recorded form is "Avery Quill"): each character a defined name cannot
 * have becomes "_", so the name and every formula naming it stay valid and agree. A worksheet name
 * is written as recorded; checkNames refuses one the spreadsheet would not accept.
 */
function restoreName(slot: NameSlot, name: string, rv: Revealer): Revealed {
  const r = rv.text(name);
  if (slot !== "definedName" || r.restored === 0 || violation(slot, r.text) === null) return r;
  return { text: r.text.replace(/[^\p{L}\p{N}_.\\]/gu, "_").replace(/^(?=[^\p{L}_\\])/u, "_"), restored: r.restored };
}

/** Restored worksheet or defined names must be valid and distinct (ignoring case), or the workbook is not revealed. */
function checkNames(slot: NameSlot, names: readonly string[], rv: Revealer): void {
  const what = slot === "sheet" ? "worksheet" : "defined or table";
  const seen = new Map<string, string>();
  for (const name of new Map(names.map((n) => [lower(n), n])).values()) {
    const r = restoreName(slot, name, rv);
    const why = r.restored === 0 ? null : violation(slot, r.text);
    if (why !== null) throw new RevealError(`a restored ${what} name ${why}`);
    const other = seen.get(lower(r.text));
    if (other !== undefined && other !== lower(name)) throw new RevealError(`two ${what} names would reveal to the same name`);
    seen.set(lower(r.text), lower(name));
  }
}

function revealXlsx(bytes: Uint8Array, rv: Revealer): RevealedFile {
  let wb;
  try {
    wb = readWorkbook(bytes);
  } catch (e) {
    if (e instanceof XlsxError || e instanceof ZipError) throw new RevealError(`cannot read it as XLSX: ${e.message}`);
    throw e;
  }
  const broken = wb.members.find((m) => m.kind === "error");
  if (broken?.kind === "error") throw new RevealError(`cannot read it as XLSX: member ${broken.name} cannot be read (${broken.error})`);
  checkNames("sheet", wb.sheets.map((s) => s.name), rv);
  checkNames("definedName", [...wb.definedNames, ...wb.tables.flatMap((t) => [t.name, t.displayName])], rv);

  let restored = 0;
  const count = (r: Revealed): string => {
    restored += r.restored;
    return r.text;
  };
  const text = (v: string): string => count(rv.text(v));
  const definedName = (v: string): string => count(restoreName("definedName", v, rv));
  // A renumbered number: its digits (without sign, point or exponent) are an `id` pseudonym of the
  // same length, the original digits put back around the decimal point where it was.
  const number = (v: string): string => {
    const m = NUMBER.exec(v);
    if (m === null) return v;
    const [, sign, int, frac = "", exp = ""] = m as unknown as [string, string, string, string?, string?];
    const orig = rv.exact(int + frac);
    if (orig === undefined || !/^\d+$/.test(orig) || orig.length !== int.length + frac.length) return v;
    restored++;
    return `${sign}${orig.slice(0, int.length)}${frac === "" ? "" : `.${orig.slice(int.length)}`}${exp}`;
  };
  // The first sheet of a 3-D reference (Sheet1:Sheet3!A1) is a bare name; the whole reference
  // would need quoting if its restored name did, which is not written.
  const firstSheet = (name: string): string => {
    const to = text(name);
    if (to !== name && needsQuotes(to)) throw new RevealError("a worksheet name restored in a 3-D reference would need quotes");
    return to;
  };
  const literal = (v: string): string => {
    // HYPERLINK("#'Sheet name'!A1", ...) and the like.
    const m = /^(#?)(?:'((?:[^']|'')+)'|([^'!#]+))!(.*)$/s.exec(v);
    if (m !== null) {
      const name = m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] as string);
      const to = text(name);
      if (to !== name) return `${m[1]}${m[2] !== undefined || needsQuotes(to) ? quoteSheet(to) : to}!${text(m[4] as string)}`;
    }
    return text(v);
  };
  const formula = (f: string): string =>
    tokenizeFormula(f)
      .map((t, i, tokens) => {
        switch (t.kind) {
          case "string":
            return `"${literal(t.text).replace(/"/g, '""')}"`;
          case "sheet": {
            const to = text(t.text);
            if (to === t.text) return t.raw;
            return t.quoted || to.split(":").some(needsQuotes) ? quoteSheet(to) : to;
          }
          case "name": {
            const next = tokens[i + 1];
            return next?.kind === "other" && next.text.startsWith(":") ? firstSheet(t.text) : definedName(t.text);
          }
          case "bracket":
            return t.text.replace(/\[([^[\]#'][^[\]]*)\]/g, (whole, inner: string) => {
              const to = text(inner);
              return to === inner ? whole : `[${to}]`;
            });
          case "other":
            return t.text;
        }
      })
      .join("");

  // The main runs of each shared string (by index) and inline string (by member and cell), revealed once.
  const source = new Map<string, readonly string[]>(wb.sharedStrings.map((s, i) => [`${i}`, s.runs]));
  for (const s of wb.sheets) for (const c of s.cells) if (s.member !== null && c.type === "inlineStr") source.set(`${s.member}\0${c.ref}`, c.runs);
  const revealed = new Map<string, string[]>();
  const runs = (key: string): string[] | undefined => {
    let out = revealed.get(key);
    const from = source.get(key);
    if (out === undefined && from !== undefined) {
      const r = revealRuns(from, rv);
      restored += r.restored;
      out = r.runs;
      revealed.set(key, out);
    }
    return out;
  };

  const phonetic = (parents: readonly Frame[]): boolean => parents.some((f) => localName(f.name) === "rPh");
  const counters = new Map<string, () => { si: number; run: number }>();

  const slotValue = (slot: Slot | null, value: string, member: string, parents: readonly Frame[]): string => {
    switch (slot) {
      case null:
        return value;
      case "cellValue": {
        const type = parents[parents.length - 1]?.attrs.get("t") ?? "n";
        return type === "n" ? number(value) : type === "str" ? text(value) : value;
      }
      case "inlineRun":
      case "sharedRun": {
        // Phonetic runs are read on their own; the main runs as one text.
        if (phonetic(parents)) return text(value);
        const pos = (counters.get(member) as () => { si: number; run: number })();
        const ref = [...parents].reverse().find((f) => localName(f.name) === "c")?.attrs.get("r") ?? "";
        const out = runs(slot === "sharedRun" ? `${pos.si}` : `${member}\0${ref}`);
        // A run the read pass did not see cannot be placed in its string: the workbook is not revealed.
        if (out === undefined || out[pos.run] === undefined) throw new RevealError(`cannot read it as XLSX: ${member} has a text run outside any string`);
        return out[pos.run] as string;
      }
      case "formula":
      case "location":
        return formula(value);
      case "display":
        return value.includes("!") ? formula(value) : text(value);
      case "number":
        return number(value);
      case "cache":
        return NUMBER.test(value) ? number(value) : text(value);
      case "definedName":
      case "nameRef":
        return definedName(value);
      case "sheetName":
      case "sheetRef":
      case "text":
      case "header":
        return text(value);
      // Identity metadata replaced whole, and the account names in a path: pseudonyms the map records.
      case "whole":
      case "path":
        return text(value);
      case "officeId":
      case "documentId":
        // Office's linking IDs stay as blinding wrote them: they are not reversed.
        return value;
    }
  };

  let result;
  try {
    result = rewriteOoxml(
      bytes,
      (value, ctx) => slotValue(classify(ctx.member, ctx.element, ctx.parents, ctx.attribute), value, ctx.member, ctx.parents),
      (member) => {
        // Which shared string, and which run of it or of an inline string, the next <t> belongs to.
        let si = -1;
        let run = -1;
        counters.set(member, () => ({ si, run }));
        return slotRules(member, {
          visit(el, parents) {
            const name = localName(el.name);
            const root = localName((parents[0] ?? el).name);
            if (root === "sst" && name === "si") {
              si++;
              run = -1;
            } else if (root === "worksheet" && name === "is") run = -1;
            else if (name === "t" && !phonetic(parents)) run++;
          },
        });
      },
    );
  } catch (e) {
    if (e instanceof ZipError) throw new RevealError(`cannot read it as XLSX: ${e.message}`);
    throw e;
  }
  const failed = result.members.find((m) => m.kind === "error");
  if (failed?.kind === "error") throw new RevealError(`cannot read it as XLSX: member ${failed.name} cannot be read (${failed.error})`);
  return { bytes: restored === 0 ? bytes : result.bytes, restored };
}

// ---------------------------------------------------------------- DOCX

type DocxNode = DocxPlan["wholes"][number];
type Role = DocxNode["role"];

function revealDocx(bytes: Uint8Array, rv: Revealer): RevealedFile {
  let plan: DocxPlan;
  try {
    plan = planDocx(bytes, "keep");
  } catch (e) {
    if (e instanceof DocxError) throw new RevealError(`cannot read it as DOCX: ${e.message}`);
    throw e;
  }
  let restored = 0;
  const cuts = new Map<DocxNode, Cut[]>();

  // Each unit (a paragraph's text, its field instructions, or a single value) read as one text. With
  // tracked changes it is read as accepted and as rejected, as blinding reads it; a pseudonym both
  // readings find in the same place is restored once.
  for (const unit of plan.units) {
    const nodes = unit.items.flatMap((i) => ("node" in i ? [i.node] : []));
    if (nodes.length === 0) continue;
    const ids = new Map(nodes.map((n, i) => [n, i]));
    const revised = unit.items.some((i) => ("node" in i ? i.node.role : i.role) !== "plain");
    const readings: { skip: Role; own: Role }[] = revised ? [{ skip: "del", own: "ins" }, { skip: "ins", own: "del" }] : [{ skip: "del", own: "ins" }];
    const recorded = new Set<string>();
    for (const { skip, own } of readings) {
      let joined = "";
      const segments: { key: DocxNode; start: number; value: string }[] = [];
      for (const item of unit.items) {
        if ("node" in item) {
          if (item.node.role === skip) continue;
          segments.push({ key: item.node, start: joined.length, value: item.node.value });
          joined += item.node.value;
        } else if (item.role !== skip) joined += item.sep;
      }
      for (const [s, e, orig] of rv.spans(joined)) {
        const ps = pieces(segments, s, e);
        const key = ps.map((p) => `${ids.get(p.key)}:${p.start}-${p.end}`).join(",");
        if (recorded.has(key)) continue;
        recorded.add(key);
        if (ps.some((p) => (cuts.get(p.key) ?? []).some((c) => c.start < p.end && p.start < c.end))) {
          throw new RevealError("a pseudonym reads differently with tracked changes accepted and with them rejected; accept or reject the changes, then reveal");
        }
        const anchor = ps.find((p) => p.key.role === own) ?? ps[0];
        for (const p of ps) {
          const list = cuts.get(p.key) ?? [];
          list.push({ start: p.start, end: p.end, insert: p === anchor ? orig : "" });
          cuts.set(p.key, list);
        }
        restored++;
      }
    }
  }
  for (const list of cuts.values()) list.sort((a, b) => a.start - b.start);

  const next = new Map<string, number>();
  const result = rewriteOoxml(
    plan.bytes,
    (value, ctx) => {
      const k = next.get(ctx.member) ?? 0;
      next.set(ctx.member, k + 1);
      const node = plan.nodes.get(ctx.member)?.[k];
      // The write pass sees the same values in the same order as the read, or it stops.
      if (node === undefined || node.value !== value) throw new Error(`docx reveal: ${ctx.member} changed between read and write`);
      // Office's linking IDs stay as blinding wrote them: they are not reversed.
      if (node.link !== undefined) return value;
      // Values replaced whole (authors, creator, company) are pseudonyms as a whole.
      if (node.whole !== undefined) {
        const r = rv.text(value);
        restored += r.restored;
        return r.text;
      }
      const list = cuts.get(node);
      return list === undefined ? value : splice(value, list);
    },
    (member) => rulesFor(plan.kinds.get(member) ?? "inert"),
  );
  const failed = result.members.find((m) => m.kind === "error");
  if (failed?.kind === "error") throw new RevealError(`cannot read it as DOCX: part ${failed.name} cannot be written (${failed.error})`);
  return { bytes: restored === 0 ? bytes : result.bytes, restored };
}
