# Spec and profile reference

blind passes two JSON documents between its roles:

- the **profile** (`.blind/profile.json`): statistics and short excerpts describing the corpus. It
  is the only thing a model ever sees.
- the **spec** (`.blind/spec.json`): what to blind and how. The analyst proposes it, you review and
  edit it, the engine applies it.

Both have a published JSON Schema in [`schema/`](../schema): `spec.schema.json` and
`profile.schema.json`. blind validates every spec and profile against them before using it,
whether you wrote it, the analyst wrote it, or it came from an earlier run. Validation is strict:

- **Unknown fields are rejected** on every object, at every level. A typo such as `treatmnet` is an
  error, never silently ignored.
- **Wrong types and out-of-range values are rejected** (a `confidence` of `1.5`, a `class` of
  `"manager"`).
- Every problem is reported with a path to it, for example
  `$.columns[2].treatment: must be one of "blind", "keep", "value", got "drop"`.
- Error messages show at most a short prefix of a rejected value, never the whole thing.

Field names are camelCase. All examples below are synthetic.

## Spec

```json
{
  "version": 1,
  "columns": [
    { "file": "staff.csv", "header": "Owner", "class": "person", "treatment": "blind", "confidence": 0.95, "source": "analyst" },
    { "file": "assets.xlsx", "sheet": "Servers", "header": "Status", "class": "vocabulary", "treatment": "keep", "confidence": 1, "source": "human" },
    { "file": "tickets.json", "jsonPath": "$.items[*].ref_code", "class": "unknown", "treatment": "value", "confidence": 0.4, "source": "analyst" }
  ],
  "entities": {
    "person": [{ "canonical": "Avery Quill", "aliases": ["A. Quill", "Quill, Avery", "Aves"], "parts": ["Avery", "Quill"] }],
    "org": [{ "canonical": "Example Widgets", "aliases": ["Example Widgets Ltd", "EXW"], "parts": [] }]
  },
  "patterns": { "ip": true, "email": true, "host": true, "guid": true, "mac": false },
  "questions": [
    { "id": "q1", "text": "Values under ref_code look like internal project IDs. Hide them?", "options": ["blind", "keep"], "answer": null,
      "about": { "file": "tickets.json", "jsonPath": "$.items[*].ref_code" } }
  ]
}
```

All five top-level fields are required.

### `version`

Always `1`. Any other value is rejected.

### `columns`

One rule per table column or JSON key path. An array, possibly empty. Each rule:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `file` | string, non-empty | yes | Path of the file, as listed in the profile. Example: `"staff.csv"`. |
| `sheet` | string, non-empty | no | Worksheet name, for workbooks. Example: `"Servers"`. |
| `header` | string | one of `header` / `jsonPath` | Column header text. May be `""` for a blank header. Example: `"Owner"`. |
| `jsonPath` | string, non-empty | one of `header` / `jsonPath` | Key path, for JSON and JSONL. Example: `"$.items[*].ref_code"`. |
| `class` | `person` \| `org` \| `host` \| `email` \| `id` \| `location` \| `vocabulary` \| `unknown` | yes | What the values are. `vocabulary` means ordinary words that identify no one. `unknown` means nobody could decide. |
| `treatment` | `blind` \| `keep` \| `value` | yes | `blind`: replace with a class-prefixed pseudonym (`Person_A7F3`). `keep`: leave unchanged. `value`: replace with a neutral `Value_` pseudonym. |
| `confidence` | number, 0 to 1 | yes | How sure the author of the rule was. Example: `0.95`. |
| `source` | `analyst` \| `human` \| `heuristic` | yes | Who wrote the rule: the model analyst, you, or the built-in heuristics. |

A rule sets exactly one of `header` and `jsonPath`; neither, or both, is an error. Two rules for
the same column (same `file`, `sheet`, and `header` or `jsonPath`) are an error: keep one. A rule
with class `unknown` cannot use treatment `keep`: an undecided column never passes through
unchanged. To keep it, classify it (for example as `vocabulary`).

### `entities`

Names to find and replace in free text, grouped by class. An object whose keys are any of
`person`, `org`, `host`, `email`, `id`, `location`, `vocabulary` (not `unknown`); every key is
optional and `{}` is valid. Each value is an array of entities:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `canonical` | string, non-empty | yes | The one form every mention resolves to, and the input to the pseudonym. Example: `"Avery Quill"`. |
| `aliases` | array of non-empty strings | yes | Other ways the same entity is written: nicknames, misspellings, `Last, First`, acronyms, legal suffixes. Example: `["A. Quill", "Aves"]`. May be `[]`. |
| `parts` | array of non-empty strings | yes | Pieces that also refer to it on their own, such as a given name or surname. Example: `["Avery", "Quill"]`. May be `[]`. |

### `patterns`

Shape detectors for free text. All five keys are required, so turning a detector off is always an
explicit, visible choice. `true` means values of that shape are found and replaced.

| Field | Type | Meaning |
|---|---|---|
| `ip` | boolean | IPv4 and IPv6 addresses, e.g. `192.0.2.10`. |
| `email` | boolean | Email addresses, e.g. `avery@example.com`. |
| `host` | boolean | Host names, e.g. `db01.example.com`. |
| `guid` | boolean | GUIDs, e.g. `123e4567-e89b-12d3-a456-426614174000`. |
| `mac` | boolean | MAC addresses, e.g. `00:00:5e:00:53:01`. |

### `questions`

Things the analyst could not decide and is asking you. An array, possibly empty. Each question:

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string, non-empty, unique in the spec | yes | Stable handle, used with `blind plan --answer q1=blind`. |
| `text` | string, non-empty | yes | The question. Example: `"Values under ref_code look like internal project IDs. Hide them?"`. |
| `options` | array of 2 or more distinct non-empty strings | yes | The allowed answers. Example: `["blind", "keep"]`. |
| `answer` | one of `options`, or `null` | yes | Your answer; `null` while unanswered. |
| `about` | object: `file`, optional `sheet`, and exactly one of `header` and `jsonPath` | no | The column the question decides. While the question is unanswered, `blind plan` keeps that column `unknown`/`value`. Its options are then drawn from `blind`, `keep`, `value` and the class names. |

`blind plan --answer q1=<option>` records the answer and, for a question with `about`, rewrites
that column's rule as your decision (`source: "human"`, `confidence: 1`):

| Answer | Column rule becomes |
|---|---|
| `blind` | treatment `blind`, class unchanged (an `unknown` column gets `Value_` pseudonyms) |
| `value` | treatment `value`; on an `unknown` column, treatment `blind`, so it is always pseudonymised |
| `keep` | treatment `keep`; an `unknown` column becomes `vocabulary` |
| a class name | that class, treatment `blind` if the policy calls it sensitive, otherwise `keep` |

## How `blind apply` uses the spec

`blind apply <inputs> -o <out>` reads `.blind/spec.json` and `.blind/salt` and refuses (exit 2,
nothing written) if either is missing or the spec is invalid. Spec `file` values are paths relative
to an input directory, or the file name for a file named directly. This release handles CSV/TSV,
JSON and JSONL (`.json`, `.jsonl`, `.ndjson`) and text (`.txt`, `.md`, `.log`); any other file is
listed and not written (exit 1).

**Table columns.** The header row is found the same way `blind profile` finds it, so spec headers always match: the earliest of the first 20 rows that fills more than half the table's width and is mostly non-numeric text, or row 1 if no row qualifies.

| Rule | Result |
|---|---|
| `treatment: keep` (any class) | Byte-identical. Cells that contain a spec entity or pattern match are left alone and reported as a warning. |
| `treatment: blind`, class `person`/`org`/`host`/`email`/`id`/`location` | Every non-empty cell gets that class's pseudonym. |
| `treatment: blind` with `unknown`/`vocabulary`, or `value` with any other class | Every non-empty cell gets a `Value_` pseudonym. |
| `class: unknown, treatment: value`, or **no rule at all** | Fail closed. If distinct ratio ≥ 0.5 and (digit ratio ≥ 0.3, or dictionary-word ratio ≤ 0.3, or ≥ 80% of values are Title-Case multi-word), every cell gets a `Value_` pseudonym, reported as `unknown → pseudonymised`. Otherwise the column is kept (`unknown → kept (low cardinality)`, or `kept (not identifier-like)` for prose), but spec entities and patterns are still replaced inside its cells. |

A rule that names a column the file does not have is an error, so a stale spec never quietly stops
blinding a column. Rows above the header and the header row itself are treated as free text.

**JSON and JSONL.** Rules name a key path with `jsonPath` (see [key paths](#key-paths)); a `header`
or `sheet` rule on a JSON file is an error, as is a rule for a key path the file does not have. The
table above applies to each key path's values as it does to a column's cells:

- Strings and numbers are values. A number counts as written, so the string `"9123"` and the number
  `9123` under one key path get the same pseudonym (a numeric ID stays numeric). A number whose
  pseudonym is not a number (`Person_A7F3`, `Value_2C9E`) is written as a JSON string. `true`,
  `false` and `null` are never changed.
- Keys that are record identifiers are the values of their `.*~` key path and are rewritten like any
  other value, so an ID used as a key and the same ID used as a value get the same pseudonym. If
  blinding would give two keys of one object the same name, apply refuses (exit 2, nothing written).
- Other keys (field names) are free text, like a table's header row.

Edits are spliced into the original text: indentation, spacing, separators, key order, the escaping
of untouched characters and the trailing newline are unchanged, and JSONL stays one record per line.
A file that does not parse (strict RFC 8259; for JSONL, each non-blank line) is listed and not
written (exit 1).

**Free text** (text files, and the non-blinded cells above). Enabled `patterns` are matched first,
and each match is replaced whole. Then every entity `canonical`, alias and part is replaced, longest
form first and whole words only. All forms of one entity share one pseudonym. Case rules depend on
how the form is written:

- An acronym (no lowercase letters, at most 6 letters, such as `EXW`) matches exactly.
- A single capitalised word (such as `Avery` or `May`) matches only where the text is capitalised,
  so `may` is left alone.
- Anything else matches case-insensitively, with any run of whitespace between words.

`vocabulary` entities are kept as written and shield their words from other entity forms.

**Kept hosts.** A host name equal to, or under, a domain-shaped term of the `blind.toml` keep list
(`terms = ["vendor.example.net"]`; a leading `*.` is ignored) is kept as written: `api.vendor.example.net`
stays, `badvendor.example.net` does not. Terms without a dot never keep a host, and the keep list
does not keep email addresses. Each file's report counts the hosts kept this way. Without a
`blind.toml` no host is kept; an invalid one is refused (exit 2).

**File and folder names.** Every folder name and every file name (without its extension) in the
output tree is rewritten like free text: enabled patterns, spec entities, and also every cell value
a column rule replaced, so `reviews/Robin Example.md` is written as `reviews/Person_4C1D.md` when
`Robin Example` is a blinded `Owner`. Names use the same pseudonyms as the content. Names are
also searched piece by piece between underscores (`backup_db01.example.com.txt`). The report lists each renamed file
(`written as ...`). Two inputs whose blinded names coincide are refused (exit 2, nothing written).
Every pseudonym used in a name is in the reversal map, so names are as reversible as the content;
`blind reveal` is not built yet, and until it is, restore names by looking each pseudonym up in the
map. The engine also exposes this rewrite for worksheet and defined names; this release reads no
workbooks, so it is not yet applied to any.

**Output.** Delimiter, quoting, line endings and encoding (UTF-8 with or without BOM, UTF-16 with
BOM, otherwise 8-bit bytes) are preserved, and a file with nothing to replace is copied byte for
byte. The reversal map goes to `.blind/map.json`, or to `--map-out <path>`, created with mode 0600.
It may not sit inside the output or an input. An existing map at that path is reused, so earlier
pseudonyms stay the same.

## How `blind audit` checks the output

`blind audit <out>` reads `.blind/spec.json` and the map (`.blind/map.json`, or `--map <path>`)
and checks the output tree as it is on disk, independently of how `blind apply` wrote it. This
release runs the mechanical layer only (no model).

- **What is read.** Every entry under `<out>`, hidden ones included. Each file's raw bytes are read
  as Latin-1, UTF-8 and UTF-16 (both byte orders, both alignments), and each of those again with
  XML character references, `%XX` escapes and backslash escapes undone. Zip archives (xlsx, docx,
  anything starting `PK`) are opened recursively, up to 8 levels deep. File, directory and member
  names are read too. Symbolic links are not followed.
- **What it looks for.** Every spec entity form (canonical, aliases, parts; `vocabulary` excepted),
  every original value in the map (surface and canonical form), and every match of an enabled
  pattern that is not a pseudonym. Text that is a pseudonym or a `vocabulary` form is never a finding,
  and neither is a pattern match made only of pseudonyms and punctuation (a blinded file name such
  as `Person_1E95_user_559f@host-f3ce.com.md`). File and directory names are also read piece by
  piece between underscores, as `blind apply` reads them, and a file's extension is read on its own.
- **Kept hosts.** A host name under a domain in the `blind.toml` keep list is not reported: the
  engine keeps it because the policy says to. An invalid `blind.toml` stops the audit (exit 3).
- **`leak`**: a whole-word survivor in the case the engine would have replaced.
- **`candidate`**: a case, accent or width variant; a value inside a longer word (4 characters or
  more); a value under 3 characters; a host label or email local part of a blinded value; a column
  the spec declares `unknown`; a CSV/TSV column with no spec rule; an unanswered spec question; and
  anything the audit could not read in full (undecodable or encrypted archive members, binary
  content, images, symbolic links, unreadable files).

Status is `leak` if any leak, else `candidates` if any candidate, else `clean`. Exit status: 0
clean, 1 candidates, 2 leak, 3 the audit could not run (usage error, or a missing or invalid spec
or map; nothing audited). The report (a table, or `--json`) gives file, zip member, byte offset and
line, class and a masked value: the first two characters (never more than half), `***`, and the
length. `clean` means only that this check found nothing it knows to look for; it is not a
guarantee that nothing identifying remains.

## Profile

```json
{
  "version": 1,
  "sampleCount": 3,
  "files": [
    { "path": "staff.csv", "format": "csv", "size": 2048 },
    { "path": "tickets.json", "format": "json", "size": 4096 },
    { "path": "notes.md", "format": "markdown", "size": 512 },
    { "path": "standup.vtt", "format": "vtt", "size": 1024 }
  ],
  "tables": [
    {
      "file": "staff.csv",
      "headerRow": 1,
      "columns": [
        {
          "header": "Owner",
          "stats": {
            "count": 40, "distinctRatio": 0.6, "digitRatio": 0, "dictionaryRatio": 0.05, "meanLength": 11.2,
            "detectorRates": { "ip": 0, "email": 0, "host": 0, "guid": 0, "mac": 0, "numericId": 0 },
            "samples": ["Avery Quill", "Robin Example", "Sam Placeholder"]
          }
        }
      ]
    }
  ],
  "jsonKeys": [],
  "documents": [
    { "file": "notes.md", "outline": ["Overview", "Next steps"], "sampleSentences": ["Avery Quill will migrate db01.example.com on Friday."] }
  ],
  "transcripts": [
    { "file": "standup.vtt", "speakers": ["Avery Quill", "Robin Example"], "sampleLines": ["Robin Example: the demo moved to Tuesday."] }
  ],
  "cooccurrence": [
    { "a": { "file": "staff.csv", "header": "Owner" }, "b": { "file": "tickets.json", "jsonPath": "$.items[*].assignee" }, "shared": 7 }
  ]
}
```

All eight top-level fields are required; the arrays may be empty.

**Privacy limits.** Every string taken from document content (`header`, `sheet`, `samples`,
`outline`, `sampleSentences`, `speakers`, `sampleLines`, and `header`/`sheet` in a co-occurrence
location) is at most **120 characters** (counted as Unicode code points). The profiler truncates
before writing; the validator rejects anything longer. `samples`, `sampleSentences` and
`sampleLines` each hold at most `sampleCount` items. The profile has no field for raw document
text, and co-occurrence pairs carry counts, not the shared values.

### `version`

Always `1`.

### `sampleCount`

Integer, 0 or more. `k`, the most sample values any one column, key, document or transcript carries.
`0` means statistics and headers only. Example: `5`.

### `files`

Every input file. Each entry:

| Field | Type | Meaning |
|---|---|---|
| `path` | string, non-empty, unique | Path relative to the input root. Example: `"staff.csv"`. Every `file` elsewhere in the profile must be one of these. |
| `format` | `csv` \| `tsv` \| `json` \| `jsonl` \| `xlsx` \| `docx` \| `text` \| `markdown` \| `log` \| `vtt` \| `srt` | The file's container format. A transcript-shaped DOCX or text file keeps `docx` or `text` here and also appears under `transcripts`. |
| `size` | integer, 0 or more | Size in bytes. Example: `2048`. |

### `tables`

One entry per table (a CSV/TSV file or a worksheet).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `file` | string, non-empty | yes | The file the table is in. |
| `sheet` | string, at most 120 characters | no | Worksheet name, for workbooks. |
| `headerRow` | integer, 1 or more | yes | 1-based row number of the header row. |
| `columns` | array of `{ header, stats }` | yes | `header` (string, at most 120 characters, may be `""`) and its statistics. |

### `jsonKeys`

One entry per JSON or JSONL key path, in the order first seen in the file.

| Field | Type | Meaning |
|---|---|---|
| `file` | string, non-empty | The file. |
| `path` | string, non-empty | The key path. Example: `"$.items[*].ref_code"`. |
| `stats` | stats | Statistics over the values at that path. |

#### Key paths

- `$` is the document root; in JSONL, the root of each line, so every record shares its key paths.
- `.name` for a key made of letters, digits and `_` that does not start with a digit; any other key
  is written `["key"]`, JSON-quoted (`$["first name"]`).
- `[*]` is every element of an array, so an array of scalars is one column (`$.records[*].tags[*]`).
- A key that is itself a record identifier is written `.*`, so an object keyed by record IDs is one
  set of columns rather than one per record (`$.users.*.name`), and its keys are the column `.*~`
  (`$.users.*~`). A key is a record identifier when it is all digits, has 4 or more digits
  (`u-1001`, a date), is hex of 6 or more with a digit (`a3f9c2`), or is a GUID, an email address
  or an IPv4 address. Field names such as `sha256` or `line1` are not.

Strings and numbers (as written) are the values a key path's statistics are computed over; `true`,
`false` and `null` are not counted, but the key path is still listed.

### stats

Shared by table columns and JSON keys. All fields required.

| Field | Type | Meaning |
|---|---|---|
| `count` | integer, 0 or more | Number of non-empty values. Example: `40`. |
| `distinctRatio` | number, 0 to 1 | Distinct values ÷ `count`. Example: `0.6`. |
| `digitRatio` | number, 0 to 1 | Share of characters that are digits. Example: `0.8`. |
| `dictionaryRatio` | number, 0 to 1 | Share of words found in the dictionary. Example: `0.05`. |
| `meanLength` | number, 0 or more | Mean value length in characters. Example: `11.2`. |
| `detectorRates` | object `{ ip, email, host, guid, mac, numericId }`, each 0 to 1 | Share of values each shape detector matched. All six keys required. `ip` (IPv4), `email`, `host`, `guid` and `mac` count values that contain the shape; `numericId` counts values that are wholly an optional short letter prefix and 4 or more digits (`004417`, `ACCT-000123`). |
| `samples` | array of strings, each at most 120 characters, at most `sampleCount` items | Example values, quoted as data. |

### `documents`

One entry per prose document (text, Markdown, logs, DOCX).

| Field | Type | Meaning |
|---|---|---|
| `file` | string, non-empty | The file. |
| `outline` | array of strings, each at most 120 characters | Headings, in order. |
| `sampleSentences` | array of strings, each at most 120 characters, at most `sampleCount` items | Example sentences. |

### `transcripts`

One entry per transcript (VTT, SRT, or a DOCX or text file detected as transcript-shaped).

| Field | Type | Meaning |
|---|---|---|
| `file` | string, non-empty | The file. |
| `speakers` | array of strings, each at most 120 characters | Speaker labels as written. |
| `sampleLines` | array of strings, each at most 120 characters, at most `sampleCount` items | Example lines. |

### `cooccurrence`

Pairs of locations that share values, which suggests they hold the same kind of thing.

| Field | Type | Meaning |
|---|---|---|
| `a`, `b` | location | Each `{ file, sheet?, header }` for a table column or `{ file, jsonPath }` for a JSON key; exactly one of `header` and `jsonPath`. |
| `shared` | integer, 1 or more | Number of distinct values present in both. Example: `7`. |

### How `blind profile` builds it

`blind profile <inputs...>` reads CSV (`.csv`), TSV (`.tsv`, `.tab`), JSON (`.json`), JSONL
(`.jsonl`, `.ndjson`), plain text (`.txt`, `.text`), Markdown (`.md`, `.markdown`) and logs (`.log`), writes `.blind/profile.json` (mode
0600) and prints it as a table; `--json` prints the JSON instead. `k` is `[profile] samples` in
`blind.toml`, or `--samples N`. When `samples` is unset, `k` follows `[privacy] mode`: 5 under
`local-only` and `none`, 0 (headers and statistics only) under `profile-only`.

- **Paths.** Directories are walked recursively in sorted order; `path` is relative to the input
  directory, or the file name for a file named directly. Hidden entries, symbolic links, files in
  other formats, files that are not valid UTF-8 and CSV or JSON files that do not parse are left out of the
  profile, listed under "not profiled", and the command exits 1. blind's own `.blind/` and
  `blind.toml` are skipped without comment.
- **Long paths.** `path` is never truncated, because the spec and the engine need it exact. A file
  whose profile path is over 120 characters is left out and listed under "not profiled" instead.
  Every other document-derived string (headers, samples, outline, sentences) is cut as below.
- **Key paths.** JSON key paths, like file paths, are never truncated; a JSON file with a key path
  over 120 characters is left out and listed under "not profiled".
- **Header row.** The earliest of the first 20 rows that fills more than half the table's width
  and whose filled cells are mostly text (contain a letter and are not a number). Rows above it,
  such as a title, are ignored. When no row qualifies, row 1 is used and a note says so.
- **Statistics.** Over the non-empty cells below the header. Words are runs of two or more letters,
  looked up in a small built-in English word list. Ratios are rounded to four decimals.
- **Samples.** Up to `k` distinct values per column, spread evenly through the column in file order
  (no randomness, so the same corpus gives the same profile). Every excerpt has whitespace collapsed
  and is cut to 120 characters, ending in `…` when cut.
- **Documents.** The outline is the first non-empty line, then, for Markdown, each heading (fenced
  code is skipped), at most 50 entries. Sample sentences are up to `k` distinct sentences spread
  evenly through the document; for logs, each line is one sample.
- **Co-occurrence.** Every pair of table columns or JSON key paths, in the same or different files, whose distinct
  values (compared case-insensitively, trimmed) overlap by more than half of the smaller column's
  distinct values.

## Privacy modes

`[privacy] mode` in `blind.toml` decides what a model call may do. Every check runs before
anything is sent; a refused call exits 2 and names the mode (except under `blind audit`, where 2
means a leak: there a refused call exits 3, "the audit could not run"). There is no fallback to another mode
or backend.

| Mode | Model calls | What is sent |
|---|---|---|
| `local-only` (default) | Loopback endpoints only (127.0.0.0/8, `::1`, `localhost`). `claude-cli`, the hosted Anthropic API and any other host are refused with "privacy.mode is local-only". | The caller's data, every string at most 120 characters. |
| `profile-only` | Remote endpoints allowed, over https. | Exactly the profile and the policy (classes, description split into pieces of at most 120 characters, examples, keep list). Anything else is refused. |
| `none` | None. `blind plan` uses the heuristic analyst; `blind audit` runs its mechanical and semantic layers only. | Nothing. |

Each call prints one line to stderr before it is sent:
`role · backend · model · mode · [samples k ·] N bytes sent`, where `samples k` is the profile's
`sampleCount` and appears under `profile-only`. Under `profile-only` the line is printed even when
the command is quiet.
