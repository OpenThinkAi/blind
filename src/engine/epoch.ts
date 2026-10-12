// Unix timestamps. A 10- or 13-digit integer in 2000-01-01..2100-01-01 is a time, not an ID: a
// column that is mostly such values is a measurement and is never pseudonymised or renumbered by
// default (AGT-1843). A leaf module: the profiler shares it with the engine.

/** A Unix time in seconds (10 digits) or milliseconds (13 digits) between 2000-01-01 and 2100-01-01 UTC. */
export function isEpochTimestamp(value: string): boolean {
  if (!/^\d{10}(?:\d{3})?$/.test(value)) return false;
  const seconds = value.length === 10 ? Number(value) : Number(value) / 1000;
  return seconds >= 946_684_800 && seconds < 4_102_444_800;
}

/** Share of non-empty values that must be Unix times for the column to count as a column of times. */
export const EPOCH_RATE = 0.8;

/** Whether at least EPOCH_RATE of the non-empty values are Unix times. */
export function isEpochColumn(values: readonly string[]): boolean {
  const filled = values.map((v) => v.trim()).filter((v) => v !== "");
  return filled.length > 0 && filled.filter(isEpochTimestamp).length / filled.length >= EPOCH_RATE;
}
