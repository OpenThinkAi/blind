// Preloaded by test/engine/sha256-kit.test.ts only (`bun --preload`): swaps the engine's pure-JS
// src/engine/sha256.ts for the node:crypto implementation the engine used before AGT-2731, so the
// same `blind apply` can run on both and its output be compared byte for byte. Kept in the tests
// only; the engine never imports node:crypto.

import { plugin } from "bun";

const OLD = `
import { createHash, createHmac } from "node:crypto";
export const sha256 = (data) => new Uint8Array(createHash("sha256").update(data).digest());
export const hmacSha256 = (key, message) => new Uint8Array(createHmac("sha256", key).update(message).digest());
export const utf8 = (s) => new Uint8Array(Buffer.from(s, "utf8"));
export const toHex = (bytes) => Buffer.from(bytes).toString("hex");
process.stderr.write("old-hmac: node:crypto in use\\n");
`;

plugin({
  name: "old-hmac",
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]engine[\\/]sha256\.ts$/ }, () => ({ contents: OLD, loader: "js" }));
  },
});
