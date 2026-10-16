// AGT-1939: a name-safe class-word shape (`Host_A_1234`) reads as an ordinary identifier, so it is a
// pseudonym only when the map confirms it. Synthetic data only.
import { describe, expect, test } from "bun:test";
import { type AuditReport, auditTree, type Finding, type TreeEntry } from "../../src/audit/mechanical.ts";
import { addSemanticLayer } from "../../src/audit/semantic.ts";
import type { BlindMap } from "../../src/engine/map.ts";
import { isPseudonym, nameSafe } from "../../src/engine/pseudonym.ts";
import type { Spec } from "../../src/schema.ts";
import { makeZip } from "./zipfixture.ts";

const SPEC: Spec = {
  version: 1,
  columns: [],
  entities: { vocabulary: [] },
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const MAP: BlindMap = { version: 1, entries: [{ kind: "person", canonical: "x", value: "x", pseudonym: "[Client A #7F3A]" }] };

const file = (path: string, data: Uint8Array | string): TreeEntry => ({ path, kind: "file", bytes: typeof data === "string" ? Buffer.from(data, "utf8") : data });
const audit = (entries: TreeEntry[], map: BlindMap = MAP): AuditReport => addSemanticLayer(auditTree(entries, SPEC, map), entries, SPEC, map, { keep: [] });
const all = (r: AuditReport): Finding[] => [...r.files.flatMap((f) => f.findings), ...r.general];
const accounts = (r: AuditReport): Finding[] => all(r).filter((f) => f.class === "account");
const docx = (account: string): Uint8Array =>
  makeZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>` },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>`,
    },
    { name: "docProps/app.xml", data: `<?xml version="1.0"?><Properties><Template>C:\\Users\\${account}\\AppData\\Normal.dotm</Template></Properties>` },
  ]);

describe("name-safe shapes need the map", () => {
  test("a Host_A_1234 token not in the map is reported by the semantic layer", () => {
    for (const tok of ["Host_A_1234", "Id_A_1234", "Value_A_1234", "Org_AB_1234"]) {
      const r = audit([file("notes.txt", `see ${tok} here\n`)]);
      expect(all(r).length).toBeGreaterThan(0);
    }
  });

  test("an account path segment shaped like a twin that is not in the map is a leak", () => {
    const r = audit([file("memo.docx", docx("Host_A_1234"))]);
    expect(accounts(r).some((f) => f.severity === "leak")).toBe(true);
  });

  test("the name-safe twin of a map pseudonym stays clean", () => {
    const twin = nameSafe("[Client A #7F3A]");
    expect(twin).toBe("Client_A_7F3A");
    expect(isPseudonym(twin, MAP)).toBe(true);
    expect(all(audit([file("notes.txt", `see ${twin} here\n`)]))).toEqual([]);
    expect(accounts(audit([file("memo.docx", docx(twin))]))).toEqual([]);
  });

  test("a class-word shape is a pseudonym by shape alone only without a map", () => {
    expect(isPseudonym("Host_A_1234", MAP)).toBe(false);
    expect(isPseudonym("Host_A_1234", { version: 1, entries: [{ kind: "host", canonical: "h", value: "h", pseudonym: "[Host A #1234]" }] })).toBe(true);
  });

  test("compact and bracketed forms are unchanged", () => {
    expect(isPseudonym("Person_A7F3", MAP)).toBe(true);
    expect(isPseudonym("[Client A #7F3A]", MAP)).toBe(true);
    expect(isPseudonym("Person_A7F3")).toBe(true);
    expect(all(audit([file("notes.txt", "see Person_A7F3 here\n")]))).toEqual([]);
    expect(accounts(audit([file("memo.docx", docx("Person_A7F3"))]))).toEqual([]);
  });
});
