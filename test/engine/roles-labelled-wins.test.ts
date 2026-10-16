import { describe, expect, test } from "bun:test";
import { type ApplyResult, applySpec, type InputFile } from "../../src/engine/apply.ts";
import type { ColumnRule, Spec } from "../../src/schema.ts";

// Synthetic salt and data only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 21);

const rule = (file: string, header: string, cls: ColumnRule["class"] = "org"): ColumnRule =>
  ({ file, header, class: cls, treatment: "blind", confidence: 1, source: "human" }) as ColumnRule;

const spec = (columns: ColumnRule[], entities: Spec["entities"] = {}): Spec => ({
  version: 1,
  columns,
  entities,
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
});

const file = (path: string, text: string): InputFile => ({ path, bytes: Buffer.from(text, "utf8") });
const out = (r: ApplyResult, path: string): string => Buffer.from(r.outputs.find((o) => o.path === path)?.bytes ?? new Uint8Array()).toString("utf8");
const READABLE = /\[([A-Za-z ]+?) ([A-Z]+) #[0-9A-F]{4}\]/g;
const labels = (s: string): string[] => [...s.matchAll(READABLE)].map((m) => m[1] as string);

describe("a labelled request beats an earlier unlabelled mention (AGT-1957)", () => {
  const inputs = [
    file("a.csv", "Counterparty Label\nQuillfeather Holdings\n"),
    file("note.txt", "Call Quillfeather about the invoice.\n"),
  ];
  const s = spec([rule("a.csv", "Counterparty Label")], { org: [{ canonical: "Quillfeather Holdings", aliases: ["Quillfeather"], parts: [] }] });

  test("unlabelled mention sorting first does not drop the column's label", () => {
    const r = applySpec(inputs, s, { salt: SALT, pseudonymStyle: "readable" });
    const csv = out(r, "a.csv");
    expect(labels(csv)).toEqual(["Counterparty Label"]);
    const pz = csv.match(READABLE)?.[0] as string;
    expect(out(r, "note.txt")).toContain(pz);
  });

  test("only unlabelled mentions take the class word", () => {
    const r = applySpec([file("note.txt", "Call Quillfeather Holdings and Quillfeather.\n")], spec([], { org: [{ canonical: "Quillfeather Holdings", aliases: ["Quillfeather"], parts: [] }] }), { salt: SALT, pseudonymStyle: "readable" });
    expect(labels(out(r, "note.txt")).length).toBe(2);
    for (const l of labels(out(r, "note.txt"))) expect(l).toBe("Org");
  });

  test("two columns labelling one entity keep a single label", () => {
    const r = applySpec(
      [file("b.csv", "Vendor,Payer\nQuillfeather Holdings,Quillfeather Holdings\n")],
      spec([rule("b.csv", "Vendor"), rule("b.csv", "Payer")]),
      { salt: SALT, pseudonymStyle: "readable" },
    );
    const l = labels(out(r, "b.csv"));
    expect(l.length).toBe(2);
    expect(l[0]).toBe(l[1] as string);
  });

  test("deterministic across two applies with the written map", () => {
    const a = applySpec(inputs, s, { salt: SALT, pseudonymStyle: "readable" });
    const b = applySpec(inputs, s, { salt: SALT, pseudonymStyle: "readable", map: a.map });
    expect(out(b, "a.csv")).toBe(out(a, "a.csv"));
    expect(out(b, "note.txt")).toBe(out(a, "note.txt"));
  });
});
