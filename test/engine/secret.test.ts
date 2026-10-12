// The secret pattern (AGT-1844): credential-shaped tokens, strict anywhere and relaxed in the
// sentence or turn of a trigger and the next two. Precision matters as much as recall: ordinary
// words, ids, hashes in logs, pseudonyms, dates, versions, measures and product codes must never
// match. Every value here is invented.

import { describe, expect, test } from "bun:test";
import { findSecretSpans, isSecretToken, newSecretCarry } from "../../src/engine/secret.ts";
import { findPatternSpans, secretSpans } from "../../src/engine/text.ts";
import type { Patterns } from "../../src/schema.ts";

const found = (text: string, carry = newSecretCarry()) => secretSpans(text, { carry }).map((s) => text.slice(s.start, s.end));
const strict = (t: string) => isSecretToken(t, "none");
const boosted = (t: string) => isSecretToken(t, "strong");

describe("secret: strict shapes (no trigger)", () => {
  test.each([
    "Tr0ub4dor&3",
    "P@ssw0rd!",
    "aB3xY9qL",
    "Zx9Qw7Lp2",
    "Kq8vR2mX9tL4wZ7p",
    "Welcome!2026x",
    "Correct#Horse#Battery9",
    "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
  ])("%j is a secret", (t) => {
    expect(strict(t)).toBe(true);
  });

  test("a long base64 or base64url token is a secret", () => {
    expect(strict("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true);
    // A JWT-shaped token: three base64url segments, over 64 characters.
    expect(strict("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.Qm9ndXNTaWduYXR1cmVGb3JUZXN0czEyMzQ1Ng")).toBe(true);
    // Lowercase and digits only, 24 characters, high entropy.
    expect(strict("q7k2m9x4z8p1w6n3b5c0r2t8")).toBe(true);
  });

  test("8 to 64 characters: shorter and longer mixed tokens are not strict secrets", () => {
    expect(strict("aB3xY9q")).toBe(false);
    expect(strict(`aB3xY9qL${"Zz".repeat(30)}!`)).toBe(false);
  });
});

describe("secret: never a secret (false-positive guards)", () => {
  // The ticket's guards, then ordinary words, ids, hashes and other shapes that mix classes.
  test.each([
    ["product code", "AB-2026-0001"],
    ["version", "v2.10.3"],
    ["version with a pre-release", "1.4.0-rc2"],
    ["CamelCase word", "HelloWorld"],
    ["drug with a dose", "Amoxi500mg"],
    ["drug with a dose, hyphenated", "Cefa-250mg"],
    ["pseudonym", "Person_1A2B"],
    ["pseudonym (id)", "Id_3F9A"],
    ["pseudonym in a possessive", "Person_1A2B's"],
    ["placeholder", "REDACTED"],
    ["product name and number", "Windows11"],
    ["product name and number", "Office365"],
    ["fiscal label", "FY2026Budget"],
    ["camel product", "iPhone15Pro"],
    ["style name", "Heading1"],
    ["method name", "getUserById"],
    ["ISO timestamp", "2026-10-12T10:02:11Z"],
    ["ISO timestamp with offset", "2026-10-12T10:02:11.120+02:00"],
    ["time", "10:02:30"],
    ["date", "12/10/2026"],
    ["amount", "$1,250.00"],
    ["amount with currency code", "USD$40"],
    ["measure", "38.6lb"],
    ["percent", "12.5%"],
    ["URL", "https://example.com/a?b=C1d2"],
    ["email", "jane.doe@example.com"],
    ["handle", "@JaneDoe99"],
    ["issue reference", "Issue#42"],
    ["path", "/var/log/App2026.log"],
    ["windows path", "C:\\Users\\Ada\\Doc1.txt"],
    ["file name", "Report_Q3_v2.docx"],
    ["sha256 hash", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["git sha", "3f9a2b1c4d5e6f708192a3b4c5d6e7f809a1b2c3"],
    ["uppercase hex", "3F9A2B1C4D5E6F70"],
    ["GUID", "123e4567-e89b-12d3-a456-426614174000"],
    ["request id", "req_8f3a9c2b1d"],
    ["pod name", "web-7d4b9c8f6-x2k9p"],
    ["ticket id", "INC0012345"],
    ["quarter", "Q3-2026"],
    ["quarter", "2026Q3"],
    ["R&D code", "R&D-2026-Q3"],
    ["MAC", "00:1A:2B:3C:4D:5E"],
    ["architecture", "x86_64"],
    ["spreadsheet reference", "!$B$2:$B$5"],
    ["spreadsheet reference", "Sheet1!$A$1:$C$9"],
    ["contraction", "McDonald's"],
    ["excited word", "Thanks!"],
    ["config key with a numeronym", "i18n.commitEncoding"],
    ["doc anchor", "policy.md#columns"],
    ["class and method", "String#toLowerCase"],
    ["qualified XML name", "w14:paraId"],
    ["acronyms", "IPv4/IPv6"],
    ["user at a bare host", "admin@srv01"],
    ["regex range", "A-Za-z0-9"],
    ["member path", "specSchema.$defs.entity"],
    ["encoding label", "utf-16le+unescape"],
    ["sheet range", "Sheet1:Sheet3!A1"],
  ])("%s %j", (_why, t) => {
    expect(strict(t)).toBe(false);
  });

  test("ids, hashes, dates and measures stay unmatched even under a trigger", () => {
    for (const t of [
      "AB-2026-0001", "v2.10.3", "Amoxi500mg", "Person_1A2B", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "123e4567-e89b-12d3-a456-426614174000", "req_8f3a9c2b1d", "INC0012345", "2026-10-12T10:02:11Z", "38.6lb", "$1,250.00",
      "sha256", "base64", "Thanks!", "rotating", "HelloWorld", "Report_Q3_v2.docx",
    ]) {
      expect([t, boosted(t)]).toEqual([t, false]);
    }
  });

  test("a synthetic application log: timestamps, ids, hashes, hosts and key=value pairs", () => {
    const log = [
      "2026-10-12T10:02:11.120Z INFO  [worker-3] request_id=req_8f3a9c2b1d user_id=10442 status=200 latency=38ms",
      "2026-10-12T10:02:11.344Z DEBUG [worker-3] commit 3f9a2b1c4d5e6f708192a3b4c5d6e7f809a1b2c3 deployed to web-7d4b9c8f6-x2k9p",
      "2026-10-12T10:02:12.001Z WARN  cache miss key=session:7f3e9a21 ttl=3600s host=db01.example.com ip=192.0.2.10",
      "2026-10-12T10:02:12.500Z INFO  token refresh ok for Person_1A2B (Id_3F9A), sha256=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "2026-10-12T10:02:13.000Z ERROR upload failed: /var/lib/app/uploads/Report_Q3_v2.docx (code E_TIMEOUT, retry 2/5)",
      "2026-10-12T10:02:13.900Z INFO  v2.10.3 build 4521 trace=123e4567-e89b-12d3-a456-426614174000 level=INFO",
      "",
    ].join("\n");
    expect(found(log)).toEqual([]);
  });

  test("ordinary prose, with the trigger words in it, finds nothing", () => {
    const prose =
      "The key point of the Q3-2026 review: HelloWorld shipped on Windows11 and Office365. Thanks! " +
      "Dr. Avery Quill prescribed Amoxi500mg twice daily; weight 38.6lb, invoice AB-2026-0001 for $1,250.00. " +
      "We rotated the password policy last week, and the token budget is unchanged at 12.5%. " +
      "Combination therapy started 2026-10-12 at 10:02:30.\n";
    expect(found(prose)).toEqual([]);
  });

  test("a token another pattern matches whole is not a secret", () => {
    const all: Patterns = { ip: true, email: true, host: true, guid: true, mac: true, phone: true, secret: true };
    const spans = findPatternSpans("mail Jo3n.D0e!x@example.com or call +1 (801) 555-0100", all);
    expect(spans.map((s) => s.cls)).toEqual(["email", "id"]);
  });
});

describe("secret: the trigger boost", () => {
  test("in the trigger's sentence and the next two, two classes with a digit or symbol inside", () => {
    expect(found("The wifi password is on the card. Network ExampleNet, use Summer2024 to join.")).toEqual(["Summer2024"]);
    expect(found("Token for the staging box. It is in the vault. Paste x9k2m7q4 there.")).toEqual(["x9k2m7q4"]);
  });

  test("after key or token a natural word with a number is left; after a password trigger it is not", () => {
    expect(found("The key point: Windows11 shipped. Our token budget covers Office365.")).toEqual([]);
    expect(found("The password: Summer2024.")).toEqual(["Summer2024"]);
  });

  test("not in the third sentence after the trigger", () => {
    expect(found("The password changed. One. Two. Then Summer2024 came up.")).toEqual([]);
  });

  test("without a trigger the same word-and-number token is left", () => {
    expect(found("Network ExampleNet, use Summer2024 to join.")).toEqual([]);
  });

  test("an ordinary word after a trigger is never boosted: it has no digit or inner symbol", () => {
    expect(found("Change the password today. Great! Rotating tomorrow.")).toEqual([]);
  });

  test("a list entry: wifi: ExampleNet / Tr0ub4dor&3", () => {
    expect(found("wifi: ExampleNet / Tr0ub4dor&3")).toEqual(["Tr0ub4dor&3"]);
  });

  test("key:value reads the value", () => {
    expect(found("pw:Tr0ub4dor&3 and pin:4471")).toEqual(["Tr0ub4dor&3"]);
  });

  test("the carry reaches the next two calls (turns) and stops at the third", () => {
    const carry = newSecretCarry();
    expect(found("Backup box hasn't had its password rotated yet.", carry)).toEqual([]);
    expect(found("Taped under the monitor - Example2031! - rotating it today.", carry)).toEqual(["Example2031!"]);
    expect(found("Or was it Spring2031?", carry)).toEqual(["Spring2031?"]);
    expect(found("Later: Autumn2031 is the theme.", carry)).toEqual([]);
  });

  test("a range with no word (a cue number, a closing tag) does not use up the reach, and is still read strictly", () => {
    const carry = newSecretCarry();
    expect(found("Did you change the password?", carry)).toEqual([]);
    expect(found("</v>\n\n12\n", carry)).toEqual([]);
    expect(found("Fine.", carry)).toEqual([]);
    expect(found("It is Harbor2031 now.", carry)).toEqual(["Harbor2031"]);
    expect(found("a1!b2@c3#d4$")).toEqual(["a1!b2@c3#d4$"]);
  });

  test("without a carry each call stands alone", () => {
    expect(found("Backup box hasn't had its password rotated yet.")).toEqual([]);
    expect(found("Taped under the monitor - Example2031! - rotating it today.")).toEqual([]);
  });

  test("boost off reads strict shapes only", () => {
    const text = "password: Summer2024 and Tr0ub4dor&3";
    expect(findSecretSpans(text, () => false, { boost: false }).map((s) => text.slice(s.start, s.end))).toEqual(["Tr0ub4dor&3"]);
  });
});
