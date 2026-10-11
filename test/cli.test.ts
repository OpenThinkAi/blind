import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { COMMANDS, helpText, main } from "../src/cli.ts";

test("help lists every planned command", () => {
  const help = helpText();
  expect(help).toContain(pkg.version);
  for (const c of COMMANDS) expect(help).toContain(c.name);
});

test("stub commands exit 2", async () => {
  expect(await main(["audit"])).toBe(2);
});

test("init is wired and no longer listed as not implemented", async () => {
  const line = helpText().split("\n").find((l) => l.trimStart().startsWith("init"));
  expect(line).not.toContain("not implemented");
  expect(await main(["init", "--help"])).toBe(0);
});

test("a command name that is an Object prototype key is unknown", async () => {
  expect(await main(["constructor"])).toBe(2);
});
