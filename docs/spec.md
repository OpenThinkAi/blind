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
    { "id": "q1", "text": "Values under ref_code look like internal project IDs. Hide them?", "options": ["blind", "keep"], "answer": null }
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

One entry per JSON or JSONL key path.

| Field | Type | Meaning |
|---|---|---|
| `file` | string, non-empty | The file. |
| `path` | string, non-empty | The key path. Example: `"$.items[*].ref_code"`. |
| `stats` | stats | Statistics over the values at that path. |

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

`blind profile <inputs...>` reads CSV (`.csv`), TSV (`.tsv`, `.tab`), plain text (`.txt`,
`.text`), Markdown (`.md`, `.markdown`) and logs (`.log`), writes `.blind/profile.json` (mode
0600) and prints it as a table; `--json` prints the JSON instead. `k` is `[profile] samples` in
`blind.toml`, or `--samples N`.

- **Paths.** Directories are walked recursively in sorted order; `path` is relative to the input
  directory, or the file name for a file named directly. Hidden entries, symbolic links, files in
  other formats, files that are not valid UTF-8 and CSV files that do not parse are left out of the
  profile, listed under "not profiled", and the command exits 1. blind's own `.blind/` and
  `blind.toml` are skipped without comment.
- **Long paths.** `path` is never truncated, because the spec and the engine need it exact. A file
  whose profile path is over 120 characters is left out and listed under "not profiled" instead.
  Every other document-derived string (headers, samples, outline, sentences) is cut as below.
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
- **Co-occurrence.** Every pair of table columns, in the same or different files, whose distinct
  values (compared case-insensitively, trimmed) overlap by more than half of the smaller column's
  distinct values.
