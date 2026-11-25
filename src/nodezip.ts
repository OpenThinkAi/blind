// The zip codec backed by node:zlib, for the CLI (and the test preload). Kept
// out of src/engine, src/formats and src/audit so nothing a library bundle pulls
// in imports node:zlib (D-24; see src/formats/zipcodec.ts).

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { setZipCodec, type ZipCodec } from "./formats/zipcodec.ts";

export const nodeZipCodec: ZipCodec = {
  inflateRaw: (data, maxOutputLength) => inflateRawSync(data, { maxOutputLength }),
  deflateRaw: (data) => deflateRawSync(data, { level: 6 }),
};

/** Installs the node:zlib codec. */
export function installNodeZipCodec(): void {
  setZipCodec(nodeZipCodec);
}
