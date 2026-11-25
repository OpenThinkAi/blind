// The zip codec: raw deflate and inflate, supplied by the caller. The engine,
// the format readers and the audit never import a compression library
// themselves, so a bundle that never installs a codec carries none (D-24). The
// CLI installs Node's (src/nodezip.ts) before any command runs; a build with no
// codec refuses Office files with NO_ZIP_CODEC_REASON instead of reading them.

export interface ZipCodec {
  /** Raw (headerless) inflate. Throws when the data is not valid deflate or would pass `maxOutputLength` bytes. */
  inflateRaw(data: Uint8Array, maxOutputLength: number): Uint8Array;
  /** Raw (headerless) deflate. Must be deterministic: the same input always gives the same bytes. */
  deflateRaw(data: Uint8Array): Uint8Array;
}

/** Why an Office file is not read or written when no codec is installed. */
export const NO_ZIP_CODEC_REASON = "Office files are not supported in this build";

let installed: ZipCodec | null = null;

/** Installs the codec every zip read and write uses from now on; null removes it. */
export function setZipCodec(codec: ZipCodec | null): void {
  installed = codec;
}

/** The installed codec, or null when this build has none. */
export function zipCodec(): ZipCodec | null {
  return installed;
}
