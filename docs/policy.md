# Policy reference: `blind.toml`

`blind.toml` is the policy: what sensitive means for your corpus, which words to leave alone, which
models to use, and how much may leave your machine. You write it (`blind init` creates a starting
file), you own it, and blind never edits it. It sits next to the `.blind/` directory, and every
command reads it from the directory you run it in.

Which commands need it: `blind profile`, `blind plan` and `blind run` require it and stop with
`blind.toml not found; run blind init first` without one. `blind apply` and `blind audit` work
without it, with an empty keep list, and `blind audit` then runs no model layer. A file that does
not parse stops the command, and so does a typo: **unknown keys are rejected** at every level, and
the message names the key and what was expected.

The file is not a secret, but the text in it is sent to your analyst model (see
[What is sent](#what-is-sent)). Write invented examples, never real values.

## A complete file

This is what `blind init --defaults` writes, minus the comments. Every key shown is read.

```toml
[sensitive]
classes = ["person", "org", "host", "email", "id", "location"]
description = "Anything that tells a reader who these documents are about: people, the organisations they work for, their machines and hosts, email addresses, account or record IDs, and where they are."
examples = ["Ada Example", "Example Widgets Ltd", "build01.corp.example.com", "ada@example.com", "ACCT-000123", "Springfield office"]

[keep]
terms = ["vendor.example.net", "Quarterly Review"]

[models.analyst]
backend = "openai-compatible"
url = "http://127.0.0.1:11434/v1"
model = ""
key_env = ""

[models.auditor]
backend = "openai-compatible"
url = "http://127.0.0.1:11434/v1"
model = ""
key_env = ""

[profile]
samples = 5

[privacy]
mode = "local-only"

[patterns]
ip = true
host = true

[context]
# enabled = true
# triggers = ["locker code", { word = "license", kind = "number" }]
```

`[sensitive]`, `[keep]`, `[models.analyst]`, `[profile]` and `[privacy]` must be present.
`[models.auditor]`, `profile.samples`, `[patterns]`, [`[context]`](#context), [`[defaults]`](#defaults) and [`[[columns]]`](#columns) rules are optional.

## `[sensitive]`

What the analyst should treat as sensitive, in your words.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `classes` | array of strings | yes | Which classes to blind: any of `person`, `org`, `host`, `email`, `id`, `location`. Anything else is an error. `[]` is valid and blinds nothing by class. |
| `description` | string | yes | In plain language: what must a reader of the blinded output not learn? |
| `examples` | array of strings | yes | Invented examples of the kind of value you mean. |

What `classes` does: the analyst is told these are the sensitive classes; an answer to a spec
question that names a class (`blind plan --answer q1=org`) blinds the column only if the class is
listed here, otherwise it keeps it; and the built-in detectors (`blind plan --no-model`) blind a
column they recognise, and turn a pattern on, only when its class is listed (`host` covers IP
addresses, host names and MAC addresses, `email` emails, `id` GUIDs and numeric IDs). It does not
turn off a rule you wrote in the spec. To switch a pattern regardless of the classes or the spec,
use [`[patterns]`](#patterns).

`description` and `examples` guide the model analyst. The `--no-model` planner does not read them.

## `[keep]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `terms` | array of strings | yes | Words and names that must survive blinding unchanged: product names, jargon, public terms, vendor domains. `[]` keeps nothing. |

What a keep term does:

- **Hosts.** A term that looks like a domain (it contains a dot; a leading `*.` is ignored) keeps
  every host name equal to it or under it: `vendor.example.net` keeps `api.vendor.example.net`
  and not `badvendor.example.net`. Terms without a dot never keep a host. Email addresses are not
  kept by a term: an address under a kept domain is still blinded.
- **Names.** A part of a person's name that equals a keep term is not replaced on its own
  wherever it recurs, and a transcript speaker tag equal to a keep term is kept and counted.
- **IP addresses.** A term may be an exact IP address or a CIDR range (`198.51.100.7`,
  `10.2.0.0/16`). The audit does not report an address equal to or inside one. Every other IP
  address in the output is a candidate unless the map says the engine issued it as a pseudonym,
  whatever the `ip` pattern says. Only the audit reads these terms; the engine matches IPs by
  the `ip` pattern (the spec's, or [`[patterns]`](#patterns) here).
- **Audit.** The audit does not report a keep term, a Title-Case phrase made of keep terms, or a
  host under a kept domain, and the model auditor is told to leave them.
- **Models.** The analyst and auditor are sent the list so they do not propose or report them.
- **Columns.** A table column, or a JSON key, whose header (key name) equals a keep term, ignoring
  case and runs of spaces, is kept: `blind plan` writes it into the spec as `vocabulary`/`keep`
  with `source: "policy"`, as a [`[[columns]]`](#columns) rule would. A `[[columns]]` rule that
  matches the column wins over the term.

A keep term does **not** override your spec's values: a value or entity the spec blinds is blinded even when
it also appears in the keep list. To keep it, take it out of the spec (or classify it as
`vocabulary`).

## `[[columns]]`

Column rules: a policy such as "keep species, weight, visit date and microchip; drop the notes"
written in `blind.toml`, with no model and no spec edit. Each `[[columns]]` table is one rule.

```toml
[[columns]]
header = ["species", "weight*", "visit date", "microchip"]
treatment = "keep"

[[columns]]
header = ["notes", "remarks", "diagnosis"]
treatment = "scan"

[[columns]]
header = "gate code"
treatment = "redact"

[[columns]]
header = "notes"
file = "clinic/**/*.csv"
treatment = "drop"

[[columns]]
header = "owner"
treatment = "blind"
class = "person"
```

| Key | Type | Required | Meaning |
|---|---|---|---|
| `header` | string or array of strings | yes | Header globs: `*` any run of characters, `?` one. Case and runs of spaces do not matter. A JSON key path matches by its last key name (`$.visits[*].weight` by `weight`); the root and record-ID keys (`.*~`) never match. |
| `file` | string | no | A glob on the input-relative path (`/`-separated): `*` and `?` within one folder, `**` across folders. Absent: every file. |
| `treatment` | `"keep"`, `"scan"`, `"drop"`, `"blind"`, `"value"` or `"redact"` | yes | What the matching columns get (the spec's treatments, [spec.md](spec.md#columns)). `keep` leaves every cell byte-identical, whatever it holds. `scan` keeps the cell as written except for what the free-text scanner finds in it: pattern matches (phone, email, IP), spec entities, values blinded elsewhere, people named only in prose and the value after a [context](#context) keyword; use it for notes, remarks and diagnoses. `drop` removes the column or key from the output; `redact` writes `REDACTED` in each non-empty value. The column itself is not in the map, so it cannot be revealed; but every non-empty value still recurs: the same text in another file or column is replaced, and so are a person's name parts, as if the column had been blinded. The class is the rule's `class` when it is sensitive, else `person` for a column of names, `id` for phones, emails and codes, else `value`. |
| `class` | a spec class (`person`, `org`, `host`, `email`, `id`, `location`, `vocabulary`, `unknown`) | no | Default: `vocabulary` for `keep`, `unknown` otherwise. `keep` with `unknown` is an error; `scan` needs no class (the audit reads a `scan` column as free text whatever its class). `blind` with a sensitive class gives that class's pseudonyms; with `unknown`, `Value_` ones. `value` with `unknown` leaves the column to the engine's identifier-like test. |

How they apply:

- **When.** `blind plan` (and so `blind run`) writes them into the spec after the analyst or the
  heuristic has proposed its rules, on every plan, with `source: "policy"`. The first rule that
  matches a column wins; a [keep term](#keep) naming the header comes after every rule. `blind
  apply` reads only the spec, so re-plan after editing this table.
- **What they override.** Analyst, heuristic and earlier policy rules. A spec rule with
  `source: "human"` (an answered question, or a rule you wrote) is kept, and the plan says so. An
  unanswered question about a column a rule now decides is removed.
- **Removing a rule.** On the next plan, a column whose saved rule came from a `[[columns]]` rule
  that is gone goes back to the heuristic rule.
- **XLSX.** A dropped column keeps its place in the worksheet with its data cells emptied, so
  references stay valid. A number, date or boolean cell in a dropped or redacted column, or a
  pivot or chart cache, stops the workbook from being written; see [spec.md](spec.md#how-blind-apply-uses-the-spec).
- **Kept values stay kept.** A value that is a whole cell of a `keep` or `scan` column anywhere in
  the corpus (a pet's name, a clinic's public number) is never pseudonymised whole by the
  fail-closed fallback in another column: those cells are scanned as text instead, and `blind
  apply` reports how many per column. A rule that blinds that other column still wins.

## `[defaults]`

```toml
[defaults]
columns = "scan"
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `columns` | `"fallback"` or `"scan"` | `"fallback"` | What a column (or JSON key) gets when no rule decides it: no spec rule, or an `unknown`/`value` one. `fallback` runs the engine's fail-closed identifier-like test ([spec.md](spec.md#how-blind-apply-uses-the-spec)): codes, names and other mostly distinct values are pseudonymised whole, the rest scanned as text. `scan` treats every such column as `scan`: nothing is pseudonymised whole unless a rule says so, and its text is still scanned. Use `scan` when your policy lists what *is* sensitive and everything else should stay. |

`blind apply` reads it at apply time (no re-plan needed); `[[columns]]` rules, keep terms and the
analyst's or heuristic's classified rules (an email or numeric-ID column, say) still decide their
columns. The apply report shows such a column as `unknown → scanned (the [defaults] columns setting)`.

## `[models.analyst]` and `[models.auditor]`

The analyst proposes the spec; the auditor looks for what the output still gives away. Configure
them separately so the auditor can be a different model from the analyst. Each table has the same
four keys, all required in the table:

| Key | Type | Meaning |
|---|---|---|
| `backend` | `"claude-cli"`, `"anthropic"` or `"openai-compatible"` | How to reach the model. |
| `url` | string | The server's base URL. Empty means the backend's default (`https://api.anthropic.com` for `anthropic`; `http://127.0.0.1:11434/v1` for `openai-compatible`). Ignored by `claude-cli`. |
| `model` | string | The model name. Empty means "not set": `openai-compatible` then asks the server which models it has and uses the first (a request that carries no document data); `claude-cli` uses its own default; `anthropic` refuses to run. |
| `key_env` | string | The **name** of the environment variable that holds the API key, never the key. Empty means no key. A value that is not a valid variable name (a pasted key) is refused without being printed. |

The backends:

| Backend | What it does |
|---|---|
| `openai-compatible` | `POST <url>/chat/completions` to any OpenAI-compatible server: a local MLX, Ollama or vLLM server, or a hosted one. `key_env`, if set, is sent as a bearer token. |
| `anthropic` | `POST <url>/v1/messages` to the Anthropic API. `key_env` and `model` are required. |
| `claude-cli` | Runs `claude -p` with tools off, in a fresh empty directory, using your Claude Code login. The prompt goes to Anthropic. `key_env` is ignored. |

`[models.analyst]` is required. When `[models.auditor]` is absent, the auditor uses the analyst's
backend with its own prompt, and `blind audit` says so. The independence of the auditor is the
point of having one, so set it once you have a second model. Under `privacy.mode = "none"` the
tables are still validated but no model is called.

Keys are read from the environment only when a call is made, go only into request headers, and are
never written to a file, a message or the output. Redirects are not followed. A model that is slow
gets 10 minutes per call; a timeout is a failure, never an empty answer.

## `[profile]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `samples` | whole number, 0 or more | no | Sample values the profile carries for each column, key, document and transcript. `0` means headers and statistics only. Must be `0` (or unset) under `profile-only`. |

Unset, `samples` follows the privacy mode: **5** under `local-only` and `none`, **0** under
`profile-only`, where the profile goes to a remote model. Under `local-only` and `none` setting it
overrides the mode. Under `profile-only` a model never sees a value, so `samples` above 0 is an
error (`profile.samples must be 0 under privacy.mode = "profile-only"`), and `blind init` does not
ask for it. `--samples N` on `blind profile` overrides the file for one run; under `profile-only`
the samples are still left out of what it prints and saves. Each sample is cut to 120 characters,
ending in `…`. Samples are the only document text a profile carries, apart from the outlines and
speaker names that `local-only` also sends and `profile-only` leaves out.

## `[privacy]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `mode` | `"local-only"`, `"profile-only"` or `"none"` | yes | How far a model call may reach. |

| Mode | Models | What is sent |
|---|---|---|
| `local-only` | Only a loopback server: `127.0.0.1` (the whole `127.0.0.0/8`), `::1` or `localhost`. `claude-cli`, the hosted Anthropic API and any other host are refused. | Analyst: the profile and the policy. Auditor: the blinded output's text in lines of at most 120 characters, in chunks of at most 8 kB, and the policy. |
| `profile-only` | Remote servers over https, and `claude-cli`. A loopback server may use http. | Exactly the profile's statistics and the policy, nothing else; anything else is refused. No value: no samples, sample sentences or lines, document outlines or speaker names. Every file, folder and sheet name, header and JSON key as an opaque token. Auditor: the profile of the output tree, the same way. |
| `none` | No model. `blind plan` uses the built-in detectors; `blind audit` runs its rule-based layers only. | Nothing. |

Every check runs before anything is sent. A refused call exits 2 and names the mode, except under
`blind audit`, where 2 means a leak and a refused call exits 3. There is no fallback: a refused
call is never retried against another backend or in another mode. The full rules, with the token
scheme, are in [spec.md](spec.md#privacy-modes).

### What is sent

The same limit applies in every mode: **no string over 120 characters is sent**. A string or key
over the limit in the data refuses the call; it is never cut. blind cuts samples, outline entries
and similar excerpts to 120 characters when it builds the profile, and splits `description` into
pieces of at most 120 characters. The things you write cannot be cut for you: a `keep` term or an
`examples` entry over 120 characters makes `blind plan` stop with
`refusing to send: the string at $.policy.keep[0] is 130 characters`. Shorten it.

Each call prints a line to stderr first: `role · backend · model · mode · [samples k ·] N bytes
sent`. `--quiet` hides it, except under `profile-only`.

## `[patterns]`

Switches for the free-text shape finders, read by `blind apply` and `blind audit`. A key set here
wins over the spec's `patterns` in both directions, every run, without editing
`.blind/spec.json`; a key left unset follows the spec. The table and every key in it are optional.

| Key | Type | Finds |
|---|---|---|
| `ip` | `true` or `false` | IPv4 and IPv6 addresses |
| `email` | `true` or `false` | email addresses |
| `host` | `true` or `false` | host names |
| `guid` | `true` or `false` | GUIDs |
| `mac` | `true` or `false` | MAC addresses |
| `phone` | `true` or `false` | phone numbers (on when the spec says nothing: a spec written before `phone` existed has it on) |

`blind init` writes `ip = true` and `host = true`, so addresses and host names in free text are
replaced even when `host` is not one of `[sensitive] classes`, and leaves the other four
commented out (the spec decides). A `blind.toml` without the table behaves as before: the spec
decides every pattern. `blind plan` and `blind run` show the patterns in force, marking one that
blind.toml changed: `ip on (blind.toml; spec: off)`. The spec file itself is never changed. A
pattern turned off finds nothing new, but a value an earlier run already replaced is still in the
map and is replaced again wherever it recurs.

Turning a pattern off here also turns it off for `blind plan --from-audit`: a candidate accepted
as a pattern sets it in the spec, but a `false` here still wins.

## `[context]`

Secrets that no name or shape finder targets, such as a gate code, a password or an account
number, are found by the word in front of them. In free text (text files, DOCX, transcripts, cells
and JSON strings kept as text) the value after a keyword is replaced with `REDACTED`, the same
placeholder a `redact` column writes, and the keyword stays: `gate code 4471` becomes
`gate code REDACTED`. A redacted value is not recorded in the map, so `blind reveal` cannot
restore it. The table and both keys are optional; with no `[context]`, the built-in keywords are on.

| Key | Type | Meaning |
|---|---|---|
| `enabled` | `true` or `false` (default `true`) | `false` turns the keywords off, built-in and extra |
| `triggers` | array of strings and `{ word, kind }` tables | extra keywords or phrases, matched whole-word in any case; the value after each is redacted. A bare string expects a `secret`; a table names the `kind`: `secret`, `number` or `date` |

Built-in keywords: `DOB` / `date of birth`; `DL` / `driver's license`; `plate`; `gate code` (also
door, garage, alarm, entry, access, keypad and lockbox `code`/`pin`); `password` / `passcode` /
`passphrase` / `pw`; `combo` / `combination`; `routing`; `account` / `acct`; `card` / `visa` /
`mastercard` / `amex`; `CVV` / `CVC`; `policy`.

What counts as the value, after the keyword and any separators or filler (`:`, `=`, `#`, `is`,
`number`, `no.`, `ending in`):

- `password`, `pw`, `combo`, `gate code` and every extra `triggers` word take the next token,
  whatever it is, unless it is an ordinary word (`the password was reset` redacts nothing). A
  quoted value is taken to its closing quote.
- The others (`account`, `card`, `routing`, `plate`, `DL`, `CVV`) take the next token only if it
  holds a digit and is at least three characters, so `account manager` and `plate 2` stay.
  `policy` also needs a number marker (`policy #AB-77123`, `policy number: 99120344`), so
  `the policy 2024 update` stays.
- Card, account and routing numbers and combinations take following digit groups too:
  `card number 4111 1111 1111 1111`, `safe combo 12 34 56`.
- A date after `DOB` may be numeric, `April 12, 1980` or `12 April 1980`.
- A value spelled out in digits right after the keyword (`gate code four four seven one`) is taken whole.
- Up to four ordinary words may sit between the keyword and the value: `combo changed to 47-11-09`,
  `the gate code is now 9182#`, `password was reset to Example!42`, `license on file is ST 123`. A
  sentence end (`.`, `;`, `!`, `?`) or a line break stops the search, and so does a fifth word.
  After skipped words a secret must look like one (a digit or a symbol, or any word right after
  `to`): `the password was reset and then we left` redacts nothing.

A trigger from `triggers` can name the kind of value it expects, so an ordinary word after it is
left alone:

```toml
[context]
triggers = ["vault code", { word = "license", kind = "number" }, { word = "born", kind = "date" }]
```

With `kind = "number"`, `her license photo is old` stays and `license 4417-22 expires` becomes
`license REDACTED expires`. A bare string is a `secret` trigger and takes the next token whatever it
is. An unknown `kind`, a blank `word` or any other key in the table is an error.

**Forms and tables.** The label and the value are often in different cells (`| Owner DOB |
01/02/1960 |`). In a DOCX table (also a DrawingML table), a CSV or an XLSX sheet, a cell that ends
in a keyword (`DOB`, `Owner DOB:`, `Driver license`, `Account number`; at most four words, no
sentence) marks the cell to its right as the value, which must fit the keyword's rule (a date for
`DOB`, a digit and three characters for a number keyword, any non-prose text for a secret). A label
in the first row of a table whose right neighbour is no value, or is a plain word beside a secret
keyword (so it reads as the next column header), heads a column instead: every cell below it that
fits the rule is the value. A cell that is itself a label is never a value. In a CSV or XLSX the
whole value cell becomes `REDACTED`, but only where the column is left as text: a column a
`[[columns]]` rule keeps, drops or redacts, or that is already pseudonymised, is not touched. A
number-typed XLSX cell is not redacted this way (write it as text). In a DOCX only the value in the
cell is replaced.

A match is a heuristic on the words around it: `the password is swordfish` is redacted, and prose
such as `password is stored in the vault` can lose a word it should keep (`stored` is on the
ordinary-word list, but the list is short). It does not look inside column values: a `Gate Code`
column needs a [`[[columns]]`](#columns) `redact` rule.

## Choosing a setup

| You want | Set |
|---|---|
| Nothing leaves this machine, with a local model | `mode = "local-only"`, both models `openai-compatible` at a loopback `url` |
| Nothing leaves this machine, no model at all | `mode = "none"` (or `blind plan --no-model` and `blind audit --no-model` per run) |
| A hosted analyst that never sees a value (recommended when a model must help) | `mode = "profile-only"`, analyst `backend = "anthropic"`, `model = "<id>"`, `key_env = "ANTHROPIC_API_KEY"`, and `[[columns]]` rules for what you already know (example below) |

Under `profile-only` the analyst writes column rules from statistics (count, distinct ratio,
digit ratio, dictionary ratio, mean length, shape-detector rates) and the policy alone: every
header is `col_N` and every key `["key_N"]`, so it classifies by shape, not by name, and asks when
the statistics cannot decide. Its rules are mapped back to the real headers and written into the
spec with `source: "analyst"`; your `[[columns]]` rules are applied after it, the same way as in
every mode, and win (`source: "policy"`). So the more you state in `[[columns]]`, the less the
model has to guess.

`privacy.mode` is one setting for the whole file: the analyst and the auditor both obey it. Under
`profile-only` the auditor, which reuses the analyst when `[models.auditor]` is absent, is sent
only the profile of the output, with no values, a coarse check: parts of the output that a profile does not
describe (such as a DOCX that is not a transcript) are listed as not sent. To have a local model
read the output text instead, audit from a `blind.toml` whose mode is `local-only` and whose
`[models.auditor]` is a loopback server; the analyst table is not used by `blind audit`. Or audit
without a model (`blind audit --no-model`), which still runs the rule-based layers.

For example, a hosted analyst that never sees a value, with the columns you already know decided
in `blind.toml`:

```toml
[sensitive]
classes = ["person", "org", "host", "email", "id"]
description = "Names of our customers and their staff, their systems, and account numbers."
examples = ["Pat Example", "Example Freight Ltd", "ACCT-004417"]

[keep]
terms = ["tenanthub.example"]

[models.analyst]
backend = "anthropic"
url = ""
model = "your-model-id"
key_env = "ANTHROPIC_API_KEY"

[profile]

[privacy]
mode = "profile-only"

[[columns]]
header = ["species", "weight*", "visit date"]
treatment = "keep"

[[columns]]
header = ["microchip*"]
treatment = "blind"
class = "id"
```

## `blind init`

`blind init [dir]` writes `blind.toml` and `.blind/salt` (32 random bytes, mode 0600) in `dir`
(default `.`).

- On a terminal it asks for the main settings (mode, the two models, samples, classes, keep terms;
  not samples under `profile-only`);
  Enter takes the default. `--defaults`, or input that is not a terminal, writes the defaults.
- An existing `blind.toml` is kept. An existing salt makes `init` refuse (exit 1): a new salt gives
  every value a different pseudonym, so it breaks the match with earlier runs and with the map.
  `--force` replaces both files, and the old pseudonyms no longer match.
- `[sensitive] description` and `examples` get the defaults above; edit them to say what matters
  for your documents.
- The salt is a secret. Never commit `.blind/`.
