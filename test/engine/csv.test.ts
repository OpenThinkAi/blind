import { describe, expect, test } from "bun:test";
import { CsvError, detectHeaderRow, parseCsv, renderCell, serializeCsv, sniffDelimiter } from "../../src/engine/csv.ts";

const roundTrip = (text: string, delim = ",") => serializeCsv(parseCsv(text, delim), delim);

describe("parseCsv / serializeCsv", () => {
  test.each([
    ["plain LF", "a,b\n1,2\n"],
    ["CRLF", "a,b\r\n1,2\r\n"],
    ["bare CR", "a,b\r1,2\r"],
    ["mixed line endings", "a,b\r\n1,2\n3,4\r5,6"],
    ["no trailing newline", "a,b\n1,2"],
    ["quoted with delimiter, quote and newline", 'a,b\n"x, ""y""\r\nz",2\n'],
    ["empty cells and blank lines", "a,,c\n\n,,\n"],
    ["text after a closing quote is kept", 'a,b\n"x"y,2\n'],
    ["stray quote inside an unquoted cell", 'a,b\nab"c,2\n'],
  ])("%s round-trips byte for byte", (_name, text) => {
    expect(roundTrip(text)).toBe(text);
  });

  test("unescapes quoted cells and records each row's line ending", () => {
    const rows = parseCsv('h1,h2\r\n"Quill, Avery","say ""hi"""\n', ",");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.eol).toBe("\r\n");
    expect(rows[1]?.cells.map((c) => c.value)).toEqual(["Quill, Avery", 'say "hi"']);
    expect(rows[1]?.cells.map((c) => c.quoted)).toEqual([true, true]);
  });

  test("an empty file has no rows", () => {
    expect(parseCsv("", ",")).toEqual([]);
  });

  test("an unterminated quote is an error naming the line", () => {
    expect(() => parseCsv('a,b\n1,"open\nstill open', ",")).toThrow(CsvError);
    expect(() => parseCsv('a,b\n1,"open', ",")).toThrow(/line 2/);
  });

  test("tab and semicolon delimiters", () => {
    expect(roundTrip("a\tb\n1\t2\n", "\t")).toBe("a\tb\n1\t2\n");
    expect(parseCsv("a;b\n1;2\n", ";")[1]?.cells.map((c) => c.value)).toEqual(["1", "2"]);
  });
});

describe("sniffDelimiter", () => {
  test.each([
    ["a,b,c\n", ","],
    ["a;b;c\n1,5;2,5;3\n", ";"],
    ["a\tb\tc\n", "\t"],
    ["a|b|c\n", "|"],
    ['"x;y;z",b,c\n', ","],
    ["single\n", ","],
  ])("%j → %j", (text, want) => {
    expect(sniffDelimiter(text)).toBe(want);
  });
});

describe("renderCell", () => {
  test("keeps quoting, adds it only when needed", () => {
    expect(renderCell("Person_AB12", true, ",")).toBe('"Person_AB12"');
    expect(renderCell("Person_AB12", false, ",")).toBe("Person_AB12");
    expect(renderCell("a,b", false, ",")).toBe('"a,b"');
    expect(renderCell('say "x"', false, ";")).toBe('"say ""x"""');
    expect(renderCell("a,b", false, "\t")).toBe("a,b");
  });
});

describe("detectHeaderRow", () => {
  const rows = (text: string) => parseCsv(text, ",");
  test("the first row when it is text", () => {
    expect(detectHeaderRow(rows("Name,Code\nAvery,1\n"))).toBe(0);
  });
  test("skips blank and numeric rows above the header", () => {
    expect(detectHeaderRow(rows(",,\n2026,10,11\nName,Code,Total\nAvery,1,2\n"))).toBe(2);
  });
  test("a row must be more than half text", () => {
    expect(detectHeaderRow(rows("Total,1,2,3\nName,Code,Owner,Status\n"))).toBe(1);
  });
  test("-1 when every row is numeric", () => {
    expect(detectHeaderRow(rows("1,2\n3.5,$4\n"))).toBe(-1);
  });
});
