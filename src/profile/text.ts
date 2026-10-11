// Plain text, Markdown and logs: an outline and sample sentences.

import type { ProfileDocument } from "../schema.ts";
import { distinct, excerpt, pick } from "./stats.ts";

/** The most outline entries one document carries. */
export const MAX_OUTLINE = 50;

const HEADING = /^ {0,3}#{1,6}(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export type TextFormat = "text" | "markdown" | "log";

interface Parsed {
  headings: string[];
  /** Prose units: paragraphs for text and Markdown, single lines for logs. */
  units: string[];
}

function parse(text: string, format: TextFormat): Parsed {
  const lines = text.split(/\r\n|\n|\r/);
  if (format === "log") return { headings: [], units: lines.filter((l) => l.trim() !== "") };

  const headings: string[] = [];
  const units: string[] = [];
  let para: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (para.length > 0) units.push(para.join(" "));
    para = [];
  };
  for (const line of lines) {
    if (format === "markdown") {
      const f = FENCE.exec(line);
      if (fence !== null) {
        // Fenced code is neither prose nor headings.
        if (f !== null && f[1]?.[0] === fence[0] && (f[1]?.length ?? 0) >= fence.length) fence = null;
        continue;
      }
      if (f !== null) {
        flush();
        fence = f[1] ?? "```";
        continue;
      }
      const h = HEADING.exec(line);
      if (h !== null) {
        flush();
        const title = (h[1] ?? "").trim();
        if (title !== "") headings.push(title);
        continue;
      }
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return { headings, units };
}

/** Splits a prose unit after `.`, `!` or `?` followed by whitespace. */
function sentences(unit: string): string[] {
  return unit.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * The outline is the first non-empty line, then (for Markdown) every heading, in order, without
 * repeating the first line, at most MAX_OUTLINE entries. Sample sentences are up to `k` distinct
 * sentences spread evenly through the document (log lines for logs). Everything is an excerpt.
 */
export function profileText(file: string, text: string, format: TextFormat, k: number): ProfileDocument {
  const { headings, units } = parse(text, format);
  const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== "");
  const outline: string[] = [];
  if (firstLine !== undefined) {
    const h = format === "markdown" ? HEADING.exec(firstLine) : null;
    outline.push(excerpt(h !== null ? (h[1] ?? "") : firstLine));
  }
  for (const h of headings) {
    const e = excerpt(h);
    // A first line that is itself the first heading is listed once.
    if (outline.length === 1 && outline[0] === e) continue;
    outline.push(e);
  }
  const all = distinct(units.flatMap((u) => (format === "log" ? [u.trim()] : sentences(u))));
  return {
    file,
    outline: outline.filter((o) => o !== "").slice(0, MAX_OUTLINE),
    sampleSentences: pick(all, k).map(excerpt),
  };
}
