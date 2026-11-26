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
// A later export (profile, plan, audit) is added to src/lib.ts, and so reaches this entry too, as
// long as it keeps to the same rule; the bundle test is what holds it there.

export * from "./lib.ts";
