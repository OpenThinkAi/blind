// Account names in file paths. Office writes the path a file was saved at, or
// the template or linked workbook it came from, into the package
// (`x15ac:absPath`, app.xml `Template`, an external link's target): on most
// machines that path holds the account name of whoever saved it
// (`C:\Users\avery\Documents\`, `/Users/avery/`, `/home/avery/`). Shared by the
// engine (which replaces the account segment) and the audit (which reports one
// that survives), so the two agree on what an account segment is. Pure string
// work: no model, no clock, no randomness.

/** One account-name segment of a path: value[start, end). */
export interface AccountSegment {
  start: number;
  end: number;
  value: string;
}

// The folders that hold account folders, at the root of a drive, a share or a file system.
const HOMES = new Set(["users", "home", "documents and settings"]);
// Folders under them that belong to no one.
const SHARED = new Set(["public", "default", "default user", "all users", "shared"]);

/**
 * The account-name segment of `value` when it is a path whose user folder sits at its root, in a
 * list (empty or one entry). The path may be a file URL (`file:///C:/Users/avery/`,
 * `file://server/Users/avery/`), a drive path (`C:\Users\avery\`), a UNC path
 * (`\\server\Users\avery\`), a rooted path (`/Users/avery/`, `/home/avery/`) or a relative one
 * that climbs to the root (`../../Users/avery/`). A user folder deeper in the path
 * (`/var/lib/app/home/svc`) is not an account folder, and `C:\Users\Public\` names no one.
 */
export function accountSegments(value: string): AccountSegment[] {
  // Leading and trailing white space is not part of the path.
  const segs = [...value.matchAll(/[^\\/\s](?:[^\\/]*[^\\/\s])?/g)].map((m) => ({ start: m.index as number, value: m[0] }));
  const lead = value.slice(0, segs[0]?.start ?? 0);
  const rooted = /[\\/]/.test(lead);
  let i = 0;
  const at = (k: number): string => segs[k]?.value ?? "";
  let anchored = rooted;
  if (/^file:$/i.test(at(i))) {
    i++;
    anchored = true;
    // file://host/…: a host before the path, unless the path starts at once (file:///…).
    const afterScheme = value.slice((segs[0] as { start: number }).start + 5);
    if (/^[\\/]{2}[^\\/]/.test(afterScheme)) i++;
  } else if (/^[\\/]{2}[^\\/]/.test(value.trimStart()) && !HOMES.has(at(i).toLowerCase())) i++; // \\server\…
  if (/^[A-Za-z]:$/.test(at(i))) {
    i++;
    anchored = true;
  }
  while (at(i) === "." || at(i) === "..") {
    i++;
    anchored = true;
  }
  if (!anchored || !HOMES.has(at(i).toLowerCase())) return [];
  const seg = segs[i + 1];
  if (seg === undefined || seg.value.trim() === "" || SHARED.has(seg.value.toLowerCase())) return [];
  return [{ start: seg.start, end: seg.start + seg.value.length, value: seg.value }];
}

/** `value` with each account segment replaced by `replace(segment)` and every other piece by `other(piece)`. */
export function replaceAccounts(value: string, replace: (segment: string) => string, other: (piece: string) => string = (s) => s): string {
  let out = "";
  let at = 0;
  for (const s of accountSegments(value)) {
    out += (s.start > at ? other(value.slice(at, s.start)) : "") + replace(s.value);
    at = s.end;
  }
  return out + (at < value.length ? other(value.slice(at)) : "");
}
