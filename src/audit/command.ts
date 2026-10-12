// `blind audit <out>`: the file-system side of the audit (mechanical, semantic, then model). Reads the
// saved spec and the map, walks every entry of the output tree (hidden ones
// included, symbolic links not followed), runs the audit and prints the
// report as a table or JSON. Exit status is the contract: 0 clean,
// 1 candidates, 2 leak; 3 the audit could not run (never 2, which would
// report a leak that was not found, and never 0 or 1).

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAP_FILE, SPEC_FILE } from "../apply.ts";
import { type BlindMap, MapError, readMap } from "../engine/map.ts";
import { BLIND_DIR } from "../init.ts";
import { type AskOptions, ModelRefusal, modelsEnabled } from "../model.ts";
import { loadPolicy, type Policy, POLICY_FILE, PolicyError, withPolicyPatterns } from "../policy.ts";
import type { Spec } from "../schema.ts";
import { parseSpec, SchemaError } from "../validate.ts";
import { addModelLayer } from "./auditor.ts";
import { addSemanticLayer } from "./semantic.ts";
import { type AuditReport, auditTree, type Finding, type Status, type TreeEntry } from "./mechanical.ts";
import { oneLine, terminalStream } from "../terminal.ts";

export interface AuditIO {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The corpus workspace: where blind.toml and .blind/ live. */
  cwd: string;
  /** Test seams, passed through to the model auditor's calls. */
  model?: Pick<AskOptions, "fetch" | "spawn" | "env" | "timeoutMs">;
}

const AUDIT_HELP = [
  "Usage: blind audit <out> [--map <path>] [--json] [--no-model]",
  "",
  "Audits a blinded output tree (a directory, or one file) against the saved spec (.blind/spec.json)",
  "and the map. Every file is read as raw bytes, in Latin-1, UTF-8 and UTF-16, with XML, percent",
  "and backslash escapes undone; zip members (xlsx, docx, nested archives) are opened recursively;",
  "file, directory and member names are checked too. It looks for every spec entity, every original",
  "value in the map and every enabled pattern match that is not a pseudonym. Host names under a",
  "domain in the blind.toml keep list are not reported: the policy keeps them.",
  "",
  "Then the semantic layer, which does not rely on the spec: identifier-shaped tokens (hex of 6 or",
  "more, 4 or more digits mixed with letters, runs of 10 or more digits), Title-Case phrases of two",
  "or more words not in the keep list or the spec's vocabulary, and email and host shapes. Anything",
  "that is a pseudonym is left out. Each is a candidate, listed once per file (at most 200 per file,",
  "with a count of the rest).",
  "",
  "Then the model layer, unless --no-model or privacy.mode = \"none\": the auditor model ([models.auditor]",
  "in blind.toml; without it, the analyst's backend with the auditor's own prompt) is told it is the",
  "subject of the documents and asked to find what gives it away. Under local-only it is sent the",
  "output's text in lines of at most 120 characters and chunks of at most 8 kB, to a loopback server",
  "only; under profile-only only the output's profile. It can only add candidates. A call that fails",
  "or a reply that is rejected is itself a candidate: that text was not checked by a model.",
  "",
  "Status: leak (a spec value survives), candidates (something to review: a variant or partial",
  "match, a semantic candidate, a column the spec declares unknown or does not mention, an",
  "unanswered spec question, or a part that could not be read), clean (none of these). Clean means",
  "only that these checks found nothing they look for; it is not a guarantee that nothing",
  "identifying remains.",
  "Values in the report are masked: first characters, ***, length. Paths are printed as on disk.",
  "",
  "Options:",
  "      --map <path>  The map apply wrote (default .blind/map.json)",
  "      --json        Print the report as JSON",
  "      --no-model    Mechanical and semantic layers only: no model is called",
  "  -h, --help        Show this help",
  "",
  "Exit status: 0 clean, 1 candidates, 2 leak, 3 the audit could not run (usage error, or a refusal such as a",
  "model call the privacy mode forbids; nothing audited).",
  "",
].join("\n");

const EXIT: Record<Status, number> = { clean: 0, candidates: 1, leak: 2 };
/** Not 2: that means a leak was found. */
export const EXIT_NOT_RUN = 3;

class Refusal extends Error {}

/** Code-unit order, never locale order. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every entry under `root` (or `root` itself when it is a file), paths relative and "/"-separated. */
export function collectTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const visit = (abs: string, rel: string): void => {
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      entries.push({ path: rel, kind: "unreadable", reason: (e as NodeJS.ErrnoException).code ?? "error" });
      return;
    }
    if (st.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(abs);
      } catch (e) {
        entries.push({ path: rel, kind: "unreadable", reason: (e as NodeJS.ErrnoException).code ?? "error" });
        return;
      }
      entries.push({ path: rel, kind: "symlink", target });
    } else if (st.isDirectory()) {
      if (rel !== "") entries.push({ path: rel, kind: "dir" });
      let names: string[];
      try {
        names = readdirSync(abs).sort(cmp);
      } catch (e) {
        entries.push({ path: rel === "" ? "." : rel, kind: "unreadable", reason: (e as NodeJS.ErrnoException).code ?? "error" });
        return;
      }
      for (const n of names) visit(join(abs, n), rel === "" ? n : `${rel}/${n}`);
    } else if (st.isFile()) {
      try {
        entries.push({ path: rel, kind: "file", bytes: readFileSync(abs) });
      } catch (e) {
        entries.push({ path: rel, kind: "unreadable", reason: (e as NodeJS.ErrnoException).code ?? "error" });
      }
    } else entries.push({ path: rel, kind: "other" });
  };
  let st;
  try {
    st = lstatSync(root);
  } catch {
    throw new Refusal(`${root} does not exist`);
  }
  visit(root, st.isDirectory() && !st.isSymbolicLink() ? "" : basename(root));
  return entries;
}

function loadSpec(cwd: string): Spec {
  const path = join(cwd, BLIND_DIR, SPEC_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Refusal(`${path} not found; the audit checks the output against the saved spec`);
    throw new Refusal(`${path}: cannot read the spec`);
  }
  return parseSpec(text, path);
}

function loadMap(path: string): BlindMap {
  try {
    lstatSync(path);
  } catch {
    throw new Refusal(`${path} not found; pass --map with the map \`blind apply\` wrote`);
  }
  return readMap(path);
}

function where(f: Finding): string {
  let w = f.part === "" ? f.file : `${f.file}!${f.part}`;
  if (f.in !== "content") w += ` [${f.in}]`;
  if (f.offset !== null) w += `@${f.offset}`;
  if (f.line !== null) w += ` line ${f.line}`;
  return w;
}

export function renderTable(r: AuditReport): string {
  const rows = [...r.files.flatMap((f) => f.findings), ...r.general];
  const lines: string[] = [];
  if (rows.length > 0) {
    const cells = rows.map((f) => [f.severity, where(f), f.class, f.masked === "" ? "-" : f.masked, f.reason].map(oneLine));
    const head = ["SEVERITY", "WHERE", "CLASS", "VALUE", "REASON"];
    const width = head.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] as string).length)));
    const fmt = (c: string[]) => c.map((x, i) => (i === c.length - 1 ? x : x.padEnd(width[i] as number))).join("  ");
    lines.push(fmt(head), ...cells.map(fmt), "");
  }
  for (const f of r.files) {
    if (f.kind === "dir") continue;
    lines.push(`${f.status.padEnd(10)}  ${oneLine(f.path)}`);
  }
  if (r.model !== undefined) lines.push("", ...modelLines(r.model));
  const layers = layersLine(r);
  const { files, leaks, candidates } = r.summary;
  const counts = `${files} file${files === 1 ? "" : "s"}; ${leaks} leak${leaks === 1 ? "" : "s"}, ${candidates} candidate${candidates === 1 ? "" : "s"}`;
  lines.push("");
  if (r.status === "clean") {
    lines.push(
      `status: clean (${counts}; ${layers})`,
      "No spec entity, map value or enabled pattern was found in any byte, name or archive member, no identifier-,",
      "name-, email- or host-shaped text was found that is not a pseudonym or kept, and nothing was left undecided.",
      "These checks find only what they look for; it is not a guarantee that nothing identifying remains.",
    );
  } else lines.push(`status: ${r.status} (${counts}; ${layers})`);
  return `${lines.join("\n")}\n`;
}

/** `layers run: mechanical, semantic; model: not reached (127.0.0.1:11434)`: a model layer that read nothing is named, never listed as run. */
export function layersLine(r: Pick<AuditReport, "layers" | "modelLayer">): string {
  const m = r.modelLayer;
  let line = `layers run: ${r.layers.filter((l) => !l.startsWith("model (")).join(", ")}`;
  if (m === undefined || m.status === "ran") return line;
  const at = m.host === null ? "" : ` (${m.host})`;
  if (m.status === "skipped") line += `; model: skipped (${m.reason})`;
  else if (m.status === "unreachable") line += `; model: not reached${at}`;
  else if (m.status === "rejected") line += `; model: replies rejected${at}, nothing it said was accepted`;
  else line += `; model: partial${at}, some chunks were not checked`;
  return line;
}

function modelLines(m: NonNullable<AuditReport["model"]>): string[] {
  const name = m.model === "" ? "default model" : m.model;
  const what = m.sent === "text" ? `the output's text in ${m.chunks} chunk${m.chunks === 1 ? "" : "s"}` : "the output's profile only";
  const out = [`model layer: ${m.backend} · ${name} · ${m.mode}; sent ${what}; ${m.answered} of ${m.chunks} answered`];
  if (m.config === "analyst") out.push("model layer: [models.auditor] is not set, so the analyst's backend was used with the auditor's prompt");
  for (const n of m.notSent) out.push(oneLine(`model layer: not sent: ${n.part === "" ? n.file : `${n.file}!${n.part}`} (${n.reason})`));
  return out;
}

/** Why the model layer does not run, or null when it does. */
function noModelReason(noModel: boolean, policy: Policy | null): string | null {
  if (noModel) return null;
  if (policy === null) return `no ${POLICY_FILE}, so no model is configured: mechanical and semantic layers only (run blind init to configure one)`;
  if (!modelsEnabled(policy)) return 'privacy.mode is "none": mechanical and semantic layers only';
  return null;
}

export async function runAudit(argv: string[], io: AuditIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        map: { type: "string" },
        json: { type: "boolean", default: false },
        "no-model": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind audit: ${(e as Error).message}\n\n${AUDIT_HELP}`);
    return EXIT_NOT_RUN;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out.write(AUDIT_HELP);
    return 0;
  }
  if (positionals.length !== 1) {
    io.err.write(`blind audit: ${positionals.length === 0 ? "no output tree given" : "give exactly one output tree"}\n\n${AUDIT_HELP}`);
    return EXIT_NOT_RUN;
  }
  try {
    const saved = loadSpec(io.cwd);
    const map = loadMap(resolve(io.cwd, values.map ?? join(BLIND_DIR, MAP_FILE)));
    const entries = collectTree(resolve(io.cwd, positionals[0] as string));
    // Without a blind.toml nothing is kept (the more private reading) and no model is configured.
    const policy = existsSync(join(io.cwd, POLICY_FILE)) ? loadPolicy(io.cwd) : null;
    // The patterns apply used: blind.toml's [patterns] switches over the spec's.
    const spec = withPolicyPatterns(saved, policy?.patterns ?? {});
    // Hosts the engine kept under a keep-list domain are policy, not leaks.
    const keep = policy?.keep.terms ?? [];
    let report = addSemanticLayer(auditTree(entries, spec, map, keep, policy?.keep.placeholders ?? true), entries, spec, map, { keep });
    const skip = noModelReason(values["no-model"], policy);
    if (skip !== null) io.err.write(`blind audit: ${skip}\n`);
    if (skip !== null || values["no-model"]) {
      const reason = values["no-model"] ? "--no-model" : policy === null ? `no ${POLICY_FILE}` : 'privacy.mode is "none"';
      report = { ...report, modelLayer: { status: "skipped", host: null, reason } };
    } else if (policy !== null && !values["no-model"]) {
      if (!policy.models.auditorExplicit) {
        io.err.write("blind audit: [models.auditor] is not set; the auditor uses the analyst's backend with its own prompt\n");
      }
      report = await addModelLayer(report, entries, {
        policy,
        root: positionals[0] as string,
        cwd: io.cwd,
        spec,
        keep,
        ask: { ...io.model, stderr: (line) => io.err.write(`blind audit: ${line}\n`) },
      });
    }
    io.out.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderTable(report));
    return EXIT[report.status];
  } catch (e) {
    // A refused model call is "could not run" (3), never 2: 2 means a leak was found.
    if (e instanceof Refusal || e instanceof PolicyError || e instanceof SchemaError || e instanceof MapError || e instanceof ModelRefusal) {
      const hint = e instanceof ModelRefusal ? "; --no-model runs the mechanical and semantic layers without a model" : "";
      io.err.write(`blind audit: ${e.message}\nnothing was audited${hint}\n`);
      return EXIT_NOT_RUN;
    }
    // Anything else is a bug; exit 3 rather than let the runtime's exit 1 read as "candidates".
    io.err.write(`blind audit: unexpected error: ${(e as Error).message}; nothing was audited\n`);
    return EXIT_NOT_RUN;
  }
}

export function processAuditIO(): AuditIO {
  return { out: terminalStream(process.stdout), err: terminalStream(process.stderr), cwd: process.cwd() };
}
