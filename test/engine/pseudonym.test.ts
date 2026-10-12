import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IPV4_DOC_PREFIXES,
  isPseudonym,
  MAX_ATTEMPTS,
  type PseudoClass,
  PseudonymError,
  Pseudonymizer,
} from "../../src/engine/pseudonym.ts";

// Synthetic salts only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_SALT = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

const fresh = (opts: Partial<ConstructorParameters<typeof Pseudonymizer>[0]> = {}) =>
  new Pseudonymizer({ salt: SALT, ...opts });

// Golden values pin the derivation: a change here changes every pseudonym in
// every existing corpus, so it must be deliberate.
const GOLDEN: [PseudoClass, string, string][] = [
  ["person", "Ada Lovelace", "Person_D03F"],
  ["org", "Example Widgets, Inc.", "Org_B7BC"],
  ["host", "192.0.2.10", "192.0.2.57"],
  ["host", "app01.corp.example.com", "host-3180.host-56b1.host-72ee.com"],
  ["email", "ada.lovelace@example.com", "user_b865@host-72ee.com"],
  ["id", "0f8fad5b-d9cb-469f-a165-70867728950e", "8d229911-b48b-4a74-aece-b7b7aebd586c"],
  ["id", "004217", "139218"],
  ["id", "98765", "90932"],
  ["id", "AB-12x", "Id_325D"],
  ["location", "Springfield", "Loc_5400"],
  ["value", "zq-7781", "Value_7736"],
  ["host", "fileserver01", "Host_B6B5"],
];

describe("determinism", () => {
  test("golden values for a fixed salt", () => {
    const p = fresh();
    for (const [cls, value, want] of GOLDEN) expect(p.pseudonym(cls, value)).toBe(want);
  });

  test("same input, same output, across instances", () => {
    const a = fresh();
    const b = fresh();
    for (const [cls, value] of GOLDEN) expect(a.pseudonym(cls, value)).toBe(b.pseudonym(cls, value));
  });

  test("repeated calls return the cached pseudonym", () => {
    const p = fresh();
    expect(p.pseudonym("person", "Ada Lovelace")).toBe(p.pseudonym("person", "Ada Lovelace"));
  });

  test("same output in a separate process", async () => {
    const script = `
      import { Pseudonymizer } from ${JSON.stringify(join(import.meta.dir, "../../src/engine/pseudonym.ts"))};
      const p = new Pseudonymizer({ salt: Uint8Array.from({ length: 32 }, (_, i) => i + 1) });
      const cases = ${JSON.stringify(GOLDEN.map(([c, v]) => [c, v]))};
      process.stdout.write(JSON.stringify(cases.map(([c, v]) => p.pseudonym(c, v))));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out)).toEqual(GOLDEN.map(([, , want]) => want));
  });

  test("a different salt gives different output", () => {
    const a = fresh();
    const b = new Pseudonymizer({ salt: OTHER_SALT });
    for (const [cls, value] of GOLDEN) expect(b.pseudonym(cls, value)).not.toBe(a.pseudonym(cls, value));
  });

  test("the class is part of the HMAC input", () => {
    const p = fresh();
    const hex = (s: string) => s.slice(s.indexOf("_") + 1);
    expect(hex(p.pseudonym("person", "Sample"))).not.toBe(hex(p.pseudonym("org", "Sample")));
  });

  test("call order does not matter when nothing collides", () => {
    const values = ["Ada Lovelace", "Bo Quill", "Cy Varden", "Di Ostrander"];
    const fwd = fresh();
    const rev = fresh();
    const a = values.map((v) => fwd.pseudonym("person", v));
    const b = [...values].reverse().map((v) => rev.pseudonym("person", v)).reverse();
    expect(b).toEqual(a);
  });

  test("the engine source never reaches for clocks or randomness", () => {
    const dir = join(import.meta.dir, "../../src/engine");
    for (const f of readdirSync(dir).sort()) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|randomUUID|randomBytes|localeCompare|toLocale/);
    }
  });

  // Deterministic leaf modules the engine shares with the profiler (header rule, word list, the
  // workbook reader), so the two agree on what a header, a dictionary word and a sheet are.
  const SHARED = [
    "node:crypto", "node:fs", "../schema.ts", "../profile/table.ts", "../profile/words.ts", "../formats/ooxml.ts", "../formats/xlsx.ts",
    "../formats/officeids.ts", "../formats/paths.ts",
  ];
  const SHARED_IMPORTS: Record<string, string[]> = {
    "../formats/ooxml.ts": ["node:zlib"],
    "../formats/xlsx.ts": ["./ooxml.ts", "./officeids.ts", "./paths.ts"],
    "../formats/paths.ts": [],
    "../formats/officeids.ts": ["./ooxml.ts"],
    "../profile/table.ts": ["../schema.ts", "./stats.ts", "../engine/csv.ts"],
    "../profile/stats.ts": ["../schema.ts", "./words.ts"],
    "../profile/words.ts": [],
  };

  test("engine modules import only node:crypto, node:fs, each other and shared deterministic leaves", () => {
    const dir = join(import.meta.dir, "../../src/engine");
    for (const f of readdirSync(dir).sort()) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
        const spec = m[1] as string;
        expect(SHARED.includes(spec) || /^\.\/[a-z]+\.ts$/.test(spec)).toBe(true);
      }
    }
    // The shared modules reach only each other and the spec types, which import nothing.
    expect(readFileSync(join(dir, "../schema.ts"), "utf8")).not.toMatch(/\bimport\b|\brequire\(/);
    for (const [mod, allowed] of Object.entries(SHARED_IMPORTS)) {
      const src = readFileSync(join(dir, mod), "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g)) expect(allowed).toContain(m[1] as string);
    }
  });
});

describe("salt and map requirements", () => {
  test("a short salt is refused", () => {
    expect(() => new Pseudonymizer({ salt: new Uint8Array(8) })).toThrow(PseudonymError);
  });

  test("neither salt nor map is refused", () => {
    expect(() => new Pseudonymizer({})).toThrow(PseudonymError);
  });
});

describe("class prefixes", () => {
  const p = fresh();
  for (const [cls, value, re] of [
    ["person", "Bo Quill", /^Person_[0-9A-F]{4}$/],
    ["org", "Sample Holdings", /^Org_[0-9A-F]{4}$/],
    ["host", "buildbox", /^Host_[0-9A-F]{4}$/],
    ["id", "zx-q7", /^Id_[0-9A-F]{4}$/],
    ["value", "teal-otter", /^Value_[0-9A-F]{4}$/],
    ["location", "North Quarry", /^Loc_[0-9A-F]{4}$/],
    // An email-class value with no email shape fails closed to the neutral class.
    ["email", "not an address", /^Value_[0-9A-F]{4}$/],
  ] as const) {
    test(`${cls}: ${value}`, () => expect(p.pseudonym(cls, value)).toMatch(re));
  }
});

describe("canonicalisation reaches the pseudonym", () => {
  test("case and spacing variants share a pseudonym", () => {
    const p = fresh();
    expect(p.pseudonym("person", "ADA  lovelace")).toBe(p.pseudonym("person", "Ada Lovelace"));
  });

  test("org suffix variants share a pseudonym", () => {
    const p = fresh();
    const want = p.pseudonym("org", "Example Widgets");
    for (const v of ["Example Widgets, Inc.", "EXAMPLE WIDGETS LLC", "Example Widgets Pty Ltd"]) {
      expect(p.pseudonym("org", v)).toBe(want);
    }
  });

  test("'Last, First' and 'First Last' share a pseudonym", () => {
    const p = fresh();
    expect(p.pseudonym("person", "Lovelace, Ada")).toBe(p.pseudonym("person", "Ada Lovelace"));
  });

  test("different people get different pseudonyms", () => {
    const p = fresh();
    expect(p.pseudonym("person", "Ada Lovelace")).not.toBe(p.pseudonym("person", "Ada Quill"));
  });
});

describe("entities", () => {
  const entities = {
    person: [
      { canonical: "Ada Lovelace", aliases: ["A. Lovelace", "Countess Ada"], parts: ["Ada", "Lovelace"] },
      { canonical: "Bo Quill", parts: ["Bo", "Quill"] },
    ],
  };

  test("a listed name part maps to its full person", () => {
    const p = fresh({ entities });
    const full = p.pseudonym("person", "Ada Lovelace");
    for (const v of ["Ada", "lovelace", "A. Lovelace", "Countess Ada", "Lovelace, Ada"]) {
      expect(p.pseudonym("person", v)).toBe(full);
    }
    expect(p.pseudonym("person", "Bo")).toBe(p.pseudonym("person", "Bo Quill"));
    expect(p.pseudonym("person", "Bo")).not.toBe(full);
  });

  test("a part resolves the same whichever form is seen first", () => {
    const a = fresh({ entities });
    const b = fresh({ entities });
    expect(a.pseudonym("person", "Ada")).toBe(b.pseudonym("person", "Ada Lovelace"));
  });

  test("the map records the entity's canonical name for reveal", () => {
    const p = fresh({ entities });
    p.pseudonym("person", "Ada");
    expect(p.toMap().entries).toEqual([
      { kind: "person", canonical: "ada lovelace", value: "Ada Lovelace", pseudonym: "Person_D03F" },
    ]);
  });

  test("an unlisted part is its own value", () => {
    const p = fresh({ entities });
    expect(p.pseudonym("person", "Lovelace Ada King")).not.toBe(p.pseudonym("person", "Ada Lovelace"));
    expect(fresh().pseudonym("person", "Ada")).not.toBe(fresh().pseudonym("person", "Ada Lovelace"));
  });

  test("a part claimed by two people is ambiguous: reported, pseudonymized as itself", () => {
    const p = fresh({
      entities: {
        person: [
          { canonical: "Ada Lovelace", parts: ["Ada"] },
          { canonical: "Ada Quill", parts: ["Ada"] },
        ],
      },
    });
    const ada = p.pseudonym("person", "Ada");
    expect(ada).toMatch(/^Person_[0-9A-F]{4}$/);
    expect(ada).not.toBe(p.pseudonym("person", "Ada Lovelace"));
    expect(ada).not.toBe(p.pseudonym("person", "Ada Quill"));
    expect(p.ambiguous).toEqual([{ cls: "person", key: "ada" }]);
  });

  test("entities are per class", () => {
    const p = fresh({ entities });
    expect(p.pseudonym("org", "Ada")).not.toBe(p.pseudonym("org", "Ada Lovelace"));
  });
});

describe("shape preservation", () => {
  describe("IPv4", () => {
    test("maps into a documentation range with a usable host octet", () => {
      const p = fresh();
      for (let i = 1; i <= 50; i++) {
        const out = p.pseudonym("host", `10.20.${i}.${i * 3}`);
        const prefix = out.slice(0, out.lastIndexOf("."));
        const last = Number(out.slice(out.lastIndexOf(".") + 1));
        expect(IPV4_DOC_PREFIXES as readonly string[]).toContain(prefix);
        expect(last).toBeGreaterThanOrEqual(1);
        expect(last).toBeLessThanOrEqual(254);
      }
    });

    test("an out-of-range dotted quad is not treated as IPv4", () => {
      expect(fresh().pseudonym("host", "300.1.1.1")).toMatch(/^host-[0-9a-f]{4}(\.host-[0-9a-f]{4}){3}$/);
    });

    test("a documentation-range input never maps to itself", () => {
      const p = fresh();
      for (let i = 1; i <= 254; i++) expect(p.pseudonym("host", `192.0.2.${i}`)).not.toBe(`192.0.2.${i}`);
    });
  });

  describe("hostnames", () => {
    test("labels are pseudonymized per label and the TLD is kept", () => {
      const p = fresh();
      const a = p.pseudonym("host", "app01.corp.example.com").split(".");
      const b = p.pseudonym("host", "db.corp.example.com").split(".");
      expect(a).toHaveLength(4);
      expect(b).toHaveLength(4);
      expect(a[0]).not.toBe(b[0]);
      expect(a.slice(1)).toEqual(b.slice(1));
      expect(a[3]).toBe("com");
    });

    test("a non-alphabetic last label is pseudonymized too", () => {
      expect(fresh().pseudonym("host", "node7.rack42")).toMatch(/^host-[0-9a-f]{4}\.host-[0-9a-f]{4}$/);
    });

    test("case and trailing dot do not change the pseudonym", () => {
      const p = fresh();
      expect(p.pseudonym("host", "App01.Example.COM.")).toBe(p.pseudonym("host", "app01.example.com"));
    });

    test("a single label uses the Host_ prefix", () => {
      expect(fresh().pseudonym("host", "fileserver01")).toMatch(/^Host_[0-9A-F]{4}$/);
    });
  });

  describe("email", () => {
    test("user_xxxx@ the domain's host pseudonym", () => {
      const p = fresh();
      const email = p.pseudonym("email", "Ada.Lovelace@Mail.Example.org");
      expect(email).toMatch(/^user_[0-9a-f]{4}@host-[0-9a-f]{4}\.host-[0-9a-f]{4}\.org$/);
      expect(email.split("@")[1]).toBe(p.pseudonym("host", "mail.example.org"));
    });

    test("a single-label domain stays DNS-shaped", () => {
      expect(fresh().pseudonym("email", "ops@intranet")).toMatch(/^user_[0-9a-f]{4}@host-[0-9a-f]{4}$/);
    });

    test("the same local part on two domains keeps one user pseudonym", () => {
      const p = fresh();
      const a = p.pseudonym("email", "ada@example.com").split("@");
      const b = p.pseudonym("email", "ada@example.org").split("@");
      expect(a[0]).toBe(b[0] as string);
      expect(a[1]).not.toBe(b[1] as string);
    });
  });

  describe("GUID", () => {
    test("GUID → valid v4 GUID", () => {
      const out = fresh().pseudonym("id", "0f8fad5b-d9cb-469f-a165-70867728950e");
      expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    test("case and braces of the input are preserved; the pseudonym is shared", () => {
      const p = fresh();
      const lower = p.pseudonym("id", "0f8fad5b-d9cb-469f-a165-70867728950e");
      expect(p.pseudonym("id", "{0F8FAD5B-D9CB-469F-A165-70867728950E}")).toBe(`{${lower.toUpperCase()}}`);
    });
  });

  describe("numeric IDs", () => {
    test("numeric → numeric of the same length", () => {
      const p = fresh();
      for (const v of ["7", "42", "98765", "1234567890123456", "9".repeat(80)]) {
        const out = p.pseudonym("id", v);
        expect(out).toMatch(/^\d+$/);
        expect(out).toHaveLength(v.length);
        expect(out).not.toBe(v);
      }
    });

    test("a leading non-zero digit stays non-zero; a leading zero may stay", () => {
      const p = fresh();
      for (let i = 0; i < 200; i++) expect(p.pseudonym("id", String(10_000 + i))[0]).not.toBe("0");
      expect(p.pseudonym("id", "004217")).toHaveLength(6);
    });

    test("mixed alphanumeric ids use the Id_ prefix", () => {
      expect(fresh().pseudonym("id", "AB-12x")).toMatch(/^Id_[0-9A-F]{4}$/);
    });
  });
});

describe("collision handling", () => {
  test("a numeric pseudonym never equals a supplied real value", () => {
    const first = fresh().pseudonym("id", "98765");
    const a = fresh({ avoid: [first] }).pseudonym("id", "98765");
    const b = fresh({ avoid: [first] }).pseudonym("id", "98765");
    expect(a).not.toBe(first);
    expect(a).toMatch(/^\d{5}$/);
    expect(b).toBe(a);
  });

  test("avoidance holds over a dense set of real values", () => {
    // 300 of the 900 three-digit values are real; the other 600 must absorb all 300 pseudonyms.
    const real = Array.from({ length: 300 }, (_, i) => String(100 + i * 3));
    const p = fresh({ avoid: real });
    const avoid = new Set(real);
    for (const v of real) expect(avoid.has(p.pseudonym("id", v))).toBe(false);
  });

  test("a candidate whose suffix token equals an avoided real token is rejected", () => {
    const first = fresh().pseudonym("id", "ledger-ref-1");
    const token = first.slice("Id_".length);
    const out = fresh({ avoid: [token] }).pseudonym("id", "ledger-ref-1");
    expect(out).not.toBe(first);
    expect(out).toMatch(/^Id_[0-9A-F]{4}$/);
    expect(out).not.toContain(token);
    expect(fresh({ avoid: [token] }).pseudonym("id", "ledger-ref-1")).toBe(out);
  });

  test("avoidance applies to GUIDs regardless of case", () => {
    const first = fresh().pseudonym("id", "0f8fad5b-d9cb-469f-a165-70867728950e");
    const out = fresh({ avoid: [first.toUpperCase()] }).pseudonym("id", "0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(out).not.toBe(first);
  });

  test("a GUID candidate with a group equal to an avoided value is rejected (AGT-1805)", () => {
    const v = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const first = fresh().pseudonym("id", v);
    const group = first.split("-")[1] as string;
    const out = fresh({ avoid: [group.toUpperCase()] }).pseudonym("id", v);
    expect(out).not.toBe(first);
    expect(out.split("-").map((g) => g.toLowerCase())).not.toContain(group);
    expect(fresh({ avoid: [group] }).pseudonym("id", v)).toBe(out);
    // Avoiding nothing that matches leaves the golden value alone.
    expect(fresh({ avoid: ["1234"] }).pseudonym("id", v)).toBe(first.split("-")[1] === "1234" ? out : first);
  });

  test("distinct values never share a pseudonym, and the retry is exercised", () => {
    const p = fresh();
    const names = Array.from({ length: 3000 }, (_, i) => `Synthetic Person ${i}`);
    const out = names.map((n) => p.pseudonym("person", n));
    expect(new Set(out).size).toBe(names.length);
    const retried = names.filter((n, i) => fresh().pseudonym("person", n) !== out[i]);
    expect(retried.length).toBeGreaterThan(0);
  });

  test("host labels stay collision-free", () => {
    const p = fresh();
    const out = Array.from({ length: 2000 }, (_, i) => p.pseudonym("host", `n${i}.example.com`));
    expect(new Set(out).size).toBe(out.length);
  });

  test("IPv4 pseudonyms stay distinct until the documentation ranges are exhausted, then throw", () => {
    const p = fresh();
    const out: string[] = [];
    for (let i = 0; i < 762; i++) out.push(p.pseudonym("host", `10.${Math.floor(i / 250)}.${i % 250}.1`));
    expect(new Set(out).size).toBe(762);
    expect(() => p.pseudonym("host", "10.9.9.9")).toThrow(PseudonymError);
  });

  test("the retry is bounded: an exhausted space throws instead of reusing", () => {
    const avoid = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    expect(() => fresh({ avoid }).pseudonym("id", "5")).toThrow(`after ${MAX_ATTEMPTS} attempts`);
  });

  test("errors never quote the value", () => {
    try {
      fresh({ avoid: ["1", "2", "3", "4", "6", "7", "8", "9"] }).pseudonym("id", "5");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("5");
    }
  });
});

describe("isPseudonym", () => {
  const p = fresh();
  for (const [cls, value] of GOLDEN) p.pseudonym(cls, value);
  p.pseudonym("id", "{0F8FAD5B-D9CB-469F-A165-70867728950E}");
  p.pseudonym("email", "ops@intranet");
  const map = p.toMap();

  test("recognises every emitted pseudonym", () => {
    expect(map.entries.length).toBeGreaterThan(GOLDEN.length);
    for (const e of map.entries) {
      expect(p.isPseudonym(e.pseudonym)).toBe(true);
      expect(isPseudonym(e.pseudonym, map)).toBe(true);
    }
    for (const [, , want] of GOLDEN) expect(isPseudonym(want, map)).toBe(true);
    expect(p.isPseudonym("{8D229911-B48B-4A74-AECE-B7B7AEBD586C}")).toBe(true);
  });

  test("shaped forms are recognised without a map", () => {
    for (const s of [
      "Person_D03F", "Org_B7BC", "Host_B6B5", "Id_325D", "Value_7736", "Loc_5400",
      "192.0.2.57", "198.51.100.1", "203.0.113.254",
      "host-3180.host-56b1.host-72ee.com", "user_b865@host-72ee.com", "user_b865@host-72ee",
    ]) {
      expect(isPseudonym(s)).toBe(true);
    }
  });

  test("GUID and numeric pseudonyms are recognised only through the map", () => {
    expect(isPseudonym("8d229911-b48b-4a74-aece-b7b7aebd586c")).toBe(false);
    expect(isPseudonym("90932")).toBe(false);
    expect(isPseudonym("90932", map)).toBe(true);
  });

  test("rejects real-looking values and near misses", () => {
    for (const s of [
      "Ada Lovelace", "Person_D03", "Person_d03f", "Person_D03FF", "Human_D03F", "Value_GGGG",
      "10.0.0.1", "192.0.2.0", "192.0.2.255", "192.0.2.057", "192.0.3.5",
      "app01.example.com", "user_b865@example.com", "ada@host-72ee.com", "host-72ee.com.",
      "12345", "0f8fad5b-d9cb-469f-a165-70867728950e",
    ]) {
      expect(isPseudonym(s, map)).toBe(false);
      expect(p.isPseudonym(s)).toBe(false);
    }
  });
});
