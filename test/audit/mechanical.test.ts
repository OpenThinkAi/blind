import { describe, expect, test } from "bun:test";
import { auditTree, type AuditReport, type TreeEntry } from "../../src/audit/mechanical.ts";
import { maskValue } from "../../src/mask.ts";
import { MAX_INFLATE_BYTES, readZip } from "../../src/audit/zip.ts";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { makeZip } from "./zipfixture.ts";

// Synthetic data only: invented names, example.com, RFC 5737 addresses.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 11);

const rule = (file: string, header: string, cls: ColumnRule["class"], treatment: ColumnRule["treatment"]): ColumnRule => ({
  file,
  header,
  class: cls,
  treatment,
  confidence: 1,
  source: "human",
});

const SPEC: Spec = {
  version: 1,
  columns: [
    rule("staff.csv", "Owner", "person", "blind"),
    rule("staff.csv", "Status", "vocabulary", "keep"),
    rule("staff.csv", "Ref Code", "id", "blind"),
  ],
  entities: {
    person: [
      { canonical: "Avery Quill", aliases: ["Quill, Avery"], parts: ["Avery", "May"] },
      { canonical: "Robin Example", aliases: [], parts: [] },
    ],
    org: [{ canonical: "Example Widgets", aliases: ["EXW"], parts: [] }],
    vocabulary: [{ canonical: "May Day Parade", aliases: [], parts: [] }],
  },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const STAFF = "Owner,Status,Ref Code\nAvery Quill,open,ZX-4471-Q\nRobin Example,open,ZX-4472-R\n";
const NOTES =
  "Avery from EXW mailed avery@example.com about db01.example.com (192.0.2.10), ticket 123e4567-e89b-12d3-a456-426614174000.\n" +
  "Robin Example joined the May Day Parade.\n";

const file = (path: string, data: Uint8Array | string): TreeEntry => ({
  path,
  kind: "file",
  bytes: typeof data === "string" ? Buffer.from(data, "utf8") : data,
});

/** A blinded kit: the engine's own output, its map, and the spec. */
function kit(spec: Spec = SPEC): { entries: TreeEntry[]; map: BlindMap } {
  const r = applySpec(
    [
      { path: "staff.csv", bytes: Buffer.from(STAFF) },
      { path: "notes/notes.md", bytes: Buffer.from(NOTES) },
    ],
    spec,
    { salt: SALT },
  );
  return { entries: [{ path: "notes", kind: "dir" }, ...r.outputs.map((o) => file(o.path, o.bytes))], map: r.map };
}

const findings = (r: AuditReport) => [...r.files.flatMap((f) => f.findings), ...r.general];
const leaks = (r: AuditReport) => findings(r).filter((f) => f.severity === "leak");

describe("auditTree", () => {
  test("the engine's own output of a fully specified kit is clean", () => {
    const { entries, map } = kit();
    const r = auditTree(entries, SPEC, map);
    expect(findings(r)).toEqual([]);
    expect(r.status).toBe("clean");
    expect(r.layers).toEqual(["mechanical"]);
    expect(r.files.map((f) => [f.path, f.status])).toEqual([
      ["notes/notes.md", "clean"],
      ["staff.csv", "clean"],
    ]);
  });

  test("a survivor in a deflated zip member, nested one archive deep, is a leak at its member path", () => {
    const { entries, map } = kit();
    const inner = makeZip([
      { name: "word/document.xml", data: "<w:t>Status for </w:t><w:t>Avery Quill</w:t>" },
      { name: "word/styles.xml", data: "<w:style/>", method: 0 },
    ]);
    const outer = makeZip([{ name: "embed/inner.docx", data: inner }]);
    const r = auditTree([...entries, file("report.docx", outer)], SPEC, map);
    expect(r.status).toBe("leak");
    const f = r.files.find((x) => x.path === "report.docx");
    expect(f?.status).toBe("leak");
    expect(f?.findings).toEqual([
      expect.objectContaining({
        part: "embed/inner.docx!word/document.xml",
        in: "content",
        offset: 27,
        class: "person",
        source: "entity",
        severity: "leak",
        masked: "Av***11",
      }),
    ]);
  });

  test("a survivor in a file name, a directory name or a member name is a leak", () => {
    const { entries, map } = kit();
    const zip = makeZip([{ name: "Robin Example/readme.txt", data: "nothing here" }]);
    const r = auditTree(
      [...entries, file("notes/Avery Quill.txt", "nothing here"), { path: "EXW", kind: "dir" }, file("pack.zip", zip)],
      SPEC,
      map,
    );
    expect(r.status).toBe("leak");
    const named = leaks(r).map((f) => [f.file, f.part, f.in, f.offset, f.class]);
    expect(named).toEqual([
      ["EXW", "", "name", 0, "org"],
      ["notes/Avery Quill.txt", "", "name", 6, "person"],
      ["pack.zip", "Robin Example/readme.txt", "name", 0, "person"],
    ]);
  });

  test("a kit with a declared unknown column is candidates, not clean", () => {
    const spec: Spec = { ...SPEC, columns: [...SPEC.columns.slice(0, 2), rule("staff.csv", "Ref Code", "unknown", "value")] };
    const { entries, map } = kit(spec);
    const r = auditTree(entries, spec, map);
    expect(leaks(r)).toEqual([]);
    expect(r.status).toBe("candidates");
    expect(r.files.find((f) => f.path === "staff.csv")?.findings).toEqual([
      expect.objectContaining({ class: "unknown", source: "spec", severity: "candidate", reason: expect.stringContaining("declares column Re***8 as unknown") }),
    ]);
  });

  test("a table column with no spec rule is a candidate", () => {
    const spec: Spec = { ...SPEC, columns: SPEC.columns.slice(0, 2) };
    const { entries, map } = kit(spec);
    const r = auditTree(entries, spec, map);
    expect(r.status).toBe("candidates");
    expect(findings(r).map((f) => f.reason)).toEqual([expect.stringContaining("column 3 (header Re***8) has no spec rule")]);
  });

  test("an unanswered spec question is a candidate", () => {
    const spec: Spec = { ...SPEC, questions: [{ id: "q1", text: "Hide ref codes?", options: ["blind", "keep"], answer: null }] };
    const { entries, map } = kit(spec);
    const r = auditTree(entries, spec, map);
    expect(r.status).toBe("candidates");
    expect(r.general).toEqual([expect.objectContaining({ file: "(spec)", reason: 'spec question "q1" is unanswered' })]);
  });

  test("map values survive detection: a blinded cell value elsewhere is a leak", () => {
    const { entries, map } = kit();
    const r = auditTree([...entries, file("extra.txt", "ref ZX-4472-R and robin example")], SPEC, map);
    expect(leaks(r).map((f) => [f.offset, f.class, f.source, f.masked])).toEqual([
      [4, "id", "map", "ZX***9"],
      [18, "person", "entity", "ro***13"],
    ]);
  });

  test("an 8-bit text file in the output is a leak (AGT-1857), and its raw bytes are still scanned", () => {
    const { entries, map } = kit();
    const r = auditTree([...entries, file("f.txt", Buffer.from("Zoë said EXW", "latin1")), file("g.txt", "Zoë said EXW")], SPEC, map);
    const f = r.files.find((x) => x.path === "f.txt");
    expect(f?.status).toBe("leak");
    expect(f?.findings.some((x) => x.class === "encoding" && x.severity === "leak")).toBe(true);
    expect(f?.findings.some((x) => x.class === "org" && x.severity === "leak")).toBe(true);
    expect(r.files.find((x) => x.path === "g.txt")?.findings.some((x) => x.class === "encoding")).toBe(false);
  });

  test("survivors are found in UTF-16 (either byte order, BOM or not), escapes and Latin-1", () => {
    const { entries, map } = kit();
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("x Avery Quill", "utf16le")]);
    const be = Buffer.from("x Avery Quill", "utf16le").swap16();
    const r = auditTree(
      [
        ...entries,
        file("a.txt", le),
        file("b.txt", be),
        file("c.xml", "<t>Av&#101;ry Qu&#x69;ll</t>"),
        file("d.url", "https://example.org/?q=Avery%20Quill"),
        file("e.json", '{"n":"Avery\\u0020Quill"}'),
      ],
      SPEC,
      map,
    );
    const at = Object.fromEntries(leaks(r).map((f) => [f.file, [f.offset, f.class]]));
    expect(at).toEqual({
      "a.txt": [6, "person"],
      "b.txt": [4, "person"],
      "c.xml": [3, "person"],
      "d.url": [23, "person"],
      "e.json": [6, "person"],
    });
    // Fully read, so no "unscanned" candidate for the BOM-less UTF-16 file.
    expect(findings(r).filter((f) => f.class === "unscanned")).toEqual([]);
  });

  test("pattern matches that are not pseudonyms are leaks; pseudonyms are not", () => {
    const { entries, map } = kit();
    const r = auditTree([...entries, file("p.txt", "from 10.1.2.3 and db07.example.net, also 203.0.113.9 and Person_ABCD")], SPEC, map);
    expect(leaks(r).map((f) => [f.class, f.masked])).toEqual([
      ["pattern:ip", "10***8"],
      ["pattern:host", "db***16"],
    ]);
  });

  test("case rules: other-case forms of a capitalised part or an acronym are candidates, not leaks", () => {
    const { entries, map } = kit();
    const r = auditTree([...entries, file("c.txt", "we may see exw. MAY and EXW.")], SPEC, map);
    const got = findings(r)
      .filter((f) => f.file === "c.txt")
      .map((f) => [f.offset, f.severity]);
    expect(got).toEqual([
      [3, "candidate"],
      [11, "candidate"],
      [16, "leak"],
      [24, "leak"],
    ]);
  });

  test("vocabulary forms shield their words; a value inside a longer word is a candidate", () => {
    const { entries, map } = kit();
    const r = auditTree([...entries, file("v.txt", "The May Day Parade. Averyville.")], SPEC, map);
    expect(findings(r).map((f) => [f.offset, f.severity, f.reason])).toEqual([
      [20, "candidate", "spec person entity, inside a longer word"],
    ]);
  });

  test("an accent or width variant is a candidate", () => {
    const { entries, map } = kit();
    // Both words varied: "Quill" written as it is would be a surviving word of a blinded name (AGT-1801).
    const r = auditTree([...entries, file("w.txt", "Avéry Qüill and Ａｖｅｒｙ")], SPEC, map);
    expect(findings(r).map((f) => f.severity)).toEqual(["candidate", "candidate"]);
  });

  test("parts the audit cannot decode are candidates, and their raw bytes are still scanned", () => {
    const { entries, map } = kit();
    const odd = makeZip([{ name: "a.bin", data: "Avery Quill", method: 99 }]);
    const corrupt = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from(" EXW and junk")]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("zzz")]);
    const r = auditTree(
      [...entries, file("odd.zip", odd), file("bad.zip", corrupt), file("logo.png", png), { path: "link", kind: "symlink", target: "../elsewhere" }],
      SPEC,
      map,
    );
    const by = (p: string) => r.files.find((f) => f.path === p)?.findings.map((f) => [f.severity, f.class, f.reason.split(":")[0]]);
    expect(by("odd.zip")).toEqual([
      ["leak", "person", "spec person entity survives"],
      ["candidate", "unscanned", "compression method 99 not supported, not decoded; its raw bytes were scanned only"],
    ]);
    expect(by("bad.zip")).toEqual([
      ["candidate", "unscanned", "looks like a zip archive but cannot be read (no end-of-central-directory record)"],
      ["leak", "org", "spec org entity survives"],
    ]);
    expect(by("logo.png")).toEqual([["candidate", "unscanned", "PNG image content"]]);
    expect(by("link")).toEqual([["candidate", "unscanned", "symbolic link, not followed"]]);
  });

  test("one file's decompression allowance is shared by its nested archives, and members past it are candidates", () => {
    const { entries, map } = kit();
    const QUARTER = 250 * 1024 * 1024;
    const inner = declareSizes(makeZip([{ name: "x.txt", data: "ok" }, { name: "y.txt", data: "Avery Quill" }]), QUARTER);
    const outer = declareSizes(
      makeZip([{ name: "a.txt", data: "ok" }, { name: "b.txt", data: "ok" }, { name: "c.txt", data: "ok" }, { name: "inner.zip", data: inner }]),
      QUARTER,
      ["a.txt", "b.txt", "c.txt"],
    );
    expect(4 * QUARTER).toBeLessThan(MAX_INFLATE_BYTES);
    expect(5 * QUARTER).toBeGreaterThan(MAX_INFLATE_BYTES);
    const r = auditTree([...entries, file("bomb.zip", outer)], SPEC, map);
    const got = r.files.find((f) => f.path === "bomb.zip")!.findings.filter((f) => f.class === "unscanned");
    expect(got.map((f) => [f.part, f.reason.split(";")[0]])).toEqual([
      ["inner.zip!y.txt", `decompressing it would pass the ${MAX_INFLATE_BYTES}-byte limit for one file, not decoded`],
    ]);
    expect(r.status).not.toBe("clean");
  });

  test("readZip charges a shared budget and reports members past it", () => {
    const zip = makeZip([{ name: "a.txt", data: "123456" }, { name: "s.txt", data: "stored", method: 0 }, { name: "b.txt", data: "123456" }]);
    const budget = { left: 10 };
    const z = readZip(zip, budget);
    expect(z.map((m) => [m.name, m.bytes === undefined ? m.error : Buffer.from(m.bytes).toString()])).toEqual([
      ["a.txt", "123456"],
      ["s.txt", "stored"],
      ["b.txt", `decompressing it would pass the ${MAX_INFLATE_BYTES}-byte limit for one file, not decoded`],
    ]);
    expect(budget.left).toBe(4);
  });

  test("the report never carries a value in full", () => {
    const { entries, map } = kit();
    const r = auditTree([...entries, file("x.txt", "Robin Example, ZX-4471-Q, 10.1.2.3")], SPEC, map);
    const json = JSON.stringify(r);
    for (const v of ["Robin Example", "ZX-4471-Q", "10.1.2.3"]) expect(json).not.toContain(v);
  });

  test("the report is deterministic and independent of entry order", () => {
    const { entries, map } = kit();
    const extra = [file("x.txt", "Avery and EXW"), file("y.txt", "10.1.2.3")];
    const a = auditTree([...entries, ...extra], SPEC, map);
    const b = auditTree([...extra, ...entries].reverse(), SPEC, map);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("maskValue", () => {
  test("first two characters, ***, length; never more than half of a short value", () => {
    expect(maskValue("Avery Quill")).toBe("Av***11");
    expect(maskValue("Bo")).toBe("B***2");
    expect(maskValue("7")).toBe("***1");
    expect(maskValue("a\nb c")).toBe("a?***5");
  });
});

describe("readZip", () => {
  test("reads stored and deflated members", () => {
    const z = readZip(makeZip([{ name: "a.txt", data: "one", method: 0 }, { name: "b.txt", data: "two" }]));
    expect(z.map((m) => [m.name, Buffer.from(m.bytes ?? []).toString()])).toEqual([
      ["a.txt", "one"],
      ["b.txt", "two"],
    ]);
  });
});

describe("keep-list hosts and blinded names (AGT-1737)", () => {
  const VENDOR = "Fetched from api.vendor.example.net and db01.example.com.\n";
  const inputs = [
    { path: "staff.csv", bytes: Buffer.from(STAFF) },
    { path: "backup_db01.example.com/Robin Example_avery@example.com.md", bytes: Buffer.from("hi\n") },
    { path: "123e4567-e89b-12d3-a456-426614174000/vendor.txt", bytes: Buffer.from(VENDOR) },
  ];
  /** The engine's output as a tree, with each output folder as a directory entry. */
  const tree = (keep: string[]) => {
    const r = applySpec(inputs, SPEC, { salt: SALT, keep });
    const dirs = [...new Set(r.outputs.flatMap((o) => (o.path.includes("/") ? [o.path.slice(0, o.path.lastIndexOf("/"))] : [])))];
    const entries: TreeEntry[] = [...dirs.map((d) => ({ path: d, kind: "dir" as const })), ...r.outputs.map((o) => file(o.path, o.bytes))];
    return { entries, map: r.map };
  };

  test("a host the engine kept under a keep-list domain is not a leak when the audit has the same keep list", () => {
    const { entries, map } = tree(["vendor.example.net"]);
    expect(leaks(auditTree(entries, SPEC, map, ["vendor.example.net"]))).toEqual([]);
    // Without the keep list the audit still reports it: the keep list is the only exemption.
    const without = leaks(auditTree(entries, SPEC, map));
    expect(without.map((f) => f.class)).toEqual(["pattern:host"]);
  });

  test("blinded names joined by underscores (pseudonyms side by side) are not leaks", () => {
    const { entries, map } = tree([]);
    const names = entries.map((e) => e.path).join("\n");
    expect(names).not.toMatch(/db01|avery|Robin|123e4567/);
    expect(leaks(auditTree(entries, SPEC, map))).toEqual([]);
  });

  test("an unblinded name with an underscore-joined host or an email before the extension is a leak", () => {
    const { map } = tree([]);
    const r = auditTree([file("backup_db02.example.org.txt", "x\n"), file("ops@example.org.md", "y\n")], SPEC, map);
    expect(leaks(r).map((f) => [f.file, f.in, f.class])).toEqual([
      ["backup_db02.example.org.txt", "name", "pattern:host"],
      ["ops@example.org.md", "name", "pattern:email"],
    ]);
  });

  test("a match made of a pseudonym plus real text is still a leak", () => {
    const { map } = tree([]);
    const person = map.entries.find((e) => e.pseudonym.startsWith("Person_"))?.pseudonym as string;
    const r = auditTree([file("a.txt", `mail ${person}_ops@example.org now\n`)], SPEC, map);
    expect(leaks(r).map((f) => f.class)).toEqual(["pattern:email"]);
  });
});

/** Rewrite the central directory's declared uncompressed size of the named members (all when none named). */
function declareSizes(zip: Uint8Array, size: number, names?: string[]): Uint8Array {
  const b = Buffer.from(zip);
  for (let p = 0; p + 46 <= b.length; p++) {
    if (b.readUInt32LE(p) !== 0x02014b50) continue;
    const name = b.subarray(p + 46, p + 46 + b.readUInt16LE(p + 28)).toString("utf8");
    if (names === undefined || names.includes(name)) b.writeUInt32LE(size, p + 24);
  }
  return b;
}
