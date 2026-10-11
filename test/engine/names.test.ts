import { describe, expect, test } from "bun:test";
import { ApplyError, type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import { NameError, NameRewriter, type NameSlot } from "../../src/engine/names.ts";
import { Pseudonymizer } from "../../src/engine/pseudonym.ts";
import { EntityMatcher, keepDomains, underKeptDomain } from "../../src/engine/text.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic only: invented names, example.com/.net, RFC 5737 addresses.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);
const PATTERNS = { ip: true, email: true, host: true, guid: true, mac: true };

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const spec = (over: Partial<Spec> = {}): Spec => ({
  version: 1,
  columns: [],
  entities: { person: [{ canonical: "Avery Quill", aliases: ["Aves"], parts: ["Avery", "Quill"] }] },
  patterns: PATTERNS,
  questions: [],
  ...over,
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const text = (r: ApplyResult, path: string): string => {
  const o = r.outputs.find((x) => x.path === path);
  if (o === undefined) throw new Error(`no output ${path}`);
  return Buffer.from(o.bytes).toString("utf8");
};
const outPath = (r: ApplyResult, path: string): string => {
  const f = r.files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no report for ${path}`);
  return f.outputPath;
};

const STAFF = [
  "Owner,Ref Code,Notes",
  "Avery Quill,ZX-4471-Q,call back later",
  "Robin Example,ZX-4472-R,ping 192.0.2.44 first",
  "Sam Placeholder,ZX-4473-S,the meeting moved",
  "Jo Sample,ZX-4474-T,send the invoice",
].join("\n") + "\n";
const STAFF_SPEC = spec({ columns: [rule("staff.csv", "Owner", "person", "blind")] });

describe("patterns in every text (AC1)", () => {
  test("an IP in a notes cell is replaced with an IP-shaped pseudonym", () => {
    const r = applySpec([file("staff.csv", STAFF)], STAFF_SPEC, { salt: SALT });
    const out = text(r, "staff.csv");
    expect(out).not.toContain("192.0.2.44");
    expect(out).toMatch(/,ping \d+\.\d+\.\d+\.\d+ first\n/);
    expect(r.files[0]?.patternReplacements).toBe(1);
  });

  test("a disabled pattern is left alone", () => {
    const r = applySpec([file("staff.csv", STAFF)], spec({ ...STAFF_SPEC, patterns: { ...PATTERNS, ip: false } }), { salt: SALT });
    expect(text(r, "staff.csv")).toContain("ping 192.0.2.44 first");
  });

  const NOTES = "Deploy from api.vendor.example.net, then db01.example.com and badvendor.example.net. Mail ops@vendor.example.net.\n";

  test("hosts under a keep-list domain are kept, and counted; other hosts are replaced", () => {
    const r = applySpec([file("notes.txt", NOTES)], spec(), { salt: SALT, keep: ["vendor.example.net", "Widgetry"] });
    const out = text(r, "notes.txt");
    expect(out).toContain("api.vendor.example.net");
    expect(out).not.toContain("db01.example.com");
    expect(out).not.toContain("badvendor.example.net");
    // The keep list keeps host names only; an email under the domain is still blinded.
    expect(out).not.toContain("ops@vendor.example.net");
    expect(r.files[0]?.keptHosts).toBe(1);
    expect(r.files[0]?.patternReplacements).toBe(3);
  });

  test("without a keep list every host is replaced", () => {
    const r = applySpec([file("notes.txt", NOTES)], spec(), { salt: SALT });
    expect(text(r, "notes.txt")).not.toContain("vendor.example.net");
    expect(r.files[0]?.keptHosts).toBe(0);
  });

  test("keepDomains takes only domain-shaped terms; matching is by whole labels", () => {
    expect(keepDomains(["Vendor.Example.NET", "*.cdn.example.org", "net", "Widgetry", "two words.example", ""])).toEqual([
      "cdn.example.org",
      "vendor.example.net",
    ]);
    const d = keepDomains(["vendor.example.net"]);
    expect(underKeptDomain("vendor.example.net", d)).toBe(true);
    expect(underKeptDomain("API.vendor.example.net.", d)).toBe(true);
    expect(underKeptDomain("badvendor.example.net", d)).toBe(false);
    expect(underKeptDomain("vendor.example.net.evil.example", d)).toBe(false);
  });
});

describe("file and folder names (AC2)", () => {
  test("an email in a file name is replaced, keeping the extension; the report maps the names", () => {
    const r = applySpec([file("inbox/avery.quill@example.com.txt", "hello\n")], spec(), { salt: SALT });
    const renamed = outPath(r, "inbox/avery.quill@example.com.txt");
    expect(renamed).not.toContain("avery");
    expect(renamed).toMatch(/^inbox\/[^/@]+@[^/]+\.txt$/);
    expect(r.outputs.map((o) => o.path)).toEqual([renamed]);
  });

  test("a host or IP joined to other words by an underscore is still found", () => {
    const r = applySpec([file("backup_db01.example.com_192.0.2.7.txt", "x\n"), file("avery_quill@example.com.txt", "y\n")], spec(), {
      salt: SALT,
    });
    const host = outPath(r, "backup_db01.example.com_192.0.2.7.txt");
    expect(host).toMatch(/^backup_[^_]+\.[a-z]+_\d+\.\d+\.\d+\.\d+\.txt$/);
    expect(host).not.toContain("db01");
    expect(host).not.toContain("192.0.2.7");
    // A column value next to an email joined by an underscore: both are found.
    const r2 = applySpec([file("staff.csv", STAFF), file("Robin Example_avery@example.com.md", "z\n")], STAFF_SPEC, { salt: SALT });
    expect(outPath(r2, "Robin Example_avery@example.com.md")).toMatch(/^Person_[0-9A-F]{4}_user_[0-9a-f]+@[^/]+\.md$/);
    // An underscore inside an email's local part stays part of the email.
    expect(outPath(r, "avery_quill@example.com.txt")).toMatch(/^[^_@]+_?[^@]*@[^/]+\.txt$/);
    expect(outPath(r, "avery_quill@example.com.txt")).not.toContain("quill");
  });

  test("a GUID in a folder name becomes a GUID-shaped pseudonym", () => {
    const guid = "123e4567-e89b-12d3-a456-426614174000";
    const r = applySpec([file(`runs/${guid}/run.log`, "ok\n")], spec(), { salt: SALT });
    const renamed = outPath(r, `runs/${guid}/run.log`);
    expect(renamed).not.toContain(guid);
    expect(renamed).toMatch(/^runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/run\.log$/);
  });

  test("names use the same pseudonym as the content: entities and column values", () => {
    const r = applySpec(
      [
        file("staff.csv", STAFF),
        file("reviews/Robin Example.md", "Robin Example did well.\n"),
        file("ZX-4473-S/notes.txt", "see the ticket\n"),
        file("Avery 1-1.md", "Avery and Aves\n"),
      ],
      STAFF_SPEC,
      { salt: SALT },
    );
    const staff = text(r, "staff.csv").split("\n");
    const robin = (staff[2] as string).split(",")[0] as string;
    const ref = (staff[3] as string).split(",")[1] as string;
    expect(robin).toMatch(/^Person_[0-9A-F]{4}$/);
    expect(ref).toMatch(/^Value_[0-9A-F]{4}$/);
    expect(outPath(r, "reviews/Robin Example.md")).toBe(`reviews/${robin}.md`);
    expect(outPath(r, "ZX-4473-S/notes.txt")).toBe(`${ref}/notes.txt`);
    // Column values are matched only in names, not in a document body.
    expect(text(r, `${ref}/notes.txt`)).toBe("see the ticket\n");
    const avery = outPath(r, "Avery 1-1.md");
    expect(avery).toMatch(/^Person_[0-9A-F]{4} 1-1\.md$/);
    expect(text(r, avery)).toBe(`${avery.split(" ")[0]} and ${avery.split(" ")[0]}\n`);
  });

  test("a JSON value a key-path rule blinds is blinded in a folder name too; kept JSON hosts are counted", () => {
    const json = '{"items": [{"ticket": "ZX-4471-Q", "url": "api.vendor.example.net"}, {"ticket": "ZX-4472-R", "url": "x"}]}\n';
    const keyRule: ColumnRule = { file: "t.json", jsonPath: "$.items[*].ticket", class: "id", treatment: "blind", confidence: 1, source: "human" };
    const r = applySpec([file("t.json", json), file("ZX-4471-Q/notes.txt", "hi\n")], spec({ columns: [keyRule] }), {
      salt: SALT,
      keep: ["vendor.example.net"],
    });
    const ticket = JSON.parse(text(r, "t.json")).items[0].ticket as string;
    expect(ticket).not.toBe("ZX-4471-Q");
    expect(outPath(r, "ZX-4471-Q/notes.txt")).toBe(`${ticket}/notes.txt`);
    expect(r.files.find((f) => f.path === "t.json")?.keptHosts).toBe(1);
  });

  test("names with nothing to replace are kept, and a kept vendor host in a folder name stays", () => {
    const r = applySpec(
      [file("docs/report.md", "plain\n"), file("api.vendor.example.net/config.txt", "plain\n")],
      spec(),
      { salt: SALT, keep: ["vendor.example.net"] },
    );
    expect(outPath(r, "docs/report.md")).toBe("docs/report.md");
    expect(outPath(r, "api.vendor.example.net/config.txt")).toBe("api.vendor.example.net/config.txt");
  });

  test("same output whatever the input order", () => {
    const inputs = [file("Avery/a.txt", "Avery\n"), file("hosts/db01.example.com.txt", "x\n"), file("staff.csv", STAFF)];
    const a = applySpec(inputs, STAFF_SPEC, { salt: SALT });
    const b = applySpec([...inputs].reverse(), STAFF_SPEC, { salt: SALT });
    expect(b.outputs).toEqual(a.outputs);
    expect(b.files).toEqual(a.files);
  });

  test("two inputs whose blinded names coincide are refused", () => {
    expect(() => applySpec([file("Avery.txt", "a\n"), file("Aves.txt", "b\n")], spec(), { salt: SALT })).toThrow(ApplyError);
    expect(() => applySpec([file("Avery.txt", "a\n"), file("Aves.txt", "b\n")], spec(), { salt: SALT })).toThrow(
      /would both be written as Person_[0-9A-F]{4}\.txt/,
    );
  });
});

// A stand-in for a workbook handler: it lists its sheet and defined names at plan
// time and asks for each blinded name while rendering, as the XLSX handler will.
const fakeWorkbook = (names: { slot: NameSlot; name: string }[]) => ({
  plan: (rewriter: NameRewriter) => {
    for (const n of names) rewriter.plan(n.slot, n.name);
  },
  render: (rename: (slot: NameSlot, name: string) => string) => names.map((n) => rename(n.slot, n.name)),
});

function runHandler(names: { slot: NameSlot; name: string }[]) {
  const matcher = new EntityMatcher(spec().entities);
  const rewriter = new NameRewriter(matcher, PATTERNS);
  const handler = fakeWorkbook(names);
  handler.plan(rewriter);
  const pz = new Pseudonymizer({ salt: SALT, entities: { person: spec().entities.person } });
  const wanted = rewriter.requests().map((r) => `${r.cls}\0${r.value}`);
  for (const w of [...new Set(wanted)].sort()) {
    const [cls, value] = w.split("\0") as ["person", string];
    pz.pseudonym(cls, value);
  }
  return { out: handler.render((slot, name) => rewriter.rename(slot, name, pz)), pz };
}

describe("sheet and defined-name hook (AC3)", () => {
  test("a handler's sheet and defined names are blinded with the shared pseudonyms", () => {
    const { out, pz } = runHandler([
      { slot: "sheet", name: "Avery Quill" },
      { slot: "sheet", name: "Summary" },
      { slot: "definedName", name: "Avery_Budget" },
    ]);
    const person = pz.pseudonym("person", "Avery Quill");
    expect(out).toEqual([person, "Summary", `${person}_Budget`]);
  });

  test("a blinded sheet name that breaks the worksheet naming rules is refused, not written", () => {
    // Each 4-letter alias becomes an 11-character pseudonym, past the 31-character limit.
    expect(() => runHandler([{ slot: "sheet", name: "Aves Aves Aves Aves Aves Aves" }])).toThrow(NameError);
    expect(() => runHandler([{ slot: "sheet", name: "Aves Aves Aves Aves Aves Aves" }])).toThrow(/longer than 31/);
    expect(() => runHandler([{ slot: "definedName", name: "Ops.db01.example.com" }])).toThrow(/not a valid defined name/);
  });

  test("an unchanged name is never refused, and an unplanned name cannot be renamed", () => {
    expect(runHandler([{ slot: "sheet", name: "Q3 [draft]" }]).out).toEqual(["Q3 [draft]"]);
    const rewriter = new NameRewriter(new EntityMatcher({}), PATTERNS);
    expect(() => rewriter.rename("sheet", "Summary", new Pseudonymizer({ salt: SALT }))).toThrow(/not planned/);
  });
});
