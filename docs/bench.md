# Kits and `blind bench`

blind is tested on generated corpora, never on real data. `src/bench/synth.ts` builds a **kit**: a
small set of input files with the shapes that make document blinding go wrong, an **oracle** that
lists every sensitive value in those files with its class, and the reviewed **spec**. `blind bench`
blinds the input once and scores the output against the oracle. You can build a kit from your own
data the same way (see [A kit from your own data](#a-kit-from-your-own-data)); it never enters the
repository.

Everything in a kit is invented: the people and organisations are made up, every host and email
domain is under `.example`, and every IP address is from the RFC 5737 documentation ranges.

## Generating a kit

```sh
bun src/bench/synth.ts /tmp/kit                 # seed 1739, 60 rows
bun src/bench/synth.ts /tmp/kit --seed 42 --rows 200
bun src/bench/synth.ts /tmp/kit --kit 2           # kit v2: adds XLSX, DOCX, VTT, JSON and a container log
bun src/bench/synth.ts /tmp/kit --recur-in-prose  # also cite column values in the review notes
```

The full usage is `bun src/bench/synth.ts <dir> [--seed N] [--rows N] [--kit 1|2] [--recur-in-prose]`.

This writes:

```
/tmp/kit/
  input/
    accounts.csv
    notes/review.md
    notes/standup.txt
    sync.log
  oracle.json
  spec.json
```

The oracle and the spec sit next to `input/`, not inside it, so blinding `input/` never reads them.

Kit v2 adds `workbooks/tenant-access.xlsx`, `meetings/renewal-call.docx`, `meetings/renewal-call.vtt`,
`exports/scopes.json` and `logs/agent-container.log` to the same tree (see [What kit v2
adds](#what-kit-v2-adds)).

From code, `generateKit(seed, { rows, version })` returns the files, the oracle and the spec in memory, and
`writeKit(dir, kit)` writes them as above. The spec (`kitSpec()`) is the one a reviewer would save
for kit v1: the organisation, person, host and ID columns blinded, `Status`, `Region`, `Amount` and
`Opened` kept, `client_scope_code` left a declared unknown, the cast as entities (nicknames and
misspellings as aliases, given names and surnames as parts) and the two decoys as vocabulary. Kit
v2's spec adds a rule for every worksheet column and JSON key path, and the cloud account ID as an
`id` entity.

### Determinism

A kit depends only on its seed and options. The generator uses its own seeded PRNG (mulberry32),
no clock and no environment, so the same seed gives byte-identical files and oracle on every
machine and every run. The seed is recorded in the oracle. The PRNG lives in `src/bench/`, outside
the engine. Kit v2 holds kit v1's four files byte for byte: its own files draw from a second PRNG
stream, so adding them never moves a v1 value. The XLSX and DOCX files are built from XML in code
(`src/bench/office.ts`, a stored zip with a fixed timestamp); no real file is copied.

## What kit v1 contains

Formats: CSV and text (Markdown, plain text, a log). [Kit v2](#what-kit-v2-adds) adds the Office,
JSON and transcript formats.

**`accounts.csv`**, one row per account. Its columns, and what each tests:

| Header | Holds | Shape it tests |
|---|---|---|
| `Acct No` | account IDs | short IDs: 4 digits |
| `Counterparty Label` | organisation names | an org-name column under header wording no rule anticipates |
| `client_scope_code` | internal codes such as `CS-417-QK` | a snake_case header over codes a reviewer cannot place |
| `Ledger Ref` | ledger IDs such as `a3f9c2` | hex IDs: 6 characters |
| `Owner` | people | |
| `Tenant Host` | `<org>.tenanthub.example` | vendor-hosted tenant hosts: the vendor's domain, the customer's label |
| `Status`, `Region`, `Amount`, `Opened` | enums, money, dates | ordinary values that must come through unchanged |

**`notes/review.md`** and **`notes/standup.txt`**: prose about the same people and organisations,
written the way people write: full names, given names and surnames alone, nicknames (`Bart`,
`Iggy`), misspellings (`Bartholemew Quince`, `Penhalow`), initials (`B. Quince`), organisation
short names and acronyms (`Quillfeather`, `QFH`). The review notes also list each person's email
address and tenant host.

**Decoys.** Two cast members have given names that are also ordinary words elsewhere in the notes:
`Sam` next to the acronym `SAM` ("the SAM report"), and `Jan` next to the month abbreviation `Jan.`
("by 22 Jan."). A decoy must come through blinding unchanged. The generator never writes the name
in the decoy's form (it never puts a period after the given name `Jan`), so a checker can tell them
apart.

**`sync.log`**: machine-written lines with tenant hosts, email addresses and IP addresses.

**`recurInProse`** (`--recur-in-prose`, off by default) also cites account numbers, ledger refs and
scope codes from `accounts.csv` in the review notes. These are column values that are neither spec
entities nor pattern matches.

## What kit v2 adds

Everything in kit v1, plus:

**`workbooks/tenant-access.xlsx`**, three worksheets:

- `Contents`: the sheet list, each name with a description that names a person or an organisation,
  and a hyperlink to each sheet. Its two columns are declared unknowns in the spec.
- `Access`: identity columns `User` (people), `Email`, `Employee No` (4-digit IDs as number cells),
  `Booked Under` (organisation names under header wording no rule anticipates) and `Path` (the
  vendor's service-account home directories, named after the customer, such as
  `/var/lib/tenanthub/home/svc-quillfeather-sync`), then `Role` and `Last Login`, kept.
- a sheet **named after an organisation** (`Quarter`, `Amount`, kept), with a defined name
  `<name>_Total` that refers to it.

It also has a shared string **no cell uses** that holds an IP address, a **pivot cache** over the
people and organisations of `Access`, the sheet list in `docProps/app.xml`, and a creator and a
nickname as last editor in `docProps/core.xml`.

**`meetings/renewal-call.docx`** and **`meetings/renewal-call.vtt`**: one Teams meeting, saved
both ways. The Word copy has a speaker-and-time paragraph per turn (`Marisol Penhallow   0:17`,
every other one split across two runs, as Word does after an edit) followed by the turn's text; the
WebVTT copy has a GUID cue identifier and a voice tag per turn. The turns mention people in all
their forms and organisations by name, short name and acronym. The Word copy also carries the
bibliography `customXml` part Word saves into every document (no text; its `schemaRef` `uri` holds the
OOXML host), which blind writes through rather than refuses. The last three turns hold values
read aloud: a phone number spelled digit by digit (`eight oh one, five five five, zero one four
two`, oracle class `id`, scope `spelled digits`) and an email address spoken word by word
(`bart dot quince at quillfeather dot example`, class `email`, scope `spoken email`), and number
words in ordinary prose, `two dogs, one cat`, a decoy that must survive.

**`exports/scopes.json`**: a scope list with snake_case keys, `scope_id` hex IDs (8 characters),
`account_no` 4-digit IDs written as strings, organisation names, emails, tenant hosts, an access
level and a date.

**`logs/agent-container.log`**: a container log that pulls images from a registry host whose first
label is the customer's cloud account ID (`<12 digits>.dkr.registry.cloudvendor.example`), cites
the account ID on its own, and lists tenant hosts and peer IP addresses.

## The oracle

`oracle.json`:

| Field | Meaning |
|---|---|
| `version` | Kit version, `1` or `2`. |
| `seed`, `rows`, `recurInProse` | The inputs that produced the kit. |
| `columns` | Each column's `file`, `header` (and `sheet` for a worksheet) or `jsonPath` for a JSON key path, true `class` (`person`, `org`, `host`, `email`, `id`, or `vocabulary` for values that identify no one) and a note. This is ground truth, not a spec: `client_scope_code` holds IDs even though a reviewer may leave it undecided. |
| `values` | Every sensitive value as written, sorted by class then value: `value`, `class`, the `canonical` entity or value it stands for, its `form` (`canonical`, `alias`, `part`, or `value` for cells and pattern matches) and the `files` it occurs in. Kit v2 also gives each value its `scope`: every place it is planted, as `{file, where}` (`column Owner`, `sheet Access, column Path`, `key path $.scopes[*].scope_id`, `orphaned shared string`, `pivot cache`, `sheet name`, `speaker`, `registry host label`, …). |
| `decoys` | Each decoy's `text`, the name part it `resembles`, why it is not a name, and its `files`. |

A blinded output passes the oracle when no `values[].value` occurs in it as a whole word, in any
case, once the decoy texts (exact case) are set aside.

## `blind bench`

```sh
bun src/bench/synth.ts /tmp/kit && blind bench /tmp/kit
```

The bench reads `<kit>/oracle.json`, `<kit>/spec.json` and, if present, `<kit>/blind.toml` (its keep
list matters to apply and audit; the default policy is used otherwise). It makes a private temporary
workspace (mode 0700) with that policy, a fresh salt and the spec (mode 0600), runs `blind apply` on
`<kit>/input` and `blind audit` on the output once, scores, and deletes the workspace, the blinded
copies and the map with it. Nothing in the kit is changed except the report it writes.

No model is called. The audit runs its mechanical and semantic layers. `--plan` ignores `spec.json`
and plans the spec with the heuristic analyst (`blind plan --no-model`), which scores the first try
on an unseen corpus rather than the reviewed spec.

### What it scores

A value **matches** when it occurs as a whole word, in any case, once the decoy texts (exact case)
are set aside: the rule in [The oracle](#the-oracle).

| Score | Counts |
|---|---|
| **leaks** | Oracle values left anywhere in the output: every file's bytes in each decoding the audit reads (Latin-1, UTF-8, UTF-16, with escapes undone), XML text joined across runs, zip members and their names, file and folder names. One item per value per file, part and place (content or name). |
| **damage** | Changes the oracle does not explain. A CSV/TSV or worksheet cell that changed, unless it is a data cell of a column the spec blinds (`blind` or `value`, which includes declared unknowns) or the original cell holds an oracle value. Header and preamble rows count like kept cells; each worksheet uses its own header row and rules, and is named by position, never by name. A JSON key or value that changed, unless it is a value (or a record-ID key) of a key path the spec blinds, or holds an oracle value. A DOCX paragraph (body, headers, footers, comments) that changed and holds no oracle value. A file, folder, worksheet or defined name that changed and holds no oracle value. A decoy with fewer occurrences in the output than in the input (text, cells, paragraphs). A table, workbook, JSON document or DOCX whose row, cell, sheet, token or paragraph count changed. Plain text, Markdown, logs and transcripts are scored for decoys only. |
| **honesty** | Files (and folders) the audit called `clean` that have a leak. |
| **speed** | Wall time of apply and of audit, in `timing`. |

Anything the bench cannot score is listed as **unscored**, never assumed fine: files apply did not
write, inputs or outputs it cannot parse in their format, workbook parts it cannot read, archive
members it cannot decode, symbolic links. Kits v1 and v2 have none of these.

### Output

A table with one row per leak, damage item, honesty item, unwritten file and unscored part, every
value masked (first characters, `***`, length), then the scores and a last `speed:` line. The same
report is written as JSON to `<kit>/bench-report.json` (or `--report <path>`; not inside `input/`):

| Field | Meaning |
|---|---|
| `result` | `pass` or `fail`. |
| `kit` | The oracle's `version`, `seed` and `rows` when it has them; input files and bytes; oracle values and decoys. |
| `spec` | `kit` (the kit's spec.json) or `heuristic` (`--plan`). |
| `apply`, `audit` | Exit codes; files written and not written; the audit's status, counts and layers. |
| `leaks`, `damage`, `honesty` | `count` and `items` (masked). |
| `unscored` | What could not be scored, and why. |
| `timing` | `applyMs`, `auditMs`, `totalMs`. |

For a fixed kit everything except `timing` is the same on every run: items are in a fixed order and
no field depends on the salt.

Exit status: **0** only when leaks, damage and honesty are all 0, every input was written and
everything was scored; **1** otherwise; **2** when the bench could not run (a usage error, a missing
or invalid oracle, spec or input, or apply or audit refused).

`result: pass` means only that none of the values the oracle lists survived and nothing the oracle
can check was damaged. It says nothing about sensitive values the oracle does not list.

## A kit from your own data

The bench is most useful on data like yours. Build the kit **outside the repository** (for example
`~/blind-kits/<name>/`, never under a git checkout) and never commit it:

1. Copy the documents into `<kit>/input/`.
2. In a scratch workspace, run `blind init`, `blind plan <kit>/input`, review and correct the spec,
   and copy `.blind/spec.json` to `<kit>/spec.json`. Copy `blind.toml` too if you changed the keep
   list. Or skip this step and score the first try with `--plan`.
3. Write `<kit>/oracle.json` by reading the inputs, not from blind's output, so the oracle does not
   inherit blind's mistakes: every sensitive value as it is written, including nicknames,
   misspellings and name parts.

   ```json
   {
     "values": [
       { "value": "Theodora Wrexley", "class": "person", "files": ["notes.md"] },
       { "value": "Teddie", "class": "person" },
       { "value": "4417", "class": "id" }
     ],
     "decoys": [{ "text": "May" }]
   }
   ```

   `value` and `class` are required; `files` (where the value occurs) is for you, since a leak
   counts wherever it is found. `decoys` are words that look like a name part but are not one in
   context; they must survive.
4. Run `blind bench <kit>`.

The oracle and the spec hold the sensitive values in the clear: keep the kit as private as the
documents. The report masks every value it finds, but file, folder and archive member names are
printed as they are on disk, so a leak in a name shows that name in full. `bench-report.json` is
written 0600 for that reason; keep it with the kit.

## The walking-skeleton test

`test/bench/walking-skeleton.test.ts` runs the CLI end to end on the default kit: `blind init
--defaults`, `blind profile`, `blind plan --no-model`, then the reviewer's edits to the saved spec
(classify the org, person, hex-ID and vocabulary columns, add the cast as entities and the decoys
as vocabulary, and leave `client_scope_code` declared `unknown`), `blind apply` and `blind audit`.
It checks:

- no oracle value is left in any output file;
- no CSV cell changes outside the blinded and declared-unknown columns;
- the audit says `candidates`, not `clean`, with exactly one candidate (the declared unknown column)
  and no leak;
- the whole run takes under 10 seconds.

The skeleton records no known gaps now. Both gaps it used to carry are fixed and their tests are plain
`test`s: values from a blinded column cited in prose (`recurInProse`) are replaced there too
(AGT-1779), and the vocabulary entry `SAM` keeps the acronym when the given-name part `Sam` has the
same length (AGT-1783). A gap found later is recorded as `test.failing`, so it turns red when it is
fixed and must then be switched to `test`.

## The profile-only test

`test/bench/profile-only.test.ts` checks the "model never sees a value" mode (AGT-1832) on kit v2,
which has every shape the profiler reads: CSV, worksheets with sheet names, JSON keys, prose,
DOCX and VTT transcripts. It builds the profile with samples on purpose, then checks what
`profile-only` would send, and what `blind plan` actually sends to a fake remote analyst:

- every string in the profile is a counter token (`dir_N/file_N`, `sheet_N`, `col_N`, a key path
  of `["key_N"]` segments) or a file-format name, and `sampleCount` is 0;
- no cell value (every CSV and worksheet cell, every JSON leaf, every oracle value) and no header,
  sheet name, JSON key or file name of the kit appears in it;
- the analyst's column rules, written against the tokens, land on the real headers in the saved
  spec, and a `[[columns]]` rule in `blind.toml` still decides its column (`source: "policy"`).
