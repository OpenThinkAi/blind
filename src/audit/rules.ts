// The rule-based audit: the mechanical layer (mechanical.ts) then the semantic layer (semantic.ts), over
// an output tree held in memory. No file system, no process, no model: `blind audit` (command.ts) reads
// the tree, spec, map, policy and salt from disk and calls auditRules; the library entry (src/lib.ts)
// builds the tree from bytes with memoryTree and calls the same function. The model layer (auditor.ts)
// is added on top by the CLI only, and nothing here imports it.

import type { BlindMap } from "../engine/map.ts";
import { InputError } from "../profile/inputs.ts";
import type { Spec } from "../schema.ts";
import { type AuditReport, auditTree, type TreeEntry } from "./mechanical.ts";
import { addSemanticLayer } from "./semantic.ts";

export interface RuleAuditOptions {
  /** The policy keep list (`[keep] terms`). */
  keep: readonly string[];
  /** The built-in placeholder allowlist (`[keep] placeholders`); on unless false. */
  placeholders: boolean;
  /** The salt the spec's `redact` fingerprints were made with; without it a spec with redact entries gets a general candidate. */
  salt?: Uint8Array;
}

/**
 * The report `blind audit --no-model` prints, before its `modelLayer` note: the mechanical layer, then
 * the semantic layer, over `entries`. `spec` is the spec as the audit reads it (blind.toml's pattern
 * switches already applied).
 */
export function auditRules(entries: readonly TreeEntry[], spec: Spec, map: BlindMap, opts: RuleAuditOptions): AuditReport {
  return addSemanticLayer(auditTree(entries, spec, map, opts.keep, opts.placeholders, opts.salt), entries, spec, map, { keep: opts.keep });
}

/**
 * The tree `blind audit` would walk for a directory holding `files` (each a "/"-separated path relative
 * to it, and its bytes): every file, and a `dir` entry for every directory above one, so directory names
 * are audited too. Throws InputError for an empty, absolute or `.`/`..` path, an empty segment, a path
 * given twice, or a path that is both a file and a directory.
 */
export function memoryTree(files: readonly { path: string; bytes: Uint8Array }[]): TreeEntry[] {
  const paths = new Set<string>();
  const dirs = new Set<string>();
  for (const f of files) {
    const segments = f.path.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new InputError(`${JSON.stringify(f.path)} is not a relative "/"-separated path`);
    }
    if (paths.has(f.path)) throw new InputError(`two files have the same path ${JSON.stringify(f.path)}`);
    paths.add(f.path);
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  for (const d of dirs) {
    if (paths.has(d)) throw new InputError(`${JSON.stringify(d)} is both a file and a directory`);
  }
  const entries: TreeEntry[] = [...[...dirs].map((path): TreeEntry => ({ path, kind: "dir" })), ...files.map((f): TreeEntry => ({ path: f.path, kind: "file", bytes: f.bytes }))];
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
