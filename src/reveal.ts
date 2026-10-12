// `blind reveal <path> --map <map.json>`: the file-system side of reveal. Reads a
// blinded file (or a blinded tree) and the map, restores every pseudonym in the
// content and in the folder and file names, and writes the result under
// .blind/revealed/ (or -o <dir>). Revealed files hold the original values, so
// they are secrets like the map: folders are created 0700 and every file through
// a temp file opened exclusively with mode 0600, then renamed. Nothing is
// written beside the blinded files or into the tree being revealed, where it
// could be taken for blinded output. Nothing is written unless every name
// checks out.

import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { MAP_FILE } from "./apply.ts";
import { type BlindMap, MapError, readMap } from "./engine/map.ts";
import { RevealError, revealFile, Revealer } from "./engine/reveal.ts";
import { BLIND_DIR } from "./init.ts";
import { oneLine, terminalStream } from "./terminal.ts";

export const REVEALED_DIR = "revealed";

export interface RevealIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where .blind/ lives. */
  cwd: string;
}

const REVEAL_HELP = [
  "Usage: blind reveal <path> [--map <map.json>] [-o <dir>] [--force]",
  "",
  "Reverses a blinded file, or every file of a blinded tree, with the map `blind apply` wrote:",
  "each pseudonym in the content and in folder and file names is replaced with the original value",
  "the map records for it (an alias or a case variant comes back as that recorded form). Handles",
  "CSV/TSV, JSON/JSONL, text (.txt, .md, .log, .vtt, .srt), XLSX and DOCX; a workbook or document is revealed",
  "whole or not at all. Other formats have no reversal path.",
  "",
  "Revealed files hold the original values. They are written under .blind/revealed/ by default,",
  "with mode 0600 (folders 0700), never beside the blinded files or inside the tree being revealed.",
  "",
  "Options:",
  "      --map <path>  The map apply wrote (default .blind/map.json)",
  "  -o, --out <dir>   Where to write the revealed files (default .blind/revealed)",
  "      --force       Replace revealed files already there",
  "  -h, --help        Show this help",
  "",
  "Exit status: 0 everything revealed, 1 some files not revealed (listed), 2 refused or failed.",
  "",
].join("\n");

class Refusal extends Error {}

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const toPosix = (p: string): string => p.split(sep).join("/");

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Collected {
  files: { path: string; abs: string }[];
  skipped: { path: string; reason: string }[];
}

/** The files to reveal: `root` itself, or every file under it (paths relative, "/"-separated, sorted). */
function collect(root: string): { dir: boolean; c: Collected } {
  const c: Collected = { files: [], skipped: [] };
  const walk = (abs: string, rel: string): void => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) c.skipped.push({ path: rel, reason: "symbolic link, not followed; not revealed" });
    else if (st.isDirectory()) {
      for (const n of readdirSync(abs).sort(cmp)) walk(join(abs, n), rel === "" ? n : `${rel}/${n}`);
    } else if (st.isFile()) c.files.push({ path: rel, abs });
    else c.skipped.push({ path: rel, reason: "not a regular file; not revealed" });
  };
  let st;
  try {
    st = lstatSync(root);
  } catch {
    throw new Refusal(`${root} does not exist`);
  }
  const dir = st.isDirectory();
  walk(root, dir ? "" : basename(root));
  return { dir, c };
}

function loadMap(path: string): BlindMap {
  try {
    lstatSync(path);
  } catch {
    throw new Refusal(`${path} not found; pass --map with the map \`blind apply\` wrote`);
  }
  return readMap(path);
}

/** Exclusive 0600 temp file, then a rename: never readable by others, never chmod'ed afterwards. */
function writePrivate(dest: string, bytes: Uint8Array): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, bytes);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export async function runReveal(argv: string[], io: RevealIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: "string" },
        out: { type: "string", short: "o" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind reveal: ${(e as Error).message}\n\n${REVEAL_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(REVEAL_HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    io.err.write(`blind reveal: ${positionals.length === 0 ? "no blinded file given" : "give exactly one blinded file or directory"}\n\n${REVEAL_HELP}`);
    return 2;
  }

  try {
    const input = resolve(io.cwd, positionals[0] as string);
    const mapPath = resolve(io.cwd, values.map ?? join(BLIND_DIR, MAP_FILE));
    const outName = values.out ?? join(BLIND_DIR, REVEALED_DIR);
    const outDir = resolve(io.cwd, outName);
    const { dir, c } = collect(input);

    // Never where it could be taken for blinded output: not inside the tree being revealed (or
    // around it), and not beside a blinded file, unless under blind's own private directory.
    const home = dir ? input : dirname(input);
    const privateDir = resolve(io.cwd, BLIND_DIR);
    if (within(outDir, input) || within(input, outDir) || (within(outDir, home) && !within(outDir, privateDir))) {
      throw new Refusal(
        `${outName} is ${dir ? "inside or around the tree being revealed" : "beside the blinded file"}; revealed files hold the original values and must not sit with blinded output. Choose another -o`,
      );
    }
    if (within(mapPath, outDir)) throw new Refusal("the revealed files must not be written around the map; choose another -o");

    const rv = new Revealer(loadMap(mapPath));
    const skipped = [...c.skipped];
    const outputs: { from: string; to: string; bytes: Uint8Array; restored: number; renamed: boolean }[] = [];
    for (const f of c.files) {
      let revealed;
      try {
        let bytes: Buffer;
        try {
          bytes = readFileSync(f.abs);
        } catch (e) {
          throw new RevealError(`cannot read it (${(e as NodeJS.ErrnoException).code ?? "error"})`);
        }
        revealed = revealFile(f.path, bytes, rv);
      } catch (e) {
        if (!(e instanceof RevealError)) throw e;
        if (!dir) throw new Refusal(`${f.path}: ${e.message}; nothing was revealed`);
        skipped.push({ path: f.path, reason: `${e.message}; not revealed` });
        continue;
      }
      const name = rv.path(f.path);
      outputs.push({ from: f.path, to: name.text, bytes: revealed.bytes, restored: revealed.restored + name.restored, renamed: name.restored > 0 });
    }

    // Check every destination before writing any.
    const taken = new Map<string, string>();
    for (const o of outputs) {
      const prior = taken.get(o.to);
      if (prior !== undefined) throw new Refusal(`${prior} and ${o.from} reveal to the same name`);
      taken.set(o.to, o.from);
      if (!values.force && exists(join(outDir, ...o.to.split("/")))) {
        throw new Refusal(`the revealed copy of ${o.from} already exists in ${toPosix(outName)}; pass --force to replace it`);
      }
    }

    try {
      for (const o of outputs) {
        const dest = join(outDir, ...o.to.split("/"));
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        writePrivate(dest, o.bytes);
      }
    } catch (e) {
      io.err.write(`blind reveal: writing failed part-way (${(e as NodeJS.ErrnoException).code ?? "error"}); the revealed output is incomplete\n`);
      return 2;
    }

    // Revealed names are original values: the report names files by their blinded paths only.
    for (const o of outputs) {
      io.out.write(`${oneLine(o.from)}: ${o.restored} pseudonym${o.restored === 1 ? "" : "s"} restored${o.renamed ? " (name restored too)" : ""}\n`);
    }
    for (const s of skipped) io.err.write(`blind reveal: ${oneLine(s.path)}: ${oneLine(s.reason)}\n`);
    io.out.write(
      `wrote ${outputs.length} revealed file${outputs.length === 1 ? "" : "s"} to ${toPosix(outName)} (mode 0600; they hold the original values, keep them secret)\n`,
    );
    if (skipped.length > 0) {
      io.err.write(`blind reveal: ${skipped.length} file${skipped.length === 1 ? " was" : "s were"} not revealed; see above\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof Refusal || e instanceof MapError || e instanceof RevealError) {
      io.err.write(`blind reveal: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

export function processRevealIO(): RevealIO {
  return { out: terminalStream(process.stdout), err: terminalStream(process.stderr), cwd: process.cwd() };
}
