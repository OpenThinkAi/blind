// The library entry: blind's engine as functions over bytes held in memory, for
// code that would otherwise launch the CLI (a web SDK, blindbox). Same engine,
// same stand-ins, same map and reveal as `blind apply` and `blind reveal`: for
// the same salt, spec, policy and input, applySpec here writes the bytes and the
// map the CLI writes (D-2, D-3, D-24).
//
// Nothing here touches the file system, the process or a terminal. Where the CLI
// reads `.blind/salt`, `.blind/spec.json`, `.blind/map.json` and `blind.toml`,
// the caller passes the salt (newSalt() makes one), the spec (an object, or
// parseSpec(text)), the map (parseMap(text)) and the policy (a plain object
// shaped like blind.toml's tables). The map comes back as an object;
// serializeMap(map) is the text the CLI writes to map.json.
//
// Planning: profileInputs(inputs, { policy }) is the profile `blind plan` builds, and
// proposeSpec(profile, policy) the spec `blind plan --no-model` writes (explainProposal adds, per column, who
// decided it and why, as the plan's notes say), from bytes and a policy object
// validated by blind.toml's own rules. No model is ever called from here.
//
// Audit: auditOutputs(files, spec, map, { policy, salt }) is the report `blind audit --no-model --json`
// prints for the same blinded files: the mechanical and semantic layers. The model layer is CLI-only.
//
// Office files (DOCX, XLSX): the zip codec is injected (src/formats/zipcodec.ts),
// and this entry installs none, so it never imports a compression library. With
// no codec an Office input is skipped by applySpec, and refused by revealFile,
// with NO_ZIP_CODEC_REASON, and every other format works. src/browser.ts is this
// entry for a browser. A Node or Bun caller that wants Office support installs Node's
// codec once, with the CLI's settings (level 6), so the bytes match the CLI's:
//
//   import { deflateRawSync, inflateRawSync } from "node:zlib";
//   setZipCodec({
//     inflateRaw: (data, maxOutputLength) => inflateRawSync(data, { maxOutputLength }),
//     deflateRaw: (data) => deflateRawSync(data, { level: 6 }),
//   });

import { heuristicSpec, locationKey, profileLocations } from "./analyst/heuristic.ts";
import type { AuditReport } from "./audit/mechanical.ts";
import { auditRules, memoryTree } from "./audit/rules.ts";
import { applyColumnPolicy, ColumnPolicy } from "./analyst/policycolumns.ts";
import { baseReason, columnNotes, overlayNotes } from "./analyst/reasons.ts";
import { applySpec as engineApply, type ApplyOptions, type ApplyResult, type InputFile } from "./engine/apply.ts";
import type { ColumnDefault } from "./engine/columns.ts";
import type { ContextTriggerSpec } from "./engine/context.ts";
import type { BlindMap } from "./engine/map.ts";
import { Revealer } from "./engine/reveal.ts";
import { type PrivacyMode, defaultSamples, policyFromObject, type SensitiveClass, withPolicyPatterns } from "./policyrules.ts";
import { byCodeUnit, forPrivacyMode, InputError, profileSources, type ProfileResult } from "./profile/inputs.ts";
import type { ColumnRule, EntityClassName, PatternName, Profile, Spec, Treatment } from "./schema.ts";
import { SchemaError, validateProfile, validateSpec } from "./validate.ts";

export { ApplyError, engineFormat } from "./engine/apply.ts";
export type { ApplyResult, ColumnOutcome, ColumnReport, EngineFormat, FileReport, HeaderCellReplaced, InputFile, SkippedFile, TranscriptReport } from "./engine/apply.ts";
export { MapError, parseMap, serializeMap, type BlindMap, type MapEntry, type MapKind } from "./engine/map.ts";
export { RevealError, revealFile, Revealer, type Revealed, type RevealedFile } from "./engine/reveal.ts";
export { MIN_SALT_BYTES, PseudonymError } from "./engine/pseudonym.ts";
export { NameError } from "./engine/names.ts";
export { NO_ZIP_CODEC_REASON, setZipCodec, type ZipCodec, zipCodec } from "./formats/zipcodec.ts";
export { parseProfile, parseSpec, SchemaError, validateProfile, validateSpec } from "./validate.ts";
export { PolicyError, type PrivacyMode, type SensitiveClass } from "./policyrules.ts";
export { InputError, type ProfileResult, type Skipped } from "./profile/inputs.ts";
export type { Profile, Spec } from "./schema.ts";
export type { AuditReport, FileAudit, Finding, ModelLayerStatus, Severity, Status } from "./audit/mechanical.ts";

/** Bytes in a salt from newSalt(): the size `blind init` writes to `.blind/salt`. */
export const SALT_BYTES = 32;

/** A fresh salt: 32 random bytes, the same kind of value `blind init` writes to `.blind/salt`, from the platform's CSPRNG. */
export function newSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** The blinded-name shape (blind.toml `[pseudonyms] style`): whatever styles the engine accepts. */
export type PseudonymStyle = NonNullable<ApplyOptions["pseudonymStyle"]>;

/**
 * A `[[columns]]` rule, as blind.toml writes it: the columns whose header matches one of `header` (globs,
 * any case; a JSON key by its last key name) and, with `path`, the JSON keys whose whole key path
 * matches it, in the files `file` matches and on the worksheets `sheet` matches, get `treatment` and
 * `class`. At least one of `header` and `path`; `path` and `sheet` not both. `class` defaults to
 * `vocabulary` for keep and `unknown` for the rest. The most specific matching rule wins (src/policy.ts).
 */
export interface ColumnRuleInput {
  header?: string | readonly string[];
  path?: string;
  sheet?: string;
  file?: string;
  treatment: Treatment;
  class?: EntityClassName;
}

/**
 * The settings the CLI reads from blind.toml, as a plain object with the same tables and keys
 * (camelCase where the TOML key has an underscore: `keepDates`). Every part is optional. applySpec
 * reads the apply-time tables, and a part left out gets what blind.toml gives it when the table is
 * absent. profileInputs and proposeSpec validate the whole object by blind.toml's own rules (an unknown
 * key, a wrong type or value, a rule with neither header nor path: PolicyError naming the field), and
 * a table blind.toml requires but the object leaves out gets what `blind init` writes. No model is
 * called by the library, so `[models]` has no part here.
 */
export interface BlindPolicy {
  /** `[sensitive]`: the classes to blind (every class when unset); the heuristic proposes a column shape or speaker only for a listed class, or a pattern switched on. */
  sensitive?: { classes?: readonly SensitiveClass[]; description?: string; examples?: readonly string[] };
  /** `[[columns]]`, in file order: rules that decide their columns ahead of the heuristic. */
  columns?: readonly ColumnRuleInput[];
  /** `[profile] samples`: sample values per column the profile carries; 5 unless privacy.mode is profile-only (then 0). */
  profile?: { samples?: number };
  /** `[privacy] mode`: profile-only empties every sample, outline and speaker list from the profile. local-only when unset. */
  privacy?: { mode?: PrivacyMode };
  /** `[pseudonyms] style`; compact when unset. */
  pseudonyms?: { style?: PseudonymStyle };
  /** `[patterns]`: switches that win over the spec's `patterns`; an unset one follows the spec. */
  patterns?: Partial<Record<PatternName, boolean>>;
  /** `[defaults] columns`: what a column with no rule gets, `fallback` (the default) or `scan`. */
  defaults?: { columns?: ColumnDefault };
  /** `[keep]`: terms kept as written (domain-shaped terms keep the hosts under them), and the textbook placeholder allowlist (on unless false). */
  keep?: { terms?: readonly string[]; placeholders?: boolean };
  /** `[context]`: the value after "gate code", "password" and the like written as REDACTED; on unless `enabled` is false; `triggers` adds words. */
  context?: { enabled?: boolean; triggers?: readonly ContextTriggerSpec[] };
  /** `[images] keep`: false (the default) replaces pictures in DOCX and XLSX with a neutral placeholder. */
  images?: { keep?: boolean };
  /** `[metadata] keep_dates`: false (the default) writes Office document dates and zip timestamps as constants. */
  metadata?: { keepDates?: boolean };
}

export interface BlindOptions {
  /** At least MIN_SALT_BYTES bytes; newSalt() makes one. The same salt gives the same stand-ins. */
  salt: Uint8Array;
  /** An earlier map (parseMap): its pseudonyms are reused verbatim, as `blind apply` reuses `.blind/map.json`. */
  map?: BlindMap;
  /** What blind.toml would say. Left out, the result is the CLI's with no blind.toml. */
  policy?: BlindPolicy;
}

/**
 * Blinds `inputs` (each a "/"-separated path and its bytes) with `spec`, in memory. The result holds
 * the blinded files (`outputs`, under their blinded paths), the map to keep (`map`), a report per
 * file and every input not written (`skipped`, with the reason). Throws where `blind apply` refuses:
 * ApplyError (a spec rule that does not fit the input), MapError, PseudonymError (a salt too short, or
 * too many values of one stand-in shape, such as IPv4 addresses: the message names the file and the
 * column header or key path, quoted, and the value's shape, never the value) or NameError. `spec` is not validated here; parseSpec or validateSpec checks one first.
 */
export function applySpec(inputs: readonly InputFile[], spec: Spec, options: BlindOptions): ApplyResult {
  const p = options.policy ?? {};
  const opts: ApplyOptions = {
    salt: options.salt,
    map: options.map,
    keep: p.keep?.terms ?? [],
    placeholders: p.keep?.placeholders ?? true,
    pseudonymStyle: p.pseudonyms?.style ?? "compact",
  };
  if (p.context !== undefined) opts.context = { enabled: p.context.enabled ?? true, triggers: p.context.triggers ?? [] };
  if (p.defaults?.columns !== undefined) opts.columns = p.defaults.columns;
  if (p.images?.keep !== undefined) opts.images = p.images.keep ? "keep" : "replace";
  if (p.metadata?.keepDates !== undefined) opts.dates = p.metadata.keepDates ? "keep" : "scrub";
  // The policy's pattern switches over the spec's own, as `blind apply` does.
  return engineApply(inputs, withPolicyPatterns(spec, p.patterns ?? {}), opts);
}

/** `text` with every pseudonym `map` records replaced with its original value. */
export function revealText(text: string, map: BlindMap): string {
  return new Revealer(map).text(text).text;
}

export interface ProfileOptions {
  /** Sample values per column, key, document and transcript (at most MAX_SAMPLES). Unset, the policy's `[profile] samples`, or 5 with no policy. */
  samples?: number;
  /** What blind.toml would say (validated as proposeSpec validates it): its samples count and privacy mode, as `blind plan` uses them. */
  policy?: BlindPolicy;
}

/**
 * The corpus profile of `inputs` (each a "/"-separated path and its bytes), in memory: what `blind plan`
 * builds from the same files on disk before it proposes a spec, by the same code. The result holds the
 * profile (statistics, sample values and detector rates per table column, JSON key, document and
 * transcript), every input left out with the reason (`skipped`: an unsupported type, bytes that do not
 * decode or parse) and notes. Inputs are profiled in path order. Office files need a zip codec
 * (setZipCodec); without one a DOCX or XLSX is skipped. Throws InputError when two inputs share a path,
 * and PolicyError for an invalid policy.
 */
export function profileInputs(inputs: readonly InputFile[], options: ProfileOptions = {}): ProfileResult {
  const policy = options.policy === undefined ? undefined : policyFromObject(options.policy);
  const samples = options.samples ?? policy?.profile.samples ?? defaultSamples("local-only");
  if (!Number.isInteger(samples) || samples < 0) throw new RangeError(`samples must be a non-negative integer (got ${samples})`);
  const sorted = [...inputs].sort((a, b) => byCodeUnit(a.path, b.path));
  sorted.forEach((f, i) => {
    if (i > 0 && sorted[i - 1]?.path === f.path) throw new InputError(`two inputs have the same path ${JSON.stringify(f.path)}`);
  });
  const result = profileSources(sorted.map((f) => ({ path: f.path, read: () => f.bytes })), samples);
  return policy === undefined ? result : forPrivacyMode(result, policy.privacy.mode);
}

/**
 * The spec `blind plan --no-model` proposes for `profile` under `policy`, with no model call: the
 * built-in detectors decide a column only when one shape matches most of its values (everything else
 * is `unknown`, decided at apply time, fail closed), transcript speakers become people when the policy
 * lists people, and then blind.toml's column rules (`columns`, and headers that are `keep.terms`) decide
 * the columns they match. For the same files and policy it is the spec the CLI writes to
 * `.blind/spec.json` in a workspace with no saved spec. Each column rule says where it came from
 * (`source`: heuristic or policy). Throws PolicyError for an invalid policy and SchemaError for a
 * profile that is not one.
 */
export function proposeSpec(profile: Profile, policy: BlindPolicy = {}): Spec {
  return explainProposal(profile, policy).spec;
}

/** One table column or JSON key in a proposal: where it is, what is proposed for it, who decided and why. */
export interface ProposalEntry {
  /** The input's "/"-separated path. */
  file: string;
  /** The worksheet, for a workbook column. */
  sheet?: string;
  /** The column header, for a table column. */
  header?: string;
  /** The key path (`$.owner.phone`), for a JSON key. */
  jsonPath?: string;
  class: EntityClassName;
  treatment: Treatment;
  /** `policy`: a blind.toml column rule (or a header that is a keep term) decided it; `heuristic`: the built-in detectors did, or nothing did and it is decided at apply time. */
  source: "heuristic" | "policy";
  /**
   * Why, in plain English. Where `blind plan --no-model` prints a note about the column (rules that overlap
   * on it, a birth-date header, a policy pattern, a column shape), this is that note's text after the
   * location, several joined with "; ". Otherwise: the blind.toml rule that decided it, the detector that
   * classified it and its rate, or that nothing decides it until apply time. Names, globs, classes and
   * rates only, never a sample value.
   */
  reason: string;
}

export interface Proposal {
  /** The spec, exactly what proposeSpec returns. */
  spec: Spec;
  /** Every table column and JSON key the profile describes, in profile order. */
  columns: ProposalEntry[];
  /** `blind plan`'s notes about the plan as a whole, same text: how many columns blind.toml decided, and keep rules that decide nothing (`warning: ...`). */
  notes: string[];
}

/**
 * proposeSpec with the reasons: the spec, and for every table column and JSON key what is proposed, whether a
 * policy rule or a detector decided it, and why (the note `blind plan --no-model` prints beside it, where it
 * prints one). No model call. Throws as proposeSpec does.
 */
export function explainProposal(profile: Profile, policy: BlindPolicy = {}): Proposal {
  const p = policyFromObject(policy);
  const checked = validateProfile(profile);
  if (!checked.ok) throw new SchemaError("profile", "profile", checked.issues);
  const overlay = applyColumnPolicy(heuristicSpec(profile, p), profile, p);
  const spec = overlay.spec;
  const result = validateSpec(spec);
  if (!result.ok) throw new SchemaError("spec", "proposed spec", result.issues);
  const notesOf = overlayNotes(overlay);
  const byLoc = new Map<string, string[]>();
  for (const n of [...notesOf.overlaps, ...columnNotes(spec, profile, p)]) {
    const k = locationKey(n.loc);
    byLoc.set(k, [...(byLoc.get(k) ?? []), n.text]);
  }
  const rules = new Map(spec.columns.map((c) => [locationKey(c), c]));
  const cp = new ColumnPolicy(p);
  const columns = profileLocations(profile).map(({ loc, stats }): ProposalEntry => {
    const k = locationKey(loc);
    const rule = rules.get(k) as ColumnRule;
    const said = byLoc.get(k);
    return {
      ...loc,
      class: rule.class,
      treatment: rule.treatment,
      source: rule.source === "policy" ? "policy" : "heuristic",
      reason: said === undefined ? baseReason(rule, stats, p, cp) : said.join("; "),
    };
  });
  const notes = [...(notesOf.decided === undefined ? [] : [notesOf.decided]), ...notesOf.shadowedKeeps];
  return { spec, columns, notes };
}

export interface AuditOptions {
  /** What blind.toml would say (validated as proposeSpec validates it): the audit reads `keep` (terms and placeholders) and `patterns`. */
  policy?: BlindPolicy;
  /**
   * The salt the output was blinded with. Read only when the spec lists values to redact (`redact`), to
   * check the output for them by their salted fingerprints; without it such a spec gets a general candidate.
   */
  salt?: Uint8Array;
}

/**
 * Audits blinded output held in memory (`files`, each a "/"-separated path and its bytes, as applySpec
 * returns them in `outputs`) against the spec and map it was made with: the report `blind audit
 * --no-model --json` prints for a directory holding the same files, with the same blind.toml and salt.
 * The rule-based layers only: the mechanical layer (every spec entity, every original value in the map,
 * every enabled pattern match that is not a pseudonym, and the spec's redact fingerprints, in every
 * decoding, name and archive member) and the semantic layer (identifier-, name-, email- and host-shaped
 * text that is not a pseudonym or kept). No model is called; `modelLayer` says the layer was skipped.
 *
 * `status` is `leak` (a spec or map value survives), `candidates` (something to review) or `clean`
 * (these checks found nothing they look for, not a guarantee). Values in the report are masked. With no
 * zip codec installed (the browser entry), an archive's deflated members are reported as unread
 * candidates, so an Office file is never `clean`. Throws InputError for a bad or repeated path and
 * PolicyError for an invalid policy. `spec` is not validated here; parseSpec or validateSpec checks one first.
 */
export function auditOutputs(files: readonly InputFile[], spec: Spec, map: BlindMap, options: AuditOptions = {}): AuditReport {
  const policy = options.policy === undefined ? null : policyFromObject(options.policy);
  const entries = memoryTree(files);
  // As `blind audit`: blind.toml's pattern switches over the spec's, and the salt only for a spec with redact entries.
  const checked = withPolicyPatterns(spec, policy?.patterns ?? {});
  const salt = (checked.redact?.length ?? 0) > 0 ? options.salt : undefined;
  const report = auditRules(entries, checked, map, { keep: policy?.keep.terms ?? [], placeholders: policy?.keep.placeholders ?? true, salt });
  // The note `blind audit --no-model` adds: the model layer was not called.
  return { ...report, modelLayer: { status: "skipped", host: null, reason: "--no-model" } };
}
