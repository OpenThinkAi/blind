// Terminal-safe output: names and values from documents never reach a terminal as control sequences.
// Synthetic names only.
import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { renderTable } from "../src/audit/command.ts";
import { auditTree } from "../src/audit/mechanical.ts";
import { MAP_VERSION } from "../src/engine/map.ts";
import type { Spec } from "../src/schema.ts";
import { oneLine, terminalStream, terminalText } from "../src/terminal.ts";

const ESC = String.fromCharCode(0x1b);
const CSI8 = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);

test("terminalText escapes cursor, colour, OSC, C1 and bidi controls and keeps tabs and newlines", () => {
  const s = `a${ESC}[2Kb${ESC}]0;title${BEL}c${CSI8}31md\re${RLO}f\tg\nh${String.fromCharCode(0x2028)}`;
  expect(terminalText(s)).toBe("a\\u001b[2Kb\\u001b]0;title\\u0007c\\u009b31md\\u000de\\u202ef\tg\nh\\u2028");
  expect(terminalText("Avery Quill, résumé, 名前")).toBe("Avery Quill, résumé, 名前");
});

test("oneLine also escapes tabs and newlines, so a name cannot start a forged line", () => {
  expect(oneLine("x.txt\nstatus: clean\t")).toBe("x.txt\\u000astatus: clean\\u0009");
});

test("terminalStream escapes every string written and passes the rest of the stream through", () => {
  const got: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      got.push(chunk.toString());
      cb();
    },
  });
  const s = terminalStream(sink);
  s.write(`${ESC}[31mred\n`);
  s.write(Buffer.from("raw"));
  expect(got).toEqual(["\\u001b[31mred\n", "raw"]);
  expect(s.writable).toBe(true);
  // JSON stays valid and means the same thing.
  const json = JSON.stringify({ name: `q${CSI8}${RLO}` });
  expect(JSON.parse(terminalText(json))).toEqual({ name: `q${CSI8}${RLO}` });
});

test("the audit table escapes a file name carrying an escape sequence or a newline", () => {
  const spec: Spec = {
    version: 1,
    columns: [],
    entities: { person: [{ canonical: "Avery Quill", aliases: [], parts: [] }], org: [], vocabulary: [] },
    patterns: { ip: true, email: true, host: true, guid: true, mac: false },
    questions: [],
  } as unknown as Spec;
  const name = `notes${ESC}[2K\nstatus: clean.txt`;
  const r = auditTree([{ path: name, kind: "file", bytes: Buffer.from("Avery Quill\n") }], spec, { version: MAP_VERSION, entries: [] });
  const table = renderTable(r);
  expect(table).not.toContain(ESC);
  expect(table).toContain("notes\\u001b[2K\\u000astatus: clean.txt");
  expect(table.split("\n").filter((l) => l.startsWith("status:"))).toEqual([expect.stringMatching(/^status: leak/)]);
});
