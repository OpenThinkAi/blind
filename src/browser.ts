// The browser entry: the library entry, for code a browser loads (D-3,
// D-15, D-24). Everything it reaches uses only web-standard globals (TextEncoder, TextDecoder,
// crypto.getRandomValues, Uint8Array): no `node:` or `bun` module, no Buffer, process or require.
// test/browser.test.ts bundles this file for the browser and fails if any of those appear, then runs
// the bundle with only web-standard globals.
//
// It installs no zip codec, so it carries no compression code: an Office input (DOCX, XLSX) is
// skipped by applySpec, and refused by revealFile, with NO_ZIP_CODEC_REASON. CSV, TSV, JSON, JSONL
// and text work (D-14). A caller that brings its own raw deflate/inflate can still install one with
// setZipCodec; its contract is in src/formats/zipcodec.ts.
//
// The package's `exports` (`.` and `./browser`, D-24) are wired up with the release build, not here.
// Profile and plan (profileInputs, proposeSpec: built-in detectors and policy rules, no model) and the
// rule-based audit (auditOutputs: mechanical and semantic layers, no model) are here through src/lib.ts;
// the bundle test is what holds them to the same rule. With no codec, the audit reports a deflated
// archive member as unread (a candidate), so such a file is never clean.

export * from "./lib.ts";
