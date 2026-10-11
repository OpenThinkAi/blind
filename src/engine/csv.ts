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

/** The delimiter used most in the first line, outside quotes; ties prefer the earlier candidate, "," by default. */
export function sniffDelimiter(text: string): string {
  const counts = new Map<string, number>();
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best: string = ",";
  let bestCount = 0;
  for (const c of CANDIDATES) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
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
      // Lenient: anything between the closing quote and the delimiter is kept literally.
      while (i < n && text[i] !== delim && text[i] !== "\n" && text[i] !== "\r") value += text[i++];
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

const NUMERIC_RE = /^[\s+\-−$€£¥%.,:/()#\d]*\d[\s+\-−$€£¥%.,:/()#\d]*$/;

/**
 * The header row: the earliest row that is mostly non-numeric text (more than
 * half of its non-empty cells are not numbers). -1 when no row qualifies.
 */
export function detectHeaderRow(rows: readonly Row[]): number {
  for (let r = 0; r < rows.length; r++) {
    const filled = (rows[r] as Row).cells.map((c) => c.value.trim()).filter((v) => v !== "");
    if (filled.length === 0) continue;
    const text = filled.filter((v) => !NUMERIC_RE.test(v)).length;
    if (text * 2 > filled.length) return r;
  }
  return -1;
}
