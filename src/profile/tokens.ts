// Profile-only tokens. Under privacy.mode "profile-only" the profile a model sees carries no
// document text beyond what sampleCount bounds, yet file and folder names, sheet names, some JSON
// keys and some table headers are document text: a file called "Avery Quill review.md", a sheet
// named after a client, an object keyed by people's names, a headerless CSV whose first row of
// names was taken as the header. tokeniseProfile() replaces those with opaque local tokens before
// anything is sent, and restoreSpec() maps the analyst's reply back to the real locations.
//
// Tokens:
//   file and folder paths  every segment: folders `dir_N`, the file `file_N` (`dir_1/dir_2/file_3`)
//   sheet names            `sheet_N`
//   JSON key segments      `["key_N"]`, for a key that is not ASCII-identifier-shaped or that
//                          matches the host, email or ip pattern
//   value-like headers     every header of the table becomes `col_N` (its 1-based column)
// N counts from 1 over the distinct real strings in code-unit sorted order (headers: column order).
// A token is a counter, never a hash: it says nothing about the value and uses no salt. The same
// profile always gives the same tokens. The mapping lives only in memory for one model call.
//
// untokenised() is the check model.ts runs on every profile-only payload: it lists any path,
// sheet name, header or key segment that should have been a token. Pure functions, no I/O.

import type { Location, Profile, ProfileTable, Question, Spec } from "../schema.ts";
import { DETECTORS } from "./stats.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const FILE_TOKEN = /^file_[1-9]\d*$/;
const DIR_TOKEN = /^dir_[1-9]\d*$/;
const SHEET_TOKEN = /^sheet_[1-9]\d*$/;
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_PATTERNS = [DETECTORS.host, DETECTORS.email, DETECTORS.ip];
/** Header patterns: every shape finder, so a host, email, IP, GUID or MAC as a header is caught. */
const HEADER_PATTERNS = [DETECTORS.host, DETECTORS.email, DETECTORS.ip, DETECTORS.guid, DETECTORS.mac];
/** Two or more capitalised words ("Avery Quill", "Jean-Luc O'Brien", "McAllister Group"). */
const TITLE_WORD = String.raw`\p{Lu}[\p{Ll}\p{M}]*(?:['’-]?\p{Lu}?[\p{Ll}\p{M}]+)*`;
const TITLE_CASE_WORDS = new RegExp(`^${TITLE_WORD}(?: ${TITLE_WORD})+$`, "u");
/** A header row is value-like when at least this share of its filled cells are title-case words. */
export const TITLE_CASE_SHARE = 0.5;
const NUMBER = /^[-+]?(?:\d[\d,]*)?(?:\.\d+)?(?:e[-+]?\d+)?%?$/i;

/** True for `file_N` or `dir_N/.../file_N`. */
export function isTokenPath(path: string): boolean {
  const parts = path.split("/");
  const last = parts.pop() ?? "";
  return FILE_TOKEN.test(last) && parts.every((p) => DIR_TOKEN.test(p));
}

export const isTokenSheet = (sheet: string): boolean => SHEET_TOKEN.test(sheet);

/**
 * True when a table's header cells look like data rather than names for columns: the row would
 * not have been picked as a header (half the width or less filled, or not mostly text; this is
 * always so when the profiler fell back to row 1), a cell matches a shape pattern, or at least
 * TITLE_CASE_SHARE of the filled cells are two or more capitalised words, like a person's name.
 */
export function headersLookLikeValues(headers: readonly string[]): boolean {
  const filled = headers.map((h) => h.trim()).filter((h) => h !== "");
  if (filled.length === 0) return headers.length > 0;
  if (filled.length * 2 <= headers.length) return true;
  const text = filled.filter((h) => /\p{L}/u.test(h) && !NUMBER.test(h));
  if (text.length * 2 <= filled.length) return true;
  if (filled.some((h) => HEADER_PATTERNS.some((re) => re.test(h)))) return true;
  return filled.filter((h) => TITLE_CASE_WORDS.test(h)).length >= TITLE_CASE_SHARE * filled.length;
}

/** A key path segment: `raw` as written, `key` the decoded key for a `.name` or `["key"]` segment. */
interface Segment {
  raw: string;
  key?: string;
}

const SEGMENT = /\.([A-Za-z_][A-Za-z0-9_]*)|\.\*~?|\[\*\]|\[("(?:[^"\\]|\\.)*")\]/y;

/** Splits a key path (`$`, `.name`, `["key"]`, `[*]`, `.*`, `.*~`) into segments; null when it is not one. */
function segments(path: string): Segment[] | null {
  if (!path.startsWith("$")) return null;
  const out: Segment[] = [];
  SEGMENT.lastIndex = 1;
  while (SEGMENT.lastIndex < path.length) {
    const at = SEGMENT.lastIndex;
    const m = SEGMENT.exec(path);
    if (m === null) return null;
    const raw = path.slice(at, SEGMENT.lastIndex);
    if (m[1] !== undefined) out.push({ raw, key: m[1] });
    else if (m[2] !== undefined) out.push({ raw, key: JSON.parse(m[2]) as string });
    else out.push({ raw });
  }
  return out;
}

/** A key that must not leave the machine under profile-only. */
const flaggedKey = (key: string): boolean => !PLAIN_KEY.test(key) || KEY_PATTERNS.some((re) => re.test(key));

const locKey = (l: Location): string => JSON.stringify([l.file, l.sheet ?? null, l.header ?? null, l.jsonPath ?? null]);

function makeLocation(file: string, sheet: string | undefined, header: string | undefined, jsonPath: string | undefined): Location {
  const base = sheet === undefined ? { file } : { file, sheet };
  return jsonPath !== undefined ? { ...base, jsonPath } : { ...base, header: header ?? "" };
}

export interface Tokenised {
  /** The profile with every path, sheet name, flagged key segment and value-like header tokenised. */
  profile: Profile;
  /** The real location of a location in `profile`, or undefined when it is not one. */
  restore(loc: Location): Location | undefined;
  /** `text` with every file_, dir_, sheet_ and key_ token of this profile replaced by its real string, JSON-quoted. */
  restoreText(text: string): string;
  counts: { paths: number; sheets: number; tables: number; keys: number };
}

/** Numbers distinct strings 1.. in code-unit order. */
function numbered(values: Iterable<string>, prefix: string): Map<string, string> {
  return new Map([...new Set(values)].sort(byCodeUnit).map((v, i) => [v, `${prefix}_${i + 1}`]));
}

/** Tokenises a profile for a profile-only call. See the header comment for the scheme. */
export function tokeniseProfile(profile: Profile): Tokenised {
  const realFiles = [
    ...profile.files.map((f) => f.path),
    ...profile.tables.map((t) => t.file),
    ...profile.jsonKeys.map((j) => j.file),
    ...profile.documents.map((d) => d.file),
    ...profile.transcripts.map((t) => t.file),
    ...profile.cooccurrence.flatMap((c) => [c.a.file, c.b.file]),
  ];
  const fileTokens = numbered(realFiles, "file");
  const dirTokens = numbered(
    realFiles.flatMap((p) => {
      const parts = p.split("/").slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    }),
    "dir",
  );
  const sheetTokens = numbered(
    [...profile.tables.flatMap((t) => (t.sheet === undefined ? [] : [t.sheet])), ...profile.cooccurrence.flatMap((c) => [c.a.sheet, c.b.sheet].filter((s): s is string => s !== undefined))],
    "sheet",
  );
  const keyPaths = [...profile.jsonKeys.map((j) => j.path), ...profile.cooccurrence.flatMap((c) => [c.a.jsonPath, c.b.jsonPath].filter((p): p is string => p !== undefined))];
  const parsed = new Map<string, Segment[]>();
  for (const p of keyPaths) {
    const segs = segments(p);
    // The profiler's own key paths always parse; anything else is a bug, and is not sent.
    if (segs === null) throw new Error(`internal error: ${JSON.stringify(p)} is not a key path`);
    parsed.set(p, segs);
  }
  const keyTokens = numbered(
    [...parsed.values()].flatMap((segs) => segs.flatMap((s) => (s.key !== undefined && flaggedKey(s.key) ? [s.key] : []))),
    "key",
  );

  const token = (map: Map<string, string>, v: string): string => {
    const t = map.get(v);
    if (t === undefined) throw new Error("internal error: a profile string has no token");
    return t;
  };
  const path = (p: string): string => {
    const parts = p.split("/");
    const dirs = parts.slice(0, -1).map((_, i) => token(dirTokens, parts.slice(0, i + 1).join("/")));
    return [...dirs, token(fileTokens, p)].join("/");
  };
  const sheet = (s: string | undefined): string | undefined => (s === undefined ? undefined : token(sheetTokens, s));
  const keyPath = (p: string): string =>
    `$${(parsed.get(p) ?? []).map((s) => (s.key !== undefined && flaggedKey(s.key) ? `[${JSON.stringify(token(keyTokens, s.key))}]` : s.raw)).join("")}`;

  const forward = new Map<string, Location>();
  const back = new Map<string, Location>();
  const link = (real: Location, sent: Location) => {
    forward.set(locKey(real), sent);
    back.set(locKey(sent), real);
  };

  let tables = 0;
  const tableOut = profile.tables.map((t): ProfileTable => {
    const flagged = headersLookLikeValues(t.columns.map((c) => c.header));
    if (flagged) tables++;
    const file = path(t.file);
    const sh = sheet(t.sheet);
    const columns = t.columns.map((c, i) => {
      const header = flagged ? `col_${i + 1}` : c.header;
      link(makeLocation(t.file, t.sheet, c.header, undefined), makeLocation(file, sh, header, undefined));
      return { ...c, header };
    });
    return sh === undefined ? { file, headerRow: t.headerRow, columns } : { file, sheet: sh, headerRow: t.headerRow, columns };
  });
  const jsonOut = profile.jsonKeys.map((j) => {
    const sent = { ...j, file: path(j.file), path: keyPath(j.path) };
    link({ file: j.file, jsonPath: j.path }, { file: sent.file, jsonPath: sent.path });
    return sent;
  });
  const fwd = (l: Location): Location => {
    const t = forward.get(locKey(l));
    if (t !== undefined) return { ...t };
    if (l.jsonPath !== undefined) return makeLocation(path(l.file), sheet(l.sheet), undefined, keyPath(l.jsonPath));
    // A header is tokenised by its table, so one with no table cannot be sent safely.
    throw new Error("internal error: a co-occurrence names a table column the profile does not describe");
  };

  const reverse = new Map<string, string>(
    [fileTokens, dirTokens, sheetTokens, keyTokens].flatMap((m) => [...m].map(([real, tok]) => [tok, real] as [string, string])),
  );
  return {
    profile: {
      ...profile,
      files: profile.files.map((f) => ({ ...f, path: path(f.path) })),
      tables: tableOut,
      jsonKeys: jsonOut,
      documents: profile.documents.map((d) => ({ ...d, file: path(d.file) })),
      transcripts: profile.transcripts.map((t) => ({ ...t, file: path(t.file) })),
      cooccurrence: profile.cooccurrence.map((c) => ({ ...c, a: fwd(c.a), b: fwd(c.b) })),
    },
    restore: (loc) => {
      const real = back.get(locKey(loc));
      return real === undefined ? undefined : { ...real };
    },
    restoreText: (text) => text.replace(/\b(?:file|dir|sheet|key)_[1-9]\d*\b/g, (t) => {
      const real = reverse.get(t);
      return real === undefined ? t : JSON.stringify(real);
    }),
    counts: { paths: fileTokens.size, sheets: sheetTokens.size, tables, keys: keyTokens.size },
  };
}

export interface RestoreIssue {
  path: string;
  message: string;
}

/**
 * Maps a reply written against `t.profile` back to real locations: every column rule and every
 * question's `about`, and the tokens in question texts. A location that is not one of the tokens
 * sent is an issue (the reply is rejected whole by the caller), never guessed at.
 */
export function restoreSpec(spec: Spec, t: Tokenised): { spec: Spec; issues: RestoreIssue[] } {
  const issues: RestoreIssue[] = [];
  const show = (l: Location) => `${l.file}${l.sheet === undefined ? "" : ` [${l.sheet}]`} ${JSON.stringify(l.header ?? l.jsonPath ?? "")}`;
  const columns = spec.columns.map((c, i) => {
    const real = t.restore(c);
    if (real === undefined) {
      issues.push({ path: `$.columns[${i}]`, message: `${show(c)} is not a location in the profile that was sent` });
      return c;
    }
    const { file: _f, sheet: _s, header: _h, jsonPath: _j, ...rule } = c;
    return { ...real, ...rule };
  });
  const questions = spec.questions.map((q, i): Question => {
    const text = t.restoreText(q.text);
    if (q.about === undefined) return { ...q, text };
    const about = t.restore(q.about);
    if (about === undefined) {
      issues.push({ path: `$.questions[${i}].about`, message: `${show(q.about)} is not a location in the profile that was sent` });
      return { ...q, text };
    }
    return { ...q, text, about };
  });
  return { spec: { ...spec, columns, questions }, issues };
}

/**
 * Every place in a profile that a profile-only payload must carry as a token but does not: a path
 * that is not `dir_N/.../file_N`, a sheet name that is not `sheet_N`, a table whose headers look
 * like values, a key path with a flagged segment (or that is not a key path), and a co-occurrence
 * naming a column that is not in the payload's tables. Empty when the profile is fit to send.
 */
export function untokenised(profile: Profile): string[] {
  const out: string[] = [];
  const file = (p: string, at: string) => {
    if (!isTokenPath(p)) out.push(at);
  };
  const sheet = (s: string | undefined, at: string) => {
    if (s !== undefined && !isTokenSheet(s)) out.push(at);
  };
  const key = (p: string, at: string) => {
    const segs = segments(p);
    if (segs === null || segs.some((s) => s.key !== undefined && flaggedKey(s.key))) out.push(at);
  };
  profile.files.forEach((f, i) => file(f.path, `$.profile.files[${i}].path`));
  const columns = new Set<string>();
  profile.tables.forEach((t, i) => {
    file(t.file, `$.profile.tables[${i}].file`);
    sheet(t.sheet, `$.profile.tables[${i}].sheet`);
    if (headersLookLikeValues(t.columns.map((c) => c.header))) out.push(`$.profile.tables[${i}].columns[*].header`);
    for (const c of t.columns) columns.add(locKey(makeLocation(t.file, t.sheet, c.header, undefined)));
  });
  profile.jsonKeys.forEach((j, i) => {
    file(j.file, `$.profile.jsonKeys[${i}].file`);
    key(j.path, `$.profile.jsonKeys[${i}].path`);
  });
  profile.documents.forEach((d, i) => file(d.file, `$.profile.documents[${i}].file`));
  profile.transcripts.forEach((t, i) => file(t.file, `$.profile.transcripts[${i}].file`));
  profile.cooccurrence.forEach((c, i) => {
    for (const side of ["a", "b"] as const) {
      const l = c[side];
      const at = `$.profile.cooccurrence[${i}].${side}`;
      file(l.file, `${at}.file`);
      sheet(l.sheet, `${at}.sheet`);
      if (l.jsonPath !== undefined) key(l.jsonPath, `${at}.jsonPath`);
      else if (!columns.has(locKey(l))) out.push(`${at}.header`);
    }
  });
  return out;
}
