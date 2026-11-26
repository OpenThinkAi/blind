// AGT-2737: the browser entry (src/browser.ts). The entry is bundled for the browser and the bundle is
// checked for Node-only code (no `node:`/`bun:` module, no `require`, no `Buffer` or `process` global),
// then run in a context that has only web-standard globals, where a synthetic CSV is blinded and
// revealed and an Office file is skipped (D-14, D-15, D-24; project rule 2). node:vm, node:fs and the
// TypeScript parser are used here, in the test, never by the entry. Synthetic data only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { NO_ZIP_CODEC_REASON, parseMap, Revealer, RevealError, revealFile, setZipCodec, type ZipCodec, zipCodec } from "../src/lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "blind-browser-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * `bun build <entry> --target=browser`, returning the bundle's text. For the browser target Bun quietly
 * swaps a Node built-in for a polyfill or a stub (`node:fs` becomes `{}`), which would hide the very
 * import this test is for, so `external` keeps every non-relative import as an import statement.
 */
function bundle(entry: string, name: string, external: boolean): string {
  const outfile = join(scratch, name);
  const args = [process.execPath, "build", entry, "--target=browser", "--outfile", outfile];
  if (external) args.push("--packages=external");
  const r = Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bun build ${entry} failed:\n${r.stderr.toString()}`);
  return readFileSync(outfile, "utf8");
}

/** Globals a browser does not have. The identifier is reported wherever it is referenced, not where it is a property name. */
const NODE_GLOBALS = new Set(["Buffer", "process", "require", "__require", "Bun", "setImmediate", "__dirname", "__filename"]);

const isPropertyName = (node: ts.Identifier): boolean => {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p)) return p.name === node;
  if (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) return p.name === node;
  if (ts.isBindingElement(p)) return p.propertyName === node;
  return false;
};

/** Every Node-only thing in bundled JavaScript: a module specifier (any import, `node:` or `bun:` above all), a `node:`/`bun:` string, or a Node global. */
function nodeOnly(code: string): string[] {
  const found: string[] = [];
  const sf = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(`import "${node.moduleSpecifier.text}"`);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      found.push("import()");
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^(?:node:|bun:|bun$)/.test(node.text)) {
      found.push(`"${node.text}"`);
    } else if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && !isPropertyName(node)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(found)];
}

/** The bundle as a classic script: its one `export { a, b as c }` becomes `globalThis.__blind = { a, c: b }`. */
function asScript(code: string): string {
  const sf = ts.createSourceFile("bundle.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const exports = sf.statements.filter(ts.isExportDeclaration);
  const last = exports[0];
  if (exports.length !== 1 || last === undefined || last.moduleSpecifier !== undefined || last.exportClause === undefined || !ts.isNamedExports(last.exportClause)) {
    throw new Error("expected one local export statement in the bundle");
  }
  const fields = last.exportClause.elements.map((e) => `${e.name.text}: ${(e.propertyName ?? e.name).getText(sf)}`);
  return `${code.slice(0, last.getStart(sf))}globalThis.__blind = { ${fields.join(", ")} };${code.slice(last.getEnd())}`;
}

const ENTRY = "src/browser.ts";
const shipped = bundle(ENTRY, "blind.browser.js", false);
const strict = bundle(ENTRY, "blind.browser.strict.js", true);

describe("the browser bundle has no Node-only code", () => {
  test("the bundle is the entry's own code: no built-in was polyfilled or stubbed in", () => {
    // Equal only when nothing outside src/ was imported: a polyfilled `node:` module or a stub would differ.
    expect(shipped).toBe(strict);
  });

  test("no node:/bun: module, require, Buffer or process", () => {
    expect(nodeOnly(strict)).toEqual([]);
  });

  test("the check catches each kind of Node-only code it bans", () => {
    const probe = join(scratch, "probe.ts");
    writeFileSync(
      probe,
      [
        'import { readFileSync } from "node:fs";',
        'import "node:os";',
        'export const a = [readFileSync, Buffer.from("x"), process.env.HOME, require("node:path")];',
        'export const fine = ["the process", { process: 1 }.process, "a Buffer of time"];',
      ].join("\n"),
    );
    const found = nodeOnly(bundle(probe, "probe.js", true));
    expect(found).toEqual(expect.arrayContaining(['import "node:fs"', 'import "node:os"', "Buffer", "process", '"node:path"']));
    expect(found.some((f) => f === "require" || f === "__require")).toBe(true);
    // Words in strings and property names are not references to a global.
    expect(nodeOnly('const s = "the process"; const o = { process: 1, Buffer: 2 }; o.process;')).toEqual([]);
  });

  test("a Bun built-in is caught: kept as an import here, refused by the plain browser build", () => {
    const probe = join(scratch, "bunprobe.ts");
    writeFileSync(probe, 'import { file } from "bun";\nimport { Database } from "bun:sqlite";\nexport const f = [file, Database];\n');
    expect(nodeOnly(bundle(probe, "bunprobe.js", true))).toEqual(expect.arrayContaining(['import "bun"', 'import "bun:sqlite"']));
    expect(() => bundle(probe, "bunprobe.plain.js", false)).toThrow();
  });
});

const SPEC = {
  version: 1,
  columns: [
    { file: "staff.csv", header: "name", class: "person", treatment: "blind", confidence: 1, source: "human" },
    { file: "staff.csv", header: "email", class: "email", treatment: "blind", confidence: 1, source: "human" },
  ],
  entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery", "Quill"] }, { canonical: "Rowan Pike", aliases: [], parts: ["Rowan", "Pike"] }] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const CSV = "name,email,team\nAvery Quill,avery.quill@example-corp.test,North\nRowan Pike,rowan.pike@example-corp.test,South\n";

// Runs inside the context. Builds its own byte arrays there, so nothing from this realm reaches the engine.
const SCENARIO = `
(() => {
  const lib = globalThis.__blind;
  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);
  const globals = ["Buffer", "process", "require", "Bun", "setImmediate", "module"].filter((g) => typeof globalThis[g] !== "undefined");
  const spec = lib.parseSpec(SPEC_TEXT);
  const salt = lib.newSalt();
  const r = lib.applySpec([{ path: "staff.csv", bytes: enc(CSV_TEXT) }, { path: "book.xlsx", bytes: enc("PK not a real workbook") }], spec, { salt });
  const blinded = r.outputs.map((o) => ({ path: o.path, text: dec(o.bytes) }));
  const map = lib.parseMap(lib.serializeMap(r.map));
  const rv = new lib.Revealer(map);
  const back = r.outputs.map((o) => ({ path: rv.path(o.path).text, text: dec(lib.revealFile(o.path, o.bytes, rv).bytes) }));
  let xlsxReveal = "not refused";
  try { lib.revealFile("book.xlsx", enc("PK not a real workbook"), rv); } catch (e) { xlsxReveal = e.name + ": " + e.message; }
  const policy = { columns: [{ header: "team", treatment: "keep" }], keep: { terms: ["North"] } };
  const profiled = lib.profileInputs([{ path: "staff.csv", bytes: enc(CSV_TEXT) }], { policy });
  const proposed = lib.proposeSpec(profiled.profile, policy).columns.map((c) => [c.header, c.treatment, c.source]);
  return JSON.stringify({ globals, skipped: r.skipped, blinded, back, xlsxReveal, codec: lib.zipCodec() === null, proposed });
})()
`;

describe("the browser bundle runs with only web-standard globals", () => {
  test("blinds then reveals a synthetic CSV, skips and refuses an XLSX, and profiles and proposes", () => {
    const context = vm.createContext({ TextEncoder, TextDecoder, crypto: globalThis.crypto, URL, console, SPEC_TEXT: JSON.stringify(SPEC), CSV_TEXT: CSV });
    vm.runInContext(asScript(shipped), context, { filename: "blind.browser.js" });
    const out = JSON.parse(vm.runInContext(SCENARIO, context) as string) as {
      globals: string[];
      skipped: { path: string; reason: string }[];
      blinded: { path: string; text: string }[];
      back: { path: string; text: string }[];
      xlsxReveal: string;
      codec: boolean;
      proposed: [string, string, string][];
    };
    expect(out.globals).toEqual([]);
    expect(out.codec).toBe(true);
    expect(out.skipped).toEqual([{ path: "book.xlsx", reason: NO_ZIP_CODEC_REASON }]);
    expect(out.blinded.map((b) => b.path)).toEqual(["staff.csv"]);
    const blinded = out.blinded[0]?.text ?? "";
    for (const real of ["Avery", "Quill", "Rowan", "Pike", "example-corp"]) expect(blinded).not.toContain(real);
    expect(out.back).toEqual([{ path: "staff.csv", text: CSV }]);
    expect(out.xlsxReveal).toBe(`RevealError: ${NO_ZIP_CODEC_REASON}`);
    // Profile and propose run there too, with no model and no file system.
    expect(out.proposed).toContainEqual(["team", "keep", "policy"]);
  });
});

describe("reveal with no zip codec", () => {
  test("an Office file is refused whole, never copied through unrevealed", () => {
    // The test preload installs the CLI's codec; take it out and put it back as found.
    const saved: ZipCodec | null = zipCodec();
    setZipCodec(null);
    try {
      const rv = new Revealer(parseMap('{"version":1,"entries":[]}'));
      for (const path of ["out/book.xlsx", "out/letter.docx"]) {
        expect(() => revealFile(path, new TextEncoder().encode("PK"), rv)).toThrow(RevealError);
        expect(() => revealFile(path, new TextEncoder().encode("PK"), rv)).toThrow(NO_ZIP_CODEC_REASON);
      }
    } finally {
      setZipCodec(saved);
    }
  });
});
