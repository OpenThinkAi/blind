// `blind forget <value...>` and `blind purge`: removing what blind keeps under .blind/.
//
// forget removes one data subject: the map entries that record the value, the spec entity it names
// (with its aliases, and the parts no other entity uses), the profile excerpts that contain it, the
// run record when a real path carries it, and the whole .blind/revealed/ tree. purge removes every
// file that holds originals or reverses pseudonyms: the map, the profile, the run record and
// .blind/revealed/. Both rewrite or delete files only after every input has been read and checked,
// and only after confirmation (--yes, or "yes" typed at a terminal). Neither prints a value.

import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAP_FILE, SPEC_FILE } from "./apply.ts";
import { type BlindMap, foldText, MapError, withoutValues } from "./engine/map.ts";
import { readMap, writeMap, writePrivateText } from "./mapfile.ts";
import { BLIND_DIR } from "./init.ts";
import { PROFILE_FILE } from "./profile/command.ts";
import { REVEALED_DIR } from "./reveal.ts";
import { RUN_FILE } from "./runmanifest.ts";
import type { Entities, Entity } from "./schema.ts";
import { oneLine, terminalStream, terminalText } from "./terminal.ts";
import { parseProfile, parseSpec, SchemaError } from "./validate.ts";

export interface EraseIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where .blind/ lives. */
  cwd: string;
  /** Asks a person at a terminal; null when cancelled. Absent when stdin is not a terminal. */
  prompt?: (question: string) => Promise<string | null>;
}

const FORGET_HELP = [
  "Usage: blind forget <value...> [--map <map.json>] [--yes]",
  "",
  "Removes one data subject from what blind keeps under .blind/. Each value is a written form: a",
  "name, an email, an ID. For each one, forget removes:",
  "  - every map entry that records it (map.json), by written or canonical form, so `blind reveal`",
  "    leaves its pseudonym in place;",
  "  - the spec entity whose canonical form or an alias it is (spec.json), with its aliases, and the",
  "    map entries of those aliases and of the parts no remaining entity uses;",
  "  - every profile sample, sentence, line, outline heading and speaker that contains any of",
  "    those forms (profile.json); a profile whose file, sheet, header or key names contain one is",
  "    deleted (the next `blind profile` or `blind plan` writes it again);",
  "  - .blind/run.json when a real path in it contains one;",
  "  - the whole .blind/revealed/ tree, when anything above matched: revealed files are full",
  "    originals, so blind does not edit them. Reveal again afterwards: the forgotten subject stays",
  "    pseudonymised.",
  "Revealed files written elsewhere with `blind reveal -o` are not touched: delete them yourself.",
  "The spec's other parts (column rules, questions) are not edited; forget says when a value is",
  "still in spec.json. Values are compared case- and space-insensitively and never printed.",
  "",
  "If the inputs still contain the subject, the next plan or apply records it again: remove it",
  "from the inputs first. The salt is kept, so pseudonyms do not change; whoever holds .blind/salt",
  "can still test a guessed value against a pseudonym.",
  "",
  "Without --yes, forget prints what it would remove and asks at a terminal; elsewhere it refuses.",
  "",
  "Options:",
  "      --map <path>  The map to forget from (default .blind/map.json)",
  "  -y, --yes         Remove without asking",
  "  -h, --help        Show this help",
  "",
  "Exit status: 0 forgotten; 1 nothing records the values (nothing changed, revealed files kept),",
  "or a value is still in spec.json (said which);",
  "2 refused (usage, not confirmed, an unreadable map, spec or profile), nothing changed; or a",
  "write failed part-way (said so; run the same command again).",
  "",
].join("\n");

const PURGE_HELP = [
  "Usage: blind purge [--map <map.json>] [--yes]",
  "",
  "Removes every file under .blind/ that holds original values or reverses pseudonyms:",
  "  .blind/map.json (or --map), .blind/profile.json, .blind/run.json, the .blind/revealed/ tree,",
  "  and temp copies of the map, profile, run record and spec an interrupted write left in .blind/.",
  "Kept: blind.toml, .blind/salt and .blind/spec.json (the reviewed spec, which names entities; use",
  "`blind forget` to remove a subject from it, or delete it and plan again).",
  "",
  "Afterwards `blind reveal` has no map and refuses: nothing blinded so far can be reversed with",
  "blind. The next `blind apply` starts a new map; with the same salt, compact pseudonyms come out",
  "the same, readable ones keep their #tag but may get other letters. Revealed files written",
  "elsewhere with `blind reveal -o` are not touched: delete them yourself.",
  "",
  "Without --yes, purge lists what it would remove and asks at a terminal; elsewhere it refuses.",
  "",
  "Options:",
  "      --map <path>  The map to remove (default .blind/map.json); it must parse as a map",
  "  -y, --yes         Remove without asking",
  "  -h, --help        Show this help",
  "",
  "Exit status: 0 removed, or nothing to remove; 2 refused (usage, not confirmed, --map is not a",
  "map), nothing removed.",
  "",
].join("\n");

class Refusal extends Error {}

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Files under `dir` (0 when absent), without following links. */
function countFiles(dir: string): number {
  let n = 0;
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const c of readdirSync(p)) walk(join(p, c));
    else n++;
  };
  if (exists(dir)) walk(dir);
  return n;
}

/** --yes, or "yes" typed at a terminal. Without either the command refuses. */
async function confirmed(yes: boolean, io: EraseIO, cmd: string, question: string): Promise<boolean> {
  if (yes) return true;
  if (io.prompt === undefined) {
    io.err.write(`blind ${cmd}: nothing changed; pass --yes to go ahead (stdin is not a terminal)\n`);
    return false;
  }
  const answer = await io.prompt(question);
  if (answer?.trim().toLowerCase() === "yes") return true;
  io.err.write(`blind ${cmd}: not confirmed; nothing changed\n`);
  return false;
}

function parse(argv: string[], help: string, cmd: string, io: EraseIO) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind ${cmd}: ${(e as Error).message}\n\n${help}`);
    return undefined;
  }
}

function loadMapIfAny(path: string): BlindMap | undefined {
  if (!exists(path)) return undefined;
  return readMap(path);
}

// Every entity class; `satisfies` plus the exhaustiveness check below make a new class a type error here.
const ENTITY_CLASSES = ["person", "org", "host", "email", "id", "location", "vocabulary"] as const satisfies readonly (keyof Entities)[];
type Missing = Exclude<keyof Entities, (typeof ENTITY_CLASSES)[number]>;
const allClasses: [Missing] extends [never] ? true : never = true;
void allClasses;

interface ForgetPlan {
  forms: string[];
  entities: number;
  spec?: { path: string; text: string };
  specStill: number[];
  map?: { path: string; map: BlindMap; dropped: number };
  profile?: { path: string; text?: string; excerpts: number };
  runJson?: string;
  revealed: number;
}

/** Folded `text` contains a folded form. */
const containsAny = (text: string, folded: readonly string[]): boolean => {
  const t = foldText(text);
  return folded.some((f) => t.includes(f));
};

function planForget(values: string[], mapPath: string, cwd: string): ForgetPlan {
  const blind = join(cwd, BLIND_DIR);
  const wanted = new Set(values.map(foldText));
  const forms = new Set(values);

  // Spec: the entities a value names (canonical or alias), and their forms.
  const specPath = join(blind, SPEC_FILE);
  let spec: ForgetPlan["spec"];
  let entities = 0;
  let specStill: number[] = [];
  if (exists(specPath)) {
    let text: string;
    try {
      text = readFileSync(specPath, "utf8");
    } catch {
      throw new Refusal(`${relative(cwd, specPath)}: cannot read it`);
    }
    // A spec that does not validate is never rewritten. The validated spec is written back as parsed
    // (validation adds and drops nothing), with only its entity lists changed.
    const raw = parseSpec(text, relative(cwd, specPath));
    const named = (e: Entity): boolean => [e.canonical, ...e.aliases].some((f) => wanted.has(foldText(f)));
    const gone: Entity[] = [];
    const kept: Entity[] = [];
    for (const cls of ENTITY_CLASSES) {
      const list = raw.entities[cls];
      if (list === undefined) continue;
      gone.push(...list.filter(named));
      kept.push(...list.filter((e) => !named(e)));
      raw.entities[cls] = list.filter((e) => !named(e));
    }
    entities = gone.length;
    // A part another entity still uses (a shared surname) stays: its map entry belongs to that entity too.
    const stillUsed = new Set(kept.flatMap((e) => [e.canonical, ...e.aliases, ...e.parts]).map(foldText));
    for (const e of gone) {
      forms.add(e.canonical);
      for (const a of e.aliases) forms.add(a);
      for (const p of e.parts) if (!stillUsed.has(foldText(p))) forms.add(p);
    }
    const out = `${JSON.stringify(raw, null, 2)}\n`;
    if (entities > 0) spec = { path: specPath, text: out };
    // What forget does not edit: a value still in a column rule, a question or another entity's form.
    specStill = values.flatMap((v, i) => (foldText(out).includes(foldText(v)) ? [i + 1] : []));
  }

  const folded = [...forms].map(foldText).filter((f) => f !== "");

  // Map: every entry recording any form, and the host and email components only they used.
  let map: ForgetPlan["map"];
  const loaded = loadMapIfAny(mapPath);
  if (loaded !== undefined) {
    const r = withoutValues(loaded, [...forms]);
    if (r.dropped > 0) map = { path: mapPath, map: r.map, dropped: r.dropped };
  }

  // Profile: excerpts containing a form are removed; a structural name containing one deletes the file.
  const profilePath = join(blind, PROFILE_FILE);
  let profile: ForgetPlan["profile"];
  if (exists(profilePath)) {
    let text: string;
    try {
      text = readFileSync(profilePath, "utf8");
    } catch {
      throw new Refusal(`${relative(cwd, profilePath)}: cannot read it`);
    }
    const p = parseProfile(text, relative(cwd, profilePath));
    const names = [
      ...p.files.map((f) => f.path),
      ...p.tables.flatMap((t) => [t.file, t.sheet ?? "", ...t.columns.map((c) => c.header)]),
      ...p.jsonKeys.flatMap((k) => [k.file, k.path]),
      ...p.documents.map((d) => d.file),
      ...p.transcripts.map((t) => t.file),
      ...p.cooccurrence.flatMap((c) => [c.a, c.b].flatMap((l) => [l.file, l.sheet ?? "", l.header ?? "", l.jsonPath ?? ""])),
    ];
    if (names.some((n) => containsAny(n, folded))) {
      profile = { path: profilePath, excerpts: 0 };
    } else {
      let removed = 0;
      const keep = (list: string[]): string[] => {
        const k = list.filter((s) => !containsAny(s, folded));
        removed += list.length - k.length;
        return k;
      };
      for (const t of p.tables) for (const c of t.columns) c.stats.samples = keep(c.stats.samples);
      for (const k of p.jsonKeys) k.stats.samples = keep(k.stats.samples);
      for (const d of p.documents) {
        d.outline = keep(d.outline);
        d.sampleSentences = keep(d.sampleSentences);
      }
      for (const t of p.transcripts) {
        t.speakers = keep(t.speakers);
        t.sampleLines = keep(t.sampleLines);
      }
      if (removed > 0) profile = { path: profilePath, text: `${JSON.stringify(p, null, 2)}\n`, excerpts: removed };
    }
  }

  // run.json pairs real input paths with blinded ones; it is only a record of the last run.
  const runPath = join(blind, RUN_FILE);
  let runJson: string | undefined;
  if (exists(runPath)) {
    let text = "";
    try {
      text = readFileSync(runPath, "utf8");
    } catch {
      throw new Refusal(`${relative(cwd, runPath)}: cannot read it`);
    }
    let paths: string[] = [];
    try {
      const m = JSON.parse(text) as { inputs?: { input?: unknown }[] };
      paths = (m.inputs ?? []).map((i) => (typeof i?.input === "string" ? i.input : ""));
    } catch {
      paths = [text];
    }
    if (paths.some((p) => containsAny(p, folded))) runJson = runPath;
  }

  return { forms: [...forms], entities, spec, specStill, map, profile, runJson, revealed: countFiles(join(blind, REVEALED_DIR)) };
}

function describeForget(p: ForgetPlan, cwd: string): string[] {
  const rel = (path: string) => relative(cwd, path) || path;
  const lines: string[] = [];
  if (p.map) lines.push(`${rel(p.map.path)}: ${plural(p.map.dropped, "entry", "entries")}`);
  if (p.spec) lines.push(`${rel(p.spec.path)}: ${plural(p.entities, "entity", "entities")}, with its aliases and parts`);
  if (p.profile) {
    lines.push(
      p.profile.text === undefined
        ? `${rel(p.profile.path)}: deleted (a file, sheet, header or key name in it contains the value)`
        : `${rel(p.profile.path)}: ${plural(p.profile.excerpts, "excerpt")}`,
    );
  }
  if (p.runJson) lines.push(`${rel(p.runJson)}: deleted (a real path in it contains the value)`);
  if (p.revealed > 0) lines.push(`${join(BLIND_DIR, REVEALED_DIR)}/: deleted (${plural(p.revealed, "file")}; reveal again afterwards)`);
  return lines;
}

const stillLine = (positions: number[]): string =>
  `blind forget: value ${positions.join(", ")} is still in ${join(BLIND_DIR, SPEC_FILE)} (a column rule, a question, or another entity's form); edit it by hand\n`;

export async function runForget(argv: string[], io: EraseIO): Promise<number> {
  const parsed = parse(argv, FORGET_HELP, "forget", io);
  if (parsed === undefined) return 2;
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(FORGET_HELP);
    return 0;
  }
  if (positionals.length === 0) {
    io.err.write(`blind forget: no value given\n\n${FORGET_HELP}`);
    return 2;
  }
  const empty = positionals.findIndex((v) => foldText(v) === "");
  if (empty >= 0) {
    io.err.write(`blind forget: value ${empty + 1} is empty\n`);
    return 2;
  }

  let plan: ForgetPlan;
  try {
    plan = planForget(positionals, resolve(io.cwd, values.map ?? join(BLIND_DIR, MAP_FILE)), io.cwd);
  } catch (e) {
    if (e instanceof Refusal || e instanceof MapError || e instanceof SchemaError) {
      // Neither quotes a value: MapError names only where, and SchemaError masks what it quotes.
      io.err.write(`blind forget: ${oneLine(e.message)}; nothing changed\n`);
      return 2;
    }
    throw e;
  }

  const lines = describeForget(plan, io.cwd);
  const matched = plan.map !== undefined || plan.spec !== undefined || plan.profile !== undefined || plan.runJson !== undefined;
  // A value nothing records was never restored by reveal (it restores map entries only), so the
  // revealed tree is left alone: a mistyped value must not delete it.
  if (!matched) {
    io.err.write(`blind forget: nothing under ${BLIND_DIR}/ records ${positionals.length === 1 ? "that value" : "those values"} for forget to remove; nothing changed\n`);
    if (plan.specStill.length > 0) io.err.write(stillLine(plan.specStill));
    return 1;
  }
  io.out.write(`blind forget will remove:\n${lines.map((l) => `  ${l}\n`).join("")}`);
  if (!(await confirmed(values.yes, io, "forget", "Type yes to remove them: "))) return 2;

  // The spec goes last: while its entity is still there, a re-run after a failure finds every form again.
  try {
    if (plan.map) writeMap(plan.map.path, plan.map.map);
    if (plan.profile) {
      if (plan.profile.text === undefined) rmSync(plan.profile.path, { force: true });
      else writePrivateText(plan.profile.path, plan.profile.text);
    }
    if (plan.runJson) rmSync(plan.runJson, { force: true });
    if (plan.revealed > 0) rmSync(join(io.cwd, BLIND_DIR, REVEALED_DIR), { recursive: true, force: true });
    if (plan.spec) writePrivateText(plan.spec.path, plan.spec.text);
  } catch (e) {
    io.err.write(
      `blind forget: removing failed part-way (${(e as NodeJS.ErrnoException).code ?? "error"}); some files above may already be changed. ` +
        "Run the same command again: the spec is changed last, so it still finds every form\n",
    );
    return 2;
  }

  io.out.write("done\n");
  if (plan.specStill.length > 0) {
    io.err.write(stillLine(plan.specStill));
    return 1;
  }
  return 0;
}

export async function runPurge(argv: string[], io: EraseIO): Promise<number> {
  const parsed = parse(argv, PURGE_HELP, "purge", io);
  if (parsed === undefined) return 2;
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(PURGE_HELP);
    return 0;
  }
  if (positionals.length > 0) {
    io.err.write(`blind purge: takes no arguments\n\n${PURGE_HELP}`);
    return 2;
  }
  const blind = join(io.cwd, BLIND_DIR);
  const mapPath = resolve(io.cwd, values.map ?? join(BLIND_DIR, MAP_FILE));
  const rel = (path: string) => relative(io.cwd, path) || path;
  const targets: { path: string; label: string }[] = [];
  try {
    // A --map that is not a map is refused, so a mistyped path never deletes some other file.
    if (loadMapIfAny(mapPath) !== undefined) targets.push({ path: mapPath, label: rel(mapPath) });
  } catch (e) {
    if (e instanceof MapError) {
      io.err.write(`blind purge: ${oneLine(e.message)}; nothing removed\n`);
      return 2;
    }
    throw e;
  }
  for (const name of [PROFILE_FILE, RUN_FILE]) {
    const p = join(blind, name);
    if (exists(p)) targets.push({ path: p, label: rel(p) });
  }
  // Temp copies an interrupted write left behind hold the same originals.
  const tmpOf = [MAP_FILE, PROFILE_FILE, RUN_FILE, SPEC_FILE].map((n) => `${n}.tmp`);
  const leftovers = exists(blind) ? readdirSync(blind).filter((n) => tmpOf.some((t) => n.startsWith(t))).sort() : [];
  for (const n of leftovers) targets.push({ path: join(blind, n), label: rel(join(blind, n)) });
  const revealedDir = join(blind, REVEALED_DIR);
  if (exists(revealedDir)) targets.push({ path: revealedDir, label: `${rel(revealedDir)}/ (${plural(countFiles(revealedDir), "file")})` });

  if (targets.length === 0) {
    io.out.write(`nothing to purge: no map, profile, run record or revealed files under ${BLIND_DIR}/\n`);
    return 0;
  }
  io.out.write(`blind purge will remove:\n${targets.map((t) => `  ${t.label}\n`).join("")}`);
  if (!(await confirmed(values.yes, io, "purge", "Type yes to remove them: "))) return 2;
  try {
    for (const t of targets) rmSync(t.path, { recursive: true, force: true });
  } catch (e) {
    io.err.write(`blind purge: removing failed part-way (${(e as NodeJS.ErrnoException).code ?? "error"}); run it again\n`);
    return 2;
  }
  io.out.write(`done; blind reveal has no map now, and the next blind apply starts a new one\n`);
  return 0;
}

export function processEraseIO(): EraseIO {
  const io: EraseIO = { out: terminalStream(process.stdout), err: terminalStream(process.stderr), cwd: process.cwd() };
  if (process.stdin.isTTY) {
    io.prompt = async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(terminalText(question));
      } catch {
        return null;
      } finally {
        rl.close();
      }
    };
  }
  return io;
}
