// Strict validator for the spec and the corpus profile.
//
// It interprets the small JSON Schema subset that schema/*.json use, so the schema
// files stay the single source of truth with no runtime dependency. Any keyword
// outside that subset throws: a schema the validator cannot fully enforce must
// never silently pass documents. Every object in both schemas sets
// `additionalProperties: false`, so unknown fields are rejected everywhere.

import profileSchema from "../schema/profile.schema.json" with { type: "json" };
import specSchema from "../schema/spec.schema.json" with { type: "json" };
import { maskValue } from "./mask.ts";
import type { Profile, Spec } from "./schema.ts";

export interface SchemaIssue {
  /** Where the problem is, e.g. `$.columns[2].class`. */
  path: string;
  message: string;
  /**
   * Strings from the checked document that `message` quotes (with `got` or `show`), which may be
   * values. Every issue that quotes a document string must list it here, or SchemaError.masked
   * prints it whole.
   */
  values?: string[];
}

export type Validation<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

export class SchemaError extends Error {
  constructor(
    readonly kind: "spec" | "profile",
    readonly source: string,
    readonly issues: SchemaIssue[],
  ) {
    const lines = issues.map((i) => `  ${i.path}: ${i.message}`);
    super(`${source}: invalid ${kind}\n${lines.join("\n")}\nSee docs/spec.md for every field.`);
    this.name = "SchemaError";
  }

  /**
   * The message with the document's strings masked unless `showValues`: the values an issue quotes and
   * the object keys a path names in brackets (a key that is a header or a name). Schema constants
   * ("must be one of ...") and file paths print as they are.
   */
  masked(showValues: boolean): string {
    if (showValues) return this.message;
    return `${this.source}: invalid ${this.kind}\n${issueLines(this.issues, false)}\nSee docs/spec.md for every field.`;
  }
}

/**
 * The issues as indented `path: message` lines, with the document's strings masked unless
 * `showValues`, by SchemaError.masked's rules. For a report that prints issues without a SchemaError.
 */
export function issueLines(issues: readonly SchemaIssue[], showValues: boolean): string {
  return issues
    .map((i) => {
      if (showValues) return `  ${i.path}: ${i.message}`;
      let message = i.message;
      for (const v of i.values ?? []) {
        for (const quoted of [show(v), got(v)]) message = message.split(quoted).join(maskValue(v));
      }
      return `  ${maskPathKeys(i.path)}: ${message}`;
    })
    .join("\n");
}

export type Schema = { readonly [keyword: string]: unknown };

const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description"]);
const KEYWORDS = new Set([
  "$ref", "type", "const", "enum", "properties", "required", "additionalProperties", "items",
  "oneOf", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "uniqueItems",
]);

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : Number.isFinite(v) ? "number" : "non-finite";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
}

function keyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(key) ? `${path}.${key}` : `${path}[${got(key)}]`;
}

function show(v: unknown): string {
  return JSON.stringify(v);
}

// Describes an offending value without echoing more than a short prefix of it:
// rejected input may be document text, and error messages end up in terminals and logs.
function got(v: unknown): string {
  if (typeof v === "string") {
    const cps = [...v];
    return cps.length > 24 ? `${JSON.stringify(cps.slice(0, 24).join(""))}… (${cps.length} characters)` : JSON.stringify(v);
  }
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  return typeOf(v);
}

/** The strings among `vs`, for SchemaIssue.values. */
function strings(...vs: unknown[]): { values?: string[] } {
  const values = vs.filter((v): v is string => typeof v === "string");
  return values.length > 0 ? { values } : {};
}

/** `path` with each bracketed key (keyPath's `["..."]`, possibly cut short by got) masked. */
function maskPathKeys(path: string): string {
  return path.replace(/\[("(?:[^"\\]|\\.)*")(?:… \((\d+) characters\))?\]/g, (_m, quoted: string, total?: string) => {
    const key = JSON.parse(quoted) as string;
    if (total === undefined) return `[${maskValue(key)}]`;
    return `[${maskValue(key).replace(/\d+$/, total)}]`;
  });
}

function resolve(root: Schema, schema: Schema): Schema {
  const ref = schema.$ref;
  if (ref === undefined) return schema;
  const m = typeof ref === "string" ? /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref) : null;
  const defs = root.$defs;
  const name = m?.[1];
  if (name === undefined || !isObject(defs) || !own(defs, name) || !isObject(defs[name])) {
    throw new Error(`schema: unresolvable $ref ${show(ref)}`);
  }
  return resolve(root, defs[name]);
}

function check(root: Schema, node: Schema, value: unknown, path: string, out: SchemaIssue[]): void {
  for (const k of Object.keys(node)) {
    if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`schema: unsupported keyword ${show(k)} at ${path}`);
  }
  if (own(node, "$ref")) {
    if (Object.keys(node).some((k) => k !== "$ref" && !ANNOTATIONS.has(k))) {
      throw new Error(`schema: $ref must stand alone at ${path}`);
    }
    check(root, resolve(root, node), value, path, out);
    return;
  }

  if (own(node, "const") && value !== node.const) {
    out.push({ path, message: `must be ${show(node.const)}, got ${got(value)}`, ...strings(value) });
    return;
  }
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    out.push({ path, message: `must be one of ${node.enum.map(show).join(", ")}, got ${got(value)}`, ...strings(value) });
    return;
  }
  if (node.type !== undefined) {
    const types = (Array.isArray(node.type) ? node.type : [node.type]) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      out.push({ path, message: `must be ${types.join(" or ")}, got ${typeOf(value)}` });
      return;
    }
  }

  if (typeof value === "string") {
    // Lengths count code points, as JSON Schema does.
    const len = [...value].length;
    if (typeof node.minLength === "number" && len < node.minLength) {
      out.push({ path, message: node.minLength === 1 ? "must not be empty" : `must be at least ${node.minLength} characters` });
    }
    if (typeof node.maxLength === "number" && len > node.maxLength) {
      out.push({ path, message: `must be at most ${node.maxLength} characters, got ${len}` });
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      out.push({ path, message: `must be >= ${node.minimum}, got ${value}` });
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      out.push({ path, message: `must be <= ${node.maximum}, got ${value}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      out.push({ path, message: `must have at least ${node.minItems} items, got ${value.length}` });
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      out.push({ path, message: `must have at most ${node.maxItems} items, got ${value.length}` });
    }
    if (node.uniqueItems === true) {
      const seen = new Set<string>();
      value.forEach((item, i) => {
        const key = show(item);
        if (seen.has(key)) out.push({ path: `${path}[${i}]`, message: `duplicate item ${got(item)}`, ...strings(item) });
        seen.add(key);
      });
    }
    if (isObject(node.items)) {
      const items = node.items;
      value.forEach((item, i) => check(root, items, item, `${path}[${i}]`, out));
    }
  }

  if (isObject(value)) {
    const props = isObject(node.properties) ? node.properties : {};
    if (Array.isArray(node.required)) {
      for (const k of node.required as string[]) {
        if (!own(value, k)) out.push({ path: keyPath(path, k), message: "is required" });
      }
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      throw new Error(`schema: only additionalProperties: false is supported at ${path}`);
    }
    for (const k of Object.keys(value).sort()) {
      const sub = own(props, k) ? props[k] : undefined;
      if (isObject(sub)) check(root, sub, value[k], keyPath(path, k), out);
      else if (node.additionalProperties === false) out.push({ path: keyPath(path, k), message: "unknown field" });
    }
  }

  if (Array.isArray(node.oneOf)) {
    const branches = node.oneOf as Schema[];
    const passing = branches.filter((b) => {
      const scratch: SchemaIssue[] = [];
      check(root, b, value, path, scratch);
      return scratch.length === 0;
    }).length;
    if (passing !== 1) {
      const keys = branches.map((b) => (Array.isArray(b.required) && Object.keys(b).length === 1 ? b.required : null));
      if (keys.every((k) => k !== null && k.length === 1)) {
        const names = keys.map((k) => k?.[0]).join(", ");
        out.push({ path, message: passing === 0 ? `must have one of: ${names}` : `must have only one of: ${names}` });
      } else {
        out.push({ path, message: `must match exactly one allowed shape, matched ${passing}` });
      }
    }
  }
}

/**
 * Checks a JSON value against any schema written in the supported subset (the same
 * subset schema/*.json use). Throws on a keyword the validator cannot enforce.
 */
export function validateSchema(schema: Schema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, schema, value, "$", issues);
  return issues;
}

function locationKey(loc: { file: string; sheet?: string; header?: string; jsonPath?: string }): string {
  return show([loc.file, loc.sheet ?? null, loc.header ?? null, loc.jsonPath ?? null]);
}

/** Checks a JSON value against schema/spec.schema.json plus the rules a schema cannot state. */
export function validateSpec(value: unknown): Validation<Spec> {
  const issues = validateSchema(specSchema, value);
  if (issues.length > 0) return { ok: false, issues };
  const spec = value as Spec;

  const targets = new Map<string, number>();
  spec.columns.forEach((c, i) => {
    // Fail closed: "unknown" means nobody decided, so it may never pass through unchanged.
    if (c.class === "unknown" && c.treatment === "keep") {
      issues.push({
        path: `$.columns[${i}].treatment`,
        message: `class "unknown" cannot use treatment "keep"; use "value" or "blind", or classify the column (e.g. "vocabulary") to keep it`,
      });
    }
    const key = locationKey(c);
    const first = targets.get(key);
    if (first !== undefined) {
      issues.push({ path: `$.columns[${i}]`, message: `same column as $.columns[${first}]; keep one rule per column` });
    } else targets.set(key, i);
  });

  const ids = new Map<string, number>();
  spec.questions.forEach((q, i) => {
    const first = ids.get(q.id);
    if (first !== undefined) issues.push({ path: `$.questions[${i}].id`, message: `duplicate id ${got(q.id)} (also $.questions[${first}])`, ...strings(q.id) });
    else ids.set(q.id, i);
    if (q.answer !== null && !q.options.includes(q.answer)) {
      issues.push({ path: `$.questions[${i}].answer`, message: `must be null or one of ${q.options.map(show).join(", ")}, got ${got(q.answer)}`, ...strings(q.answer, ...q.options) });
    }
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: spec };
}

/** Checks a JSON value against schema/profile.schema.json plus file references and the sample-count limit. */
export function validateProfile(value: unknown): Validation<Profile> {
  const issues = validateSchema(profileSchema, value);
  if (issues.length > 0) return { ok: false, issues };
  const profile = value as Profile;
  const k = profile.sampleCount;

  const listed = new Set<string>();
  profile.files.forEach((f, i) => {
    if (listed.has(f.path)) issues.push({ path: `$.files[${i}].path`, message: `duplicate path ${got(f.path)}` });
    listed.add(f.path);
  });
  const known = (file: string, path: string) => {
    if (!listed.has(file)) issues.push({ path, message: `${got(file)} is not listed in $.files` });
  };
  profile.tables.forEach((t, i) => known(t.file, `$.tables[${i}].file`));
  profile.jsonKeys.forEach((j, i) => known(j.file, `$.jsonKeys[${i}].file`));
  profile.documents.forEach((d, i) => known(d.file, `$.documents[${i}].file`));
  profile.transcripts.forEach((t, i) => known(t.file, `$.transcripts[${i}].file`));
  profile.cooccurrence.forEach((c, i) => {
    known(c.a.file, `$.cooccurrence[${i}].a.file`);
    known(c.b.file, `$.cooccurrence[${i}].b.file`);
  });

  const limit = (list: string[], path: string) => {
    if (list.length > k) issues.push({ path, message: `must have at most sampleCount (${k}) items, got ${list.length}` });
  };
  profile.tables.forEach((t, i) =>
    t.columns.forEach((c, j) => limit(c.stats.samples, `$.tables[${i}].columns[${j}].stats.samples`)),
  );
  profile.jsonKeys.forEach((j, i) => limit(j.stats.samples, `$.jsonKeys[${i}].stats.samples`));
  profile.documents.forEach((d, i) => limit(d.sampleSentences, `$.documents[${i}].sampleSentences`));
  profile.transcripts.forEach((t, i) => limit(t.sampleLines, `$.transcripts[${i}].sampleLines`));

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: profile };
}

function parse<T>(kind: "spec" | "profile", text: string, source: string, validate: (v: unknown) => Validation<T>): T {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const message = (err as Error).message;
    // The parser quotes the token it stopped at, which may be document text.
    const quoted = [...message.matchAll(/"(?:[^"\\]|\\.)*"/g)].flatMap((m) => {
      try {
        return [JSON.parse(m[0]) as string];
      } catch {
        return [];
      }
    });
    throw new SchemaError(kind, source, [{ path: "$", message: `not valid JSON (${message})`, ...strings(...quoted) }]);
  }
  const result = validate(data);
  if (!result.ok) throw new SchemaError(kind, source, result.issues);
  return result.value;
}

/** Parses and validates spec JSON text. Throws SchemaError listing every issue with its path. */
export function parseSpec(text: string, source = "spec"): Spec {
  return parse("spec", text, source, validateSpec);
}

/** Parses and validates profile JSON text. Throws SchemaError listing every issue with its path. */
export function parseProfile(text: string, source = "profile"): Profile {
  return parse("profile", text, source, validateProfile);
}
