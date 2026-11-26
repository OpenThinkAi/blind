// Where a table names its columns, read back from the output (AGT-2785): the cells of a detected
// CSV/TSV header row, JSON structural keys, and in a workbook the text of each worksheet's detected
// header cells and the table column and pivot field names that repeat one. Blind never rewrites
// these for a lone word of a blinded person's name (a whole value still is), so the audit calls such
// a survivor there a candidate, not a leak. Only a row the profiler's rule detects counts: with no
// detected header, row 1 is free text to the engine, and a part surviving there is still a leak.

import { CsvError, parseCsv, sniffDelimiter } from "../engine/csv.ts";
import { scanJson, scanJsonl, JsonError } from "../engine/json.ts";
import { cellText, readWorkbook, sheetRows } from "../formats/xlsx.ts";
import { detectHeaderRow } from "../profile/table.ts";
import { latin1 } from "./views.ts";
import { localName, walkXml } from "./xml.ts";
import { readZip, zipBudget } from "./zip.ts";

/** Code-unit ranges of the cells of a CSV/TSV table's detected header row, quotes included. Empty when none is detected. */
export function headerCellRanges(text: string, tsv: boolean): [number, number][] {
  let delimiter: string;
  let rows;
  try {
    delimiter = sniffDelimiter(text, tsv ? "\t" : undefined);
    rows = parseCsv(text, delimiter);
  } catch (e) {
    if (e instanceof CsvError) return [];
    throw e;
  }
  const detected = detectHeaderRow(rows.map((r) => r.cells.map((c) => c.value)));
  if (detected === null) return [];
  const out: [number, number][] = [];
  let at = 0;
  for (const [i, row] of rows.entries()) {
    row.cells.forEach((c, col) => {
      if (i === detected - 1) out.push([at, at + c.raw.length]);
      at += c.raw.length + (col < row.cells.length - 1 ? delimiter.length : 0);
    });
    at += row.eol.length;
  }
  return at === text.length ? out : [];
}

/** Code-unit ranges of the structural keys (field names, not record IDs) of a JSON or JSONL text. Empty when it cannot be read. */
export function jsonKeyRanges(text: string, jsonl: boolean): [number, number][] {
  try {
    return (jsonl ? scanJsonl(text) : scanJson(text)).filter((t) => t.kind === "key" && t.column === null).map((t) => [t.start, t.end]);
  } catch (e) {
    if (e instanceof JsonError) return [];
    throw e;
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(Number.parseInt(e[1] === "x" || e[1] === "X" ? e.slice(2) : e.slice(1), e[1] === "x" || e[1] === "X" ? 16 : 10)) : (XML_ENTITIES[e] ?? m),
  );

/**
 * Per zip member of a workbook, the byte ranges that hold detected header text: the runs of a
 * shared string only detected header cells use (one another cell shares is written as free text),
 * an inline or formula string header cell's text, and a table column or pivot field name equal to a
 * detected header cell. Empty when the workbook cannot be read.
 */
export function xlsxHeaderRanges(bytes: Uint8Array): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let wb;
  let members;
  try {
    wb = readWorkbook(bytes);
    members = readZip(bytes, zipBudget());
  } catch {
    // Unreadable: nothing is placed, so every finding stands.
    return out;
  }
  const uses = wb.sharedStrings.map(() => ({ header: 0, other: 0 }));
  const cells = new Set<string>();
  const texts = new Set<string>();
  for (const sheet of wb.sheets) {
    if (sheet.member === null) continue;
    const detected = detectHeaderRow(sheetRows(sheet, wb.sharedStrings));
    for (const c of sheet.cells) {
      const header = detected !== null && c.row === detected - 1;
      if (c.type === "s") {
        const u = uses[Number(c.v)];
        if (u !== undefined) u[header ? "header" : "other"]++;
      }
      if (!header) continue;
      if (c.type === "inlineStr" || c.type === "str") cells.add(`${sheet.member}\0${c.ref}`);
      texts.add(cellText(c, wb.sharedStrings));
    }
  }
  const sharedOnly = (i: number): boolean => (uses[i]?.header ?? 0) > 0 && uses[i]?.other === 0;
  // A shared string a non-header cell uses too is free text: it is no heading for a repeated name either.
  wb.sharedStrings.forEach((s, i) => {
    if ((uses[i]?.header ?? 0) > 0 && !sharedOnly(i)) texts.delete(s.runs.join(""));
  });
  for (const m of members) {
    if (m.bytes === undefined) continue;
    // Latin-1, so a code-unit offset is a byte offset; names are compared as UTF-8 below.
    const t = latin1(m.bytes);
    const ranges: [number, number][] = [];
    let si = -1;
    let phonetic = 0;
    let ref = "";
    let cell = "";
    walkXml(t, {
      attribute(element, attr, start, end) {
        const el = localName(element);
        if (el === "c" && attr === "r") ref = t.slice(start, end);
        else if ((el === "tableColumn" || el === "cacheField") && attr === "name") {
          const raw = Uint8Array.from(t.slice(start, end), (ch) => ch.charCodeAt(0));
          if (texts.has(unescapeXml(new TextDecoder().decode(raw)))) ranges.push([start, end]);
        }
      },
      tag(name, closing, selfClosing) {
        const el = localName(name);
        if (el === "si" && !closing) si++;
        else if (el === "rPh") phonetic += closing ? -1 : selfClosing ? 0 : 1;
        else if (el === "c") cell = closing || selfClosing ? "" : `${m.name}\0${ref}`;
      },
      text(start, end, parent) {
        if (parent === undefined || phonetic > 0) return;
        const el = localName(parent);
        if (el === "t" && si >= 0 && cell === "" && sharedOnly(si)) ranges.push([start, end]);
        else if ((el === "t" || el === "v") && cell !== "" && cells.has(cell)) ranges.push([start, end]);
      },
    });
    if (ranges.length > 0) out.set(m.name, ranges);
  }
  return out;
}
