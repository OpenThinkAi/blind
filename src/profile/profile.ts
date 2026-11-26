// Builds the corpus profile from input files and directories on disk. The profiling itself is in
// inputs.ts, which works on bytes and is shared with the library entry; this file walks the inputs and
// reads each file when the profiler asks for it.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { BLIND_DIR } from "../init.ts";
import { POLICY_FILE } from "../policy.ts";
import { byCodeUnit, InputError, profileSources, type ProfileResult, type Skipped } from "./inputs.ts";

export { COOCCURRENCE_OVERLAP, forPrivacyMode, InputError, MAX_SPEAKERS, profileTranscript, type ProfileResult, type Skipped } from "./inputs.ts";

const toPosix = (p: string): string => p.split(sep).join("/");

interface Found {
  /** Absolute path on disk. */
  abs: string;
  /** Path in the profile: relative to the input directory, or the file name for a file input. */
  path: string;
}

/**
 * Lists every file under the inputs, sorted by profile path. Directories are walked recursively in
 * sorted order. Inside a directory, hidden entries, symbolic links and special files are skipped and
 * reported; blind's own state (`.blind/` and `blind.toml` at the top of a walked directory) is skipped
 * silently. A file named directly is always included.
 */
function collect(inputs: readonly string[], cwd: string, skipped: Skipped[]): Found[] {
  const found: Found[] = [];
  const walk = (root: string, dir: string) => {
    const names = readdirSync(dir).sort(byCodeUnit);
    for (const name of names) {
      const abs = join(dir, name);
      const path = toPosix(relative(root, abs));
      if (name === BLIND_DIR || (dir === root && name === POLICY_FILE)) continue;
      const st = lstatSync(abs);
      if (name.startsWith(".")) skipped.push({ path, reason: "hidden" });
      else if (st.isSymbolicLink()) skipped.push({ path, reason: "symbolic link (not followed)" });
      else if (st.isDirectory()) walk(root, abs);
      else if (st.isFile()) found.push({ abs, path });
      else skipped.push({ path, reason: "not a regular file" });
    }
  };
  for (const input of inputs) {
    const abs = resolve(cwd, input);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      throw new InputError(`${input}: no such file or directory`);
    }
    if (st.isDirectory()) walk(abs, abs);
    else if (st.isFile()) found.push({ abs, path: basename(abs) });
    else throw new InputError(`${input}: not a regular file or directory`);
  }
  const seen = new Map<string, string>();
  for (const f of found) {
    const first = seen.get(f.path);
    if (first !== undefined && first !== f.abs) {
      throw new InputError(`two inputs map to the same profile path ${JSON.stringify(f.path)}; profile them separately`);
    }
    seen.set(f.path, f.abs);
  }
  const unique = [...new Map(found.map((f) => [f.path, f])).values()];
  return unique.sort((a, b) => byCodeUnit(a.path, b.path));
}

/**
 * Profiles the files under `inputs` (resolved against `cwd`; directories walked as `collect` says), carrying
 * at most `asked` samples per column, document or transcript (profileSources in inputs.ts).
 */
export function buildProfile(inputs: readonly string[], asked: number, cwd: string): ProfileResult {
  const skipped: Skipped[] = [];
  const found = collect(inputs, cwd, skipped);
  return profileSources(
    found.map((f) => ({ path: f.path, read: () => readFileSync(f.abs) })),
    asked,
    skipped,
  );
}
