// CSV and TSV: parsing, header-row detection and per-column statistics.

import type { ProfileTable } from "../schema.ts";
import { excerpt, valueStats } from "./stats.ts";

export class ParseError extends Error {
  override name = "ParseError";
}

/** RFC 4180 CSV: quoted fields with "" escapes, embedded newlines, CRLF, LF or CR line ends. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let quoteRow = 0;
  const endRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      quoteRow = rows.length + 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new ParseError(`unterminated quoted field starting in row ${quoteRow}`);
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** TSV (IANA text/tab-separated-values): one record per line, fields split on tabs, no quoting. */
export function parseTsv(text: string): string[][] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

/** How many leading rows are searched for the header. */
export const HEADER_SCAN_ROWS = 20;

const NUMBER = /^[-+]?(?:\d[\d,]*)?(?:\.\d+)?(?:e[-+]?\d+)?%?$/i;

/** Non-numeric text: contains a letter and is not a number such as `1e5`. */
function isText(cell: string): boolean {
  const v = cell.trim();
  return /\p{L}/u.test(v) && !NUMBER.test(v);
}

const filled = (row: readonly string[]): string[] => row.filter((c) => c.trim() !== "");

/**
 * The 1-based index of the header row: the earliest of the first HEADER_SCAN_ROWS rows that fills
 * more than half the table's width and whose filled cells are mostly (over half) non-numeric text.
 * Null when no row qualifies.
 */
export function detectHeaderRow(rows: readonly string[][]): number | null {
  const scan = rows.slice(0, HEADER_SCAN_ROWS);
  const width = Math.max(0, ...scan.map((r) => filled(r).length));
  for (let i = 0; i < scan.length; i++) {
    const cells = filled(scan[i] ?? []);
    if (cells.length === 0 || cells.length * 2 <= width) continue;
    if (cells.filter(isText).length * 2 > cells.length) return i + 1;
  }
  return null;
}

export interface TableResult {
  table: ProfileTable;
  /** Set when no header row was found and row 1 was used. */
  noHeader: boolean;
  /** Per column, its distinct non-empty values folded (NFKC, trimmed, lower-cased), for co-occurrence. */
  valueSets: Set<string>[];
}

const fold = (v: string): string => v.normalize("NFKC").trim().toLowerCase();

/** Profiles one parsed table. Rows above the header are skipped; blank rows below it are ignored. */
export function profileTable(file: string, rows: readonly string[][], k: number): TableResult {
  const detected = detectHeaderRow(rows);
  const headerRow = detected ?? 1;
  const header = rows[headerRow - 1] ?? [];
  const data = rows.slice(headerRow).filter((r) => filled(r).length > 0);
  const width = Math.max(header.length, ...data.map((r) => r.length));
  const cells = Array.from({ length: width }, (_, c) => data.map((r) => r[c] ?? ""));
  return {
    table: {
      file,
      headerRow,
      columns: cells.map((values, c) => ({ header: excerpt(header[c] ?? ""), stats: valueStats(values, k) })),
    },
    noHeader: detected === null && rows.length > 0,
    valueSets: cells.map((values) => new Set(values.map(fold).filter((v) => v !== ""))),
  };
}
