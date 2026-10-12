import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { COMMANDS, helpText, main } from "../src/cli.ts";

test("help lists every planned command", () => {
  const help = helpText();
  expect(help).toContain(pkg.version);
  for (const c of COMMANDS) expect(help).toContain(c.name);
});

test("every command is wired: none is listed as not implemented", () => {
  expect(helpText()).not.toContain("not implemented");
});

test("init is wired and no longer listed as not implemented", async () => {
  const line = helpText().split("\n").find((l) => l.trimStart().startsWith("init"));
  expect(line).not.toContain("not implemented");
  expect(await main(["init", "--help"])).toBe(0);
});

test("every listed command dispatches to a handler", async () => {
  // --help is each command's no-side-effect path; an unwired command would fall through to "unknown command".
  for (const c of COMMANDS) expect({ c: c.name, code: await main([c.name, "--help"]) }).toEqual({ c: c.name, code: 0 });
});

test("a command name that is an Object prototype key is unknown", async () => {
  expect(await main(["constructor"])).toBe(2);
});
