import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMN_TREATMENTS, type ModelConfig, BACKENDS, defaultSamples, PATTERN_HELP, type Policy, POLICY_FILE, POLICY_PATTERNS, PolicyError, policyFromDocument, SENSITIVE_CLASSES } from "./policyrules.ts";

export * from "./policyrules.ts";

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
    "# Textbook placeholder identities in forms and documentation (John Doe, 123 Main St, (999) 999-9999,",
    "# user@example.com) are kept as written, as is every value held in a keep column wherever else it",
    "# appears. placeholders = false blinds the placeholders like any other value.",
    p.keep.placeholders ? "# placeholders = true" : "placeholders = false",
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
    "# Column rules, applied by `blind plan` before the analyst and the heuristic.",
    "# header: header globs (* and ?, any case); a JSON key matches by its last key name. path: optional JSON",
    "# key-path glob over the whole path (owner.dob, users[*].profile.*, **.profile.dob; * within one key, ** across",
    "# keys); JSON keys only. sheet: optional worksheet-name glob; XLSX columns only. file: optional path glob",
    `# (* within a folder, ** across folders). treatment: ${COLUMN_TREATMENTS.join(" | ")}. class: optional.`,
    "# When several rules match a column, the most specific wins, whatever the file order: scoped (path, sheet or",
    "# file) over unscoped, then an exact name over a glob, then fewer wildcards, then more literal text; only a",
    "# full tie goes to the rule written first. `blind plan` notes every column two rules disagree on.",
    "# A column whose header is a [keep] term is kept too, unless a rule here says otherwise.",
    "# keep: as written, except that a value blinded, dropped or redacted elsewhere is replaced where it recurs",
    "# (a name in a kept note); a bare number never recurs into a kept number, amount or date, nor inside any",
    "# longer number. scan: kept as written apart from what the free-text scanner finds (phones, emails, names,",
    "# plates and codes after a keyword): the one for notes, remarks, diagnoses.",
    ...(p.columns.length === 0
      ? [
          "# [[columns]]",
          '# header = ["species", "weight*", "visit date"]',
          '# treatment = "keep"',
          "#",
          "# [[columns]]",
          '# header = ["notes", "remarks", "diagnosis"]',
          '# treatment = "scan"',
          "#",
          "# The pet's date of birth is kept; the owner's is not. The path rule is scoped, so it wins at owner.dob.",
          "# [[columns]]",
          '# header = "dob"',
          '# treatment = "keep"',
          "#",
          "# [[columns]]",
          '# path = "owner.dob"',
          '# treatment = "redact"',
        ]
      : p.columns.flatMap((c, i) => [
          ...(i === 0 ? [] : [""]),
          "[[columns]]",
          ...(c.header === undefined ? [] : [`header = ${list(c.header)}`]),
          ...(c.path === undefined ? [] : [`path = ${str(c.path)}`]),
          ...(c.sheet === undefined ? [] : [`sheet = ${str(c.sheet)}`]),
          ...(c.file === undefined ? [] : [`file = ${str(c.file)}`]),
          `treatment = ${str(c.treatment)}`,
          `class = ${str(c.class)}`,
          ...(c.joinWith === undefined ? [] : [`join_with = ${str(c.joinWith)}`]),
        ])),
    "",
    "[defaults]",
    "# What a column no rule decides gets. fallback: an identifier-like column (mostly distinct codes, names or",
    "# numbers) is pseudonymised whole, the rest scanned as text. scan: every such column is kept and scanned as",
    "# text; only a rule pseudonymises a column whole. Either way a value kept whole in a keep or scan column is",
    "# never pseudonymised whole by the fallback elsewhere.",
    p.defaults.columns === "fallback" ? '# columns = "fallback"' : `columns = ${str(p.defaults.columns)}`,
    "",
    "[images]",
    "# Pictures inside a DOCX or XLSX can hold scanned IDs, faces, signatures and EXIF (GPS, device owner), and blind",
    "# cannot read them. By default each is replaced with a neutral placeholder of the same format. keep = true",
    "# copies them unchanged (the apply report warns and the audit lists them as unscanned).",
    p.images.keep ? "keep = true" : "# keep = false",
    "",
    "[metadata]",
    "# A DOCX or XLSX records when it was created, saved and printed, how long it was edited, when each tracked",
    "# change and comment was made, and zip timestamps. By default blind writes all of these as constants so the",
    "# blinded file cannot be matched to its source by them. keep_dates = true copies them as the original had them.",
    p.metadata.keepDates ? "keep_dates = true" : "# keep_dates = false",
    "",
    "# Blinded names: readable is [Client A #7F3A] (role and letters, easy to read); compact is Person_7F3A;",
    "# letters is Client KQZTB (role and five consonants, no digits).",
    "# Without this table the style is compact.",
    "[pseudonyms]",
    `style = ${str(p.pseudonyms.style)}`,
    "",
  ].join("\n");
}

/** Parse and validate policy TOML. Throws PolicyError naming the offending key and expected type. */
export function parsePolicy(text: string, source = POLICY_FILE): Policy {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (e) {
    throw new PolicyError(`${source}: not valid TOML: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new PolicyError(`${source}: not a TOML table`);
  return policyFromDocument(doc, source);
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
