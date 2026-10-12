// How a human-facing report names a value from a document without printing it. Shared by the
// audit (src/audit/), the analyst's plan output (src/analyst/) and the apply report
// (src/apply.ts), so it imports nothing: src/audit/mechanical.ts and the engine stay free of
// model code.

/** First characters (at most 2, never more than half), `***`, length. Control characters show as `?`. */
export function maskValue(s: string): string {
  const chars = [...s];
  const show = Math.min(2, Math.floor(chars.length / 2));
  return `${chars.slice(0, show).join("").replace(/[\p{C}\s]/gu, "?")}***${chars.length}`;
}

/**
 * A value as a report prints it: the JSON-quoted original when `show` (an interactive reviewer,
 * or --show-values), else its mask. File and folder paths are not values and never go through this.
 */
export function shownValue(s: string, show: boolean): string {
  return show ? JSON.stringify(s) : maskValue(s);
}

/** True when `stream` is a terminal: a person is looking, and the report may show the originals. */
export function isTerminal(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}

/**
 * `text` with every JSON-quoted string in it masked. The explanations a report prints around a
 * value ("it would change the saved person entity "Avery Quill"") quote it with JSON.stringify; this
 * is the one place they are masked when the originals are not shown.
 */
export function maskQuoted(text: string, show: boolean): string {
  if (show) return text;
  return text.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    try {
      return maskValue(JSON.parse(m) as string);
    } catch {
      return "***";
    }
  });
}
