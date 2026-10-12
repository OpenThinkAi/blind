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

The first five top-level fields are required; [`seen`](#seen) is optional.

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
| `source` | `analyst` \| `human` \| `heuristic` | no | Who added it. `blind plan --from-audit` writes `"human"` on every entity it adds (see [below](#feeding-the-audit-back-into-the-spec)). The analyst cannot set it: a reply that does is rejected. |

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

A column has at most one question. The analyst's reply is rejected if two of its questions are
about the same column, and `--answer` refuses to answer either of two such questions in a
hand-edited spec until one is deleted.

### `seen`

Fingerprints of the document and transcript excerpts (outline entries, sample sentences, speakers,
sample lines) the analyst has already read: the first 16 hex digits of each excerpt's SHA-256,
sorted and unique. `blind plan` writes it; the analyst cannot. Delete an entry, or the whole field,
to have those excerpts sent again.

## Re-planning with a saved spec

`blind plan <inputs>` reuses `.blind/spec.json` when it exists (`--force` ignores it and plans from
scratch, losing its edits and answers). The saved spec is validated first; an invalid one stops the
plan (exit 2) before anything is profiled or sent.

- **What is sent.** The analyst gets a profile of only what the spec does not cover: columns and
  key paths with no rule, and excerpts not in `seen`. When nothing is new, no model is called.
- **What the analyst may change.** It may add column rules, entities and questions. It may
  classify a saved rule that is its own (`source: "analyst"`), `unknown`, and not the subject of a
  question. Everything else saved is kept exactly as it was, so a rule with `source: "human"` and
  an answered question are written back byte-identical. A reply that would change a saved rule,
  ask again about a column that already has a question, change a saved entity or flip a pattern
  has that part dropped and listed. A new entity's alias or part that is already a form of a saved
  entity is left out of it and listed. A new question whose id is taken gets the next free `qN`.
- **Vocabulary that would shield.** A vocabulary entry the analyst proposes (first plan or re-plan) is
  dropped and listed (`kind: "vocabulary"`) when one of its forms equals a value blinded in a profile
  column (its samples), a map value or canonical form, or a person or org entity form or part. A
  vocabulary form keeps its words in clear, and `blind run --yes` skips the review that would catch it.
  Human vocabulary (`--answer`, `--from-audit`, hand edits) is not checked.
- **The report.** After the spec, `blind plan` prints what was added, classified and dropped.
  `--json` prints that report as JSON instead of the spec:
  `{ "spec", "reused", "added": { "columns", "entities", "questions" }, "classified", "dropped", "notes" }`.

## Feeding the audit back into the spec

`blind plan --from-audit <report.json> -o <out>` turns what an audit could not explain into spec
changes you decide. `<report.json>` is the output of `blind audit <out> --json`, and `-o` names the
same blinded output tree. No model is called.

- **Candidates.** The report masks the values it finds (file and member names are printed as on
  disk), so each finding that points at one value
  (a byte offset, a decoding, a masked value) is mapped back to its place in `<out>` (the file, the
  zip member, its name or content) and the value is read there. It must mask exactly as the report
  says and must not be a pseudonym in the map (`--map`, default `.blind/map.json`); otherwise the
  finding is listed on stderr as not read back and the exit status is 1. A value found inside a
  longer word is taken as that whole word. Each distinct value is one candidate, `c1`, `c2`, ... in
  report order, listed with what raised it, where, and the class it suggests (`id` for identifier
  shapes, `email`, `host`, the class of a spec entity or map value, none for a Title-Case phrase).
- **Not candidates.** Findings that are not one value (a column the spec declares unknown or does
  not mention, an unanswered question, a part the audit could not read, a model chunk not checked)
  are listed and change nothing: `blind plan <inputs>` and `--answer` decide those.
- **Deciding.** On a terminal you are asked about each candidate. Otherwise `--accept c1,c2=org`
  and `--reject c3` (repeatable) decide them; without either, nothing is written. A bad id, an
  accept with no class to give, or a refused reject stops with exit 2 and nothing written.

| Decision | Spec change |
|---|---|
| `--accept c1` | an entity of the suggested class, `{ "canonical": <value>, "aliases": [], "parts": [], "source": "human" }` |
| `--accept c1=<class>` | the same, of `person`, `org`, `host`, `email`, `id` or `location` |
| `--accept c1=pattern` | the shape pattern the whole value matches (`email`, `ip`, `mac`, `guid`, `host`) is turned on |
| `--reject c1` | a `vocabulary` entity with `source: "human"`, so the mechanical and semantic layers do not raise it again |
| neither | nothing; the next audit raises it again |

- **`--accept-leaks`** decides the leaks without asking: every candidate with a `leak` finding (a
  spec entity, a map value or an enabled pattern match that survives, all from the mechanical
  layer) is accepted at its suggested class, or `id` when it suggests none (a map value a column
  pass pseudonymised as `Value_`, an account name in a path). Candidates that are not leaks
  (semantic and model findings, variants in another case) stay undecided unless `--accept` or
  `--reject` decides them, and an `--accept` or `--reject` of a leak wins. A leak that cannot be
  accepted (a saved vocabulary form) is listed with why and left undecided; the rest are still
  accepted. Until two classes share a pseudonym, a map value accepted as `id` gets an `Id_`
  pseudonym where it recurs, not its column's `Value_`.

- **Saved entries are never changed.** New entities are appended; everything saved is written back
  byte-identical. A value that is already a form of a saved entity changes nothing (and is said so);
  accepting a saved vocabulary form is refused (delete it by hand first).
- **Rejecting fails closed.** A value the mechanical layer found as a spec entity, map value or
  pattern match cannot be rejected, nor can a value that contains, as whole words, a form of a spec
  entity or a value or canonical form from the map: as vocabulary it would be kept and would shield
  those words. Accept it or leave it undecided.
- **Then** run `blind apply` and `blind audit` again (`blind run --accept-leaks` does both for
  you). `--json` prints `{ "spec", "candidates", "changes", "undecided", "leaksSkipped", "other",
  "unmapped" }`. The candidates hold the
  values read back from `<out>` in the clear, as the table does, so you can decide on them: treat
  that output as you treat the spec, and do not save it where others can read it.

## How `blind apply` uses the spec

`blind apply <inputs> -o <out>` reads `.blind/spec.json` and `.blind/salt` and refuses (exit 2,
nothing written) if either is missing or the spec is invalid, or if a file or folder it would write
inside `<out>` is already a symbolic link (it never writes through one). Spec `file` values are paths relative
to an input directory, or the file name for a file named directly. This release handles CSV/TSV,
JSON and JSONL (`.json`, `.jsonl`, `.ndjson`), XLSX workbooks (`.xlsx`), text (`.txt`, `.md`,
`.log`), DOCX (`.docx`) and WebVTT and SRT transcripts (`.vtt`, `.srt`); any other file is listed
and not written (exit 1). Transcripts are found by content, not by name (see
[transcripts](#transcripts-in-apply) below).

**Table columns.** The header row is found the same way `blind profile` finds it, so spec headers always match: the earliest of the first 20 rows that fills more than half the table's width and is mostly non-numeric text, or row 1 if no row qualifies.

| Rule | Result |
|---|---|
| `treatment: keep` (any class) | Byte-identical, except that a value blinded elsewhere is replaced (see recurring values below). Cells that contain a spec entity or pattern match are left alone and reported as a warning. |
| `treatment: blind`, class `person`/`org`/`host`/`email`/`id`/`location` | Every non-empty cell gets that class's pseudonym. |
| `treatment: blind` with `unknown`/`vocabulary`, or `value` with any other class | Every non-empty cell gets a `Value_` pseudonym. |
| `class: unknown, treatment: value`, or **no rule at all** | Fail closed. If distinct ratio ≥ 0.5 and (digit ratio ≥ 0.3, or dictionary-word ratio ≤ 0.3, or ≥ 80% of values are Title-Case multi-word), every cell gets a `Value_` pseudonym, reported as `unknown → pseudonymised`. Otherwise the column is kept (`unknown → kept (low cardinality)`, or `kept (not identifier-like)` for prose), but spec entities and patterns are still replaced inside its cells. |

A rule that names a column the file does not have is an error, so a stale spec never quietly stops
blinding a column. Rows above the header and the header row itself are treated as free text.

**One entity, one pseudonym.** A value gets one pseudonym across classes: a name blinded as a
transcript speaker (`person`) and pseudonymised again in a `value` column keeps the speaker's
`Person_` pseudonym rather than getting a `Value_` one too. A value is matched under the other
class's canonical form (`Quill, Avery` finds the person `Avery Quill`), and an earlier map counts.
The specific classes are issued before `value`, so their shape is the one kept. Phone-shaped values
canonicalise to their digits in every class, so `(801) 555-0100`, `801-555-0100` and
`+1 801 555 0100` share one pseudonym (`blind reveal` restores each as the form the map records). A
value of bare digits is never read as a phone, so numeric IDs keep their length.

**Recurring values.** Once every column is decided, each value a column rule pseudonymised, each XLSX
or DOCX identity metadata value replaced whole (creator, last modified by, comment and revision
authors, Manager, Company, user IDs and account names in paths, with their class), and each
value an earlier map holds, is replaced with the same pseudonym wherever else it appears: in text
files, header and preamble rows, cells kept as text or under `keep`, JSON strings and keys, and DOCX free text (matched across runs
like any other DOCX match). The
value as written matches, and so does its canonical form when that differs by more than case ("Example
Widgets" for "Example Widgets, Inc."). Matching is by whole token, with the entity case rules: a short
all-capitals code only exactly, a single capitalised word only where the text is capitalised too,
anything else in any case. The longest form wins at each position, and a spec entity wins a tie. Left
out, so ordinary prose is not rewritten: values with fewer than 3 letters and digits (`42`, `N/A`),
values made only of dictionary words (`open`, `Main Office`), spec vocabulary forms, values from
columns classed `vocabulary`, and the host labels and email local parts of a blinded host or email.
`blind audit` still reports any of these that survive, and spellings the case rules leave, so add
them to the spec as entities if they must go.

**Name parts.** Each person a column rule pseudonymised (or Office metadata names, or an earlier map holds) also has each part
of their name replaced on its own, with that person's pseudonym: `Quill approved it; Avery agreed`
after `Avery Quill` was blinded in an Owner column. A part is each word of the name as written and of
its canonical form, and each piece of a hyphenated word, matched like a single capitalised word (so
`quill` in lowercase is left alone). Left out, as the audit leaves them out: parts with fewer than 3
letters, dictionary words (`Will`, `Price`), honorific and role words (`Dr`, `Mrs`, `Front`, `Desk`,
`Nurse`, `Vet`, ...), keep-list terms and vocabulary forms. A part two
different people share (`Quill` for `Avery Quill` and `Bea Quill`, or a column person and a
transcript speaker) gets its own pseudonym, never either person's, and the apply report lists those
pseudonyms. Spec entities are not split this way: their parts are the ones the spec lists.

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

`vocabulary` entities are kept as written and shield their words from other entity forms. A vocabulary form wins any length tie with another form, so a vocabulary acronym such as `SAM` is kept even when a person part `Sam` (which matches any capitalised text, including all-caps) has the same length.

**Kept hosts.** A host name equal to, or under, a domain-shaped term of the `blind.toml` keep list
(`terms = ["vendor.example.net"]`; a leading `*.` is ignored) is kept as written: `api.vendor.example.net`
stays, `badvendor.example.net` does not. Terms without a dot never keep a host, and the keep list
does not keep email addresses. Each file's report counts the hosts kept this way. Without a
`blind.toml` no host is kept; an invalid one is refused (exit 2).

**DOCX.** Column rules do not apply (a rule naming a DOCX file is an error). Every part is
rewritten at the XML level, so everything not blinded is copied byte for byte:

- Text is free text, matched per paragraph across runs: Word splits `Acme Corp` into runs such as
  `Ac` + `me Corp`, and the match is still found. Its pseudonym goes into the run where the match
  starts and the rest of the match is removed from the later runs, so the number of runs, their
  formatting and the paragraphs are unchanged. A tab, break, field character or other object
  between runs separates words.
- This covers the body, tables, headers, footers, footnotes, endnotes, comments, text boxes, chart
  labels and field instructions (`w:instrText`, matched apart from the visible text).
- Tracked changes: a paragraph with insertions or deletions is matched both as accepted and as
  rejected, and every match from either reading is replaced, including in deleted text
  (`w:delText`).
- Authors and initials on comments and revisions (`w:author`, `w:initials`), people and presence
  IDs, `dc:creator`, `cp:lastModifiedBy`, Manager and Company are replaced as a whole with a
  `Person_`, `Id_` or `Org_` pseudonym even when the spec does not list them. Other document
  properties (core, app, custom), drawing names and alt text, form-field and content-control text,
  document variables, mail-merge strings and external hyperlink targets are free text.
- Office's own linking IDs are rewritten wherever they are (see **Office structural IDs** below).
- A spec value or pattern match (any shape, as for a workbook) in a part or attribute nothing here
  rewrites, such as custom XML, stops the document (listed and not written, exit 1), naming the part
  and element but never the value.
- Images are copied unchanged and listed as a warning. A package that cannot be read, has a part
  this handler does not know that holds text, or embeds another file (an OLE object, a chart's
  workbook, macros) is listed and not written (exit 1). So is one with a saved thumbnail
  (`docProps/thumbnail.*`), a picture of the original first page.

<a id="transcripts-in-apply"></a>**Transcripts.** A file is a transcript by its content:

- **WebVTT**: a `WEBVTT` first line and at least one cue timing line (`00:00:01.000 --> 00:00:04.000`).
- **SRT**: a numbered cue with a timing line first, and at least 80% of the blank-line-separated
  blocks are such cues.
- **Text and DOCX**: at least 80% of the non-empty paragraphs (and at least two) are timestamp,
  speaker, text entries: `[00:00:03] Avery Quill: text`, `00:03 Avery Quill` with the text on the
  next line or in the next paragraph, `00:00:03.120 --> 00:00:05.480` then the speaker then the text,
  or `Avery Quill   0:03` (the speaker first, as a Teams transcript saved as Word has it). For a
  text file, a paragraph is a run of non-blank lines, also split before every line that starts with
  a timestamp; for a DOCX, it is a body paragraph (as accepted, when it has tracked changes).

A `.vtt` or `.srt` file that is none of these is listed and not written (exit 1). A text file or
DOCX that is not transcript-shaped is blinded as ordinary text or DOCX. In a transcript:

- Every speaker tag or prefix is replaced with that speaker's `Person_` pseudonym, even when the spec
  does not list the speaker: VTT voice tags (`<v Avery Quill>`), caption prefixes (`Avery Quill:`,
  `- Avery:`, `>> Avery:`) and the speaker of a timestamped paragraph. A caption prefix made only of
  dictionary words (`Note:`) is not read as a speaker. A tag equal to a keep-list term or a spec
  `vocabulary` form, or made only of honorific and role words (`Front Desk`), is kept and counted in the
  report.
- One speaker, one pseudonym: the speaker's name, each capitalised part of it (given name, surname),
  and every capitalised spoken word within one edit of a part of four or more letters (`Avary` for
  `Avery`) are matched like recurring values, in every file of the corpus (a speaker named in a CSV
  cell or another document gets the same pseudonym there). A part or misspelling that fits two
  people (two speakers, or a speaker and a person blinded in a column) gets its own pseudonym. Parts
  and misspellings the name-part rules leave out (fewer than 3 letters, dictionary words such as
  `May`, honorific and role words such as `Dr`, keep-list terms, vocabulary forms) are not matched; the tag is still replaced.
- GUIDs in VTT cue identifiers (Teams writes `<guid>/12-0`) are replaced with GUID-shaped
  pseudonyms even when the spec's `guid` pattern is off.
- Cue timing lines (with their settings), SRT cue numbers, inline VTT timestamps (`<00:00:02.000>`)
  and the timestamps of text and DOCX entries are not changed, byte for byte. Everything else
  (the header, NOTE blocks, cue identifiers and spoken text) is free text.

The report says how the file was read and counts its speakers, the speaker tags and spoken mentions
replaced, and any tags kept; a file that is not a transcript reports the speaker names replaced in it.

**File and folder names.** Every folder name and every file name (without its extension) in the
output tree is rewritten like free text: enabled patterns, spec entities, and also every cell value
a column rule replaced, so `reviews/Robin Example.md` is written as `reviews/Person_4C1D.md` when
`Robin Example` is a blinded `Owner`. Names use the same pseudonyms as the content. Names are
also searched piece by piece between underscores (`backup_db01.example.com.txt`). The report lists each renamed file
(`written as ...`). Two inputs whose blinded names coincide are refused (exit 2, nothing written).
Every pseudonym used in a name is in the reversal map, so names are as reversible as the content:
`blind reveal` restores file and folder names (see [below](#how-blind-reveal-reverses-a-blinded-file)).
Worksheet, defined and table names in a workbook are rewritten the same way (see below).

**XLSX workbooks.** Handled at the zip and XML level; every byte not rewritten is copied as it
was. Each worksheet is a table: the header row is found as above, and rules name a column by
`sheet` and `header` (a rule without `sheet`, or for a sheet or header the workbook does not have,
is an error). The column table above applies to every cell, with these workbook rules:

- **Strings.** Shared strings and inline strings are rewritten. A shared string used by several
  cells gets one treatment, the strictest: a pseudonym if any cell using it is pseudonymised, else
  free text, else kept. A shared string no cell uses (an orphan) is rewritten as free text too. In
  rich text, a pseudonym, or a match that spans formatting runs, is written into the first non-empty
  run and the other runs are emptied; otherwise each run keeps its formatting.
- **Numbers.** A number cell cannot hold text, so a pseudonymised number cell is renumbered: its
  digits get a same-length numeric `id` pseudonym (`4417` → `8203`; a decimal keeps its point),
  whatever the column's class. Booleans, errors and dates are never changed.
- **Sheet and defined names.** Worksheet names, defined names and table names are rewritten through
  the same name hook as file names. Blinded worksheet names must stay distinct ignoring case, and
  every blinded name must keep the spreadsheet's naming rules; otherwise apply refuses (exit 2,
  nothing written). A cell, shared string, hyperlink text or `docProps/app.xml` sheet title whose
  whole text is a worksheet's name is written as that sheet's blinded name, so a contents sheet
  still names the right sheets.
- **Formulas** (cells, defined names, validation and conditional formats, tables, charts, hyperlink
  locations) keep their structure: references to a renamed sheet, defined name, table or table
  column follow the rename, quoted when the new name needs it, and string literals are free text.
- **Everything else** that can carry identifying text is free text: comments and their authors,
  threaded comments and people, `docProps/core.xml` (title, subject, creator, keywords,
  description, last modified by, category and the like), `docProps/app.xml` (company, manager,
  application, hyperlink base), `docProps/custom.xml` names and values, pivot caches (strings,
  field captions; numbers repeat the renumbering of their cells), pivot table captions, chart titles
  and caches, drawing text and shape names, header and footer text, validation prompts, filter
  values, and the targets of external relationships. Free text, in cells and everywhere else, goes
  through the same corpus-wide scan as CSV and JSON text (patterns, spec entities and recurring
  values), and cells under `keep` get only recurring values replaced, as in a CSV file. Table column
  names and pivot field names are rewritten like the header cells they repeat.
- Office's own linking IDs are rewritten wherever they are (see **Office structural IDs** below).
- **Fail closed.** Every other text run and attribute (connection strings, external link caches,
  query tables, custom XML) is scanned for spec entities, recurring values and every pattern shape
  (email, host, IP, GUID, MAC), including a pattern switched off in the spec; blind does not rewrite
  these parts, so it refuses rather than rewrites. Namespace, content-type and relationship-type
  URIs and Office's template IDs are format structure and are not scanned. One found there stops the
  workbook (listed and not written, exit 1), naming the part and element but never the value. So
  does a member that cannot be parsed, a cell without a reference, and a zip that is not a workbook.
  Members that are not XML are copied unread and listed in the report when they are images, fonts
  or printer settings; any other (an embedded file or workbook, a macro, an ActiveX part) stops the
  workbook (listed and not written, exit 1), as in a DOCX. So does a saved thumbnail
  (`docProps/thumbnail.*`), a picture of the original sheet.

**Office structural IDs.** Word and Excel write IDs of their own into a package. They name no
person, but two kinds are treated differently:

- **Linking IDs** are random per document, so the same value in the original and the blinded file
  would link the two. `blind apply` rewrites every one, by its position (element and attribute),
  whatever the spec says: a GUID gets an `id` pseudonym (braces and case kept; it is in the map), a
  hex value a same-length hex value derived with HMAC-SHA256 under the corpus salt (same case; an
  8-digit value under `0x80000000` stays under it and non-zero, as Word requires of paragraph ids;
  not in the map, so `blind reveal` does not restore it), and anything else at such a position is
  replaced whole with an `Id_` pseudonym. The same value gets the same replacement everywhere, so
  references between parts still resolve. The positions:
  - `w:rsid*` attributes (`rsidR`, `rsidRPr`, `rsidRDefault`, `rsidP`, `rsidDel`, `rsidSect`,
    `rsidTr`) and `val` on `w:rsid` and `w:rsidRoot` (settings.xml): edit-session ids;
  - `w14:paraId`, `w14:textId` (paragraphs, table rows), `w15:paraId`, `w15:paraIdParent`,
    `w16cid:paraId`, `w16cid:durableId`, `w16cex:durableId` (comments): paragraph and comment ids;
  - `wp14:anchorId`, `wp14:editId` (drawing anchors), `id` on `a16:creationId` (drawing objects);
  - `val` on `w14:docId` and `w15:docId` (the document's id), `w:nsid` (a list's id), `w:guid` (a
    building block's id) and `c16:uniqueId` (a chart series' id);
  - `ds:itemID` on `ds:datastoreItem` (customXml/itemProps*.xml) and `w:storeItemID` on
    `w:dataBinding` (a content control bound to that store);
  - any namespaced `uid` attribute (`xr:uid`, `xr2:uid`, `xr3:uid`, `xr10:uid`: worksheets,
    tables, table columns, filters, data validations, pivot tables, slicers);
  - `documentId` (its version prefix such as `8_` or `13_ncr:1_` is kept) and `xr10:uidLastSave`
    on `xr:revisionPtr` (workbook.xml);
  - `id`, `personId` and `parentId` on `threadedComment`, `id` on `person` (Excel threaded
    comments), `id` on `x14:cfRule` and the `x14:id` text that points at it (conditional formats).
- **Template IDs** are the same in every file made from the same template and are copied as they
  are: `id` and `vid` on `thm15:themeFamily` in a theme part (the theme's family and variant
  GUIDs), and `val` on `w:tmpl` (a list template's code).

**Output.** Delimiter, quoting, line endings and encoding (UTF-8 with or without BOM, UTF-16 with
BOM, otherwise 8-bit bytes) are preserved, and a file with nothing to replace is copied byte for
byte. The reversal map goes to `.blind/map.json`, or to `--map-out <path>`, created with mode 0600.
It may not sit inside the output or an input. An existing map at that path is reused, so earlier
pseudonyms stay the same.

## How `blind run` chains the steps

`blind run <inputs> -o <out>` runs `blind plan`, `blind apply` and `blind audit` in turn, through
the same code as the commands themselves.

- **Plan** reuses `.blind/spec.json` as `blind plan` does: only what it does not cover goes to the
  analyst, and nothing does when it covers everything.
- **Stop for review.** When there was no saved spec, or the plan added a column rule, an entity or
  a question or classified a rule, `run` prints the spec (and what changed) and stops with exit 3
  before anything is applied. Review the spec, then run again: the spec is saved, so the next run
  goes on. `--yes` applies without stopping. A plan that adds nothing does not stop, so a second
  run on the same corpus is zero-touch.
- **Apply, then audit** over `<out>` with the same map (`--map-out <path>`, default
  `.blind/map.json`).
- **`--accept-leaks`** closes the loop with no human and no model. While the audit finds a leak,
  its report goes to `blind plan --from-audit --accept-leaks` (see [above](#feeding-the-audit-back-into-the-spec)),
  and apply and audit run again into `<out>` with the same map. At most 3 rounds in all; it stops
  early when the audit finds no leak, or when accepting changed nothing (another round would find
  the same leaks). Only leaks are decided: candidates still need a human. The table printed for each
  round is the audit's own.
- **Exit status** is the last audit's: 0 clean, 1 candidates, 2 leak. It is at least 1 when plan or
  apply left inputs out (they are listed). 3 means `run` stopped for review, or a step refused or
  failed (a usage error, an invalid spec, an apply refusal), and nothing was audited; it is never
  2, which means a leak was found.

## How `blind reveal` reverses a blinded file

`blind reveal <path> [--map <map.json>]` takes a blinded file, or a blinded tree, and the map
`blind apply` wrote (default `.blind/map.json`). It needs no salt and no spec.

- **What is restored.** Every pseudonym the map records, in the content and in folder names and
  file names (not the extension, which apply never changes), is replaced with the original value
  the map records for it. That value is one written form per identity, so an alias or a case
  variant comes back as that recorded form, and a number that apply had to write as a JSON string
  stays a string. A pseudonym is matched as a whole token (not beside a letter or digit, not
  inside a longer dotted name; `_` separates tokens, as in blinded file names), longest first.
  Text that happens to equal a pseudonym is restored too.
- **Formats.** CSV/TSV cell by cell (a restored value that needs quoting is quoted), JSON and JSONL
  string by string (spliced in, the rest of the text unchanged), and text (`.txt`, `.md`, `.log`, and the
  `.vtt` and `.srt` transcripts, read as text), with the file's encoding kept. XLSX and DOCX are restored at the zip and XML level in exactly the
  places `blind apply` rewrites (every other byte is copied): cells, shared and inline strings,
  formulas, comments, metadata, pivot and chart caches; paragraphs (tracked insertions and
  deletions each in their own revision), field instructions, drawing text, authors and document
  properties. Rich text is read as one text, so a pseudonym that an editor split across runs is
  restored too: the original goes into the run where the pseudonym starts and the rest of the
  pseudonym is removed from the later runs. Runs, rows, cells, paragraphs and formulas are never
  added or removed. Worksheet, defined and table names are restored with every formula,
  hyperlink, structured reference and pivot source that names them, and a renumbered number gets
  its digits back with its decimal point where it was. Values replaced whole (authors, creator,
  company) come back from the map. Text apply merged into one run when a name crossed runs stays
  in that run, and a phonetic guide apply emptied stays empty. A defined name blinded from part of
  an identity comes back as the whole recorded form, with each character a defined name cannot
  hold written `_` (`Avery_Total` returns as `Avery_Quill_Total`), the same in every formula. A
  workbook or document is revealed whole or not at all: a member that cannot be read, a restored
  worksheet name the spreadsheet would refuse, two worksheet or defined names that would reveal to
  one name, or a pseudonym that reads differently with tracked changes accepted and rejected
  refuses the file. Office's own linking IDs (`w:rsid*`, paragraph IDs, `xr:uid` and the rest under
  **Office structural IDs**) are not identities: reveal leaves them as `blind apply` wrote them,
  even the GUIDs the map records, and does not restore the originals. Other formats have no reversal path: a single file is refused
  (exit 2); in a tree it is listed and not revealed (exit 1). A file that does not parse, or is
  refused as above, is treated the same way. Two keys of one JSON object, or two files, that would
  reveal to the same name are refused (exit 2, nothing written).
- **Where it goes.** Revealed files hold the original values, so they are secrets like the map.
  They are written under `.blind/revealed/` (or `-o <dir>`), with each file's revealed name and
  path, folders mode 0700 and files mode 0600 (created that way, never changed afterwards). `-o`
  may not be inside or around the tree being revealed, nor in the folder that holds a blinded
  file (except under `.blind/`), so revealed output is never mistaken for blinded output. An
  existing revealed file is not replaced without `--force`. The report names files by their
  blinded paths only.
- **Exit status.** 0 everything revealed; 1 some files not revealed (listed); 2 refused (usage
  error, a missing or invalid map, a destination rule above), nothing written.

## How `blind audit` checks the output

`blind audit <out>` reads `.blind/spec.json` and the map (`.blind/map.json`, or `--map <path>`)
and checks the output tree as it is on disk, independently of how `blind apply` wrote it. It runs
up to three layers, mechanical, semantic, then model; the report lists the layers run.

- **What is read.** Every entry under `<out>`, hidden ones included. Each file's raw bytes are read
  as Latin-1, UTF-8 and UTF-16 (both byte orders, both alignments), and each of those again with
  XML character references, `%XX` escapes and backslash escapes undone. Zip archives (xlsx, docx,
  anything starting `PK`) are opened recursively, up to 8 levels deep. File, directory and member
  names are read too. Symbolic links are not followed.
- **What it looks for.** Every spec entity form (canonical, aliases, parts; `vocabulary` excepted),
  every original value in the map (surface and canonical form), every word of a multi-word person
  value in the map found alone (a given name or surname the spec did not list, 3 letters or more,
  whole words only), and every match of an enabled pattern that is not a pseudonym. A lone word of a
  blinded person's name in the engine's case for a single-word form (capitalised, or an exact short
  acronym) is a `leak`; in another case, a `candidate`; one that is also a dictionary word or a keep
  term is a `candidate` in that case and is not reported otherwise. Text that is a pseudonym or a `vocabulary` form is never a finding,
  and neither is a pattern match made only of pseudonyms and punctuation (a blinded file name such
  as `Person_1E95_user_559f@host-f3ce.com.md`). File and directory names are also read piece by
  piece between underscores, as `blind apply` reads them, and a file's or zip member's extension is read on its own
  (`word/_rels/document.xml.rels` is not a host).
- **OOXML structure.** In the members of an OOXML package (a zip with `[Content_Types].xml`), the
  values in these attribute positions are format structure and are not read: namespace
  declarations (`xmlns`, `xmlns:*`), `ContentType` on `Default`/`Override` in `[Content_Types].xml`,
  `Type` on `Relationship` in a `.rels` member, `mc:Ignorable` prefix lists, and `uri` on `ext`,
  `compatSetting`, `graphicData` and `schemaRef`, `fmtid` on `property` in `docProps/custom.xml`, and the
  template IDs listed under **Office structural IDs** above (`id` and `vid` on `thm15:themeFamily`
  in a theme part, `val` on `w:tmpl`). The exemption is by position in the parsed XML, never by
  value: `schemas.openxmlformats.org`, or a theme's GUID, in document text or any other attribute
  is still reported, and so is an external relationship's `Target`. The semantic layer skips the
  same positions. Office's linking IDs are NOT exempt from the mechanical layer: `blind apply`
  replaces the GUID-shaped ones with pseudonyms in the map, so one left in place is not a pseudonym
  and is a `pattern:guid` leak, and an original put back is a map leak. The hex-shaped ones match
  no mechanical pattern; the semantic layer skips every linking position (its hex finder would
  otherwise report each rsid and paragraph id). The audit cannot tell a rewritten hex id from an
  original one without the salt.
- **Kept hosts.** A host name under a domain in the `blind.toml` keep list is not reported: the
  engine keeps it because the policy says to. An invalid `blind.toml` stops the audit (exit 3).
- **`leak`**: a whole-word survivor in the case the engine would have replaced.
- **`candidate`**: a case, accent or width variant; a value inside a longer word (4 characters or
  more); a value under 3 characters; a host label or email local part of a blinded value; a column
  the spec declares `unknown`; a CSV/TSV column with no spec rule; an unanswered spec question; and
  anything the audit could not read in full (undecodable or encrypted archive members, binary
  content, images, symbolic links, unreadable files).

- **Semantic layer.** A candidate finder that does not rely on the spec's entities or the map. It
  reads the same files, names and zip members (an XML member as its text, with runs joined so a
  name split across runs is one phrase, and its attribute values) and reports as a `candidate`:
  identifier-shaped tokens (a hex run of 6 or more with a digit and a letter; 4 or more digits mixed
  with letters, such as `PRJ-48213`; a run of 10 or more digits, not the fraction of a decimal
  number), Title-Case phrases of two or more words, email and host shapes, IPv4/IPv6, GUID and MAC
  shapes (`semantic:ip`, `semantic:guid`, `semantic:mac`), and lone capitalised
  words (`semantic:name`: a given name or nickname the spec missed). A lone word is a Title-Case
  word of 3 or more letters that is not part of a longer Title-Case run, not in the built-in
  dictionary, not a keep or vocabulary term, and not sentence-initial (after a line start, a
  heading or bullet marker, `.`, `!`, `?` or a colon), unless the same word also stands
  mid-sentence elsewhere in that file. A month or weekday abbreviation written with its dot (`9
  Feb.`) is not one. Lone words are looked for only in a part's own decoding, never in binary
  content or an archive's own bytes. Left out: anything
  that is a pseudonym; values equal to a `blind.toml` keep term, a `vocabulary` entity form or a
  value of a column the spec classifies as `vocabulary` (CSV/TSV and JSON); the spec's own headers
  for that file; hosts under a keep-list domain; ISO 8601 timestamps; file extensions (`notes.md`
  is not a host); and format structure in XML (namespace and schema URIs, revision and paragraph
  ids, colours, fonts, content types). A Title-Case run is split at keep and vocabulary terms, and
  a leading function word (`The`, `In`, ...) is dropped, so `The Spring Planning Review` with that
  term in the vocabulary is explained. Candidates are listed once per value per file (the first
  place, with how many places), at most 200 per file, then one line counting the rest. The email,
  host, IP, GUID and MAC shapes are reported whatever the spec's `patterns` say, so a pattern turned
  off by mistake cannot read as `clean`; an address equal to or inside a keep term (an exact address
  or a CIDR range such as `10.2.0.0/16`) is kept, and an address counts as a pseudonym only when the
  map says the engine issued it (the RFC 5737 pool is also where synthetic inputs live). The layer
  only adds candidates: it never removes or downgrades a mechanical finding.

- **Model layer.** Runs unless `--no-model`, `privacy.mode = "none"`, or there is no `blind.toml`
  (each said on stderr). The auditor model is `[models.auditor]` in `blind.toml`; when that table is
  absent the analyst's backend is used with the auditor's own prompt, and the report and stderr say
  so. Its system prompt casts it as the subject of the documents, trying to recognise itself. What
  it is sent follows the privacy mode:
  - `local-only`: the blinded output's text (never the inputs), read as the semantic layer reads it
    (zip members recursively, XML as its text and attribute values), plus each file and member name,
    cut into lines of at most 120 characters (at whitespace where possible) and sent in chunks of at
    most 8 kB, each with the policy. Binary content is not sent and is listed under "not sent".
  - `profile-only`: only the profile of the output tree (`blind profile <out>`, with that mode's
    samples, outlines and speaker lists left out and names tokenised) and the policy, in one call.
  The reply is `{"candidates": [{"line" | "file", "quote", "reason"}]}`: the line index sent (or
  the file token), the quoted text (at most 120 characters), and a reason from `person`, `org`,
  `host`, `email`, `id`, `location`, `context`. Each becomes a `candidate` with source `model` and
  class `model:<reason>`, located at the quote (or at the line when the quote is not on it; under
  `profile-only`, in the file the token names, without a position when the quote is not found). The
  model can only add: an empty list, or any claim that the output is clean, changes no finding and
  no status. A reply that names a line or file that was not sent is rejected whole, and that chunk
  is not checked; a reply that fails the schema twice, or a call that fails, stops the layer. Each
  is itself a candidate (`model:unchecked`, file `(model)`) saying which chunks were not checked,
  so the report is not `clean`; the other layers' findings stand. A
  call refused before sending (the privacy mode, endpoint or key setting) exits 3 and nothing is
  printed. The JSON report's `model` field gives the backend, model, mode, what was sent, the
  number of chunks and accepted answers, and what was not sent.
- **The summary line says whether the model read anything.** `layers run:` lists only layers that
  read the output. A model layer that did not is named after it, and the JSON report's `modelLayer`
  field (`status`, `host`, `reason`; additive) says the same: `ran` (no clause); `partial` (some
  chunks answered, then a call failed); `unreachable` (no usable reply: connection refused, timeout,
  HTTP or backend failure), printed `layers run: mechanical, semantic; model: not reached
  (127.0.0.1:11434)`; `rejected` (the endpoint answered but no reply passed the schema twice);
  `skipped` (`--no-model`, no `blind.toml`, or `privacy.mode = "none"`), printed `model: skipped
  (--no-model)`. Failed layers appear in `layers` as `model (unreachable)` and so on. Only the
  endpoint's host and port are printed, never credentials, path or query. A failed layer still adds
  its `model:unchecked` candidate, so the status is never `clean`. `blind run` prints the same line,
  and a `blind bench` report carries `audit.modelLayer` and the same clause (the bench always skips).

Status is `leak` if any leak, else `candidates` if any candidate, else `clean`. Exit status: 0
clean, 1 candidates, 2 leak, 3 the audit could not run (a usage error, a missing or invalid spec or
map, an invalid `blind.toml` (a missing one is not an error), or a model call the privacy mode, endpoint or key setting refuses; nothing
audited). The report (a table, or `--json`) gives file, zip member, byte offset and
line, class and a masked value: the first two characters (never more than half), `***`, and the
length. `clean` needs zero leaks, zero candidates of either layer and zero declared unknowns. It
means only that these checks found nothing they look for; it is not a guarantee that nothing
identifying remains.

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
| `format` | `csv` \| `tsv` \| `json` \| `jsonl` \| `xlsx` \| `docx` \| `text` \| `markdown` \| `log` \| `vtt` \| `srt` | The file's container format. `vtt` and `srt` are decided by content, so a `.txt` file holding WebVTT is `vtt`. A transcript-shaped DOCX or text file keeps `docx` or `text` here and also appears under `transcripts`; a DOCX that is not transcript-shaped appears under `documents`. |
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
| `outline` | array of strings, each at most 120 characters | Headings, in order. Empty under `profile-only` (see [Privacy modes](#privacy-modes)). |
| `sampleSentences` | array of strings, each at most 120 characters, at most `sampleCount` items | Example sentences. |

### `transcripts`

One entry per transcript (VTT, SRT, or a DOCX or text file detected as transcript-shaped).

| Field | Type | Meaning |
|---|---|---|
| `file` | string, non-empty | The file. |
| `speakers` | array of strings, each at most 120 characters | Speaker names as written, in order of first appearance, at most 100 (a note says when more were left out). Empty under `profile-only`. The heuristic analyst proposes each as a `person` entity, with its name parts. |
| `sampleLines` | array of strings, each at most 120 characters, at most `sampleCount` items | Example turns, `Speaker: text`, spread evenly through the transcript. |

### `cooccurrence`

Pairs of locations that share values, which suggests they hold the same kind of thing.

| Field | Type | Meaning |
|---|---|---|
| `a`, `b` | location | Each `{ file, sheet?, header }` for a table column or `{ file, jsonPath }` for a JSON key; exactly one of `header` and `jsonPath`. |
| `shared` | integer, 1 or more | Number of distinct values present in both. Example: `7`. |

### How `blind profile` builds it

`blind profile <inputs...>` (run it in the directory that holds `blind.toml`, which it needs for
the sample count and the privacy mode) reads CSV (`.csv`), TSV (`.tsv`, `.tab`; the delimiter is sniffed from the first line like CSV, and tab wins a tie, so a pipe-delimited `x.tab` splits on `|`), JSON (`.json`), JSONL
(`.jsonl`, `.ndjson`), XLSX workbooks (`.xlsx`), plain text (`.txt`, `.text`), Markdown (`.md`, `.markdown`), logs (`.log`),
WebVTT (`.vtt`) and SRT (`.srt`) transcripts, and DOCX (`.docx`) files, writes `.blind/profile.json` (mode
0600) and prints it as a table; `--json` prints the JSON instead. `k` is `[profile] samples` in
`blind.toml`, or `--samples N`. When `samples` is unset, `k` follows `[privacy] mode`: 5 under
`local-only` and `none`, 0 (headers and statistics only) under `profile-only`.

- **Paths.** Directories are walked recursively in sorted order; `path` is relative to the input
  directory, or the file name for a file named directly. Hidden entries, symbolic links, files in
  other formats, files whose declared encoding (a UTF-8 or UTF-16 byte-order mark) is malformed and CSV or JSON files that do not parse are left out of the
  profile, listed under "not profiled", and the command exits 1. blind's own `.blind/` and
  `blind.toml` are skipped without comment.
- **Long paths.** `path` is never truncated, because the spec and the engine need it exact. A file
  whose profile path is over 120 characters is left out and listed under "not profiled" instead.
  Every other document-derived string (headers, samples, outline, sentences) is cut as below.
- **Key paths.** JSON key paths, like file paths, are never truncated; a JSON file with a key path
  over 120 characters is left out and listed under "not profiled".
- **Workbooks.** Each worksheet is a table with its `sheet` name, read the way `blind apply` reads
  it (shared strings resolved, numbers as written). Chart sheets have no table. A workbook that
  cannot be read in full is left out and listed under "not profiled".
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
  evenly through the document; for logs, each line is one sample. Under `profile-only` the outline
  is left out (an empty array) and a note says how many documents it was left out of.
- **Transcripts.** Found by content, as `blind apply` finds them
  ([transcripts](#transcripts-in-apply)). A VTT, SRT or transcript-shaped text or DOCX file gets a
  `transcripts` entry; a transcript-shaped text file is also profiled as a document. A `.vtt` or
  `.srt` file that is not a transcript is listed under "not profiled". A DOCX that is not
  transcript-shaped is profiled as a document, from its paragraphs read as text. Under `profile-only` the speaker list is left out (an empty array) and a note
  says how many transcripts it was left out of.
- **Co-occurrence.** Every pair of table columns or JSON key paths, in the same or different files, whose distinct
  values (compared case-insensitively, trimmed) overlap by more than half of the smaller column's
  distinct values.

## Privacy modes

`[privacy] mode` in `blind.toml` (every key of that file is in [policy.md](policy.md)) decides what a model call may do. Every check runs before
anything is sent; a refused call exits 2 and names the mode (except under `blind audit`, where 2
means a leak: there a refused call exits 3, "the audit could not run"). There is no fallback to another mode
or backend.

| Mode | Model calls | What is sent |
|---|---|---|
| `local-only` (default) | Loopback endpoints only (127.0.0.0/8, `::1`, `localhost`). `claude-cli`, the hosted Anthropic API and any other host are refused with "privacy.mode is local-only". | The caller's data, every string at most 120 characters. |
| `profile-only` | Remote endpoints allowed, over https (a loopback server may still use http). | Exactly the profile and the policy (classes, description split into pieces of at most 120 characters, examples, keep list). Anything else is refused. |
| `none` | None. `blind plan` uses the heuristic analyst; `blind audit` runs its mechanical and semantic layers only. | Nothing. |

`blind audit`'s model layer sends, under `local-only`, the blinded output's text as lines of at
most 120 characters, and under `profile-only` only the output's profile (see "How `blind audit`
checks the output").

**Document text under `profile-only`.** The only document text a `profile-only` profile carries
is what `sampleCount` bounds: `samples`, `sampleSentences` and `sampleLines`, at most `sampleCount`
each (none at the default of 0). Document outlines (a file's first line and its headings) and
transcript speaker labels have no such bound, so under `profile-only` `blind profile` and
`blind plan` leave them out: the document or transcript is still listed, with an empty `outline`
or `speakers`, and a note says so. They are omitted rather than reduced to counts or lengths, so
the profile shape does not change between modes. What stays is structure, with its statistics;
the names in it are sent as tokens (below). A `profile-only` call whose
profile carries a non-empty `outline` or `speakers` (for example a profile built under
`local-only`) is refused before anything is sent. Under `local-only` outlines and speakers are
kept and sent as before.

**Names under `profile-only`.** File and folder names, sheet names, some JSON keys and some
headers are document text too ("Avery Quill review.md", a sheet named after a client, an object
keyed by people's names, a headerless CSV whose first row of names was taken as the header). Under
`profile-only` every model call replaces them with opaque local tokens, and the reply is mapped back
to the real locations on this machine before it is checked and saved. `.blind/profile.json` and
`.blind/spec.json` keep the real names; the tokens exist only in memory for the one call.

| Profile string | Token | When |
|---|---|---|
| File path | every folder `dir_N`, the file `file_N`: `dir_1/dir_2/file_3` | always |
| Sheet name | `sheet_N` | always |
| JSON key segment | `["key_N"]` | the key is not ASCII-identifier-shaped (`[A-Za-z_][A-Za-z0-9_]*`, so it was written `["..."]`), matches the host, email or ip pattern, or is name-like (below); `[*]`, `.*` and `.*~` segments stay |
| Table header row | every header of the table becomes `col_N` (its 1-based column) | the header row looks like values: half the width or less filled, or not mostly text (always so when row 1 was used because no header row was found), a cell matches a pattern (ip, email, host, guid, mac), or at least half the filled cells are two or more capitalised words (`Marlo Fenwick`) |
| One table header | that header becomes `col_N` (its 1-based column); the others stay | the header is name-like (below), whatever the rest of the row |

A header or key segment is **name-like** when any of these holds:

- it carries a spec entity's canonical form, alias or part, in any case, as whole words or with the
  separators removed (`rowan`, `rowan_pike` and `rowanPike` for the entity `Rowan Pike`). The
  entities are those of the saved `.blind/spec.json` on a re-plan, and of the spec being audited;
- it has a Title-Case word that is neither in blind's built-in dictionary (with a few header words
  and abbreviations such as `hostname` and `addr`, and plural and tense endings taken off) nor a
  word of a keep term (`Avery` in `Avery, Status, Amount`);
- it is identifier-shaped: it has a `_` or `.` and a part that is not a dictionary word (`avery_q`,
  so `$.users.avery_q.role` goes as `$.users["key_1"].role`; `user_id` and `created_at` stay);
- it has a digit (`srv01`, `Q3 Total`), or is shaped like a token (`col_3`, `key_1`).

A header or key that is exactly a keep term is not name-like by the last three rules; a spec entity
always is.

`N` counts from 1 over the distinct real strings in code-unit sorted order (headers: column
order), so the same profile always gives the same tokens. A token is a counter, never a hash or
anything derived from the salt, so it says nothing about the name it stands for. Name-like JSON
keys are tokenised rather than left out, so the analyst still classifies their values. Tokens in a
question's text are replaced by the real names, JSON-quoted. A reply that names a location that
was not sent is rejected whole. A `profile-only` call whose profile carries an untokenised path,
sheet name, value-like header row, name-like header (or a `col_N` in another column) or flagged
key segment is refused before anything is sent; the check uses the call's keep terms and spec
entities. `blind profile` and `blind plan` print a note with how many of each are tokenised (the
note's count does not apply keep terms or spec entities). A table of ordinary title-case headers
("First Name", "Last Name") can be caught by the header-row rule, and a header word blind does not
know (`Comments (Optional)`) by the name-like rule; those headers then go out as `col_N` with their
statistics, which costs the analyst context, never privacy. A lower-case name that is not a spec
entity and has no `_`, `.` or digit (`$.users.avery`) is not name-like and goes out as it is.

Each call prints one line to stderr before it is sent, after the command's name:
`blind plan: analyst · openai-compatible · m · local-only · 31570 bytes sent`. The line is
`role · backend · model · mode · [samples k ·] N bytes sent`, where `N` is the size of the request
and `samples k` is the profile's `sampleCount`, shown under `profile-only`. Under `profile-only`
the line is printed even when the command is quiet (`--quiet`).
