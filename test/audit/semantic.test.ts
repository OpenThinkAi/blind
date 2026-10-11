import { describe, expect, test } from "bun:test";
import { type AuditReport, auditTree, type Finding, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer, MAX_PER_FILE, semanticFindings, xmlViews } from "../../src/audit/semantic.ts";
import { applySpec } from "../../src/engine/apply.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";
import { makeZip } from "./zipfixture.ts";

// Synthetic data only: invented names, example.com, RFC 5737 addresses.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 23);

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
    rule("staff.csv", "Stage", "vocabulary", "keep"),
    rule("staff.csv", "Ref Code", "id", "blind"),
  ],
  entities: {
    person: [{ canonical: "Avery Quill", aliases: [], parts: ["Avery"] }],
    org: [{ canonical: "Example Widgets", aliases: ["EXW"], parts: [] }],
    vocabulary: [{ canonical: "Spring Planning Review", aliases: [], parts: [] }],
  },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};

const STAFF = "Owner,Stage,Ref Code\nAvery Quill,In Progress,ZX-4471-Q\nAvery Quill,Not Started,ZX-4472-R\n";
const NOTES =
  "Avery from EXW mailed avery@example.com about db01.example.com (192.0.2.10), ticket 123e4567-e89b-12d3-a456-426614174000.\n" +
  "Example Widgets joined the Spring Planning Review on 2026-10-11T09:30:00Z.\n";

const EMPTY_MAP: BlindMap = { version: 1, entries: [] };

const file = (path: string, data: Uint8Array | string): TreeEntry => ({
  path,
  kind: "file",
  bytes: typeof data === "string" ? Buffer.from(data, "utf8") : data,
});

function kit(): { entries: TreeEntry[]; map: BlindMap } {
  const r = applySpec(
    [
      { path: "staff.csv", bytes: Buffer.from(STAFF) },
      { path: "notes/notes.md", bytes: Buffer.from(NOTES) },
    ],
    SPEC,
    { salt: SALT },
  );
  return { entries: [{ path: "notes", kind: "dir" }, ...r.outputs.map((o) => file(o.path, o.bytes))], map: r.map };
}

/** Both layers, as `blind audit` runs them. */
function audit(entries: TreeEntry[], spec: Spec = SPEC, map: BlindMap = EMPTY_MAP, keep: string[] = []): AuditReport {
  return addSemanticLayer(auditTree(entries, spec, map, keep), entries, spec, map, { keep });
}

const semantic = (r: AuditReport): Finding[] => r.files.flatMap((f) => f.findings).filter((f) => f.source === "semantic");
const classes = (r: AuditReport): string[] => semantic(r).map((f) => f.class);

describe("semantic layer", () => {
  test("a clean kit of pseudonyms is clean, with both layers recorded", () => {
    const { entries, map } = kit();
    const r = audit(entries, SPEC, map);
    expect(semantic(r)).toEqual([]);
    expect(r.status).toBe("clean");
    expect(r.layers).toEqual(["mechanical", "semantic"]);
    expect(r.summary).toEqual({ files: 2, leaks: 0, candidates: 0 });
  });

  test("a planted unknown hex ID and an unlisted organisation name are candidates, with location and masked text", () => {
    const { entries, map } = kit();
    const extraText = "line one\nBuild a3fbc2de went to Northwind Harbor Supply today.\n";
    entries.push(file("extra.txt", extraText));
    const r = audit(entries, SPEC, map);
    expect(r.status).toBe("candidates");
    const extra = r.files.find((f) => f.path === "extra.txt");
    expect(extra?.status).toBe("candidates");
    expect(extra?.findings).toEqual([
      expect.objectContaining({ class: "semantic:hex", source: "semantic", severity: "candidate", offset: extraText.indexOf("a3fb"), line: 2, masked: "a3***8", in: "content" }),
      expect.objectContaining({ class: "semantic:phrase", source: "semantic", severity: "candidate", offset: extraText.indexOf("Northwind"), line: 2, masked: "No***23" }),
    ]);
    expect(JSON.stringify(r)).not.toContain("Northwind");
    expect(JSON.stringify(r)).not.toContain("a3fbc2de");
  });

  test("identifier shapes: mixed letters and 4+ digits, 10-16 digit runs, emails and hosts", () => {
    const text = [
      "ref PRJ-48213 and acct 4820193746215 by dana@corp.example.net on build.corp.example.net",
      "not: 2026-10-11T09:30:00Z 45210.416666666664 12345 deface notes.md e.g. Id_12AB 192.0.2.7",
    ].join("\n");
    const r = audit([file("a.txt", text)]);
    expect(classes(r)).toEqual(["semantic:alnum-id", "semantic:digits", "semantic:email", "semantic:host"]);
  });

  test("pseudonyms recognised by the map (GUIDs, numeric IDs) are not candidates", () => {
    const map: BlindMap = {
      version: 1,
      entries: [
        { kind: "id", canonical: "x1", value: "x1", pseudonym: "5820193746" },
        { kind: "id", canonical: "x2", value: "x2", pseudonym: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0" },
      ],
    };
    const text = "seen 5820193746 and 0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0 and user_1a2b@host-3c4d.com on host-5e6f.host-7a8b.net, Person_A7F3 Org_2C9E\n";
    expect(semantic(audit([file("a.txt", text)], SPEC, map))).toEqual([]);
    // Without the map they are unexplained.
    expect(classes(audit([file("a.txt", text)]))).toEqual(["semantic:digits", "semantic:alnum-id"]);
  });

  test("the keep list, vocabulary forms, vocabulary column values and the spec's headers explain phrases", () => {
    const csv = "Owner,Stage,Ref Code\nPerson_A7F3,In Progress,Id_1A2B\nPerson_A7F3,Northwind Harbor,Id_1A2C\n";
    const notes = "The Spring Planning Review covered Quarterly Close Northwind Harbor and Harbor Supply Quarterly Close.\n";
    const r = audit([file("staff.csv", csv), file("notes.md", notes)], SPEC, EMPTY_MAP, ["Quarterly Close"]);
    const got = semantic(r).map((f) => [f.file, f.class, f.masked]);
    // "Northwind Harbor" is a vocabulary value in staff.csv only; in notes.md it is unexplained.
    expect(got).toEqual([
      ["notes.md", "semantic:phrase", "No***16"],
      ["notes.md", "semantic:phrase", "Ha***13"],
    ]);
  });

  test("hosts under a keep-list domain and format-structure hosts are not candidates", () => {
    const text = "see api.vendor.example.org and http://schemas.openxmlformats.org/x but not build.other.example.org\n";
    const r = audit([file("a.txt", text)], SPEC, EMPTY_MAP, ["vendor.example.org"]);
    expect(semantic(r).map((f) => [f.class, f.masked])).toEqual([["semantic:host", "bu***23"]]);
  });

  test("candidates are deduplicated by value, counting the places, and capped per file with a count of the rest", () => {
    const repeated = audit([file("a.txt", "ZQ-90812 then ZQ-90812\nand ZQ-90812\n")]);
    expect(semantic(repeated)).toEqual([expect.objectContaining({ class: "semantic:alnum-id", offset: 0, reason: expect.stringContaining("(3 places in this file)") })]);

    const many = Array.from({ length: MAX_PER_FILE + 50 }, (_, i) => `ab${(0x100000 + i).toString(16)}9`).join(" ");
    const r = audit([file("many.txt", many), file("one.txt", "ab12cd34ef\n")]);
    const inMany = semantic(r).filter((f) => f.file === "many.txt");
    expect(inMany.length).toBe(MAX_PER_FILE + 1);
    const more = inMany.find((f) => f.class === "semantic:more");
    expect(more?.reason).toContain("50 more distinct semantic candidates");
    expect(semantic(r).filter((f) => f.file === "one.txt").length).toBe(1);
    expect(r.summary.candidates).toBe(MAX_PER_FILE + 2);
  });

  test("names are read: file, directory and zip member names (each entry's own name)", () => {
    const entries: TreeEntry[] = [
      { path: "Northwind Harbor", kind: "dir" },
      file("Northwind Harbor/x.txt", "nothing\n"),
      file("kit.zip", makeZip([{ name: "Dana Example notes.txt", data: "nothing" }])),
    ];
    const r = audit(entries);
    expect(semantic(r).map((f) => [f.file, f.part, f.in, f.class])).toEqual([
      ["Northwind Harbor", "", "name", "semantic:phrase"],
      ["kit.zip", "Dana Example notes.txt", "name", "semantic:phrase"],
    ]);
    expect(r.files.find((f) => f.path === "Northwind Harbor")).toEqual(expect.objectContaining({ kind: "dir", status: "candidates" }));
  });

  test("a blinded name made of pseudonyms joined by underscores is not a candidate; a real host piece is", () => {
    const r = audit([file("Person_1E95_user_559f@host-f3ce.com.md", "x\n"), file("backup_db01.example.com.txt", "x\n")]);
    expect(semantic(r).map((f) => [f.file, f.class, f.masked])).toEqual([["backup_db01.example.com.txt", "semantic:host", "db***16"]]);
  });

  test("XML members: runs are joined, attribute values are read, structural attributes are not", () => {
    const doc =
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:p w:rsidR="00A1B2C3" w14:paraId="1A2B3C4D"><w:r><w:rPr><w:b/><w:color w:val="1F3864"/></w:rPr><w:t>Northwind</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve"> Harbor</w:t></w:r></w:p><w:p><w:r><w:t>Status</w:t></w:r></w:p>' +
      '<w:comment w:author="Dana Example" w:initials="DE"/></w:document>';
    const r = audit([file("memo.docx", makeZip([{ name: "word/document.xml", data: doc }]))]);
    const got = semantic(r);
    expect(got.map((f) => [f.part, f.class, f.masked])).toEqual([
      ["word/document.xml", "semantic:phrase", "No***16"],
      ["word/document.xml", "semantic:phrase", "Da***12"],
    ]);
    // Offsets point at the bytes in the member.
    expect(doc.slice(got[0]?.offset ?? 0).startsWith("Northwind")).toBe(true);
    expect(doc.slice(got[1]?.offset ?? 0).startsWith("Dana Example")).toBe(true);
  });

  test("xmlViews keeps paragraphs apart and maps every character back to its byte", () => {
    const v = { encoding: "latin-1", text: "<a><t>Ab</t></a><b x='Cd Ef'>Gh</b>", byteAt: (i: number) => i };
    const [text, attrs] = xmlViews(v);
    expect(text?.text).toBe("Ab\nGh");
    expect(attrs?.text).toBe("Cd Ef\n");
    expect(text?.byteAt(3)).toBe(29);
  });

  test("semantic candidates never downgrade a leak, and declared unknowns keep a file from clean", () => {
    const leaking = audit([file("a.txt", "Avery Quill was here\n")]);
    expect(leaking.status).toBe("leak");
    expect(leaking.files[0]?.findings.map((f) => f.severity)).toEqual(["leak", "candidate"]);
    const spec: Spec = { ...SPEC, columns: [...SPEC.columns, rule("b.csv", "Notes", "unknown", "value")] };
    const unknown = audit([file("b.csv", "Notes\nValue_1A2B\n")], spec);
    expect(semantic(unknown)).toEqual([]);
    expect(unknown.status).toBe("candidates");
  });

  test("the same tree gives the same findings", () => {
    const entries = [file("a.txt", "Northwind Harbor a3f9c21e ZQ-90812 dana@corp.example.net\n")];
    expect(semanticFindings(entries, SPEC, EMPTY_MAP, { keep: [] })).toEqual(semanticFindings(entries, SPEC, EMPTY_MAP, { keep: [] }));
  });
});
