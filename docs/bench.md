# Synthetic kits

blind is tested on generated corpora, never on real data. `src/bench/synth.ts` builds a **kit**: a
small set of input files with the shapes that make document blinding go wrong, plus an **oracle**
that lists every sensitive value in those files with its class. A test or a benchmark blinds the
input and then checks the output against the oracle.

Everything in a kit is invented: the people and organisations are made up, every host and email
domain is under `.example`, and every IP address is from the RFC 5737 documentation ranges.

## Generating a kit

```sh
bun src/bench/synth.ts /tmp/kit                 # seed 1739, 60 rows
bun src/bench/synth.ts /tmp/kit --seed 42 --rows 200
```

This writes:

```
/tmp/kit/
  input/
    accounts.csv
    notes/review.md
    notes/standup.txt
    sync.log
  oracle.json
```

The oracle sits next to `input/`, not inside it, so blinding `input/` never reads it.

From code, `generateKit(seed, { rows })` returns the files and the oracle in memory, and
`writeKit(dir, kit)` writes them as above.

### Determinism

A kit depends only on its seed and options. The generator uses its own seeded PRNG (mulberry32),
no clock and no environment, so the same seed gives byte-identical files and oracle on every
machine and every run. The seed is recorded in the oracle. The PRNG lives in `src/bench/`, outside
the engine.

## What kit v1 contains

Formats: CSV and text (Markdown, plain text, a log). Other formats join the kit as the engine
handles them.

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

## The oracle

`oracle.json`:

| Field | Meaning |
|---|---|
| `version` | Kit version, `1`. |
| `seed`, `rows`, `recurInProse` | The inputs that produced the kit. |
| `columns` | Each CSV column's `file`, `header`, true `class` (`person`, `org`, `host`, `email`, `id`, or `vocabulary` for values that identify no one) and a note. This is ground truth, not a spec: `client_scope_code` holds IDs even though a reviewer may leave it undecided. |
| `values` | Every sensitive value as written, sorted by class then value: `value`, `class`, the `canonical` entity or value it stands for, its `form` (`canonical`, `alias`, `part`, or `value` for cells and pattern matches) and the `files` it occurs in. |
| `decoys` | Each decoy's `text`, the name part it `resembles`, why it is not a name, and its `files`. |

A blinded output passes the oracle when no `values[].value` occurs in it as a whole word, in any
case, once the decoy texts (exact case) are set aside.

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

Two known engine gaps are recorded as `test.failing`, so they turn red when fixed and must then be
switched to `test`:

- values from a blinded column cited in prose (`recurInProse`) are left in the prose (AGT-1779);
- the vocabulary entry `SAM` does not stop the given-name part `Sam` from replacing the acronym
  (over-blinding, not a leak).
