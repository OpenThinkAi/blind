// The street-address finder (AGT-1849). Every value is invented.

import { describe, expect, test } from "bun:test";
import { findAddresses } from "../../src/engine/address.ts";

const found = (text: string): string[] => findAddresses(text).map((a) => text.slice(a.start, a.end));

describe("addresses found whole", () => {
  test.each([
    ["Daughter will collect him from 77 Example Rd, Springfield UT 84000 after 5pm.", "77 Example Rd, Springfield UT 84000"],
    ["she lives at 2200 Sample Blvd", "2200 Sample Blvd"],
    ["lives at 2200 Sample Blvd.", "2200 Sample Blvd"],
    ["drop it at 12 Sample Lane today", "12 Sample Lane"],
    ["{\"line1\":\"12 Sample Lane\"}", "12 Sample Lane"],
    ["9071 S Person_A1B2 Pkwy", "9071 S Person_A1B2 Pkwy"],
    ["9071 S. Rowan Pkwy, Shelbyville UT 84001-1234", "9071 S. Rowan Pkwy, Shelbyville UT 84001-1234"],
    ["410B Oak Hollow Court Apt 4", "410B Oak Hollow Court Apt 4"],
    ["52 1/2 Example St #3, Springfield, UT 84000", "52 1/2 Example St #3, Springfield, UT 84000"],
    ["300 North Example Way Unit 12", "300 North Example Way Unit 12"],
    ["300 NE Sample Ave., Springfield UT 84000 is closed", "300 NE Sample Ave., Springfield UT 84000"],
    ["15 Fifth Street and 42 5th Ave", "15 Fifth Street"],
    ["500 SAMPLE HWY", "500 SAMPLE HWY"],
    ["88 Big Cottonwood Canyon Sample Loop", "88 Big Cottonwood Canyon Sample Loop"],
    ["77 Example Rd Springfield UT 84000", "77 Example Rd Springfield UT 84000"],
    ["123 Sample Dr, Springfield UT", "123 Sample Dr, Springfield UT"],
    ["123 Sample Dr Springfield UT 84000", "123 Sample Dr Springfield UT 84000"],
    ["100 Court St", "100 Court St"],
    ["Sunday 77 Example Rd\nnext line", "77 Example Rd"],
  ])("%j", (text, want) => {
    expect(found(text)[0]).toBe(want);
  });

  test("a sentence full stop after the suffix is left in place", () => {
    const t = "from 77 Example Rd. Daughter will wait.";
    expect(found(t)).toEqual(["77 Example Rd"]);
  });

  test("two addresses in one text are two spans", () => {
    expect(found("12 Sample Lane and 400 Example Ct, Springfield UT 84000.")).toEqual(["12 Sample Lane", "400 Example Ct, Springfield UT 84000"]);
  });
});

describe("prose that is not an address", () => {
  test.each([
    ["hit by a car on Example Rd"],
    ["Example Rd is closed"],
    ["Give 2 Tabs Daily"],
    ["Give 2 Tabs Daily Dr Sample will check"],
    ["Take 3 doses daily"],
    ["3 doses daily with food"],
    ["Rx: 10 Days Supply Way"],
    ["5 Units Per Day"],
    ["Order 5 Units Court"],
    ["2 Tabs Ct"],
    ["Dose 5 Mg Dr Sample"],
    ["Dose: 2 Tabs Dr. Sample reviewed"],
    ["1 Dr Sample St"],
    ["Seen by Dr Sample today"],
    ["Dr Sample at 4 pm"],
    ["A suite of tests"],
    ["Suite of Tests Way"],
    ["Room 12 Oak Way"],
    ["Rm 204 Sample Ct"],
    ["Suite 300 Example Way"],
    ["Bed 4 Clinic Loop"],
    ["Kennel 12 Sample Ln"],
    ["at 10:30 Sample Way"],
    ["total $12 Sample Way"],
    ["2.5 Sample Rd"],
    ["12 sample lane"],
    ["12 Sample"],
    ["12"],
    ["Invoice 2026-10-12 Sample Court"],
    ["page 12 Example Street"],
    ["12 Example Streetcar"],
  ])("%j", (text) => {
    expect(found(text)).toEqual([]);
  });

  test("a count of animals is no house number", () => {
    expect(found("Her 3 Cats Court")).toEqual([]);
  });
});
