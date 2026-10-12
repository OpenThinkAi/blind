// A lossless CSV/TSV tokenizer. Every cell keeps its raw text, so a row whose
// cells are untouched re-serialises to exactly the original characters,
// including quoting, the delimiter and each row's own line ending.

export interface Cell {
  /** Exactly as written, quotes included. */
  raw: string;
  /** Unescaped content. */
  value: string;
  quoted: boolean;
}

export interface Row {
  cells: Cell[];
  /** "\r\n", "\n", "\r", or "" for a last row without a terminator. */
  eol: string;
}

export class CsvError extends Error {
  override name = "CsvError";
}

const CANDIDATES = [",", ";", "\t", "|"] as const;

/**
 * The delimiter used most in the first line, outside quotes. Ties prefer `preferred` when given
 * (tab for `.tsv`/`.tab`), else the earlier candidate; "," is the default when none appears.
 */
export function sniffDelimiter(text: string, preferred?: string): string {
  const counts = new Map<string, number>();
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: string = preferred ?? ",";
  let bestCount = preferred === undefined ? 0 : (counts.get(preferred) ?? 0);
  for (const c of CANDIDATES) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Checks the rows below the header and returns how many are wider than it (overflow rows). A row of
 * a different width is a stray delimiter (an empty cell, a tab typed into a notes field), which is
 * accepted: a short row's missing cells are empty, and a wide row's extra cells continue the last
 * column. It is refused only when a quoted field spans a line break, the signature of an unclosed
 * quote that swallowed rows (a quote closed by a later quote is refused by `parseCsv`). Rows above
 * the header (title lines) and blank lines are exempt. `headerIndex` is 0-based. The profiler and
 * the engine both call this, so they always agree.
 */
export function assertRowWidths(rows: readonly (readonly (Cell | string)[])[], headerIndex: number): number {
  const width = rows[headerIndex]?.length;
  if (width === undefined) return 0;
  let overflow = 0;
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const row = rows[r] as readonly (Cell | string)[];
    const text = (c: Cell | string): string => (typeof c === "string" ? c : c.value);
    const blank = row.length === 1 && text(row[0] as Cell | string) === "";
    if (row.length === width || blank) continue;
    // Only a quoted field can hold a line break, so a break in a cell value means a quoted field spans lines.
    if (row.some((c) => /[\r\n]/.test(text(c)))) {
      throw new CsvError(`row ${r + 1} has ${row.length} cells but the header has ${width}; a quote is probably unclosed`);
    }
    if (row.length > width) overflow++;
  }
  return overflow;
}

export function parseCsv(text: string, delim: string): Row[] {
  const rows: Row[] = [];
  let cells: Cell[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  if (n === 0) return rows;
  for (;;) {
    const start = i;
    let value = "";
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      const openLine = line;
      i++;
      for (;;) {
        if (i >= n) throw new CsvError(`unterminated quoted field starting on line ${openLine}`);
        const ch = text[i] as string;
        if (ch === '"') {
          if (text[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        value += ch;
        i++;
      }
      // Text between the closing quote and the delimiter means the quote never really closed
      // (an earlier unclosed quote ran on to a later one), so refuse rather than swallow rows.
      if (i < n && text[i] !== delim && text[i] !== "\n" && text[i] !== "\r") {
        throw new CsvError(`unexpected text after the closing quote of the field starting on line ${openLine}; a quote is probably unclosed`);
      }
    } else {
      while (i < n && text[i] !== delim && text[i] !== "\n" && text[i] !== "\r") value += text[i++];
    }
    cells.push({ raw: text.slice(start, i), value, quoted });
    if (i < n && text[i] === delim) {
      i++;
      continue;
    }
    let eol = "";
    if (text[i] === "\r" && text[i + 1] === "\n") eol = "\r\n";
    else if (text[i] === "\r" || text[i] === "\n") eol = text[i] as string;
    i += eol.length;
    line++;
    rows.push({ cells, eol });
    cells = [];
    if (i >= n) return rows;
  }
}

/** Render a cell after its value changed: quoted stays quoted, and quoting is added only when the value needs it. */
export function renderCell(value: string, wasQuoted: boolean, delim: string): string {
  const needs = value.includes(delim) || value.includes('"') || value.includes("\n") || value.includes("\r");
  return wasQuoted || needs ? `"${value.replace(/"/g, '""')}"` : value;
}

export function serializeCsv(rows: readonly Row[], delim: string): string {
  return rows.map((r) => r.cells.map((c) => c.raw).join(delim) + r.eol).join("");
}
