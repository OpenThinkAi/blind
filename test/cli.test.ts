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
