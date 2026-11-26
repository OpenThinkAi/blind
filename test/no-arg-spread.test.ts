// AGT-2784: a call that spreads an array into its arguments puts one argument per element on the
// stack, so `Math.max(...rows)` or `out.push(...cells)` throws RangeError (Maximum call stack size
// exceeded) once the array holds about 125,000 elements under V8. Every such call in src/ is found
// here with the TypeScript parser; each must be on the allowlist below, a reviewed site whose array
// has a small fixed bound. A new one fails this test until it is a loop or reduce, or is reviewed and
// listed. Array literals (`[...a, ...b]`) are not calls and do not overflow, so they are not checked.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");

/** Callees whose spread arguments are checked: the ones that take any number of arguments. */
const CHECKED = /^(?:Math\.max|Math\.min|String\.fromCharCode|String\.fromCodePoint|.+\.push|.+\.unshift|.+\.splice)$/;

/** Reviewed sites, by file and a snippet of the call, with why the spread array stays small. */
const ALLOWED: readonly { file: string; snippet: string; why: string }[] = [
  { file: "src/cli.ts", snippet: "Math.max(...COMMANDS.map(", why: "the CLI's fixed command list" },
  { file: "src/profile/table.ts", snippet: "Math.max(0, ...scan.map(", why: "the first HEADER_SCAN_ROWS (20) rows" },
  { file: "src/engine/xlsx.ts", snippet: "Math.min(...pseudo.map(", why: "the rules that name one column" },
  { file: "src/audit/views.ts", snippet: "String.fromCharCode(...b.subarray(k, k + 8192))", why: "8192-byte chunks" },
  { file: "src/audit/views.ts", snippet: "String.fromCharCode(...units.slice(k, k + 8192))", why: "8192-unit chunks (two sites)" },
  { file: "src/audit/semantic.ts", snippet: "out.push(e.canonical, ...e.aliases, ...e.parts)", why: "one entity's aliases and parts" },
];

function spreadCalls(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && CHECKED.test(node.expression.getText(sf)) && node.arguments.some(ts.isSpreadElement)) {
      out.push(node.getText(sf).replace(/\s+/g, " "));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("no data-sized spread into a call's arguments (AGT-2784)", () => {
  const found = [...new Bun.Glob("src/**/*.ts").scanSync(ROOT)].sort().flatMap((file) => spreadCalls(file, readFileSync(resolve(ROOT, file), "utf8")).map((call) => ({ file, call })));

  test("every spread argument in src/ is a reviewed, fixed-size site", () => {
    const unreviewed = found.filter((f) => !ALLOWED.some((a) => a.file === f.file && f.call.includes(a.snippet)));
    expect(unreviewed).toEqual([]);
  });

  test("every allowlist entry still matches a call (a stale entry would let a new one in unseen)", () => {
    const stale = ALLOWED.filter((a) => !found.some((f) => f.file === a.file && f.call.includes(a.snippet)));
    expect(stale).toEqual([]);
  });

  test("the check finds a spread argument, including one split over lines, and ignores array literals", () => {
    const probe = ["Math.max(width, ...rows.map((r) => r.length));", "out.push(", "  ...cells,", ");", "const all = [...a, ...b];", "new Set([...a]);", "// Math.min(...x) in a comment"].join("\n");
    expect(spreadCalls("probe.ts", probe)).toEqual(["Math.max(width, ...rows.map((r) => r.length))", "out.push( ...cells, )"]);
  });
});
