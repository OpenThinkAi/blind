// The record `blind run` leaves of what it did: which input became which output, which inputs were
// not written and why, and the final audit's verdict per output file. It lives under .blind/ (mode
// 0600), not in the output tree: it pairs each input's real path with its blinded one, and the
// audit and anything shipped from <out> must not see it. It holds paths and statuses, never values.

import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLIND_DIR } from "./init.ts";

export const RUN_FILE = "run.json";

export type FileAuditStatus = "clean" | "candidates" | "leak";

export interface ManifestInput {
  /** The input's path as the spec names it (relative to its input directory). */
  input: string;
  /** Where it was written under <out>, "/"-separated; null when it was not written. */
  output: string | null;
  /** Why an input was not written. */
  reason?: string;
  /** The final audit's status for the output file; null when not written or when the audit did not run. */
  audit: FileAuditStatus | null;
}

export interface RunManifest {
  version: 1;
  /** The output directory, relative to the workspace, "/"-separated. */
  out: string;
  /** Apply-and-audit rounds run (more than one only under --accept-leaks). */
  rounds: number;
  /** The run's exit status. */
  exit: number;
  /** The final audit, or null when it could not run. */
  audit: { status: string; leaks: number; candidates: number } | null;
  inputs: ManifestInput[];
}

export function writeRunManifest(cwd: string, m: RunManifest): string {
  const path = join(cwd, BLIND_DIR, RUN_FILE);
  writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Where the previous run in this workspace wrote each input, when it wrote into the same <out>. */
export function readPreviousOutputs(cwd: string, outRel: string): Map<string, string> | undefined {
  try {
    const m = JSON.parse(readFileSync(join(cwd, BLIND_DIR, RUN_FILE), "utf8")) as Partial<RunManifest>;
    if (m.version !== 1 || m.out !== outRel || !Array.isArray(m.inputs)) return undefined;
    const prev = new Map<string, string>();
    for (const i of m.inputs) if (typeof i?.input === "string" && typeof i.output === "string") prev.set(i.input, i.output);
    return prev;
  } catch {
    return undefined;
  }
}

/**
 * Files already in <out> that this write did not produce but that sit where an input's earlier
 * blinded name would be: the input's own name (before any of its values became entities) and, for a
 * run, where the previous run wrote it. They are stale copies of an input that is now written under
 * another name. Never removed; reported.
 */
export function staleOutputs(
  outDir: string,
  files: readonly { path: string; outputPath: string }[],
  previous: ReadonlyMap<string, string> | undefined,
): { input: string; stale: string }[] {
  const written = new Set(files.map((f) => f.outputPath));
  const found: { input: string; stale: string }[] = [];
  for (const f of files) {
    const candidates = new Set<string>([f.path]);
    const before = previous?.get(f.path);
    if (before !== undefined) candidates.add(before);
    for (const c of candidates) {
      if (c === f.outputPath || written.has(c)) continue;
      try {
        if (lstatSync(join(outDir, ...c.split("/"))).isFile()) found.push({ input: f.path, stale: c });
      } catch {
        // not there
      }
    }
  }
  return found;
}
