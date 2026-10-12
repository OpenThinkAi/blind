// Birth-date columns (AGT-1858). A date of birth is a date, and dates are measures that the
// identifier-like fallback leaves alone (AGT-1822/1843): right for a visit or invoice date, wrong
// for a person's date of birth. A column or key whose name says it holds a birth date, and that no
// rule decides, is redacted instead (fail closed). A leaf module: the engine, the plan and the
// audit share it, so they agree on which names count.

// Whole-word phrases (lowercase) that name a birth date once a name is split into words.
const PHRASES: readonly string[] = ["dob", "d o b", "date of birth", "birth date", "birthdate", "birth day", "birthday", "born", "bday"];

/** The words of a column header or key: camelCase split, lowercased, split on anything not a letter or digit ("d.o.b" is d, o, b). */
function words(name: string): string[] {
  return name
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/** Whether a header, or the last segment of a JSON key path, names a birth date: `dob`, `d.o.b`, `Date of Birth`, `birth_date`, `birthDate`, `born`, `bday`. */
export function isBirthDateName(name: string | undefined): boolean {
  if (name === undefined) return false;
  const text = ` ${words(name).join(" ")} `;
  return PHRASES.some((p) => text.includes(` ${p} `));
}

/** The last key of a JSON key path (src/engine/json.ts): `$.owner.dob` is `dob`, `$["date of birth"]` is `date of birth`; undefined for a set of record-ID keys. */
export function lastKey(path: string): string | undefined {
  path = path.replace(/(?:\[\*\])+$/, "");
  if (path === "$" || path.endsWith("~") || path.endsWith(".*")) return undefined;
  if (path.endsWith('"]')) {
    const open = path.lastIndexOf('["');
    if (open >= 0) {
      try {
        const key: unknown = JSON.parse(path.slice(open + 1, -1));
        return typeof key === "string" ? key : undefined;
      } catch {
        return undefined;
      }
    }
  }
  const dot = path.lastIndexOf(".");
  const last = dot >= 0 ? path.slice(dot + 1) : path;
  return last === "" || last.includes("[") ? undefined : last;
}
