import { describe, expect, test } from "bun:test";
import { detectHeaderRow, ParseError, parseTable, profileTable } from "../../src/profile/table.ts";

describe("parseTable", () => {
  test("quoted fields, escaped quotes, embedded newlines and CRLF", () => {
    const text = 'name,note\r\n"Quill, Avery","said ""hi""\nthen left"\r\nRobin,plain\r\n';
    expect(parseTable(text, "csv")).toEqual([
      ["name", "note"],
      ["Quill, Avery", 'said "hi"\nthen left'],
      ["Robin", "plain"],
    ]);
  });

  test("a last line without a newline and empty fields", () => {
    expect(parseTable("a,,c\n,b,", "csv")).toEqual([["a", "", "c"], ["", "b", ""]]);
  });

  test("an unterminated quote is a ParseError, never a silent best guess", () => {
    expect(() => parseTable('a,b\n"open,x\n', "csv")).toThrow(ParseError);
  });

  test("the delimiter is guessed like the engine does: semicolon and pipe CSV", () => {
    expect(parseTable("a;b\n1;2\n", "csv")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseTable("a|b\n1|2\n", "csv")).toEqual([["a", "b"], ["1", "2"]]);
  });

  test("TSV honours quotes", () => {
    expect(parseTable('a\t"b\tc"\n1\t2\n', "tsv")).toEqual([["a", "b\tc"], ["1", "2"]]);
  });
});

describe("detectHeaderRow", () => {
  test("row 1 when it is text", () => {
    expect(detectHeaderRow([["Name", "Amount"], ["Avery", "12"]])).toBe(1);
  });

  test("skips a title row that does not fill the table and a blank row", () => {
    expect(detectHeaderRow([["Export for Q3"], [], ["Owner", "Host", "Port"], ["Avery", "db01.example.com", "22"]])).toBe(3);
  });

  test("skips mostly numeric rows above the header", () => {
    expect(detectHeaderRow([["1", "2", "x"], ["Owner", "Count", "Code"], ["Avery", "3", "7"]])).toBe(2);
  });

  test("numbers with exponents and percents are not text", () => {
    expect(detectHeaderRow([["1e5", "12%", "a"], ["Owner", "Share", "Tag"]])).toBe(2);
  });

  test("null when no row is mostly text", () => {
    expect(detectHeaderRow([["1", "2"], ["3", "4"]])).toBeNull();
  });
});

describe("profileTable", () => {
  test("columns take the header text and stats from the rows below it", () => {
    const rows = [["Report"], ["Owner", "Email"], ["Avery Quill", "avery@example.com"], ["", ""], ["Robin Example", ""]];
    const { table, noHeader } = profileTable("staff.csv", rows, 5);
    expect(noHeader).toBe(false);
    expect(table.headerRow).toBe(2);
    expect(table.columns.map((c) => c.header)).toEqual(["Owner", "Email"]);
    expect(table.columns[0]?.stats.count).toBe(2);
    expect(table.columns[1]?.stats.count).toBe(1);
    expect(table.columns[1]?.stats.detectorRates.email).toBe(1);
  });

  test("ragged rows get extra columns with an empty header", () => {
    const { table } = profileTable("t.csv", [["A", "B"], ["x", "y", "extra"]], 5);
    expect(table.columns.map((c) => c.header)).toEqual(["A", "B", ""]);
    expect(table.columns[2]?.stats.samples).toEqual(["extra"]);
  });

  test("no header row: row 1 is used and flagged", () => {
    const { table, noHeader } = profileTable("n.csv", [["1", "2"], ["3", "4"]], 5);
    expect(noHeader).toBe(true);
    expect(table.headerRow).toBe(1);
  });

  test("long headers are cut to 120 characters", () => {
    const { table } = profileTable("t.csv", [["H".repeat(400)], ["v"]], 5);
    expect([...(table.columns[0]?.header ?? "")].length).toBe(120);
  });

  test("value sets are folded for co-occurrence", () => {
    const { valueSets } = profileTable("t.csv", [["Owner"], ["Avery Quill"], ["AVERY QUILL "], ["Robin"]], 5);
    expect([...(valueSets[0] ?? [])]).toEqual(["avery quill", "robin"]);
  });
});
