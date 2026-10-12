// The engine for XLSX workbooks: each worksheet is a table with the same column
// treatments as a CSV file, and every other place identifying text lives in a
// workbook (src/formats/xlsx.ts `classify`) is rewritten as free text, except
// identity metadata (authors, creator, last modified by, manager, company,
// threaded-comment people), which is replaced as a whole whatever the spec says,
// as DOCX does, and the account names in paths (src/formats/paths.ts), which are
// replaced as a whole with a person pseudonym.
//
// Planned in three steps, like the rest of the engine:
// 1. planXlsx: read the workbook, decide every column, and give every shared
//    string one treatment (the strictest of the cells that use it; an
//    unreferenced, orphaned string is free text).
// 2. prepareXlsx, once the corpus-wide name matcher exists: plan the sheet,
//    defined and table names with the name hook, scan every text run and
//    attribute blind does not rewrite for spec values, and walk the rewrite
//    once with a recorder in place of the pseudonymizer, so every pseudonym the
//    workbook needs is derived in sorted order with the rest of the corpus.
// 3. renderXlsx: the same walk with the pseudonymizer.
//
// Free text inside a workbook (comments, metadata, pivot caches, chart caches,
// orphaned shared strings, formula string literals) is matched against the
// spec entities, the patterns and every pseudonymised column value of the
// corpus, as names are; cells in free columns use the spec entities and
// patterns only, as CSV cells do. A cell (or shared string) whose whole text
// is a worksheet's name is written as that sheet's blinded name, so a
// contents sheet keeps pointing at the right sheet.

import { type ColumnRule, REDACTED_VALUE } from "../schema.ts";
import { type Frame, localName, type MemberResult, readOoxml, rewriteOoxml, rewriteXml, ZipError } from "../formats/ooxml.ts";
import { accountSegments, replaceAccounts } from "../formats/paths.ts";
import {
  cellText,
  classify,
  needsQuotes,
  quoteSheet,
  readWorkbook,
  sheetRows,
  slotRules,
  tokenizeFormula,
  wholeClass,
  type XlsxCell,
  XlsxError,
  type XlsxWorkbook,
} from "../formats/xlsx.ts";
// The profiler's header rule, so spec headers name the same row the profile reported.
import { detectHeaderRow } from "../profile/table.ts";
import type { ColumnReport } from "./apply.ts";
import { PSEUDO_CLASSES, type PseudoClass } from "./canonical.ts";
import { type ColumnAction, decide, outcomeOf } from "./columns.ts";
import type { NameSlot } from "./names.ts";
import { type HexNamer, rewriteOfficeId } from "./officeid.ts";
import type { TextScanner } from "./recur.ts";
import type { ExtraForm, Span } from "./text.ts";
import { refuseUnrewritten } from "./unrewritten.ts";

/** The spec does not fit the workbook; the caller turns this into its ApplyError (exit 2). */
export class XlsxSpecError extends Error {
  override name = "XlsxSpecError";
}

/** Anything that hands out pseudonyms: the pseudonymizer, or a recorder while planning. */
export interface Namer {
  pseudonym(cls: PseudoClass, value: string): string;
}

export type Spanner = (text: string) => Span[];

type Action = ColumnAction | { kind: "header" };

interface CellPlan {
  action: Action;
  /** A number cell rewritten as a number (a pseudonymised column, or a whole-value spec match). */
  renumber: boolean;
}

interface Pending {
  cell: CellPlan;
  text: string;
  number: boolean;
  column: ColumnReport;
}

export interface SheetReport {
  name: string;
  /** 1-based; 0 for an empty sheet. */
  headerRow: number;
  noHeader: boolean;
}

export interface XlsxPlan {
  wb: XlsxWorkbook;
  /** Per worksheet member, per cell reference. */
  cells: Map<string, Map<string, CellPlan>>;
  /** One treatment per shared string; "orphan" for one no cell uses. */
  strings: (Action | { kind: "orphan" })[];
  columns: ColumnReport[];
  sheets: SheetReport[];
  /** Pseudonymised cell values, for the corpus-wide name matcher. */
  columnValues: ExtraForm[];
  /** The same, without columns classed vocabulary: the recurring values (recur.ts). */
  mapped: ExtraForm[];
  /** Data cells not pseudonymised, counted once the corpus-wide scanner exists. */
  pending: Pending[];
  /** Filled by prepareXlsx. */
  requests: { cls: PseudoClass; value: string }[];
  /** Hex linking IDs the render needs (src/engine/officeid.ts), for the caller to derive in sorted order. */
  hexIds: string[];
  /** Identity metadata and account names replaced whole, as written; filled by prepareXlsx. */
  metadata: string[];
  /**
   * The same values with their classes, read when the workbook is planned (AGT-1812): they recur
   * elsewhere in the corpus like a pseudonymised column value. Trimmed, in member and document order.
   */
  wholes: ExtraForm[];
  /** Set when a `drop` or `redact` column cannot be cleared in this workbook: it is not written, for this reason. */
  refusal?: string;
}

const NUMBER = /^(-?)(\d+)(?:\.(\d+))?([Ee][+-]?\d+)?$/;
const isFilled = (s: string | undefined): s is string => s !== undefined && s.trim() !== "";
const hasSensitive = (spans: readonly Span[]): boolean => spans.some((s) => s.cls !== null);
/** A span that is the whole text: a number cell holding a spec ID, which can be renumbered. */
const whole = (spans: readonly Span[], text: string): boolean => spans.length === 1 && spans[0]?.cls !== null && spans[0]?.start === 0 && spans[0]?.end === text.length;
const lower = (s: string): string => s.toLowerCase();

/** Step 1. Throws XlsxSpecError when the spec does not fit; ZipError or XlsxError when the file cannot be read. */
export function planXlsx(path: string, bytes: Uint8Array, rules: readonly ColumnRule[]): XlsxPlan {
  const wb = readWorkbook(bytes);
  const broken = wb.members.find((m) => m.kind === "error");
  if (broken?.kind === "error") throw new XlsxError(`member ${broken.name} cannot be read (${broken.error})`);

  for (const rule of rules) {
    if (rule.jsonPath !== undefined || rule.sheet === undefined) {
      throw new XlsxSpecError(`${path}: a spec rule for this workbook has no sheet; name the column by its sheet and header`);
    }
    const sheet = wb.sheets.find((s) => s.name === rule.sheet);
    if (sheet === undefined || sheet.member === null) {
      throw new XlsxSpecError(`${path}: the spec has a rule for worksheet ${JSON.stringify(rule.sheet)}, which is not in the workbook; fix the rule or re-plan`);
    }
  }

  const cells = new Map<string, Map<string, CellPlan>>();
  const columns: ColumnReport[] = [];
  const sheets: SheetReport[] = [];
  const columnValues: ExtraForm[] = [];
  const mapped: ExtraForm[] = [];
  const pending: Pending[] = [];
  let refusal: string | undefined;
  /** Per shared string, the actions of the cells that use it. */
  const uses: Action[][] = wb.sharedStrings.map(() => []);

  for (const sheet of wb.sheets) {
    if (sheet.member === null) continue;
    const rows = sheetRows(sheet, wb.sharedStrings);
    const detected = detectHeaderRow(rows);
    const headerRow = rows.length === 0 ? -1 : (detected ?? 1) - 1;
    const headerCells = headerRow >= 0 ? (rows[headerRow] ?? []) : [];
    const width = Math.max(0, ...rows.map((r) => r.length));
    const headers = Array.from({ length: width }, (_, i) => headerCells[i] ?? "");
    const sheetRules = rules.filter((r) => r.sheet === sheet.name);
    for (const rule of sheetRules) {
      if (!headers.some((h) => h.trim() === (rule.header as string).trim())) {
        throw new XlsxSpecError(
          `${path}: the spec has a rule for column ${JSON.stringify(rule.header)} on worksheet ${JSON.stringify(sheet.name)}, which is not in its header row (row ${headerRow + 1}); fix the rule or re-plan`,
        );
      }
    }
    sheets.push({ name: sheet.name, headerRow: headerRow + 1, noHeader: rows.length > 0 && detected === null });

    const byCol = new Map<number, XlsxCell[]>();
    for (const c of sheet.cells) {
      if (c.row <= headerRow) continue;
      const list = byCol.get(c.col) ?? [];
      list.push(c);
      byCol.set(c.col, list);
    }
    const plans = new Map<string, CellPlan>();
    for (let col = 0; col < width; col++) {
      const header = headers[col] as string;
      const rule = sheetRules.find((r) => (r.header as string).trim() === header.trim());
      const data = byCol.get(col) ?? [];
      const texts = data.map((c) => cellText(c, wb.sharedStrings));
      const { action, stats } = decide(rule, texts);
      const column: ColumnReport = {
        index: col,
        header,
        sheet: sheet.name,
        class: rule?.class ?? "unknown",
        treatment: rule?.treatment ?? null,
        outcome: outcomeOf(action, stats),
        changed: 0,
        flagged: 0,
      };
      // Recurring values: what this column pseudonymises, unless the column is classed vocabulary.
      const recur = action.kind === "pseudo" && rule?.class !== "vocabulary";
      const removes = action.kind === "drop" || action.kind === "redact";
      data.forEach((c, i) => {
        const text = texts[i] as string;
        if (removes && isFilled(text) && c.type !== "s" && c.type !== "str" && c.type !== "inlineStr") {
          // Only text can be emptied or overwritten in place; a number, date or boolean would need its cell retyped.
          refusal ??= `worksheet ${JSON.stringify(sheet.name)} cell ${c.ref} is not text, so its ${action.kind === "drop" ? "dropped" : "redacted"} column cannot be cleared in place; blind it (treatment "blind") instead`;
          return;
        }
        if (!isFilled(text) || c.type === "b" || c.type === "e" || c.type === "d") return;
        // A number cell is renumbered only when a rule (or the class it gives) pseudonymises the
        // column. Under the fail-closed fallback (`stats` set) it is left as written, like free
        // text: renumbering an amount gives a different, plausible number, which is silent
        // corruption (AGT-1822). A whole-value spec match is still renumbered (prepareXlsx).
        const cellAction: ColumnAction = c.type === "n" && stats !== undefined && action.kind === "pseudo" ? { kind: "free" } : action;
        if (cellAction !== action) column.numbersLeft = (column.numbersLeft ?? 0) + 1;
        const plan: CellPlan = { action: cellAction, renumber: cellAction.kind === "pseudo" && c.type === "n" };
        plans.set(c.ref, plan);
        if (c.type === "s") (uses[Number(c.v)] as Action[]).push(action);
        if (plan.renumber && !NUMBER.test(text)) {
          throw new XlsxError(`worksheet ${JSON.stringify(sheet.name)} cell ${c.ref}: a number in a form that cannot be renumbered in place`);
        }
        if (removes) column.changed++;
        else if (cellAction.kind === "pseudo") {
          column.changed++;
          // A number is pseudonymised as an id; only a whole number is found again as written.
          const form: ExtraForm | null = c.type !== "n" ? { cls: cellAction.cls, value: text } : /^\d+$/.test(text) ? { cls: "id", value: text } : null;
          if (form !== null) {
            columnValues.push(form);
            if (recur) mapped.push(form);
          }
        } else pending.push({ cell: plan, text, number: c.type === "n", column });
      });
      columns.push(column);
    }
    // Rows above the header and the header row itself are free text.
    for (const c of sheet.cells) {
      if (c.row > headerRow) continue;
      plans.set(c.ref, { action: { kind: "header" }, renumber: false });
      if (c.type === "s") (uses[Number(c.v)] as Action[]).push({ kind: "header" });
    }
    cells.set(sheet.member, plans);
  }

  // One treatment per shared string: emptied if any cell using it is dropped, else redacted if any
  // is, else a pseudonym if any cell gets one, else free text if any cell treats it so, else kept.
  // Strings no cell uses are orphans: free text all the same.
  const rank = (a: Action): number => (a.kind === "pseudo" ? 0 : a.kind === "keep" ? 2 : 1);
  const strings = uses.map((list): Action | { kind: "orphan" } => {
    if (list.length === 0) return { kind: "orphan" };
    if (list.some((a) => a.kind === "drop")) return { kind: "drop" };
    if (list.some((a) => a.kind === "redact")) return { kind: "redact" };
    const pseudo = list.filter((a): a is { kind: "pseudo"; cls: PseudoClass } => a.kind === "pseudo");
    if (pseudo.length > 0) {
      const cls = PSEUDO_CLASSES[Math.min(...pseudo.map((a) => PSEUDO_CLASSES.indexOf(a.cls)))] as PseudoClass;
      return { kind: "pseudo", cls };
    }
    return [...list].sort((a, b) => rank(a) - rank(b))[0] as Action;
  });
  const removing = columns.some((c) => c.outcome === "dropped" || c.outcome === "redacted");
  const cache = removing ? wb.members.find((m) => /^xl\/(?:pivotCache|charts)\//i.test(m.name)) : undefined;
  // Pivot and chart caches repeat cell values that are not in the map, so nothing would clear them there.
  if (refusal === undefined && cache !== undefined) refusal = `the workbook drops or redacts a column, but member ${cache.name} caches cell values blind cannot clear`;
  return { wb, cells, strings, columns, sheets, columnValues, mapped, pending, requests: [], hexIds: [], metadata: [], wholes: xlsxWholes(bytes), ...(refusal === undefined ? {} : { refusal }) };
}

/**
 * The identity metadata and path account names the render replaces whole (the `whole` and `path`
 * slots of classify), with their classes, read before any pseudonym is derived so the corpus-wide
 * recurrence pass can find them again in cells, names, other files and file names.
 */
function xlsxWholes(bytes: Uint8Array): ExtraForm[] {
  const out: ExtraForm[] = [];
  for (const m of readOoxml(bytes)) {
    // planXlsx has already refused a workbook with a member that cannot be read.
    if (m.kind !== "xml") continue;
    rewriteXml(
      m.text,
      (value, ctx) => {
        const slot = classify(m.name, ctx.element, ctx.parents, ctx.attribute);
        if (slot === "whole") {
          const core = value.trim();
          if (core !== "") out.push({ cls: wholeClass(ctx.element, ctx.attribute), value: core });
        } else if (slot === "path") {
          for (const seg of accountSegments(value)) if (seg.value.trim() !== "") out.push({ cls: "person", value: seg.value.trim() });
        }
        return value;
      },
      slotRules(m.name),
    );
  }
  return out;
}

/** Every value in the workbook that no pseudonym may equal. */
export function xlsxValues(p: XlsxPlan): string[] {
  const out: string[] = [];
  for (const s of p.wb.sheets) {
    out.push(s.name);
    for (const c of s.cells) out.push(cellText(c, p.wb.sharedStrings));
  }
  for (const s of p.wb.sharedStrings) out.push(s.runs.join(""));
  out.push(...p.wb.definedNames);
  for (const t of p.wb.tables) out.push(t.name, t.displayName, ...t.columns);
  out.push(...p.metadata);
  return out;
}

export interface NameHook {
  plan(slot: NameSlot, name: string): void;
  rename(slot: NameSlot, name: string, pz: Namer): string;
}

export interface Env {
  /** The corpus-wide scanner: patterns, spec entities and recurring values. */
  scanner: TextScanner;
  names: NameHook;
}

export interface Rendered {
  bytes: Uint8Array;
  members: MemberResult[];
  /** Worksheet names before and after. */
  sheetNames: { from: string; to: string }[];
  entityReplacements: number;
  patternReplacements: number;
  mappedReplacements: number;
  /** Transcript speakers' names (or parts, or misspellings) replaced. */
  speakerReplacements: number;
  /** People named only in prose, or parts of their names, replaced. */
  proseReplacements: number;
  keptHosts: number;
  /** Identity metadata values and account names in paths replaced as a whole. */
  metadataReplacements: number;
}

/**
 * Step 2. Plans the names, scans what blind does not rewrite (`scan` finds spec values: entities
 * and long pseudonymised column values), and records every pseudonym the render needs in
 * `p.requests`. Returns a reason when the workbook must not be written.
 */
export function prepareXlsx(path: string, bytes: Uint8Array, p: XlsxPlan, env: Env, scan: Spanner): string | null {
  // Cells left as text: free cells get every span, kept cells only recurring values.
  for (const c of p.pending) {
    if (c.cell.action.kind === "keep") {
      if (env.scanner.flagged(c.text)) c.column.flagged++;
      if (!c.number && env.scanner.kept(c.text).length > 0) c.column.changed++;
      continue;
    }
    const spans = env.scanner.free(c.text);
    if (c.number) c.cell.renumber = whole(spans, c.text) && NUMBER.test(c.text);
    if (c.number ? c.cell.renumber : hasSensitive(spans)) c.column.changed++;
  }
  for (const s of p.wb.sheets) env.names.plan("sheet", s.name);
  for (const n of p.wb.definedNames) env.names.plan("definedName", n);
  for (const t of p.wb.tables) {
    env.names.plan("definedName", t.name);
    env.names.plan("definedName", t.displayName);
  }

  // Text that no slot rewrites must not hold a spec value or a pattern match.
  const refused = refuseUnrewritten(bytes, (member) => slotRules(member), scan);
  if (refused !== null) return refused;

  const requests: { cls: PseudoClass; value: string }[] = [];
  const recorder: Namer = {
    pseudonym(cls, value) {
      requests.push({ cls, value });
      return value;
    },
  };
  const hexIds: string[] = [];
  walk(path, bytes, p, env, recorder, { hex: (v) => (hexIds.push(v), v) }, false);
  p.requests = requests;
  p.hexIds = hexIds;
  return null;
}

/** Step 3. Throws XlsxSpecError when blinded names would collide. */
export function renderXlsx(path: string, bytes: Uint8Array, p: XlsxPlan, env: Env, pz: Namer, ids: HexNamer): Rendered {
  return walk(path, bytes, p, env, pz, ids, true);
}

function digitsOf(v: string): { sign: string; int: string; frac: string; exp: string } {
  const m = NUMBER.exec(v) as RegExpExecArray;
  return { sign: m[1] as string, int: m[2] as string, frac: m[3] ?? "", exp: m[4] ?? "" };
}

/** A number with its digits pseudonymised as an `id`, same length, the decimal point where it was. */
function renumber(v: string, pz: Namer): string {
  const { sign, int, frac, exp } = digitsOf(v);
  const d = pz.pseudonym("id", int + frac);
  return `${sign}${d.slice(0, int.length)}${frac === "" ? "" : `.${d.slice(int.length)}`}${exp}`;
}

function walk(path: string, bytes: Uint8Array, p: XlsxPlan, env: Env, pz: Namer, ids: HexNamer, render: boolean): Rendered {
  let entityReplacements = 0;
  let patternReplacements = 0;
  let mappedReplacements = 0;
  let speakerReplacements = 0;
  let proseReplacements = 0;
  let keptHosts = 0;
  let metadataReplacements = 0;
  // Replaced whole: an author, creator, company or user ID, or an account name in a path.
  const wholeValue = (cls: PseudoClass, value: string): string => {
    const core = value.trim();
    if (core === "") return value;
    if (!render) p.metadata.push(core);
    const to = pz.pseudonym(cls, core);
    if (to !== core) metadataReplacements++;
    const lead = value.slice(0, value.indexOf(core));
    return lead + to + value.slice(lead.length + core.length);
  };
  const rewrite = (text: string, spans: readonly Span[]): string => {
    let out = "";
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + (s.cls === null ? text.slice(s.start, s.end) : pz.pseudonym(s.cls, s.value));
      at = s.end;
      if (s.cls !== null && s.source === "entity") entityReplacements++;
      else if (s.cls !== null && s.source === "map") mappedReplacements++;
      else if (s.cls !== null && s.source === "speaker") speakerReplacements++;
      else if (s.cls !== null && s.source === "prose") proseReplacements++;
      else if (s.cls !== null) patternReplacements++;
      else if (s.source === "pattern") keptHosts++;
    }
    return out + text.slice(at);
  };
  const free = (text: string): string => rewrite(text, env.scanner.free(text));
  const kept = (text: string): string => rewrite(text, env.scanner.kept(text));
  const rename = (slot: NameSlot, name: string): string => (render ? env.names.rename(slot, name, pz) : name);

  // Names, before and after.
  const sheetOut = new Map<string, string>();
  const sheetByLower = new Map<string, string>();
  for (const s of p.wb.sheets) {
    const to = rename("sheet", s.name);
    sheetOut.set(s.name, to);
    sheetByLower.set(lower(s.name), to);
  }
  const definedOut = new Map<string, string>();
  for (const n of [...p.wb.definedNames, ...p.wb.tables.flatMap((t) => [t.name, t.displayName])]) definedOut.set(lower(n), rename("definedName", n));
  if (render) {
    unique("worksheet", [...sheetOut], path);
    unique("defined or table", [...new Map([...p.wb.definedNames, ...p.wb.tables.flatMap((t) => [t.name, t.displayName])].map((n) => [lower(n), n])).values()].map((n) => [n, definedOut.get(lower(n)) as string]), path);
  }
  const sheetEq = (text: string): string | undefined => sheetOut.get(text);
  const freeCell = (text: string): string => sheetEq(text) ?? free(text);
  const columnOut = new Map<string, string>();
  for (const t of p.wb.tables) for (const c of t.columns) columnOut.set(lower(c), freeCell(c));

  // Numbers renumbered in cells, so pivot and chart caches repeat them.
  const numbers = new Map<string, string>();
  for (const s of p.wb.sheets) {
    if (s.member === null) continue;
    const plans = p.cells.get(s.member);
    for (const c of s.cells) if (c.type === "n" && plans?.get(c.ref)?.renumber) numbers.set(c.v, renumber(c.v, pz));
  }

  const sheetRef = (text: string): string => {
    const direct = sheetByLower.get(lower(text));
    if (direct !== undefined) return direct;
    const colon = text.indexOf(":");
    if (colon > 0) {
      const a = sheetByLower.get(lower(text.slice(0, colon)));
      const b = sheetByLower.get(lower(text.slice(colon + 1)));
      if (a !== undefined && b !== undefined) return `${a}:${b}`;
    }
    return free(text);
  };
  const literal = (text: string): string => {
    // HYPERLINK("#'Sheet name'!A1", ...) and the like.
    const m = /^(#?)(?:'((?:[^']|'')+)'|([^'!#]+))!(.*)$/s.exec(text);
    if (m) {
      const name = m[2] !== undefined ? m[2].replace(/''/g, "'") : (m[3] as string);
      const to = sheetByLower.get(lower(name));
      if (to !== undefined) return `${m[1]}${m[2] !== undefined || needsQuotes(to) ? quoteSheet(to) : to}!${m[4]}`;
    }
    return sheetEq(text) ?? free(text);
  };
  const formula = (f: string): string => {
    const tokens = tokenizeFormula(f);
    let out = "";
    tokens.forEach((t, i) => {
      switch (t.kind) {
        case "string":
          out += `"${literal(t.text).replace(/"/g, '""')}"`;
          return;
        case "sheet": {
          const to = sheetRef(t.text);
          out += to === t.text ? t.raw : t.quoted || needsQuotes(to.replace(/^([^:]+):([^:]+)$/, "$1")) || needsQuotes(to.replace(/^[^:]+:/, "")) ? quoteSheet(to) : to;
          return;
        }
        case "name": {
          // The first sheet of a 3-D reference (Sheet1:Sheet3!A1) is a bare name followed by ":".
          const next = tokens[i + 1];
          const sheet = next?.kind === "other" && next.text.startsWith(":") ? sheetByLower.get(lower(t.text)) : undefined;
          out += sheet ?? definedOut.get(lower(t.text)) ?? t.text;
          return;
        }
        case "bracket":
          out += t.text.replace(/\[([^[\]#'][^[\]]*)\]/g, (whole, inner: string) => {
            const to = columnOut.get(lower(inner));
            return to === undefined ? whole : `[${to}]`;
          });
          return;
        case "other":
          out += t.text;
      }
    });
    return out;
  };

  // Runs of one shared or inline string: unchanged, rewritten run by run, or (when a pseudonym or
  // a span crosses runs) the whole new text in the first non-empty run and the rest emptied.
  const runsOut = (runs: readonly string[], action: Action | { kind: "orphan" }): string[] => {
    const full = runs.join("");
    const merged = (text: string): string[] => {
      const first = runs.findIndex((r) => r !== "");
      return runs.map((r, i) => (i === first ? text : r === "" ? r : ""));
    };
    const eq = sheetEq(full);
    if (eq !== undefined) return eq === full ? [...runs] : merged(eq);
    if (action.kind === "drop" || action.kind === "redact") return full.trim() === "" ? [...runs] : merged(action.kind === "drop" ? "" : REDACTED_VALUE);
    if (action.kind === "pseudo") return full.trim() === "" ? [...runs] : merged(pz.pseudonym(action.cls, full));
    const spans = action.kind === "keep" ? env.scanner.kept(full) : env.scanner.free(full);
    if (spans.length === 0) return [...runs];
    const bounds: number[] = [];
    let at = 0;
    for (const r of runs) bounds.push((at += r.length));
    const crosses = spans.some((s) => bounds.some((b) => s.start < b && s.end > b));
    if (crosses) return merged(rewrite(full, spans));
    let start = 0;
    return runs.map((r) => {
      const end = start + r.length;
      const local = spans.filter((s) => s.start >= start && s.end <= end).map((s) => ({ ...s, start: s.start - start, end: s.end - start }));
      start = end;
      return local.length === 0 ? r : rewrite(r, local);
    });
  };
  const sharedOut = new Map<number, string[]>();
  const inlineOut = new Map<string, string[]>();
  const cellOf = new Map<string, Map<string, XlsxCell>>();
  for (const s of p.wb.sheets) if (s.member !== null) cellOf.set(s.member, new Map(s.cells.map((c) => [c.ref, c])));

  const cellFrame = (parents: readonly Frame[]): Frame | undefined => [...parents].reverse().find((f) => localName(f.name) === "c");
  const phonetic = (parents: readonly Frame[]): boolean => parents.some((f) => localName(f.name) === "rPh");
  // The run counters live in each member's rules; the callback reads them through this accessor.
  const counters = new Map<string, () => { si: number; run: number }>();
  const result = rewriteOoxml(
    bytes,
    (value, ctx) => {
      const slot = classify(ctx.member, ctx.element, ctx.parents, ctx.attribute);
      switch (slot) {
        case null:
          return value;
        case "cellValue": {
          const c = cellFrame(ctx.parents);
          const ref = c?.attrs.get("r") ?? "";
          const plan = p.cells.get(ctx.member)?.get(ref);
          const type = c?.attrs.get("t") ?? "n";
          if (plan === undefined) return value;
          if (type === "n") return plan.renumber ? (numbers.get(value) ?? renumber(value, pz)) : value;
          if (type !== "str") return value;
          const eq = sheetEq(value);
          if (eq !== undefined) return eq;
          if (plan.action.kind === "pseudo") return pz.pseudonym(plan.action.cls, value);
          if (plan.action.kind === "drop") return "";
          if (plan.action.kind === "redact") return REDACTED_VALUE;
          return plan.action.kind === "keep" ? kept(value) : free(value);
        }
        case "inlineRun":
        case "sharedRun": {
          const pos = (counters.get(ctx.member) as () => { si: number; run: number })();
          let action: Action | { kind: "orphan" } | undefined;
          let runs: string[] | undefined;
          let cache: string[] | undefined;
          if (slot === "sharedRun") {
            action = p.strings[pos.si];
            runs = p.wb.sharedStrings[pos.si]?.runs;
            cache = sharedOut.get(pos.si);
          } else {
            const ref = cellFrame(ctx.parents)?.attrs.get("r") ?? "";
            action = p.cells.get(ctx.member)?.get(ref)?.action;
            runs = cellOf.get(ctx.member)?.get(ref)?.runs;
            cache = inlineOut.get(`${ctx.member}\0${ref}`);
          }
          if (action === undefined || runs === undefined) return free(value);
          if (phonetic(ctx.parents)) {
            if (action.kind === "pseudo" || action.kind === "drop" || action.kind === "redact") return "";
            return action.kind === "keep" ? kept(value) : free(value);
          }
          if (cache === undefined) {
            cache = runsOut(runs, action);
            if (slot === "sharedRun") sharedOut.set(pos.si, cache);
            else inlineOut.set(`${ctx.member}\0${cellFrame(ctx.parents)?.attrs.get("r") ?? ""}`, cache);
          }
          return cache[pos.run] ?? value;
        }
        case "formula":
        case "location":
          return formula(value);
        case "text":
          return free(value);
        case "header":
          return freeCell(value);
        case "sheetName":
          return sheetOut.get(value) ?? value;
        case "definedName":
          return definedOut.get(lower(value)) ?? value;
        case "sheetRef":
          return sheetRef(value);
        case "nameRef":
          return definedOut.get(lower(value)) ?? value;
        case "display":
          return sheetEq(value) ?? (value.includes("!") ? formula(value) : free(value));
        case "number":
          return numbers.get(value) ?? value;
        case "cache":
          return NUMBER.test(value) ? (numbers.get(value) ?? value) : (sheetEq(value) ?? free(value));
        case "officeId":
          return rewriteOfficeId("id", value, pz, ids);
        case "documentId":
          return rewriteOfficeId("documentId", value, pz, ids);
        case "whole":
          return wholeValue(wholeClass(ctx.element, ctx.attribute), value);
        case "path":
          return replaceAccounts(value, (seg) => wholeValue("person", seg), free);
      }
    },
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
  return {
    bytes: result.bytes,
    members: result.members,
    sheetNames: p.wb.sheets.map((s) => ({ from: s.name, to: sheetOut.get(s.name) as string })),
    entityReplacements,
    patternReplacements,
    mappedReplacements,
    speakerReplacements,
    proseReplacements,
    keptHosts,
    metadataReplacements,
  };
}

/** Blinded names must stay distinct, ignoring case, as the spreadsheet requires. */
function unique(what: string, pairs: readonly (readonly [string, string])[], path: string): void {
  const seen = new Map<string, string>();
  for (const [from, to] of pairs) {
    const other = seen.get(lower(to));
    if (other !== undefined && lower(other) !== lower(from)) {
      throw new XlsxSpecError(`${path}: blinding would give two ${what} names the same name; change the spec so they stay distinct`);
    }
    seen.set(lower(to), from);
  }
}

export { XlsxError, ZipError };
