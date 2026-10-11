import pkg from "../package.json" with { type: "json" };
import { processIO, runInit } from "./init.ts";

export const COMMANDS = [
  { name: "init", usage: "init [dir]", summary: "Write blind.toml (policy) and .blind/ (salt)" },
  { name: "profile", usage: "profile <inputs>", summary: "Build and print the corpus profile" },
  { name: "plan", usage: "plan <inputs>", summary: "Profile, analyst, spec; print the spec for review" },
  { name: "apply", usage: "apply <inputs> -o <out>", summary: "Apply the saved spec deterministically" },
  { name: "audit", usage: "audit <out>", summary: "Independently audit a blinded output tree" },
  { name: "run", usage: "run <inputs> -o <out>", summary: "plan, apply and audit in one pass" },
  { name: "reveal", usage: "reveal <file> --map <map.json>", summary: "Reverse a blinded file with its map" },
  { name: "bench", usage: "bench <kit>", summary: "Evaluation harness on a synthetic kit" },
] as const;

const HANDLERS: Partial<Record<(typeof COMMANDS)[number]["name"], (args: string[]) => Promise<number>>> = {
  init: (args) => runInit(args, processIO()),
};

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length));
  const rows = COMMANDS.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}${Object.hasOwn(HANDLERS, c.name) ? "" : " (not implemented)"}`);
  return [
    `blind ${pkg.version}`,
    "",
    "Usage: blind <command> [options]",
    "",
    "Commands:",
    ...rows,
    "",
    "Options:",
    "  -h, --help     Show this help",
    "  -v, --version  Print the version",
    "",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(helpText());
    return 0;
  }
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const handler = Object.hasOwn(HANDLERS, cmd) ? HANDLERS[cmd as keyof typeof HANDLERS] : undefined;
  if (handler !== undefined) return handler(argv.slice(1));
  if (COMMANDS.some((c) => c.name === cmd)) {
    process.stderr.write(`blind ${cmd}: not implemented\n`);
    return 2;
  }
  process.stderr.write(`blind: unknown command '${cmd}'\n\n${helpText()}`);
  return 2;
}
