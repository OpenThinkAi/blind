import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The policy file `blind init` writes and every later command reads. */
export const POLICY_FILE = "blind.toml";

export const SENSITIVE_CLASSES = ["person", "org", "host", "email", "id", "location"] as const;
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
}

/**
 * Samples per column when blind.toml does not set `[profile] samples`: 5 while nothing leaves the
 * machine, 0 (headers and statistics only) under profile-only, where the profile goes to a remote model.
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
    "# Sample values per column the analyst sees (each truncated to 120 characters). 0 = headers and stats only.",
    `# Unset, it is ${defaultSamples("local-only")} under local-only and none, and ${defaultSamples("profile-only")} under profile-only. Set it to override.`,
    // Written out when set, or when it differs from the mode's default (so it is never silently changed).
    p.profile.samplesExplicit || p.profile.samples !== defaultSamples(p.privacy.mode)
      ? `samples = ${p.profile.samples}`
      : `# samples = ${p.profile.samples}`,
    "",
    "[privacy]",
    "# local-only: refuse any non-loopback endpoint. profile-only: remote allowed, only the profile is sent.",
    "# none: no model is called.",
    `mode = ${str(p.privacy.mode)}`,
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
  r.noExtra(doc, "", ["sensitive", "keep", "models", "profile", "privacy"]);

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
  };
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

/**
 * The keep-list terms of `dir`'s blind.toml, for apply and audit. Without a blind.toml nothing is
 * kept, the more private reading; a blind.toml that does not parse is a PolicyError.
 */
export function loadKeepTerms(dir = "."): string[] {
  return existsSync(join(dir, POLICY_FILE)) ? loadPolicy(dir).keep.terms : [];
}
