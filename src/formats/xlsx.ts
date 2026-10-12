// XLSX at the zip and XML level: which text in a workbook means what, a read
// pass that turns the workbook into sheets of cells, and a formula tokenizer.
// Shared by the profiler (sheets as tables) and the engine (src/engine/xlsx.ts),
// so the two always agree on what a sheet, a cell and a header are. No document
// object model: everything goes through the streaming rewriter in ooxml.ts.
//
// `classify` is the single list of places identifying text lives in a
// workbook. The engine rewrites exactly those places; every other text run and
// attribute is scanned, and a spec value found there stops the file instead of
// passing through unseen.

import { officeLinkAttribute, officeLinkText } from "./officeids.ts";
import { type Frame, localName, type MemberResult, rewriteOoxml, type RewriteRules, ZipError } from "./ooxml.ts";
import { accountSegments } from "./paths.ts";

/** The workbook cannot be read as a spreadsheet (as opposed to a malformed zip or XML member). */
export class XlsxError extends Error {
  override name = "XlsxError";
}

/** What a selected text node or attribute holds, and so how it is rewritten. */
export type Slot =
  /** `<v>` of a cell. */
  | "cellValue"
  /** A `<t>` run of an inline string (`<is>`). */
  | "inlineRun"
  /** A `<t>` run of a shared string. */
  | "sharedRun"
  /** A formula: cell formulas, defined names, validation and conditional-format formulas, chart references. */
  | "formula"
  /** Free text: comments, metadata, captions, pivot cache strings, external link targets. */
  | "text"
  /** Free text that must read like the header cells it repeats (table column names, pivot cache field names). */
  | "header"
  /** A worksheet name (`<sheet name>`). */
  | "sheetName"
  /** A defined name, table name or table display name. */
  | "definedName"
  /** A reference to a worksheet by name (pivot cache source). */
  | "sheetRef"
  /** A reference to a defined name or table by name (pivot cache source). */
  | "nameRef"
  /** A cell reference such as `'Sheet name'!A1` (hyperlink locations). */
  | "location"
  /** Text that is often a worksheet name (hyperlink display text, the sheet list in docProps/app.xml). */
  | "display"
  /** A cached number (pivot caches): renumbered where its source was. */
  | "number"
  /** A chart cache point: a number or a string. */
  | "cache"
  /** One of Office's own linking IDs (src/formats/officeids.ts): `xr:uid`, threaded comment ids, `x14:id`. */
  | "officeId"
  /** `documentId` on `xr:revisionPtr`: a version prefix, then linking IDs. */
  | "documentId"
  /**
   * Identity metadata, replaced as a whole whatever the spec says (as DOCX does): `dc:creator`,
   * `cp:lastModifiedBy`, app.xml Manager (person) and Company (org), comment authors, threaded-comment
   * person names and user IDs, the workbook's reserved-by user name. `wholeClass` gives the class.
   */
  | "whole"
  /**
   * A path (`x15ac:absPath`, app.xml Template and HyperlinkBase, an external link's target, and any
   * other attribute holding a path, src/formats/paths.ts): its account-name segments are replaced
   * whole, the rest is free text.
   */
  | "path";

const CORE_TEXT = new Set(["title", "subject", "keywords", "description", "category", "contentStatus", "identifier", "version"]);
const APP_TEXT = new Set(["Application"]);
const CORE_WHOLE = new Set(["creator", "lastModifiedBy"]);
const APP_WHOLE = new Set(["Company", "Manager"]);
const APP_PATH = new Set(["HyperlinkBase", "Template"]);

/** The pseudonym class of a `whole` slot, by its element (a text node) or attribute local name; the same classes DOCX uses. */
export function wholeClass(el: Frame, attribute?: string): "person" | "org" | "id" {
  const name = attribute === undefined ? local(el) : localName(attribute);
  return name === "Company" ? "org" : name === "userId" ? "id" : "person";
}
const HEADER_FOOTER = new Set(["oddHeader", "oddFooter", "evenHeader", "evenFooter", "firstHeader", "firstFooter"]);
const FORMULA = new Set(["formula", "formula1", "formula2", "calculatedColumnFormula", "totalsRowFormula"]);
const VALIDATION_TEXT = new Set(["prompt", "error", "promptTitle", "errorTitle"]);
const PIVOT_TABLE_TEXT = new Set(["name", "dataCaption", "grandTotalCaption", "rowHeaderCaption", "colHeaderCaption", "errorCaption", "missingCaption"]);

const local = (f: Frame | undefined): string => (f === undefined ? "" : localName(f.name));
const within = (parents: readonly Frame[], name: string): boolean => parents.some((p) => local(p) === name);

/**
 * The slot of a text node (no `attribute`) or attribute value, or null when blind does not rewrite
 * it. `member` is the zip member path; the root element decides the part's type.
 */
export function classify(member: string, el: Frame, parents: readonly Frame[], attribute?: string): Slot | null {
  const slot = classifyPart(member, el, parents, attribute);
  if (attribute === undefined || (slot !== null && slot !== "text")) return slot;
  // Any other attribute that holds a path with an account name in it, except a part's own name or an
  // internal relationship's target (renaming those would break the package).
  const n = localName(el.name);
  if ((n === "Relationship" && attribute === "Target") || attribute === "PartName") return slot;
  return accountSegments(el.attrs.get(attribute) ?? "").length > 0 ? "path" : slot;
}

function classifyPart(member: string, el: Frame, parents: readonly Frame[], attribute?: string): Slot | null {
  const root = local(parents[0] ?? el);
  const name = local(el);
  const parent = local(parents[parents.length - 1]);
  const attr = attribute === undefined ? undefined : localName(attribute);
  // Office's linking IDs, in any part.
  if (attribute !== undefined) {
    const link = officeLinkAttribute(el.name, attribute);
    if (link !== null) return link === "documentId" ? "documentId" : "officeId";
  } else if (officeLinkText(el.name, parents[parents.length - 1]?.name)) return "officeId";
  switch (root) {
    case "workbook":
      if (attr === undefined) return name === "definedName" ? "formula" : null;
      if (name === "sheet" && attr === "name") return "sheetName";
      if (name === "definedName" && attr === "name") return "definedName";
      if (name === "fileSharing" && attr === "userName") return "whole";
      if (name === "absPath" && attr === "url") return "path";
      return null;
    case "worksheet":
      if (attr === undefined) {
        if (name === "v" && parent === "c") return "cellValue";
        if (name === "f") return "formula";
        if (name === "t" && within(parents, "is")) return "inlineRun";
        if (FORMULA.has(name)) return "formula";
        if (HEADER_FOOTER.has(name)) return "text";
        return null;
      }
      if (name === "hyperlink") return attr === "location" ? "location" : attr === "display" ? "display" : attr === "tooltip" ? "text" : null;
      if (name === "dataValidation" && VALIDATION_TEXT.has(attr)) return "text";
      if ((name === "filter" || name === "customFilter") && attr === "val") return "text";
      return null;
    case "sst":
      return attr === undefined && name === "t" ? "sharedRun" : null;
    case "comments":
      if (attr !== undefined) return null;
      return name === "author" ? "whole" : name === "t" ? "text" : null;
    case "ThreadedComments":
      return attr === undefined && name === "text" ? "text" : null;
    case "personList":
      return name === "person" && (attr === "displayName" || attr === "userId") ? "whole" : null;
    case "coreProperties":
      if (attr !== undefined || parents.length !== 1) return null;
      return CORE_WHOLE.has(name) ? "whole" : CORE_TEXT.has(name) ? "text" : null;
    case "Properties":
      if (/(^|\/)app\.xml$/i.test(member)) {
        if (attr !== undefined) return null;
        if (parents.length === 1 && APP_WHOLE.has(name)) return "whole";
        if (parents.length === 1 && APP_PATH.has(name)) return "path";
        if (parents.length === 1 && APP_TEXT.has(name)) return "text";
        if (name === "lpstr") return within(parents, "TitlesOfParts") ? "display" : "text";
        return null;
      }
      if (attr === undefined) return parent === "property" && (name === "lpwstr" || name === "lpstr" || name === "bstr") ? "text" : null;
      return name === "property" && attr === "name" ? "text" : null;
    case "pivotCacheDefinition":
      if (attr === undefined) return null;
      if (name === "cacheField") return attr === "name" ? "header" : attr === "caption" ? "text" : attr === "formula" ? "formula" : null;
      if (name === "worksheetSource") return attr === "sheet" ? "sheetRef" : attr === "name" ? "nameRef" : null;
      if (attr === "v") return name === "s" ? "text" : name === "n" ? "number" : null;
      if (name === "sharedItems" && (attr === "minValue" || attr === "maxValue")) return "number";
      return null;
    case "pivotCacheRecords":
      if (attr !== "v") return null;
      return name === "s" ? "text" : name === "n" ? "number" : null;
    case "pivotTableDefinition":
      if (attr === undefined) return null;
      if (name === "pivotTableDefinition" && PIVOT_TABLE_TEXT.has(attr)) return "text";
      if ((name === "pivotField" || name === "dataField") && attr === "name") return "text";
      if (name === "item" && attr === "n") return "text";
      return null;
    case "table":
      if (attr === undefined) return FORMULA.has(name) ? "formula" : null;
      if (name === "table" && (attr === "name" || attr === "displayName")) return "definedName";
      if (name === "tableColumn") return attr === "name" ? "header" : attr === "totalsRowLabel" ? "text" : null;
      if ((name === "filter" || name === "customFilter") && attr === "val") return "text";
      return null;
    case "chartSpace":
      if (attr !== undefined) return null;
      if (name === "f") return "formula";
      if (name === "v") return "cache";
      return name === "t" ? "text" : null;
    case "wsDr":
      if (attr === undefined) return name === "t" ? "text" : null;
      return name === "cNvPr" && (attr === "name" || attr === "descr" || attr === "title") ? "text" : null;
    case "xml":
      // Legacy VML drawing (comment shapes): inert except the text inside <x:ClientData>.
      return attr === undefined && within(parents, "ClientData") ? "text" : null;
    case "Relationships":
      return name === "Relationship" && attr === "Target" && el.attrs.get("TargetMode") === "External" ? "path" : null;
    default:
      return null;
  }
}

/** Rules that select exactly the classified places, plus optional hooks. */
export function slotRules(member: string, hooks: Pick<RewriteRules, "visit" | "runs"> = {}): RewriteRules {
  return {
    text: (el, parents) => classify(member, el, parents) !== null,
    attribute: (el, attribute, parents) => classify(member, el, parents, attribute) !== null,
    ...hooks,
  };
}

// ---------------------------------------------------------------- references

/** "B12" (or "$B$12") → 0-based row and column, or null. */
export function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (row < 1 || row > 1_048_576 || col > 16_384) return null;
  return { row: row - 1, col: col - 1 };
}

// ---------------------------------------------------------------- read

export type CellType = "s" | "str" | "inlineStr" | "n" | "b" | "e" | "d";
const CELL_TYPES = new Set<string>(["s", "str", "inlineStr", "n", "b", "e", "d"]);

export interface XlsxCell {
  ref: string;
  row: number;
  col: number;
  type: CellType;
  /** `<v>` as written ("" when absent). For `s`, the shared-string index. */
  v: string;
  /** Inline string runs (`inlineStr`), phonetic runs excluded. */
  runs: string[];
}

export interface XlsxSheet {
  name: string;
  /** Zip member of a worksheet; null for a chart sheet or dialog sheet, which has no cells. */
  member: string | null;
  cells: XlsxCell[];
}

export interface SharedString {
  /** Main runs in order, phonetic runs excluded; empty runs included as "". */
  runs: string[];
}

export interface XlsxTable {
  member: string;
  name: string;
  displayName: string;
  columns: string[];
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  sharedStrings: SharedString[];
  definedNames: string[];
  tables: XlsxTable[];
  /** Every member, as the rewriter reported it on a no-op pass. */
  members: MemberResult[];
}

interface Rel {
  type: string;
  target: string;
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

/** Resolve a relationship target against the part that owns it. */
function resolveTarget(owner: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : dirOf(owner) + target).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}

const relsOf = (part: string): string => `${dirOf(part)}_rels/${part.slice(dirOf(part).length)}.rels`;

/** A string cell's text, or a number, boolean, error or date as written. */
export function cellText(cell: XlsxCell, sst: readonly SharedString[]): string {
  if (cell.type === "inlineStr") return cell.runs.join("");
  if (cell.type === "s") return sst[Number(cell.v)]?.runs.join("") ?? "";
  return cell.v;
}

/**
 * Read a workbook: its sheets (in workbook order) and their cells, the shared strings, defined
 * names and tables. Throws ZipError for an unreadable archive and XlsxError when the workbook
 * structure is missing or unsupported. Members that cannot be parsed are in `members` with kind
 * "error"; the caller must not treat such a workbook as read in full.
 */
export function readWorkbook(bytes: Uint8Array): XlsxWorkbook {
  const rels = new Map<string, Map<string, Rel>>();
  const workbooks = new Map<string, { sheets: { name: string; rid: string }[]; definedNames: string[] }>();
  const worksheets = new Map<string, XlsxCell[]>();
  const ssts = new Map<string, SharedString[]>();
  const tables: XlsxTable[] = [];
  const values = new Map<string, (value: string, el: Frame, parents: readonly Frame[]) => void>();

  const rulesFor = (member: string): RewriteRules => {
    // Per-member state, fed by the start-tag hook and the selected values. Cells and strings are
    // listed at their start tag (self-closing ones included) and filled in as their text arrives.
    let cell: XlsxCell | null = null;
    let si: SharedString | null = null;
    const cells: XlsxCell[] = [];
    const strings: SharedString[] = [];
    values.set(member, (value, el, parents) => {
      const name = local(el);
      const root = local(parents[0] ?? el);
      if (root === "worksheet" && cell !== null) {
        if (name === "v" && local(parents[parents.length - 1]) === "c") cell.v = value;
        else if (name === "t" && within(parents, "is") && !within(parents, "rPh")) cell.runs[cell.runs.length - 1] = value;
      } else if (root === "sst" && si !== null && name === "t" && !within(parents, "rPh")) si.runs[si.runs.length - 1] = value;
    });
    return slotRules(member, {
      visit(el, parents) {
        const root = local(parents[0] ?? el);
        const name = local(el);
        if (root === "Relationships" && name === "Relationship") {
          const map = rels.get(member) ?? new Map<string, Rel>();
          map.set(el.attrs.get("Id") ?? "", { type: el.attrs.get("Type") ?? "", target: el.attrs.get("Target") ?? "" });
          rels.set(member, map);
        } else if (root === "workbook") {
          if (name === "workbook") workbooks.set(member, { sheets: [], definedNames: [] });
          else if (name === "sheet") {
            const rid = [...el.attrs].find(([k]) => k.includes(":") && localName(k) === "id")?.[1] ?? "";
            workbooks.get(member)?.sheets.push({ name: el.attrs.get("name") ?? "", rid });
          } else if (name === "definedName") workbooks.get(member)?.definedNames.push(el.attrs.get("name") ?? "");
        } else if (root === "worksheet") {
          if (parents.length === 0) worksheets.set(member, cells);
          else if (name === "c") {
            const ref = el.attrs.get("r");
            const pos = ref === undefined ? null : parseRef(ref);
            if (ref === undefined || pos === null) throw new XlsxError(`${member}: a cell without a valid reference (r="${ref ?? ""}") is not supported`);
            const type = el.attrs.get("t") ?? "n";
            if (!CELL_TYPES.has(type)) throw new XlsxError(`${member}: cell ${ref} has an unknown type "${type}"`);
            cell = { ref, ...pos, type: type as CellType, v: "", runs: [] };
            cells.push(cell);
          } else if (cell !== null && name === "t" && within(parents, "is") && !within(parents, "rPh")) cell.runs.push("");
        } else if (root === "sst") {
          if (parents.length === 0) ssts.set(member, strings);
          else if (name === "si") {
            si = { runs: [] };
            strings.push(si);
          } else if (si !== null && name === "t" && !within(parents, "rPh")) si.runs.push("");
        } else if (root === "table") {
          if (name === "table") tables.push({ member, name: el.attrs.get("name") ?? "", displayName: el.attrs.get("displayName") ?? "", columns: [] });
          else if (name === "tableColumn") tables[tables.length - 1]?.columns.push(el.attrs.get("name") ?? "");
        }
      },
    });
  };

  const { members } = rewriteOoxml(
    bytes,
    (value, ctx) => {
      if (ctx.attribute === undefined) values.get(ctx.member)?.(value, ctx.element, ctx.parents);
      return value;
    },
    rulesFor,
  );

  // The workbook part, from the package relationships.
  const pkg = [...(rels.get("_rels/.rels")?.values() ?? [])].find((r) => r.type.endsWith("/officeDocument"));
  if (pkg === undefined) throw new XlsxError("no workbook part (no officeDocument relationship in _rels/.rels)");
  const wbPath = resolveTarget("", pkg.target);
  const wb = workbooks.get(wbPath);
  if (wb === undefined) {
    const failed = members.find((m) => m.name === wbPath && m.kind === "error");
    throw new XlsxError(failed?.kind === "error" ? `${wbPath}: ${failed.error}` : `${wbPath}: the workbook part is missing or is not a workbook`);
  }
  const wbRels = rels.get(relsOf(wbPath)) ?? new Map<string, Rel>();
  const sheets: XlsxSheet[] = wb.sheets.map((s) => {
    const rel = wbRels.get(s.rid);
    if (rel === undefined) throw new XlsxError(`${wbPath}: sheet ${JSON.stringify(s.name)} has no relationship`);
    const path = resolveTarget(wbPath, rel.target);
    if (!rel.type.endsWith("/worksheet")) return { name: s.name, member: null, cells: [] };
    const cells = worksheets.get(path);
    if (cells === undefined) {
      const failed = members.find((m) => m.name === path && m.kind === "error");
      if (failed !== undefined) return { name: s.name, member: path, cells: [] };
      throw new XlsxError(`${path}: worksheet ${JSON.stringify(s.name)} is missing or is not a worksheet`);
    }
    return { name: s.name, member: path, cells };
  });
  const sstRel = [...wbRels.values()].find((r) => r.type.endsWith("/sharedStrings"));
  const sharedStrings = sstRel === undefined ? [] : (ssts.get(resolveTarget(wbPath, sstRel.target)) ?? []);
  for (const sheet of sheets) {
    for (const c of sheet.cells) {
      if (c.type === "s" && !(/^\d+$/.test(c.v) && Number(c.v) < sharedStrings.length)) {
        throw new XlsxError(`${sheet.member}: cell ${c.ref} refers to shared string ${JSON.stringify(c.v)}, which does not exist`);
      }
    }
  }
  return { sheets, sharedStrings, definedNames: wb.definedNames, tables, members };
}

/** A worksheet as rows of cell text, row 1 first, for header detection and statistics. */
export function sheetRows(sheet: XlsxSheet, sst: readonly SharedString[]): string[][] {
  const rows: string[][] = [];
  for (const c of sheet.cells) {
    const row = (rows[c.row] ??= []);
    row[c.col] = cellText(c, sst);
  }
  for (let r = 0; r < rows.length; r++) {
    const row = (rows[r] ??= []);
    for (let c = 0; c < row.length; c++) row[c] ??= "";
  }
  return rows;
}

// ---------------------------------------------------------------- formulas

export type FormulaToken =
  /** A string literal, its content unescaped. */
  | { kind: "string"; text: string }
  /** A sheet prefix before "!", unquoted; `quoted` when written '...'. `raw` includes the quotes. */
  | { kind: "sheet"; text: string; quoted: boolean; raw: string }
  /** A bare name: a defined name, table name, or something else such as a cell reference. */
  | { kind: "name"; text: string }
  /** A bracketed part: a structured reference such as [Owner] or [[#This Row],[Owner]], or [1]. */
  | { kind: "bracket"; text: string }
  /** Anything else, as written. */
  | { kind: "other"; text: string };

const NAME_START = /[\p{L}_\\]/u;
const NAME_CHAR = /[\p{L}\p{N}_.\\]/u;

/** Split a formula into the parts a rename touches. Joining every token's written form gives the formula back. */
export function tokenizeFormula(f: string): FormulaToken[] {
  const out: FormulaToken[] = [];
  const other = (s: string) => {
    const last = out[out.length - 1];
    if (last?.kind === "other") last.text += s;
    else out.push({ kind: "other", text: s });
  };
  let i = 0;
  while (i < f.length) {
    const ch = f[i] as string;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = "";
      for (;;) {
        if (j >= f.length) break;
        if (f[j] === ch) {
          if (f[j + 1] === ch) {
            text += ch;
            j += 2;
            continue;
          }
          break;
        }
        text += f[j];
        j++;
      }
      if (j >= f.length) {
        // Unterminated: keep as written.
        other(f.slice(i));
        break;
      }
      const raw = f.slice(i, j + 1);
      if (ch === '"') out.push({ kind: "string", text });
      else if (f[j + 1] === "!") out.push({ kind: "sheet", text, quoted: true, raw });
      else other(raw);
      i = j + 1;
      continue;
    }
    if (ch === "[") {
      let depth = 0;
      let j = i;
      for (; j < f.length; j++) {
        if (f[j] === "'" && j + 1 < f.length) {
          j++; // An escaped character inside a structured reference.
          continue;
        }
        if (f[j] === "[") depth++;
        else if (f[j] === "]" && --depth === 0) break;
      }
      out.push({ kind: "bracket", text: f.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === "#") {
      const m = /^#[A-Z0-9/]+[!?]?/i.exec(f.slice(i));
      other(m?.[0] ?? ch);
      i += m?.[0].length ?? 1;
      continue;
    }
    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < f.length && NAME_CHAR.test(f[j] as string)) j++;
      const text = f.slice(i, j);
      if (f[j] === "!") out.push({ kind: "sheet", text, quoted: false, raw: text });
      else if (f[j] === "(") other(text);
      else out.push({ kind: "name", text });
      i = j;
      continue;
    }
    other(ch);
    i++;
  }
  return out;
}

/** Whether a sheet name must be quoted in a formula reference. */
export function needsQuotes(name: string): boolean {
  return !/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name) || /^[A-Za-z]{1,3}\d+$/.test(name) || /^[RrCc]\d*$|^R\d*C\d*$/i.test(name);
}

export const quoteSheet = (name: string): string => `'${name.replace(/'/g, "''")}'`;
