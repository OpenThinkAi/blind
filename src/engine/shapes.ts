// Column shapes the free-text patterns do not know (AGT-1846): vehicle licence plates, usernames
// and login handles, and phone numbers. The profile measures them per value (profile/stats.ts),
// the heuristic analyst classifies a column by them (analyst/heuristic.ts) and the audit runs the
// same test over what was written (audit/mechanical.ts), so all three agree.
//
// Precision matters more than recall here: a column classed by shape is blinded whole. Product
// codes and SKUs (a letter prefix shared across the column), short location, kennel and slot codes,
// measures, dates, microchip numbers and lowercase categoricals (species, payment method) are not
// plates or handles. A header that names the shape ("vehicle", "login") lowers the share of values
// needed; a header alone never classifies a column.
//
// Pure and deterministic: no clock, no locale.

import type { PseudoClass } from "./canonical.ts";
import { isPhoneColumn } from "./columns.ts";
import { isMeasure } from "./stats.ts";
import { holdsPhone } from "./text.ts";
import { DICTIONARY } from "./words.ts";

export type ShapeName = "plate" | "handle" | "phone";
export const SHAPE_NAMES: readonly ShapeName[] = ["phone", "plate", "handle"];

/** The share of values a shape needs to classify a column; HEADER_RATE when the header names the shape. */
export const SHAPE_RATE = 0.8;
export const HEADER_RATE = 0.5;

// A plate: an optional two-letter region code, then one or two runs of capitals and digits joined by
// one space or dash. Up to three descriptive words (colour, make, model) may come first.
const DESCRIPTOR = String.raw`\p{L}[\p{Ll}'’]*(?:-\p{L}[\p{Ll}'’]*)?`;
const PLATE_RE = new RegExp(String.raw`^((?:${DESCRIPTOR}\s+){0,3})(?:([A-Z]{2})\s+)?([A-Z0-9]+(?:[ -][A-Z0-9]+)?)$`, "u");
// Digits and a unit in capitals ("250 MG", "12LBS") are a measure, not a plate.
const UNIT_RE = /^\d+\s?(?:MG|MCG|ML|KG|G|L|LBS?|OZ|IU|CC|MM|CM|DL|MEQ|MMOL|MIN|HRS?|DAYS?)$/;
// A one- or two-letter prefix, a dash and digits ("RX-2231", "B-04"): a product, slot or form code.
const SHORT_CODE_RE = /^[A-Z]{1,2}-\d+$/;
// A letter prefix then a separator, or then only digits ("SKU-10442", "PRJ-7A3F", "ABC1234"): the
// shape a product or project code shares with some plates; told apart column-wide (shapeRates).
const PREFIXED_PLATE_RE = /^([A-Z]+)(?:[ -]|\d+$)/;
const PREFIXED_HANDLE_RE = /^([a-z]+)(?:[._-]|\d+$)/;

interface PlateMatch {
  /** The descriptive words before the plate, with their trailing space ("" when none). */
  lead: string;
  /** The plate itself, region code included. */
  plate: string;
  /** The plate without its region code. */
  core: string;
}

function plateMatch(value: string): PlateMatch | undefined {
  const v = value.trim();
  const m = PLATE_RE.exec(v);
  if (m === null) return undefined;
  const lead = m[1] ?? "";
  const region = m[2];
  const core = m[3] as string;
  const coreChars = core.replace(/[ -]/g, "");
  const all = (region ?? "") + coreChars;
  if (coreChars.length < 4 || coreChars.length > 8 || all.length < 5) return undefined;
  if (!/\d/.test(all) || !/[A-Z]/.test(all)) return undefined;
  if (region === undefined && SHORT_CODE_RE.test(core)) return undefined;
  if (UNIT_RE.test(core) || isMeasure(core) || isMeasure(v)) return undefined;
  return { lead, plate: v.slice(lead.length), core };
}

/** Whether a value is a licence plate, optionally after up to three descriptive words ("blue Civic 7ABC123"). */
export const isPlate = (value: string): boolean => plateMatch(value) !== undefined;

// Words that may stand before a plate and stay as written when only the plate is replaced: colours,
// makes, models and body styles. Anything else before a plate (a name, say) keeps the whole cell blinded.
const VEHICLE_WORDS = new Set(
  `
black white grey gray silver blue navy red maroon green tan beige brown gold yellow orange purple pink teal
dark light bright pale metallic two-tone
car truck van suv sedan coupe wagon hatchback minivan pickup convertible motorcycle scooter trailer camper rv
acura audi bmw buick cadillac chevrolet chevy chrysler dodge fiat ford genesis gmc honda hyundai infiniti jeep
kia lexus lincoln mazda mercedes mini mitsubishi nissan polestar porsche ram rivian subaru tesla toyota volkswagen
vw volvo
accord civic pilot odyssey fit camry corolla prius tacoma tundra highlander sienna focus fusion escape explorer
mustang ranger bronco golf jetta passat tiguan outback forester impreza crosstrek legacy altima sentra rogue
leaf frontier wrangler cherokee compass renegade silverado malibu equinox tahoe impala bolt elantra sonata
tucson santa fe soul forte sorento optima sportage model
`
    .trim()
    .split(/\s+/),
);

/**
 * A plate cell split for replacement: the descriptive words, kept as written, and the plate. Only
 * when every word before the plate is a colour, make, model or body style; otherwise undefined, and
 * the whole cell is replaced (fail closed).
 */
export function plateSplit(value: string): PlateMatch | undefined {
  const m = plateMatch(value);
  if (m === undefined || m.lead === "") return undefined;
  const words = m.lead.trim().split(/\s+/);
  if (!words.every((w) => VEHICLE_WORDS.has(w.toLowerCase()))) return undefined;
  const at = value.length - value.trimStart().length + m.lead.length;
  return { lead: value.slice(0, at), plate: m.plate, core: m.core };
}

/**
 * A pseudonymised cell: the whole value, or for an `id` cell that is descriptive words and a plate,
 * those words as written and the plate replaced. `core` is the value the pseudonym derives from (and
 * that recurs elsewhere).
 */
export function pseudoCell(cls: PseudoClass, value: string): { core: string; write: (pseudonym: string) => string } {
  const split = cls === "id" ? plateSplit(value) : undefined;
  if (split === undefined) return { core: value, write: (p) => p };
  const tail = value.slice(split.lead.length + split.plate.length);
  return { core: split.plate, write: (p) => split.lead + p + tail };
}

// A handle: one lowercase token of letters, digits, ".", "_" and "-", starting with a letter.
const HANDLE_RE = /^[a-z][a-z0-9._-]{2,31}$/;

/**
 * Whether a value is a username or login handle ("dana42", "lee.sample7", "rspec"): one lowercase
 * token, at least three letters, not all its words dictionary words unless it has a digit (so
 * "follow-up" and "yes" are not handles), and not a run of separators.
 */
export function isHandle(value: string): boolean {
  const v = value.trim();
  if (!HANDLE_RE.test(v) || /[._-]{2}|[._-]$/.test(v)) return false;
  const letters = v.match(/[a-z]+/g) ?? [];
  if (letters.join("").length < 3) return false;
  if (DICTIONARY.has(v)) return false;
  if (/\d/.test(v)) return true;
  return !letters.every((w) => w.length < 2 || DICTIONARY.has(w));
}

/**
 * Shares of a column's values each shape matches (empty values not counted). Column-wide: values of
 * a letter prefix and a separator, or a letter prefix and only digits ("SKU-10442", "PRJ-7A3F",
 * "user1"), whose prefixes are mostly shared (at most one per two distinct values) are codes, not
 * plates or handles, and do not count. A plate's region code is not its prefix.
 */
export function shapeRates(raw: readonly string[]): Record<ShapeName, number> {
  const values = raw.map((v) => v.trim()).filter((v) => v !== "");
  const plates = values.map((v) => plateMatch(v)?.core);
  const handles = values.map((v) => (isHandle(v) ? v : undefined));
  const codes = (found: readonly (string | undefined)[], re: RegExp): Set<string> => {
    const byValue = new Map<string, string>();
    for (const f of found) {
      const m = f === undefined ? null : re.exec(f);
      if (m !== null && f !== undefined) byValue.set(f, m[1] as string);
    }
    const prefixes = new Set(byValue.values());
    return byValue.size >= 2 && prefixes.size / byValue.size <= 0.5 ? new Set(byValue.keys()) : new Set();
  };
  const plateCodes = codes(plates, PREFIXED_PLATE_RE);
  const handleCodes = codes(handles, PREFIXED_HANDLE_RE);
  const rate = (n: number): number => (values.length === 0 ? 0 : Math.round((n / values.length) * 10_000) / 10_000);
  return {
    plate: rate(plates.filter((p) => p !== undefined && !plateCodes.has(p)).length),
    handle: rate(handles.filter((h) => h !== undefined && !handleCodes.has(h)).length),
    // A phone column as the engine reads one (columns.ts isPhoneColumn: bare NANP runs among formatted
    // phones count), else the values the free-text phone pattern finds a phone in.
    phone: isPhoneColumn(values) ? 1 : rate(values.filter(holdsPhone).length),
  };
}

// Header words that say what a column holds. Matched as whole words of the header, any case,
// any separator, camelCase split ("vehicle_plate", "UserName", "Screen Name").
const HEADER_PHRASES: Record<ShapeName, readonly string[]> = {
  plate: ["plate", "licence plate", "license plate", "vehicle", "tag", "plates", "vehicles"],
  handle: ["login", "username", "user name", "handle", "screen name", "screenname", "user id", "userid", "account name", "logins", "usernames"],
  phone: ["phone", "telephone", "tel", "mobile", "cell", "fax"],
};

/** The words of a header or the last segment of a JSON key path, lowercased. */
export function headerWords(header: string): string[] {
  const last = header.split(/[.[\]$*'"]+/).filter((s) => s !== "").pop() ?? header;
  return last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");
}

/** Whether the header names this shape. */
export function headerNames(shape: ShapeName, header: string | undefined): boolean {
  if (header === undefined) return false;
  const words = headerWords(header);
  const text = ` ${words.join(" ")} `;
  return HEADER_PHRASES[shape].some((p) => text.includes(` ${p} `));
}

export interface ShapeStats {
  distinctRatio: number;
  digitRatio: number;
  detectorRates: Partial<Record<ShapeName, number>>;
}

/**
 * Whether a column is of this shape: its rate reaches SHAPE_RATE, or HEADER_RATE when the header
 * names the shape. A handle column also needs evidence it is not a lowercase categorical ("cash",
 * "card"): digits in its values and mostly distinct values; under a naming header, either digits or
 * nearly all values distinct.
 */
export function shapeHolds(shape: ShapeName, stats: ShapeStats, header: string | undefined): boolean {
  const named = headerNames(shape, header);
  const rate = stats.detectorRates[shape] ?? 0;
  if (rate === 0 || rate < (named ? HEADER_RATE : SHAPE_RATE)) return false;
  if (shape !== "handle") return true;
  const digits = stats.digitRatio >= 0.05;
  const distinct = stats.distinctRatio >= 0.5;
  return named ? digits || stats.distinctRatio >= 0.8 : digits && distinct;
}

/** Writes a pseudonymised cell (see pseudoCell). */
export function pseudoWrite(pz: { pseudonym(cls: PseudoClass, value: string): string }, cls: PseudoClass, value: string): string {
  const cell = pseudoCell(cls, value);
  return cell.write(pz.pseudonym(cls, cell.core));
}
