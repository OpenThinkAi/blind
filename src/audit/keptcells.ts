// The cells of a CSV/TSV table that the spec keeps whole (a `keep` column rule), with where each
// sits in the decoded text. The audit does not call a pattern match or entity inside one a leak
// (blind kept it on purpose), and `--accept-leaks` does not turn a value kept there into an entity.

import { type ColumnRule } from "../schema.ts";
import { type Cell, CsvError, parseCsv, sniffDelimiter } from "../engine/csv.ts";
import { detectHeaderRow } from "../profile/table.ts";

export interface KeptCell {
  /** The cell's unescaped content. */
  value: string;
  /** Code-unit range of the cell as written (quotes included) in the decoded text. */
  start: number;
  end: number;
}

/**
 * The data cells of every column `rules` keep, in a table already decoded. A row's extra cells
 * continue the last column, as the engine reads them. Empty when the table cannot be parsed or its
 * rows do not add up to the text (then nothing is treated as kept).
 */
export function keptCells(text: string, tsv: boolean, rules: readonly ColumnRule[]): KeptCell[] {
  const keep = rules.filter((r) => r.treatment === "keep" && r.header !== undefined);
  if (keep.length === 0) return [];
  let delimiter: string;
  let rows;
  try {
    delimiter = sniffDelimiter(text, tsv ? "\t" : undefined);
    rows = parseCsv(text, delimiter);
  } catch (e) {
    if (e instanceof CsvError) return [];
    throw e;
  }
  if (rows.length === 0) return [];
  const headerRow = (detectHeaderRow(rows.map((r) => r.cells.map((c) => c.value))) ?? 1) - 1;
  const headers = (rows[headerRow]?.cells ?? []).map((c) => c.value);
  const width = headers.length;
  const cols = new Set<number>();
  for (const r of keep) {
    const col = headers.findIndex((h) => h.trim() === (r.header as string).trim());
    if (col >= 0) cols.add(col);
  }
  if (cols.size === 0) return [];
  const out: KeptCell[] = [];
  let at = 0;
  for (const [i, row] of rows.entries()) {
    row.cells.forEach((c: Cell, col: number) => {
      const owner = Math.min(col, width - 1);
      if (i > headerRow && cols.has(owner)) out.push({ value: c.value, start: at, end: at + c.raw.length });
      at += c.raw.length + (col < row.cells.length - 1 ? delimiter.length : 0);
    });
    at += row.eol.length;
  }
  return at === text.length ? out : [];
}
