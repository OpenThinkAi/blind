import { describe, expect, test } from "bun:test";
import { OfficeIds, rewriteOfficeId } from "../../src/engine/officeid.ts";
import { Pseudonymizer } from "../../src/engine/pseudonym.ts";
import { officeLinkAttribute, officeLinkText } from "../../src/formats/officeids.ts";

const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 3);

describe("Office linking IDs (AGT-1791)", () => {
  test("hex ids keep their length and case, never equal the original, and repeat consistently", () => {
    const ids = new OfficeIds(SALT);
    for (const v of ["00A1B2C3", "1a2b3c4d", "0409", "FFFFFFFF", "00000001"]) {
      const out = ids.hex(v);
      expect(out).toHaveLength(v.length);
      expect(out.toLowerCase()).not.toBe(v.toLowerCase());
      expect(out).toMatch(v === v.toUpperCase() ? /^[0-9A-F]+$/ : /^[0-9a-f]+$/);
      expect(ids.hex(v)).toBe(out);
      if (/[A-Fa-f]/.test(v)) expect(ids.hex(v.toLowerCase())).toBe(out.toLowerCase());
    }
    expect(new OfficeIds(SALT).hex("00A1B2C3")).toBe(ids.hex("00A1B2C3"));
    expect(new OfficeIds(Uint8Array.from({ length: 32 }, (_, i) => i + 4)).hex("00A1B2C3")).not.toBe(ids.hex("00A1B2C3"));
  });

  test("an 8-digit id under 0x80000000 stays under it and non-zero; distinct ids stay distinct", () => {
    const ids = new OfficeIds(SALT);
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const v = (i * 2654435761 % 0x80000000).toString(16).toUpperCase().padStart(8, "0");
      const out = ids.hex(v);
      const n = Number.parseInt(out, 16);
      expect(n > 0 && n < 0x7fffffff).toBe(true);
      seen.add(out);
    }
    expect(seen.size).toBe(3000);
  });

  test("GUIDs get an id pseudonym, braces and case kept; documentId keeps its prefix; anything else is replaced whole", () => {
    const pz = new Pseudonymizer({ salt: SALT });
    const ids = new OfficeIds(SALT);
    const g = "{3F2504E0-4F89-41D3-9A0C-0305E82C3301}";
    const out = rewriteOfficeId("id", g, pz, ids);
    expect(out).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
    expect(rewriteOfficeId("id", g.slice(1, -1).toLowerCase(), pz, ids)).toBe(out.slice(1, -1).toLowerCase());
    expect(rewriteOfficeId("id", "{00000000-0000-0000-0000-000000000000}", pz, ids)).toMatch(/^\{[0-9A-F-]{36}\}$/);
    expect(pz.isPseudonym(out)).toBe(true);
    const doc = rewriteOfficeId("documentId", `13_ncr:1_${g}_{8D2C4B6A-1E3F-4A5B-9C7D-0E2F4A6B8C1D}`, pz, ids);
    expect(doc).toMatch(/^13_ncr:1_\{[0-9A-F-]{36}\}_\{[0-9A-F-]{36}\}$/);
    expect(doc.split("_")[2]).toBe(out);
    expect(rewriteOfficeId("documentId", "11_F25DC773A252ABDACC10", pz, ids)).toMatch(/^11_[0-9A-F]{20}$/);
    expect(rewriteOfficeId("id", "Avery Quill", pz, ids)).toMatch(/^Id_[0-9A-F]{4}$/);
    expect(rewriteOfficeId("documentId", "8_Avery", pz, ids)).toMatch(/^Id_[0-9A-F]{4}$/);
    expect(rewriteOfficeId("id", "", pz, ids)).toBe("");
  });

  test("positions are matched by element and attribute, never by value", () => {
    expect(officeLinkAttribute("w:p", "w:rsidRDefault")).toBe("id");
    expect(officeLinkAttribute("w:p", "w14:paraId")).toBe("id");
    expect(officeLinkAttribute("worksheet", "xr:uid")).toBe("id");
    expect(officeLinkAttribute("xr:revisionPtr", "documentId")).toBe("documentId");
    expect(officeLinkAttribute("xr:revisionPtr", "xr10:uidLastSave")).toBe("id");
    expect(officeLinkAttribute("w:docId", "w15:val")).toBe("id");
    expect(officeLinkAttribute("ds:datastoreItem", "ds:itemID")).toBe("id");
    expect(officeLinkAttribute("thm15:themeFamily", "id")).toBeNull();
    expect(officeLinkAttribute("w:tmpl", "w:val")).toBeNull();
    expect(officeLinkAttribute("w:p", "rsidR")).toBeNull();
    expect(officeLinkAttribute("w:t", "w:val")).toBeNull();
    expect(officeLinkAttribute("w:p", "xmlns:uid")).toBeNull();
    expect(officeLinkText("x14:id", "ext")).toBe(true);
    expect(officeLinkText("id", "ext")).toBe(false);
    expect(officeLinkText("x14:id", "cfRule")).toBe(false);
  });
});
