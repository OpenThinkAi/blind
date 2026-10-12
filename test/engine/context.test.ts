// Context-keyword redaction (AGT-1831): the value after "gate code", "pw", "acct ending" ... is
// replaced with REDACTED and the keyword stays. Synthetic text only; every value is invented.

import { describe, expect, test } from "bun:test";
import { findContextSpans } from "../../src/engine/context.ts";
import { applySpec, type InputFile } from "../../src/engine/apply.ts";
import { EntityMatcher, findSpans } from "../../src/engine/text.ts";
import { parsePolicy, defaultPolicy, renderPolicy, PolicyError } from "../../src/policy.ts";
import { REDACTED_VALUE, type PatternName, type Spec } from "../../src/schema.ts";

const NONE: Record<PatternName, boolean> = { ip: false, email: false, host: false, guid: false, mac: false, phone: false, address: false, secret: false };
const found = (text: string, triggers: string[] = []) => findContextSpans(text, { triggers }).map((s) => text.slice(s.start, s.end));

describe("context keywords", () => {
  test.each([
    ["The gate code 4471 works", ["4471"]],
    ["gate code is 4471.", ["4471"]],
    ["Gate Code: 4471", ["4471"]],
    ["pw: hunter2", ["hunter2"]],
    ["her password is swordfish, ok", ["swordfish"]],
    ["password = \"Quill-9!\"", ["Quill-9!"]],
    ["acct ending 0042", ["0042"]],
    ["account number 12345678 is set", ["12345678"]],
    ["account #: 5521-0042", ["5521-0042"]],
    ["card number 4111 1111 1111 1111 expires", ["4111 1111 1111 1111"]],
    ["Visa ending in 4242", ["4242"]],
    ["routing 021000021 and acct 98765432", ["021000021", "98765432"]],
    ["CVV 123", ["123"]],
    ["DOB: 04/12/1980", ["04/12/1980"]],
    ["dob April 12, 1980 per chart", ["April 12, 1980"]],
    ["date of birth 12 April 1980.", ["12 April 1980"]],
    ["DL# D1234567", ["D1234567"]],
    ["driver's license number D1234567", ["D1234567"]],
    ["plate 7ABC123", ["7ABC123"]],
    ["safe combo 12 34 56", ["12 34 56"]],
    ["policy #AB-77123", ["AB-77123"]],
    ["policy number: 99120344", ["99120344"]],
    ["alarm code 9981", ["9981"]],
    ["password hunter2 for now", ["hunter2"]],
    ["password: dragon", ["dragon"]],
    ["pw XKCD", ["XKCD"]],
  ])("%j", (text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test.each([
    ["the account manager called"],
    ["the password was reset"],
    ["passwords must be changed"],
    ["see the policy 2024 update"],
    ["plate 2"],
    ["account 7"],
    ["card games on Friday"],
    ["a gate code"],
    ["combination of both"],
    ["dobson and plates"],
    ["password"],
    ["5 dl of water"],
    ["Backup box hasn't had its password rotated yet."],
    ["Has the backup box password been rotated?"],
    ["Was the password rotated?"],
    ["the combo lock stuck"],
  ])("%j finds nothing", (text) => {
    expect(found(text)).toEqual([]);
  });

  test("the keyword must be a whole word", () => {
    expect(found("swpw 1234 and pwx 999")).toEqual([]);
  });

  test("extra triggers from blind.toml redact the next token", () => {
    expect(found("locker code 88213", ["locker code"])).toEqual(["88213"]);
    expect(found("locker code 88213")).toEqual([]);
    expect(found("Wi-Fi key is plum.cart", ["wi-fi key"])).toEqual(["plum.cart"]);
  });
});

describe("findSpans with context", () => {
  const m = new EntityMatcher({});
  test("off unless asked", () => {
    expect(findSpans("pw: hunter2", m, NONE)).toEqual([]);
  });
  test("a redact span keeps the keyword outside it", () => {
    const text = "gate code 4471 and pw: hunter2";
    const spans = findSpans(text, m, NONE, [], { triggers: [] });
    expect(spans.map((s) => [text.slice(s.start, s.end), s.cls])).toEqual([["4471", "redact"], ["hunter2", "redact"]]);
  });
  test("a spelled value after the keyword is taken whole", () => {
    const text = "the gate code is four four seven one, thanks";
    const spans = findSpans(text, m, NONE, [], { triggers: [] });
    expect(spans.map((s) => [text.slice(s.start, s.end), s.cls])).toEqual([["four four seven one", "redact"]]);
  });
  test("a redaction wins over a phone match of the same text, and a phone elsewhere is still a phone", () => {
    const text = "gate code 801-555-0142, call 801-555-0100";
    const spans = findSpans(text, m, { ...NONE, phone: true, address: false, secret: false }, [], { triggers: [] });
    expect(spans.map((s) => [text.slice(s.start, s.end), s.cls])).toEqual([["801-555-0142", "redact"], ["801-555-0100", "id"]]);
    expect(findSpans(text, m, { ...NONE, phone: true, address: false, secret: false }).map((s) => s.cls)).toEqual(["id", "id"]);
  });
  test("a redaction wins over a pattern match of the same text", () => {
    const text = "pw: avery@example.com";
    const spans = findSpans(text, m, { ...NONE, email: true }, [], { triggers: [] });
    expect(spans.map((s) => s.cls)).toEqual(["redact"]);
  });
});

const enc = (s: string) => new TextEncoder().encode(s);
const spec = (): Spec => ({ version: 1, columns: [], entities: {}, patterns: NONE, questions: [] });
const SALT = new Uint8Array(32).fill(3);
const NOTE = "Gate code 4471 for the side door. Login pw: hunter2\nCard on file: acct ending 0042.\nThe account manager reset the password.\n";

describe("apply", () => {
  const run = (context?: { enabled: boolean; triggers: string[] }, path = "note.txt") => {
    const files: InputFile[] = [{ path, bytes: enc(NOTE) }];
    const r = applySpec(files, spec(), { salt: SALT, ...(context === undefined ? {} : { context }) });
    return { text: new TextDecoder().decode(r.outputs[0]?.bytes), map: JSON.stringify(r.map) };
  };

  test("redacts by default, keeps the keywords and prose, and records no secret in the map", () => {
    const { text, map } = run();
    expect(text).toBe(
      `Gate code ${REDACTED_VALUE} for the side door. Login pw: ${REDACTED_VALUE}\nCard on file: acct ending ${REDACTED_VALUE}.\nThe account manager reset the password.\n`,
    );
    for (const secret of ["4471", "hunter2", "0042"]) expect(map).not.toContain(secret);
  });

  test("works in a markdown file and a CSV cell kept as free text", () => {
    expect(run(undefined, "note.md").text).toContain(`pw: ${REDACTED_VALUE}`);
    const csv = applySpec([{ path: "t.csv", bytes: enc("Name,Note\nAda,gate code 4471\n") }], spec(), { salt: SALT });
    expect(new TextDecoder().decode(csv.outputs[0]?.bytes)).toContain(`gate code ${REDACTED_VALUE}`);
  });

  test("enabled = false leaves the text alone; triggers extend the list", () => {
    expect(run({ enabled: false, triggers: [] }).text).toBe(NOTE);
    const extra = applySpec([{ path: "a.txt", bytes: enc("locker code 88213\n") }], spec(), { salt: SALT, context: { enabled: true, triggers: ["locker code"] } });
    expect(new TextDecoder().decode(extra.outputs[0]?.bytes)).toBe(`locker code ${REDACTED_VALUE}\n`);
  });
});

describe("[context] in blind.toml", () => {
  test("defaults on with no extra triggers, and round-trips", () => {
    const p = defaultPolicy();
    expect(p.context).toEqual({ enabled: true, triggers: [] });
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
    p.context = { enabled: false, triggers: ["locker code", "wi-fi key"] };
    expect(parsePolicy(renderPolicy(p))).toEqual(p);
  });

  test("rejects a wrong type, a blank trigger and an unknown key", () => {
    const base = renderPolicy(defaultPolicy());
    const err = (extra: string) => {
      try {
        parsePolicy(`${base}\n${extra}`);
      } catch (e) {
        return e instanceof PolicyError ? e.message : String(e);
      }
      return "";
    };
    expect(err('[context]\nenabled = "yes"')).toContain("context.enabled must be true or false");
    expect(err('[context]\ntriggers = ["  "]')).toContain("context.triggers");
    expect(err("[context]\nmode = 1")).toContain("unknown key context.mode");
  });
});
