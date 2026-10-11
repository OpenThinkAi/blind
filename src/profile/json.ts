// JSON and JSONL: every key path is a column, with the same statistics and samples as a
// table column. Key paths come from the engine's scanner, so the profile and `blind apply`
// always agree on them.

import { type JsonFormat, JsonError, type JsonToken, scanJson, scanJsonl } from "../engine/json.ts";
import type { ProfileJsonKey } from "../schema.ts";
import { valueStats } from "./stats.ts";
import { fold, ParseError } from "./table.ts";

export interface JsonResult {
  keys: ProfileJsonKey[];
  /** Per key path, its distinct non-empty values folded as table.ts does, for co-occurrence. */
  valueSets: Set<string>[];
}

/** The scanner's tokens, with a scan failure turned into the profiler's ParseError. */
export function scanJsonFile(text: string, format: JsonFormat): JsonToken[] {
  try {
    return format === "json" ? scanJson(text) : scanJsonl(text);
  } catch (e) {
    if (e instanceof JsonError) throw new ParseError(e.message);
    throw e;
  }
}

/**
 * Profiles one JSON or JSONL file's tokens: one entry per key path, in first-seen order. Strings
 * and numbers are values (a number as written); true, false and null are not. Record-identifier
 * keys are the values of their `.*~` path.
 */
export function profileJson(file: string, tokens: readonly JsonToken[], k: number): JsonResult {
  const columns = new Map<string, string[]>();
  for (const t of tokens) {
    if (t.column === null) continue;
    const values = columns.get(t.column) ?? [];
    if (t.kind !== "literal") values.push(t.value);
    columns.set(t.column, values);
  }
  const keys: ProfileJsonKey[] = [];
  const valueSets: Set<string>[] = [];
  for (const [path, values] of columns) {
    keys.push({ file, path, stats: valueStats(values, k) });
    valueSets.push(new Set(values.map(fold).filter((v) => v !== "")));
  }
  return { keys, valueSets };
}
