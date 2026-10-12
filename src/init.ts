import { randomBytes } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  BACKENDS,
  type Backend,
  DEFAULT_LOCAL_URL,
  type ModelConfig,
  POLICY_FILE,
  PRIVACY_MODES,
  type Policy,
  SENSITIVE_CLASSES,
  type SensitiveClass,
  defaultPolicy,
  defaultSamples,
  renderPolicy,
} from "./policy.ts";
import { terminalStream } from "./terminal.ts";

export const BLIND_DIR = ".blind";
export const SALT_FILE = "salt";
export const SALT_BYTES = 32;

export interface InitIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  isTTY: boolean;
}

const INIT_HELP = [
  "Usage: blind init [dir] [--defaults] [--force]",
  "",
  "Writes blind.toml (the policy) and .blind/salt (32 random bytes, mode 0600) in dir (default: .).",
  "Prompts for the main settings on a terminal; an existing blind.toml is kept unless --force.",
  "",
  "Options:",
  "  --defaults  Write the default policy without prompting",
  "  --force     Overwrite an existing blind.toml and replace an existing .blind/salt",
  "  -h, --help  Show this help",
  "",
  "Exit status: 0 written; 1 refused or failed (the salt already exists and --force is not given, the prompts",
  "were cancelled, or a file could not be written); 2 usage.",
  "",
].join("\n");

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Write a fresh salt. The file is created with mode 0600 in the same open call, never chmod-ed afterwards.
 * Without `force` the exclusive create refuses an existing file; with `force` a 0600 temp file replaces it by rename.
 */
export function writeSalt(dir: string, force: boolean): void {
  const blindDir = join(dir, BLIND_DIR);
  mkdirSync(blindDir, { recursive: true, mode: 0o700 });
  const salt = join(blindDir, SALT_FILE);
  const target = force ? `${salt}.tmp` : salt;
  if (force) rmSync(target, { force: true });
  const fd = openSync(target, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(SALT_BYTES));
  } finally {
    closeSync(fd);
  }
  if (force) renameSync(target, salt);
}

/** Reads one answer per prompt; an empty answer takes the default. Returns null on end of input. */
class Prompter {
  private readonly lines: AsyncIterator<string>;

  constructor(private readonly io: InitIO) {
    this.lines = createInterface({ input: io.input, terminal: false })[Symbol.asyncIterator]();
  }

  async ask(question: string, def: string, check: (answer: string) => string | null = () => null): Promise<string> {
    for (;;) {
      this.io.output.write(def === "" ? `${question}: ` : `${question} [${def}]: `);
      const next = await this.lines.next();
      if (next.done) throw new InitCancelled();
      const answer = next.value.trim() === "" ? def : next.value.trim();
      // Control characters cannot be rendered into blind.toml safely.
      const problem = /[\u0000-\u001f\u007f]/.test(answer) ? "control characters are not allowed" : check(answer);
      if (problem === null) return answer;
      this.io.output.write(`  ${problem}\n`);
    }
  }

  close(): void {
    this.lines.return?.();
  }
}

class InitCancelled extends Error {}

const oneOf = (allowed: readonly string[]) => (a: string) =>
  allowed.includes(a) ? null : `expected one of: ${allowed.join(", ")}`;

const splitList = (a: string): string[] =>
  a === "" || a === "-" ? [] : a.split(",").map((s) => s.trim()).filter((s) => s !== "");

async function askModel(p: Prompter, role: string, def: ModelConfig): Promise<ModelConfig> {
  const backend = (await p.ask(`${role} backend (${BACKENDS.join(", ")})`, def.backend, oneOf(BACKENDS))) as Backend;
  const same = backend === def.backend;
  const url = backend === "openai-compatible" ? await p.ask(`${role} server URL`, (same && def.url) || DEFAULT_LOCAL_URL) : "";
  const model = await p.ask(`${role} model name (empty = set later)`, def.model);
  const keyDefault = same ? def.key_env : backend === "anthropic" ? "ANTHROPIC_API_KEY" : "";
  const key_env = backend === "claude-cli" ? "" : await p.ask(`${role} API key environment variable (empty = none)`, keyDefault);
  return { backend, url, model, key_env };
}

async function askPolicy(p: Prompter): Promise<Policy> {
  const policy = defaultPolicy();
  policy.privacy.mode = (await p.ask(
    `Privacy mode (${PRIVACY_MODES.join(", ")})`,
    policy.privacy.mode,
    oneOf(PRIVACY_MODES),
  )) as Policy["privacy"]["mode"];
  if (policy.privacy.mode !== "none") {
    policy.models.analyst = await askModel(p, "Analyst", policy.models.analyst);
    policy.models.auditor = await askModel(p, "Auditor", policy.models.analyst);
  }
  // Accepting the mode's default leaves `samples` unset in blind.toml, so it follows a later mode change.
  // profile-only takes no samples (a remote model never sees a value), so it is not asked.
  const byMode = defaultSamples(policy.privacy.mode);
  const samples =
    policy.privacy.mode === "profile-only"
      ? String(byMode)
      : await p.ask("Sample values per column shown to the analyst", String(byMode), (a) => (/^\d+$/.test(a) ? null : "expected a whole number (0 or more)"));
  policy.profile.samples = Number(samples);
  policy.profile.samplesExplicit = policy.profile.samples !== byMode;
  const classes = await p.ask("Classes to blind, comma-separated", policy.sensitive.classes.join(","), (a) => {
    const bad = splitList(a).find((c) => !(SENSITIVE_CLASSES as readonly string[]).includes(c));
    return bad === undefined ? null : `unknown class ${JSON.stringify(bad)}; expected some of: ${SENSITIVE_CLASSES.join(", ")}`;
  });
  policy.sensitive.classes = [...new Set(splitList(classes))] as SensitiveClass[];
  policy.keep.terms = splitList(await p.ask("Terms to keep unchanged, comma-separated (empty = none)", ""));
  return policy;
}

export async function runInit(argv: string[], io: InitIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        defaults: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    io.err.write(`blind init: ${(e as Error).message}\n\n${INIT_HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.output.write(INIT_HELP);
    return 0;
  }
  if (positionals.length > 1) {
    io.err.write(`blind init: expected at most one directory, got ${positionals.length}\n\n${INIT_HELP}`);
    return 2;
  }
  const dir = positionals[0] ?? ".";
  const force = values.force;
  const policyPath = join(dir, POLICY_FILE);
  const saltPath = join(dir, BLIND_DIR, SALT_FILE);

  if (!force && exists(saltPath)) {
    io.err.write(
      `blind init: ${saltPath} already exists; refusing to overwrite it. ` +
        "Pass --force to replace it (pseudonyms from earlier runs will no longer match).\n",
    );
    return 1;
  }
  const keepPolicy = !force && exists(policyPath);

  let policy = defaultPolicy();
  if (!keepPolicy && !values.defaults) {
    if (io.isTTY) {
      io.output.write("blind init: press Enter to accept a default. Edit blind.toml afterwards for anything else.\n");
      const prompter = new Prompter(io);
      try {
        policy = await askPolicy(prompter);
      } catch (e) {
        if (!(e instanceof InitCancelled)) throw e;
        io.err.write("\nblind init: cancelled; nothing written\n");
        return 1;
      } finally {
        prompter.close();
      }
    } else {
      io.err.write("blind init: stdin is not a terminal; writing the default policy (same as --defaults)\n");
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
    writeSalt(dir, force);
    if (!keepPolicy) writeFileSync(policyPath, renderPolicy(policy), { flag: force ? "w" : "wx" });
  } catch (e) {
    io.err.write(`blind init: ${(e as Error).message}\n`);
    return 1;
  }

  io.output.write(keepPolicy ? `kept existing ${policyPath}\n` : `wrote ${policyPath}\n`);
  io.output.write(`wrote ${saltPath} (mode 0600; keep it secret, never commit it)\n`);
  if (!keepPolicy) io.output.write(`next: describe what sensitive means for you in ${policyPath}\n`);
  return 0;
}

/** The real process streams. */
export function processIO(): InitIO {
  return { input: process.stdin, output: terminalStream(process.stdout), err: terminalStream(process.stderr), isTTY: process.stdin.isTTY === true };
}
