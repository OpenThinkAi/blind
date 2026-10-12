import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_KINDS, type ContextTriggerSpec } from "./engine/context.ts";
import { COLUMN_DEFAULTS, type ColumnDefault } from "./engine/columns.ts";
import type { EntityClassName, PatternName, Spec, Treatment } from "./schema.ts";

/** The policy file `blind init` writes and every later command reads. */
export const POLICY_FILE = "blind.toml";

export const SENSITIVE_CLASSES = ["person", "org", "host", "email", "id", "location", "secret"] as const;
export type SensitiveClass = (typeof SENSITIVE_CLASSES)[number];

/** `claude -p` (subscription), the Anthropic API, or any OpenAI-compatible server. */
export const BACKENDS = ["claude-cli", "anthropic", "openai-compatible"] as const;
export type Backend = (typeof BACKENDS)[number];

export const PRIVACY_MODES = ["local-only", "profile-only", "none"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export interface ModelConfig {
  backend: Backend;
  /** Endpoint base URL; empty means the backend's own default. */
  url: string;
  /** Model name; empty means not configured yet. */
  model: string;
  /** Name of the environment variable holding the API key; empty means none. */
  key_env: string;
}

/**
 * The free-text shape patterns `[patterns]` can switch, each with the comment `blind init` writes.
 * A Record so a new PatternName cannot be added without deciding how blind.toml shows it.
 */
const PATTERN_HELP: Record<PatternName, string> = {
  ip: "IPv4 and IPv6 addresses",
  email: "email addresses",
  host: "host names",
  guid: "GUIDs",
  mac: "MAC addresses",
  phone: "phone numbers",
  address: "street addresses (a house number, street and suffix, then an optional unit and City ST ZIP)",
  secret: "passwords, keys and tokens (credential-shaped words), written as REDACTED",
};
export const POLICY_PATTERNS = Object.keys(PATTERN_HELP) as PatternName[];

/** Only the patterns blind.toml sets; an unset one follows the spec. */
export type PolicyPatterns = Partial<Record<PatternName, boolean>>;

/** Every spec class, for a `[[columns]]` rule's `class`. */
export const COLUMN_CLASSES: readonly EntityClassName[] = ["person", "org", "host", "email", "id", "location", "vocabulary", "secret", "unknown"];
export const COLUMN_TREATMENTS: readonly Treatment[] = ["keep", "scan", "drop", "blind", "value", "redact"];

/**
 * A `[[columns]]` rule: the columns (and JSON keys) whose header matches one of `header` (globs,
 * case-insensitive), in the files `file` matches (a glob on the input-relative path; absent = every
 * file), get `treatment` and `class`. `blind plan` writes them into the spec ahead of the analyst
 * and the heuristic; the first matching rule wins.
 */
export interface ColumnPolicyRule {
  header: string[];
  file?: string;
  treatment: Treatment;
  /** Defaults to `vocabulary` for `keep` and to `unknown` for the rest (a `scan` column needs no class). */
  class: EntityClassName;
}

export interface Policy {
  sensitive: { classes: SensitiveClass[]; description: string; examples: string[] };
  keep: { terms: string[] };
  /**
   * `auditor` is always the config in force. `auditorExplicit` is false when blind.toml has no
   * `[models.auditor]` table, in which case the auditor reuses the analyst's backend (with its own
   * prompt) and `blind audit` says so.
   */
  models: { analyst: ModelConfig; auditor: ModelConfig; auditorExplicit: boolean };
  /**
   * `samples` is always the count in force. `samplesExplicit` is false when blind.toml leaves
   * `samples` unset, in which case it follows the mode: defaultSamples(privacy.mode).
   */
  profile: { samples: number; samplesExplicit: boolean };
  privacy: { mode: PrivacyMode };
  /** `[patterns]`: switches that win over the spec's `patterns` at apply and audit time. */
  patterns: PolicyPatterns;
  /** `[[columns]]`, in file order. */
  columns: ColumnPolicyRule[];
  /** `[context]`: redaction of the value after a keyword such as "gate code" or "password" (engine/context.ts). */
  context: { enabled: boolean; triggers: ContextTriggerSpec[] };
  /**
   * `[defaults] columns`: what a column with no rule (or an unknown/value rule) gets at apply time.
   * `fallback` (the default) is the fail-closed identifier-like test; `scan` keeps every cell and
   * replaces only what the free-text scanner finds in it.
   */
  defaults: { columns: ColumnDefault };
}

/** The spec with blind.toml's `[patterns]` switches laid over its own: the patterns apply and audit use. */
export function withPolicyPatterns(spec: Spec, patterns: PolicyPatterns): Spec {
  const set = POLICY_PATTERNS.filter((name) => patterns[name] !== undefined && patterns[name] !== spec.patterns[name]);
  if (set.length === 0) return spec;
  return { ...spec, patterns: { ...spec.patterns, ...Object.fromEntries(set.map((name) => [name, patterns[name]])) } };
}

/**
 * Samples per column when blind.toml does not set `[profile] samples`: 5 while nothing leaves the
 * machine, 0 under profile-only, where the profile goes to a remote model that may see statistics
 * but never a value. It is also the only count profile-only accepts (parsePolicy refuses more).
 */
export function defaultSamples(mode: PrivacyMode): number {
  return mode === "profile-only" ? 0 : 5;
}

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:11434/v1";

export function defaultPolicy(): Policy {
  const local = (): ModelConfig => ({ backend: "openai-compatible", url: DEFAULT_LOCAL_URL, model: "", key_env: "" });
  return {
    sensitive: {
      classes: [...SENSITIVE_CLASSES],
      description:
        "Anything that tells a reader who these documents are about: people, the organisations they work for, " +
        "their machines and hosts, email addresses, account or record IDs, and where they are.",
      examples: ["Ada Example", "Example Widgets Ltd", "build01.corp.example.com", "ada@example.com", "ACCT-000123", "Springfield office"],
    },
    keep: { terms: [] },
    models: { analyst: local(), auditor: local(), auditorExplicit: true },
    profile: { samples: defaultSamples("local-only"), samplesExplicit: false },
    privacy: { mode: "local-only" },
    // IPs, host names and secrets are found in free text even when their class is not listed.
    patterns: { ip: true, host: true, secret: true },
    columns: [],
    context: { enabled: true, triggers: [] },
    defaults: { columns: "fallback" },
  };
}

const str = (s: string): string => JSON.stringify(s);
const list = (xs: readonly string[]): string => `[${xs.map(str).join(", ")}]`;

function modelSection(name: string, m: ModelConfig): string[] {
  return [
    `[models.${name}]`,
    `backend = ${str(m.backend)}`,
    `url = ${str(m.url)}`,
    `model = ${str(m.model)}`,
    `key_env = ${str(m.key_env)}`,
  ];
}

/** Render a policy as commented TOML. Strings must not contain control characters. */
export function renderPolicy(p: Policy): string {
  return [
    "# blind policy: what sensitive means for this corpus. You own this file; edit it freely.",
    "",
    "[sensitive]",
    `# Classes to blind. Any of: ${SENSITIVE_CLASSES.join(", ")}.`,
    `classes = ${list(p.sensitive.classes)}`,
    "# In your own words: what must a reader of the blinded output not learn?",
    `description = ${str(p.sensitive.description)}`,
    "# Invented examples of the kind of value you mean (never paste real ones here).",
    `examples = ${list(p.sensitive.examples)}`,
    "",
    "[keep]",
    "# Vocabulary that must survive blinding unchanged (product names, jargon, public terms).",
    `terms = ${list(p.keep.terms)}`,
    "",
    `# Model backends: ${BACKENDS.join(" | ")}.`,
    "# url: endpoint base URL (empty = backend default). model: model name (empty = not set yet).",
    "# key_env: name of the environment variable holding the API key (empty = none).",
    ...modelSection("analyst", p.models.analyst),
    "",
    ...(p.models.auditorExplicit
      ? modelSection("auditor", p.models.auditor)
      : [
          "# [models.auditor] is not set: the auditor reuses the analyst's backend with its own prompt.",
          "# Set it to give the auditor a separate backend; independence is the point of the auditor.",
          ...modelSection("auditor", p.models.auditor).map((l) => `# ${l}`),
        ]),
    "",
    "[profile]",
    "# Sample values per column the analyst sees (each truncated to 120 characters). 0 = statistics only.",
    `# Unset, it is ${defaultSamples("local-only")} under local-only and none, and ${defaultSamples("profile-only")} under profile-only, where it must stay 0.`,
    // Written out when set, or when it differs from the mode's default (so it is never silently changed).
    p.profile.samplesExplicit || p.profile.samples !== defaultSamples(p.privacy.mode)
      ? `samples = ${p.profile.samples}`
      : `# samples = ${p.profile.samples}`,
    "",
    "[privacy]",
    "# local-only: refuse any non-loopback endpoint. none: no model is called.",
    "# profile-only: remote allowed; the model sees statistics, with every name as a token, and never a value.",
    `mode = ${str(p.privacy.mode)}`,
    "",
    "[patterns]",
    "# Free-text shape finders. true or false here wins over the spec's patterns; unset, the spec decides.",
    ...POLICY_PATTERNS.map((name) => {
      const v = p.patterns[name];
      return v === undefined ? `# ${name} = true   # ${PATTERN_HELP[name]}` : `${name} = ${v}   # ${PATTERN_HELP[name]}`;
    }),
    "",
    "[context]",
    "# The value after a keyword is replaced with REDACTED and the keyword stays: DOB, driver's license, plate,",
    "# gate code, password / pw, combo, routing, account / acct, card, CVV, policy #. Secrets that no name or",
    "# pattern finder targets. enabled = false turns it off. triggers adds words: the next token after each is redacted.",
    p.context.enabled ? "# enabled = true" : "enabled = false",
    "# A trigger may name the kind of value it expects: { word = \"license\", kind = \"number\" } (secret | number | date).",
    p.context.triggers.length === 0
      ? '# triggers = ["locker code", { word = "license", kind = "number" }, { word = "born", kind = "date" }]'
      : `triggers = [${p.context.triggers.map((t) => (typeof t === "string" ? str(t) : `{ word = ${str(t.word)}, kind = ${str(t.kind)} }`)).join(", ")}]`,
    "",
    "# Column rules, applied by `blind plan` before the analyst and the heuristic; the first match wins.",
    "# header: header globs (* and ?, any case); a JSON key matches by its name. file: optional path glob",
    `# (* within a folder, ** across folders). treatment: ${COLUMN_TREATMENTS.join(" | ")}. class: optional.`,
    "# A column whose header is a [keep] term is kept too, unless a rule here says otherwise.",
    "# keep: byte-identical, nothing in it is replaced. scan: kept as written apart from what the free-text",
    "# scanner finds (phones, emails, names, plates and codes after a keyword): the one for notes, remarks, diagnoses.",
    ...(p.columns.length === 0
      ? [
          "# [[columns]]",
          '# header = ["species", "weight*", "visit date"]',
          '# treatment = "keep"',
          "#",
          "# [[columns]]",
          '# header = ["notes", "remarks", "diagnosis"]',
          '# treatment = "scan"',
        ]
      : p.columns.flatMap((c, i) => [
          ...(i === 0 ? [] : [""]),
          "[[columns]]",
          `header = ${list(c.header)}`,
          ...(c.file === undefined ? [] : [`file = ${str(c.file)}`]),
          `treatment = ${str(c.treatment)}`,
          `class = ${str(c.class)}`,
        ])),
    "",
    "[defaults]",
    "# What a column no rule decides gets. fallback: an identifier-like column (mostly distinct codes, names or",
    "# numbers) is pseudonymised whole, the rest scanned as text. scan: every such column is kept and scanned as",
    "# text; only a rule pseudonymises a column whole. Either way a value kept whole in a keep or scan column is",
    "# never pseudonymised whole by the fallback elsewhere.",
    p.defaults.columns === "fallback" ? '# columns = "fallback"' : `columns = ${str(p.defaults.columns)}`,
    "",
  ].join("\n");
}

export class PolicyError extends Error {
  override name = "PolicyError";
}

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

function typeName(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (isTable(v)) return "table";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "float";
  return typeof v;
}

/** Validates a parsed document against the policy shape, naming the offending key on failure. */
class Reader {
  constructor(private readonly source: string) {}

  fail(key: string, expected: string, got?: unknown): never {
    const tail = got === undefined ? "missing" : typeof got === "number" ? `got ${got}` : `got ${typeName(got)}`;
    throw new PolicyError(`${this.source}: ${key} must be ${expected} (${tail})`);
  }

  table(t: Table, key: string, path: string, keys: readonly string[]): Table {
    const v = t[key];
    if (!isTable(v)) this.fail(path, "a table", v);
    this.noExtra(v, path, keys);
    return v;
  }

  noExtra(t: Table, path: string, keys: readonly string[]): void {
    const extra = Object.keys(t).filter((k) => !keys.includes(k)).sort();
    if (extra.length > 0) {
      const at = path === "" ? extra[0] : `${path}.${extra[0]}`;
      throw new PolicyError(`${this.source}: unknown key ${at} (expected one of: ${keys.join(", ")})`);
    }
  }

  string(t: Table, key: string, path: string): string {
    const v = t[key];
    if (typeof v !== "string") this.fail(path, "a string", v);
    return v;
  }

  count(t: Table, key: string, path: string): number {
    const v = t[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) this.fail(path, "a non-negative integer", v);
    return v;
  }

  boolean(t: Table, key: string, path: string): boolean {
    const v = t[key];
    if (typeof v !== "boolean") this.fail(path, "true or false", v);
    return v;
  }

  strings(t: Table, key: string, path: string): string[] {
    const v = t[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) this.fail(path, "an array of strings", v);
    return v;
  }

  oneOf<T extends string>(t: Table, key: string, path: string, allowed: readonly T[]): T {
    const v = t[key];
    const expected = `one of ${allowed.map(str).join(", ")}`;
    if (typeof v !== "string") this.fail(path, expected, v);
    if (!(allowed as readonly string[]).includes(v)) {
      throw new PolicyError(`${this.source}: ${path} must be ${expected} (got ${str(v)})`);
    }
    return v as T;
  }
}

const MODEL_KEYS = ["backend", "url", "model", "key_env"] as const;

function readModel(r: Reader, models: Table, name: string): ModelConfig {
  const path = `models.${name}`;
  const t = r.table(models, name, path, MODEL_KEYS);
  return {
    backend: r.oneOf(t, "backend", `${path}.backend`, BACKENDS),
    url: r.string(t, "url", `${path}.url`),
    model: r.string(t, "model", `${path}.model`),
    key_env: r.string(t, "key_env", `${path}.key_env`),
  };
}

/** `[models.analyst]` is required; without `[models.auditor]` the auditor reuses the analyst's config. */
function readModels(r: Reader, models: Table): Policy["models"] {
  const analyst = readModel(r, models, "analyst");
  if (models.auditor === undefined) return { analyst, auditor: { ...analyst }, auditorExplicit: false };
  return { analyst, auditor: readModel(r, models, "auditor"), auditorExplicit: true };
}

const COLUMN_RULE_KEYS = ["header", "file", "treatment", "class"] as const;

function readColumns(r: Reader, doc: Table, source: string): ColumnPolicyRule[] {
  const v = doc.columns;
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isTable)) r.fail("columns", "an array of tables ([[columns]])", v);
  return (v as Table[]).map((t, i): ColumnPolicyRule => {
    const path = `columns[${i}]`;
    r.noExtra(t, path, COLUMN_RULE_KEYS);
    const raw = t.header;
    const header = typeof raw === "string" ? [raw] : r.strings(t, "header", `${path}.header`);
    if (header.length === 0 || header.some((h) => h.trim() === "")) r.fail(`${path}.header`, "a non-empty glob or array of non-empty globs", raw);
    const treatment = r.oneOf(t, "treatment", `${path}.treatment`, COLUMN_TREATMENTS);
    const cls = t.class === undefined ? (treatment === "keep" ? "vocabulary" : "unknown") : r.oneOf(t, "class", `${path}.class`, COLUMN_CLASSES);
    // The spec's fail-closed rule: nobody decided an `unknown` column, so it may not pass through.
    if (cls === "unknown" && treatment === "keep") {
      throw new PolicyError(`${source}: ${path}: class "unknown" cannot use treatment "keep"; leave class out or name one (e.g. "vocabulary")`);
    }
    const rule: ColumnPolicyRule = { header, treatment, class: cls };
    if (t.file !== undefined) {
      const file = r.string(t, "file", `${path}.file`);
      if (file.trim() === "") r.fail(`${path}.file`, "a non-empty glob", file);
      rule.file = file;
    }
    return rule;
  });
}

/** Parse and validate policy TOML. Throws PolicyError naming the offending key and expected type. */
export function parsePolicy(text: string, source = POLICY_FILE): Policy {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (e) {
    throw new PolicyError(`${source}: not valid TOML: ${(e as Error).message}`);
  }
  if (!isTable(doc)) throw new PolicyError(`${source}: not a TOML table`);
  const r = new Reader(source);
  r.noExtra(doc, "", ["sensitive", "keep", "models", "profile", "privacy", "patterns", "columns", "context", "defaults"]);

  const sensitive = r.table(doc, "sensitive", "sensitive", ["classes", "description", "examples"]);
  const classes = r.strings(sensitive, "classes", "sensitive.classes");
  const bad = classes.find((c) => !(SENSITIVE_CLASSES as readonly string[]).includes(c));
  if (bad !== undefined) {
    throw new PolicyError(
      `${source}: sensitive.classes must contain only ${SENSITIVE_CLASSES.map(str).join(", ")} (got ${str(bad)})`,
    );
  }

  const keep = r.table(doc, "keep", "keep", ["terms"]);
  const models = r.table(doc, "models", "models", ["analyst", "auditor"]);
  const profile = r.table(doc, "profile", "profile", ["samples"]);
  const samplesExplicit = profile.samples !== undefined;
  const privacy = r.table(doc, "privacy", "privacy", ["mode"]);
  const mode = r.oneOf(privacy, "mode", "privacy.mode", PRIVACY_MODES);
  const samples = samplesExplicit ? r.count(profile, "samples", "profile.samples") : defaultSamples(mode);
  // profile-only means a remote model never sees a value (AGT-1832), so it takes no samples at all.
  if (mode === "profile-only" && samples > 0) {
    throw new PolicyError(
      `${source}: profile.samples must be 0 under privacy.mode = "profile-only" (got ${samples}): a model there sees statistics, never a value; ` +
        `remove the line, or use "local-only" with a loopback model to show it samples`,
    );
  }
  const patterns = readPatterns(r, doc);

  return {
    sensitive: {
      classes: classes as SensitiveClass[],
      description: r.string(sensitive, "description", "sensitive.description"),
      examples: r.strings(sensitive, "examples", "sensitive.examples"),
    },
    keep: { terms: r.strings(keep, "terms", "keep.terms") },
    models: readModels(r, models),
    profile: { samples, samplesExplicit },
    privacy: { mode },
    patterns,
    columns: readColumns(r, doc, source),
    context: readContext(r, doc),
    defaults: readDefaults(r, doc),
  };
}

/** `[defaults]` is optional, and so is its one key. */
function readDefaults(r: Reader, doc: Table): Policy["defaults"] {
  if (doc.defaults === undefined) return { columns: "fallback" };
  const t = r.table(doc, "defaults", "defaults", ["columns"]);
  return { columns: t.columns === undefined ? "fallback" : r.oneOf(t, "columns", "defaults.columns", COLUMN_DEFAULTS) };
}

/** `[context]` is optional, and so is each key in it. A trigger is a word or phrase, so it may not be blank. */
function readContext(r: Reader, doc: Table): Policy["context"] {
  const out: Policy["context"] = { enabled: true, triggers: [] };
  if (doc.context === undefined) return out;
  const t = r.table(doc, "context", "context", ["enabled", "triggers"]);
  if (t.enabled !== undefined) out.enabled = r.boolean(t, "enabled", "context.enabled");
  if (t.triggers !== undefined) {
    const v = t.triggers;
    const expected = 'an array of non-blank words or phrases, or { word = "...", kind = "secret" | "number" | "date" } tables';
    if (!Array.isArray(v)) r.fail("context.triggers", expected, v);
    out.triggers = (v as unknown[]).map((x, i): ContextTriggerSpec => {
      const path = `context.triggers[${i}]`;
      if (typeof x === "string") {
        if (x.trim() === "") r.fail(path, expected, x);
        return x;
      }
      if (!isTable(x)) r.fail(path, expected, x);
      r.noExtra(x, path, ["word", "kind"]);
      const word = r.string(x, "word", `${path}.word`);
      if (word.trim() === "") r.fail(`${path}.word`, "a non-blank word or phrase", word);
      return { word, kind: r.oneOf(x, "kind", `${path}.kind`, CONTEXT_KINDS) };
    });
  }
  return out;
}

/** `[patterns]` is optional, and so is each key in it; a key that is present must be a boolean. */
function readPatterns(r: Reader, doc: Table): PolicyPatterns {
  if (doc.patterns === undefined) return {};
  const t = r.table(doc, "patterns", "patterns", POLICY_PATTERNS);
  const out: PolicyPatterns = {};
  for (const name of POLICY_PATTERNS) if (t[name] !== undefined) out[name] = r.boolean(t, name, `patterns.${name}`);
  return out;
}

/** Load `blind.toml` from `dir`. A missing file is a one-line PolicyError telling the user to run `blind init`. */
export function loadPolicy(dir = "."): Policy {
  const path = join(dir, POLICY_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PolicyError(`${path} not found; run \`blind init\` first`);
    }
    throw new PolicyError(`${path}: cannot read: ${(e as Error).message}`);
  }
  return parsePolicy(text, path);
}

/** `dir`'s blind.toml, or null when there is none. A blind.toml that does not parse is a PolicyError. */
export function loadPolicyIfAny(dir = "."): Policy | null {
  return existsSync(join(dir, POLICY_FILE)) ? loadPolicy(dir) : null;
}

/**
 * The keep-list terms of `dir`'s blind.toml, for apply and audit. Without a blind.toml nothing is
 * kept, the more private reading; a blind.toml that does not parse is a PolicyError.
 */
export function loadKeepTerms(dir = "."): string[] {
  return loadPolicyIfAny(dir)?.keep.terms ?? [];
}
