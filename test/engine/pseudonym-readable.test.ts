import { describe, expect, test } from "bun:test";
import { fromNameSafe, isPseudonym, nameSafe, Pseudonymizer } from "../../src/engine/pseudonym.ts";

// Synthetic salts only.
const SALT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const readable = (opts: Partial<ConstructorParameters<typeof Pseudonymizer>[0]> = {}) =>
  new Pseudonymizer({ salt: SALT, style: "readable", ...opts });
const SHAPE = /^\[([A-Za-z0-9 -]+) ([A-Z]+) #([0-9A-F]{4})\]$/;

describe("readable form", () => {
  test("renders [Label Letters #HEX4] with letters per label", () => {
    const p = readable();
    const a = p.pseudonym("person", "Ada Lovelace");
    const b = p.pseudonym("person", "Grace Hopper");
    const o = p.pseudonym("org", "Example Widgets, Inc.");
    const l = p.pseudonym("location", "Springfield");
    const v = p.pseudonym("value", "zq-7781");
    const i = p.pseudonym("id", "AB-12x");
    expect(a).toMatch(/^\[Person A #[0-9A-F]{4}\]$/);
    expect(b).toMatch(/^\[Person B #[0-9A-F]{4}\]$/);
    expect(o).toMatch(/^\[Org A #[0-9A-F]{4}\]$/);
    expect(l).toMatch(/^\[Place A #[0-9A-F]{4}\]$/);
    expect(v).toMatch(/^\[Value A #[0-9A-F]{4}\]$/);
    expect(i).toMatch(/^\[Id A #[0-9A-F]{4}\]$/);
    expect(p.pseudonym("person", "Ada Lovelace")).toBe(a);
  });

  test("optional label argument replaces the class word", () => {
    const p = readable();
    expect(p.pseudonym("person", "Ada Lovelace", "Client")).toMatch(/^\[Client A #[0-9A-F]{4}\]$/);
    expect(p.pseudonym("person", "Grace Hopper", "Account Owner")).toMatch(/^\[Account Owner A #/);
    expect(p.pseudonym("person", "Alan Turing", "Client")).toMatch(/^\[Client B #/);
    expect(p.pseudonym("person", "Edsger Dijkstra")).toMatch(/^\[Person A #/);
  });

  test("emails, hosts, IPv4, GUIDs and numeric IDs keep their shapes", () => {
    const p = readable();
    expect(p.pseudonym("email", "ada@example.com")).toMatch(/^user_[0-9a-f]{4}@host-[0-9a-f]{4}\.com$/);
    expect(p.pseudonym("host", "app01.corp.example.com")).toMatch(/^host-/);
    expect(p.pseudonym("host", "192.0.2.10")).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    expect(p.pseudonym("id", "0f8fad5b-d9cb-469f-a165-70867728950e")).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.pseudonym("id", "98765")).toMatch(/^\d{5}$/);
  });

  test("deterministic for the same input and salt", () => {
    const run = () => {
      const p = readable();
      return ["Ada Lovelace", "Grace Hopper", "Alan Turing"].map((v) => p.pseudonym("person", v));
    };
    expect(run()).toEqual(run());
  });

  test("letters roll over A..Z, AA, AB", () => {
    const p = readable();
    const got = Array.from({ length: 29 }, (_, n) => p.pseudonym("value", `item ${n}`));
    const letters = got.map((g) => (SHAPE.exec(g) as RegExpExecArray)[2]);
    expect(letters.slice(0, 26)).toEqual("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
    expect(letters.slice(26)).toEqual(["AA", "AB", "AC"]);
    expect(new Set(got).size).toBe(29);
  });

  test("a reloaded map pins answers and new letters continue", () => {
    const first = readable();
    const a = first.pseudonym("person", "Ada Lovelace");
    const b = first.pseudonym("person", "Grace Hopper");
    const map = first.toMap();
    const again = readable({ map });
    expect(again.pseudonym("person", "Grace Hopper")).toBe(b);
    expect(again.pseudonym("person", "Ada Lovelace")).toBe(a);
    expect(again.pseudonym("person", "Alan Turing")).toMatch(/^\[Person C #/);
    expect(again.pseudonym("org", "Example Widgets")).toMatch(/^\[Org A #/);
  });

  test("a recorded AA continues at AB", () => {
    const first = readable();
    for (let n = 0; n < 27; n++) first.pseudonym("value", `item ${n}`);
    const again = readable({ map: first.toMap() });
    expect(again.pseudonym("value", "fresh value")).toMatch(/^\[Value AB #/);
  });

  test("a tag equal to a real hex run is retried", () => {
    const probe = readable().pseudonym("person", "Ada Lovelace");
    const tag = (SHAPE.exec(probe) as RegExpExecArray)[3] as string;
    const p = readable({ avoid: [tag] });
    const got = p.pseudonym("person", "Ada Lovelace");
    expect(got).toMatch(SHAPE);
    expect((SHAPE.exec(got) as RegExpExecArray)[3]).not.toBe(tag);
    expect(got).not.toBe(probe);
  });

  test("tags are unique across the upload", () => {
    const p = readable();
    const tags = Array.from({ length: 300 }, (_, n) => (SHAPE.exec(p.pseudonym("person", `Person Number${n}`)) as RegExpExecArray)[3]);
    expect(new Set(tags).size).toBe(300);
  });
});

describe("name-safe twin", () => {
  test("round-trips", () => {
    expect(nameSafe("[Client A #7F3A]")).toBe("Client_A_7F3A");
    expect(nameSafe("[Account Owner B #19C0]")).toBe("Account_Owner_B_19C0");
    expect(fromNameSafe("Client_A_7F3A")).toBe("[Client A #7F3A]");
    expect(fromNameSafe("Account_Owner_B_19C0")).toBe("[Account Owner B #19C0]");
    const p = readable();
    const r = p.pseudonym("person", "Ada Lovelace", "Account Owner");
    expect(fromNameSafe(nameSafe(r))).toBe(r);
  });

  test("both forms are recognised by isPseudonym", () => {
    const p = readable();
    const r = p.pseudonym("person", "Ada Lovelace", "Client");
    expect(isPseudonym(r)).toBe(true);
    expect(isPseudonym("Person_A_7F3A")).toBe(true);
    expect(isPseudonym(nameSafe(r), p.toMap())).toBe(true);
    expect(p.isPseudonym(r)).toBe(true);
    expect(p.isPseudonym(nameSafe(r))).toBe(true);
    expect(isPseudonym("Plain_Words_AB_12")).toBe(false);
  });
});

describe("compact", () => {
  test("output is unchanged without a style or with compact", () => {
    for (const style of [undefined, "compact" as const]) {
      const p = new Pseudonymizer({ salt: SALT, style });
      expect(p.pseudonym("person", "Ada Lovelace")).toBe("Person_D03F");
      expect(p.pseudonym("org", "Example Widgets, Inc.")).toBe("Org_B7BC");
      expect(p.pseudonym("location", "Springfield")).toBe("Loc_5400");
      expect(p.pseudonym("value", "zq-7781")).toBe("Value_7736");
    }
  });
});
