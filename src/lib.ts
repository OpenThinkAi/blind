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
// Office files (DOCX, XLSX): the zip codec is injected (src/formats/zipcodec.ts),
// and this entry installs none, so it never imports a compression library. With
// no codec an Office input is skipped with NO_ZIP_CODEC_REASON and every other
// format works. A Node or Bun caller that wants Office support installs Node's
// codec once, with the CLI's settings (level 6), so the bytes match the CLI's:
//
//   import { deflateRawSync, inflateRawSync } from "node:zlib";
//   setZipCodec({
//     inflateRaw: (data, maxOutputLength) => inflateRawSync(data, { maxOutputLength }),
//     deflateRaw: (data) => deflateRawSync(data, { level: 6 }),
//   });

import { applySpec as engineApply, type ApplyOptions, type ApplyResult, type InputFile } from "./engine/apply.ts";
import type { ColumnDefault } from "./engine/columns.ts";
import type { ContextTriggerSpec } from "./engine/context.ts";
import type { BlindMap } from "./engine/map.ts";
import { Revealer } from "./engine/reveal.ts";
import type { PatternName, Spec } from "./schema.ts";

export { ApplyError, engineFormat } from "./engine/apply.ts";
export type { ApplyResult, ColumnOutcome, ColumnReport, EngineFormat, FileReport, InputFile, SkippedFile, TranscriptReport } from "./engine/apply.ts";
export { MapError, parseMap, serializeMap, type BlindMap, type MapEntry, type MapKind } from "./engine/map.ts";
export { RevealError, revealFile, Revealer, type Revealed, type RevealedFile } from "./engine/reveal.ts";
export { MIN_SALT_BYTES, PseudonymError } from "./engine/pseudonym.ts";
export { NameError } from "./engine/names.ts";
export { NO_ZIP_CODEC_REASON, setZipCodec, type ZipCodec, zipCodec } from "./formats/zipcodec.ts";
export { parseSpec, SchemaError, validateSpec } from "./validate.ts";
export type { Spec } from "./schema.ts";

/** Bytes in a salt from newSalt(): the size `blind init` writes to `.blind/salt`. */
export const SALT_BYTES = 32;

/** A fresh salt: 32 random bytes, the same kind of value `blind init` writes to `.blind/salt`, from the platform's CSPRNG. */
export function newSalt(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** The blinded-name shape (blind.toml `[pseudonyms] style`): whatever styles the engine accepts. */
export type PseudonymStyle = NonNullable<ApplyOptions["pseudonymStyle"]>;

/**
 * The apply-time settings the CLI reads from blind.toml, as a plain object with the same tables and
 * keys (camelCase where the TOML key has an underscore). Every part is optional; a part left out
 * gets what blind.toml gives it when the table is absent. A policy parsed from blind.toml (Policy in
 * src/policy.ts) fits this shape as it is.
 */
export interface BlindPolicy {
  /** `[pseudonyms] style`; compact when unset. */
  pseudonyms?: { style?: PseudonymStyle };
  /** `[patterns]`: switches that win over the spec's `patterns`; an unset one follows the spec. */
  patterns?: Partial<Record<PatternName, boolean>>;
  /** `[defaults] columns`: what a column with no rule gets, `fallback` (the default) or `scan`. */
  defaults?: { columns?: ColumnDefault };
  /** `[keep]`: terms kept as written (domain-shaped terms keep the hosts under them), and the textbook placeholder allowlist (on unless false). */
  keep?: { terms?: readonly string[]; placeholders?: boolean };
  /** `[context]`: the value after "gate code", "password" and the like written as REDACTED; on unless `enabled` is false. */
  context?: { enabled: boolean; triggers: readonly ContextTriggerSpec[] };
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

/** Every pattern blind.toml can switch. A Record, so a new PatternName cannot be missed here. */
const PATTERN_SWITCHES: Record<PatternName, true> = {
  ip: true,
  email: true,
  host: true,
  guid: true,
  mac: true,
  phone: true,
  card: true,
  address: true,
  secret: true,
};

/** `spec` with the policy's pattern switches over its own, as the CLI does (withPolicyPatterns in src/policy.ts). */
function withPatterns(spec: Spec, patterns: Partial<Record<PatternName, boolean>>): Spec {
  const set = (Object.keys(PATTERN_SWITCHES) as PatternName[]).filter((name) => patterns[name] !== undefined && patterns[name] !== spec.patterns[name]);
  if (set.length === 0) return spec;
  return { ...spec, patterns: { ...spec.patterns, ...Object.fromEntries(set.map((name) => [name, patterns[name]])) } };
}

/**
 * Blinds `inputs` (each a "/"-separated path and its bytes) with `spec`, in memory. The result holds
 * the blinded files (`outputs`, under their blinded paths), the map to keep (`map`), a report per
 * file and every input not written (`skipped`, with the reason). Throws where `blind apply` refuses:
 * ApplyError (a spec rule that does not fit the input), MapError, PseudonymError (a salt too short)
 * or NameError. `spec` is not validated here; parseSpec or validateSpec checks one first.
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
  if (p.context !== undefined) opts.context = p.context;
  if (p.defaults?.columns !== undefined) opts.columns = p.defaults.columns;
  if (p.images?.keep !== undefined) opts.images = p.images.keep ? "keep" : "replace";
  if (p.metadata?.keepDates !== undefined) opts.dates = p.metadata.keepDates ? "keep" : "scrub";
  return engineApply(inputs, withPatterns(spec, p.patterns ?? {}), opts);
}

/** `text` with every pseudonym `map` records replaced with its original value. */
export function revealText(text: string, map: BlindMap): string {
  return new Revealer(map).text(text).text;
}
