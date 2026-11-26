// The library build (D-24): compiled ESM JavaScript and type declarations for the two entries the
// package exports, `.` (src/lib.ts) and `./browser` (src/browser.ts), into dist/. The CLI is not built:
// `bin` still runs src/ on Bun. dist/ is not committed (.gitignore); the release workflow runs this before
// it packs, and test/pack.test.ts runs it before it packs and installs the tarball.
//
//   dist/lib.js, dist/browser.js   one self-contained ESM file per entry, bundled with `bun build`
//                                  for the browser target, so neither imports anything at run time
//   dist/types/**/*.d.ts           tsc declarations, entry points dist/types/lib.d.ts and browser.d.ts
//
// Declarations are compiled with no Node or Bun types and the DOM library, as a browser consumer
// compiles them. tsc keeps the source's `.ts` import specifiers in the declarations it emits; they are
// rewritten to `.js` here so a consumer's TypeScript (node16, nodenext or bundler resolution) finds
// the `.d.ts` beside each one. test/pack.test.ts typechecks a consumer against the packed files.
//
// Run: bun scripts/build.ts (or bun run build).

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const ENTRIES = ["src/lib.ts", "src/browser.ts"];

function run(args: string[]): void {
  const r = Bun.spawnSync(args, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`build step failed (exit ${r.exitCode}): ${args.join(" ")}`);
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** `from "./x.ts"`, `import("./x.ts")` and `import "./x.ts"` with `.js`, for relative specifiers only. */
function rewriteSpecifiers(dts: string): string {
  return dts.replace(/((?:\bfrom|\bimport)\s*\(?\s*)(["'])(\.\.?\/[^"']*?)\.ts\2/g, "$1$2$3.js$2");
}

rmSync(DIST, { recursive: true, force: true });

// JavaScript: one bundle per entry. Each is built on its own, so each is a single file with no
// shared chunk. --packages=external would leave a bare import in place; there is none to leave
// (blind has no runtime dependency), so the bundle is the entry's own code only.
for (const entry of ENTRIES) {
  run([process.execPath, "build", entry, "--target=browser", "--format=esm", "--outdir", DIST]);
}

// Declarations: emitted into a scratch directory under the source's own layout (src/... beside schema/,
// which src/validate.ts imports), then src/ is moved to dist/types. The scratch directory is inside dist/,
// not the system temp directory, so the move is a rename on one file system (a tmpfs /tmp would fail it).
const scratch = join(DIST, ".types-build");
mkdirSync(scratch, { recursive: true });
try {
  const config = join(scratch, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: join(ROOT, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        lib: ["ESNext", "DOM"],
        types: [],
        rootDir: ROOT,
        outDir: join(scratch, "out"),
      },
      include: [],
      files: ENTRIES.map((e) => join(ROOT, e)),
    }),
  );
  run([process.execPath, join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", config]);
  for (const f of walk(join(scratch, "out", "src"))) writeFileSync(f, rewriteSpecifiers(readFileSync(f, "utf8")));
  renameSync(join(scratch, "out", "src"), join(DIST, "types"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
