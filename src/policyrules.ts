// blind.toml's policy as data: its shape, its defaults and the rules that validate it, with no file
// system, no TOML reader and nothing Bun- or Node-only. The CLI (src/policy.ts) parses blind.toml with
// Bun's TOML reader and hands the document to policyFromDocument; the library entry (src/lib.ts) hands it
// a plain object (resolvePolicy in src/libpolicy.ts). Both go through the same rules, so a policy the
// library accepts is one blind.toml could say, and an invalid one fails with the same message.

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
export const PATTERN_HELP: Record<PatternName, string> = {
  ip: "IPv4 and IPv6 addresses",
  email: "email addresses",
  host: "host names",
  guid: "GUIDs",
  mac: "MAC addresses",
  phone: "phone numbers",
  card: "payment card numbers (13-19 digits, a card prefix and a valid checksum), written as REDACTED; follows secret when unset",
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
 * case-insensitive; a JSON key by its last key name) and, when `path` is given, the JSON keys whose
 * full key path matches it, in the files `file` matches and on the worksheets `sheet` matches, get
 * `treatment` and `class`. `blind plan` writes them into the spec ahead of the analyst and the
 * heuristic. When several rules match one column, the most specific wins (see ruleRank in
 * analyst/policycolumns.ts): scoped (`path`, `sheet` or `file`) over unscoped, then exact over glob,
 * then fewer wildcards, then more literal text, then file order.
 */
export interface ColumnPolicyRule {
  /** Header globs. At least one of `header` and `path` is given. */
  header?: string[];
  /** A JSON key-path glob over the whole path (`owner.dob`, `users[*].profile.*`, `**.profile.dob`). JSON keys only. */
  path?: string;
  /** A worksheet-name glob. XLSX columns only. */
  sheet?: string;
  file?: string;
  treatment: Treatment;
  /** Defaults to `vocabulary` for `keep` and to `unknown` for the rest (a `scan` column needs no class). */
  class: EntityClassName;
}

export interface Policy {
  sensitive: { classes: SensitiveClass[]; description: string; examples: string[] };
  keep: {
    terms: string[];
    /** The built-in placeholder allowlist (John Doe, 123 Main St, 999-9999, user@example.com) is kept as written; false turns it off. */
    placeholders: boolean;
  };
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
  /**
   * `[images] keep`: false (the default) replaces each picture inside a DOCX or XLSX with a neutral
   * placeholder of the same format; true copies them unchanged, with a warning and an audit candidate.
   */
  images: { keep: boolean };
  /**
   * `[metadata] keep_dates`: false (the default) writes a DOCX or XLSX's own dates (created, modified,
   * printed, revision and comment dates, edit time, revision count) and its zip timestamps and extra
   * fields as constants; true keeps them as the original had them.
   */
  metadata: { keepDates: boolean };
  /** `[pseudonyms] style`: `readable` writes `[Client A #7F3A]`; `letters` writes `Client KQZTB`; `compact` writes `Person_7F3A`. No table means compact. */
  pseudonyms: { style: PseudonymStyle };
}

export const PSEUDONYM_STYLES = ["readable", "compact", "letters"] as const;
export type PseudonymStyle = (typeof PSEUDONYM_STYLES)[number];

/** The spec with blind.toml's `[patterns]` switches laid over its own: the patterns apply and audit use. */
export function withPolicyPatterns(spec: Spec, patterns: PolicyPatterns): Spec {
  const set = POLICY_PATTERNS.filter((name) => patterns[name] !== undefined && patterns[name] !== spec.patterns[name]);
  if (set.length === 0) return spec;
  return { ...spec, patterns: { ...spec.patterns, ...Object.fromEntries(set.map((name) => [name, patterns[name]])) } };
}

/**
 * Samples per column when blind.toml does not set `[profile] samples`: 5 while nothing leaves the
 * machine, 0 under profile-only, where the profile goes to a remote model that may see statistics
 * but never a value. It is also the only count profile-only accepts (policyFromDocument refuses more).
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
    keep: { terms: [], placeholders: true },
    models: { analyst: local(), auditor: local(), auditorExplicit: true },
    profile: { samples: defaultSamples("local-only"), samplesExplicit: false },
    privacy: { mode: "local-only" },
    // IPs, host names and secrets are found in free text even when their class is not listed.
    patterns: { ip: true, host: true, secret: true },
    columns: [],
    context: { enabled: true, triggers: [] },
    defaults: { columns: "fallback" },
    images: { keep: false },
    metadata: { keepDates: false },
    pseudonyms: { style: "readable" },
  };
}

const str = (s: string): string => JSON.stringify(s);

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

const COLUMN_RULE_KEYS = ["header", "path", "sheet", "file", "treatment", "class"] as const;

function readColumns(r: Reader, doc: Table, source: string): ColumnPolicyRule[] {
  const v = doc.columns;
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isTable)) r.fail("columns", "an array of tables ([[columns]])", v);
  return (v as Table[]).map((t, i): ColumnPolicyRule => {
    const path = `columns[${i}]`;
    r.noExtra(t, path, COLUMN_RULE_KEYS);
    const glob = (key: "path" | "sheet" | "file"): string | undefined => {
      if (t[key] === undefined) return undefined;
      const g = r.string(t, key, `${path}.${key}`);
      if (g.trim() === "") r.fail(`${path}.${key}`, "a non-empty glob", g);
      return g;
    };
    const keyPath = glob("path");
    const sheet = glob("sheet");
    const file = glob("file");
    let header: string[] | undefined;
    // A rule names columns by header, JSON keys by path, or both.
    if (t.header === undefined && keyPath === undefined) r.fail(`${path}.header`, "set (a rule needs header, path or both)", undefined);
    if (t.header !== undefined) {
      const raw = t.header;
      header = typeof raw === "string" ? [raw] : r.strings(t, "header", `${path}.header`);
      if (header.length === 0 || header.some((h) => h.trim() === "")) r.fail(`${path}.header`, "a non-empty glob or array of non-empty globs", raw);
    }
    // A path names JSON keys and a sheet names worksheet columns: a rule with both could match nothing.
    if (keyPath !== undefined && sheet !== undefined) {
      throw new PolicyError(`${source}: ${path}: path (JSON keys) and sheet (worksheet columns) cannot both be set; a rule with both matches nothing`);
    }
    const treatment = r.oneOf(t, "treatment", `${path}.treatment`, COLUMN_TREATMENTS);
    const cls = t.class === undefined ? (treatment === "keep" ? "vocabulary" : "unknown") : r.oneOf(t, "class", `${path}.class`, COLUMN_CLASSES);
    // The spec's fail-closed rule: nobody decided an `unknown` column, so it may not pass through.
    if (cls === "unknown" && treatment === "keep") {
      throw new PolicyError(`${source}: ${path}: class "unknown" cannot use treatment "keep"; leave class out or name one (e.g. "vocabulary")`);
    }
    const rule: ColumnPolicyRule = { treatment, class: cls };
    if (header !== undefined) rule.header = header;
    if (keyPath !== undefined) rule.path = keyPath;
    if (sheet !== undefined) rule.sheet = sheet;
    if (file !== undefined) rule.file = file;
    return rule;
  });
}

/**
 * Validates a policy document (blind.toml's tables, as Bun's TOML reader returns them) and fills in
 * what it leaves out. Throws PolicyError naming the offending key and expected type, prefixed with
 * `source`.
 */
export function policyFromDocument(doc: unknown, source = POLICY_FILE): Policy {
  if (!isTable(doc)) throw new PolicyError(`${source}: not a table`);
  const r = new Reader(source);
  r.noExtra(doc, "", ["sensitive", "keep", "models", "profile", "privacy", "patterns", "columns", "context", "defaults", "images", "metadata", "pseudonyms"]);

  const sensitive = r.table(doc, "sensitive", "sensitive", ["classes", "description", "examples"]);
  const classes = r.strings(sensitive, "classes", "sensitive.classes");
  const bad = classes.find((c) => !(SENSITIVE_CLASSES as readonly string[]).includes(c));
  if (bad !== undefined) {
    throw new PolicyError(
      `${source}: sensitive.classes must contain only ${SENSITIVE_CLASSES.map(str).join(", ")} (got ${str(bad)})`,
    );
  }

  const keep = r.table(doc, "keep", "keep", ["terms", "placeholders"]);
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
    keep: { terms: r.strings(keep, "terms", "keep.terms"), placeholders: keep.placeholders === undefined ? true : r.boolean(keep, "placeholders", "keep.placeholders") },
    models: readModels(r, models),
    profile: { samples, samplesExplicit },
    privacy: { mode },
    patterns,
    columns: readColumns(r, doc, source),
    context: readContext(r, doc),
    defaults: readDefaults(r, doc),
    images: readImages(r, doc),
    metadata: readMetadata(r, doc),
    pseudonyms: readPseudonyms(r, doc),
  };
}

/** `[pseudonyms]` is optional, and so is its one key. Without the table the style is compact (existing output). */
function readPseudonyms(r: Reader, doc: Table): Policy["pseudonyms"] {
  if (doc.pseudonyms === undefined) return { style: "compact" };
  const t = r.table(doc, "pseudonyms", "pseudonyms", ["style"]);
  return { style: t.style === undefined ? "compact" : r.oneOf(t, "style", "pseudonyms.style", PSEUDONYM_STYLES) };
}

/** `[images]` is optional, and so is its one key. */
function readImages(r: Reader, doc: Table): Policy["images"] {
  if (doc.images === undefined) return { keep: false };
  const t = r.table(doc, "images", "images", ["keep"]);
  return { keep: t.keep === undefined ? false : r.boolean(t, "keep", "images.keep") };
}

/** `[metadata]` is optional, and so is its one key. */
function readMetadata(r: Reader, doc: Table): Policy["metadata"] {
  if (doc.metadata === undefined) return { keepDates: false };
  const t = r.table(doc, "metadata", "metadata", ["keep_dates"]);
  return { keepDates: t.keep_dates === undefined ? false : r.boolean(t, "keep_dates", "metadata.keep_dates") };
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


/**
 * Validates a policy given as a plain object (the library entry's BlindPolicy: blind.toml's tables, with
 * `keepDates` for `[metadata] keep_dates`) by the same rules as a parsed blind.toml (policyFromDocument),
 * and fills in what it leaves out. Every table is optional here: a table blind.toml requires and the
 * object leaves out gets what `blind init` writes (`[sensitive]` lists every class, `[keep]` keeps no
 * term, `[privacy] mode` is local-only, the samples follow the mode); within `[sensitive]` and `[keep]`
 * a key left out gets the same. Throws PolicyError naming the offending field, prefixed with `source`.
 */
export function policyFromObject(policy: unknown, source = "policy"): Policy {
  if (policy === undefined) policy = {};
  if (!isTable(policy)) throw new PolicyError(`${source}: must be an object (got ${typeName(policy)})`);
  const d = defaultPolicy();
  const doc: Table = { ...policy };
  // A table left out gets the base; a table given gets the base under it. Anything else is left for the rules to refuse.
  const fill = (key: string, base: Table): void => {
    const v = doc[key];
    if (v === undefined) doc[key] = base;
    else if (isTable(v)) doc[key] = { ...base, ...v };
  };
  fill("sensitive", { classes: [...d.sensitive.classes], description: d.sensitive.description, examples: [...d.sensitive.examples] });
  fill("keep", { terms: [] });
  fill("models", { analyst: { ...d.models.analyst } });
  fill("profile", {});
  fill("privacy", { mode: d.privacy.mode });
  const metadata = doc.metadata;
  if (isTable(metadata)) {
    if (metadata.keep_dates !== undefined) throw new PolicyError(`${source}: unknown key metadata.keep_dates (expected one of: keepDates)`);
    const { keepDates, ...rest } = metadata;
    doc.metadata = keepDates === undefined ? rest : { ...rest, keep_dates: keepDates };
  }
  try {
    return policyFromDocument(doc, source);
  } catch (e) {
    // The rules name blind.toml's key; the object spells it keepDates (a literal keep_dates was refused above).
    if (!(e instanceof PolicyError) || !isTable(metadata)) throw e;
    throw new PolicyError(e.message.replace("metadata.keep_dates", "metadata.keepDates").replace("(expected one of: keep_dates)", "(expected one of: keepDates)"));
  }
}
