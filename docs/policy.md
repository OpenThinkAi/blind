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
classes = ["person", "org", "host", "email", "id", "location", "secret"]
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
secret = true

[context]
# enabled = true
# triggers = ["locker code", { word = "license", kind = "number" }]

[pseudonyms]
style = "readable"
```

`[sensitive]`, `[keep]`, `[models.analyst]`, `[profile]` and `[privacy]` must be present.
`[models.auditor]`, `profile.samples`, `[patterns]`, [`[context]`](#context), [`[defaults]`](#defaults), [`[images]`](#images), [`[pseudonyms]`](#pseudonyms) and [`[[columns]]`](#columns) rules are optional.
A missing `[pseudonyms]` table means the compact style.

## `[sensitive]`

What the analyst should treat as sensitive, in your words.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `classes` | array of strings | yes | Which classes to blind: any of `person`, `org`, `host`, `email`, `id`, `location`, `secret`. Anything else is an error. `[]` is valid and blinds nothing by class. `secret` (passwords, keys, tokens) turns the [`secret` pattern](#patterns) on in a spec `blind plan` writes without a model. |
| `description` | string | yes | In plain language: what must a reader of the blinded output not learn? |
| `examples` | array of strings | yes | Invented examples of the kind of value you mean. |

What `classes` does: the analyst is told these are the sensitive classes; an answer to a spec
question that names a class (`blind plan --answer q1=org`) blinds the column only if the class is
listed here, otherwise it keeps it; and the built-in detectors (`blind plan --no-model`) blind a
column they recognise, and turn a pattern on, only when its class is listed (`host` covers IP
addresses, host names and MAC addresses, `email` emails, `id` GUIDs, numeric IDs, licence plates,
usernames/login handles and phone numbers). It does not
turn off a rule you wrote in the spec. To switch a pattern regardless of the classes or the spec,
use [`[patterns]`](#patterns).

`description` and `examples` guide the model analyst. The `--no-model` planner does not read them.

## `[keep]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `terms` | array of strings | yes | Words and names that must survive blinding unchanged: product names, jargon, public terms, vendor domains. `[]` keeps nothing. |
| `placeholders` | boolean | no, default `true` | Keep the built-in textbook placeholders as written (see below). `false` blinds them like any other value. |

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

### Kept columns shield their values everywhere

Every distinct value of a `keep` column (CSV, TSV, JSON key, worksheet column) is shielded in the
whole corpus, as if it were a keep term: a pattern match, a name found in prose, a spec entity or
a learned name that falls **inside** an occurrence of it is not replaced. So the clinic's public
phone, kept in a `clinic_phone` column, stays `(555) 555-0199` in a handbook, a letter header or a
transcript NOTE line; a phone is compared by its digits, so `555-555-0199` and `+1 555 555 0199`
are the same number. A value shields only if it has at least 4 characters and is not a number,
date or measure (`38.6 lb`, `2026-10-12`); a phone shields by its digits.

An explicit rule wins. A kept value that a `blind` or `value` column, or a `drop` or `redact`
column, also pseudonymises somewhere, or that a spec entity names, is not shielded, and `blind
apply` reports `N kept values not shielded elsewhere`. A value a `blind`/`drop`/`redact` column
holds is replaced even inside a kept cell, as before; secrets (`REDACTED`) and transcript speakers
are never shielded either. Each run reports `N kept values shielded M spans elsewhere`. The audit
reads the same values back from the `keep` columns of the CSV/TSV files in the output, so it does
not report them as leaks.

### Placeholders

Forms and documentation carry textbook identities that are nobody's data. Unless `[keep]
placeholders = false`, these are kept verbatim wherever they appear:

- `John Doe`, `Jane Doe`, `John Q. Public`, `Jane Q. Public`, and `123 Main St` (`Street`, `St.`);
- a phone whose last seven digits are one repeated digit: `(999) 999-9999`, `000-000-0000`;
- an email whose local part is a template word (`user`, `username`, `name`, `yourname`, `you`,
  `email`, `someone`, `first.last`) on a reserved example domain (`example.com`, `.org`, `.net`, or
  a name ending `.example`, `.test`, `.invalid`). `dana@example.com` is not a template: it is
  blinded.

A real-looking number such as `555-0100` is not a placeholder. The run reports how many
placeholders it kept.

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

# The pet's date of birth is kept; the owner's is not. The path rule is scoped, so it wins at owner.dob.
[[columns]]
header = "dob"
treatment = "keep"

[[columns]]
path = "owner.dob"
treatment = "redact"

[[columns]]
header = "dob"
sheet = "Clients"
treatment = "redact"
```

| Key | Type | Required | Meaning |
|---|---|---|---|
| `header` | string or array of strings | yes, unless `path` is given | Header globs: `*` any run of characters, `?` one. Case does not matter, and neither do separators: `_`, `-`, `.`, space and tab each count as one space on both sides, so `invoice total`, `invoice_total` and `Invoice-Total` match the same column (`invoicetotal` does not). A JSON key path matches by its last key name (`$.visits[*].weight` by `weight`); the root and record-ID keys (`.*~`) never match. |
| `path` | string | no | A JSON key-path glob over the **whole** path: `owner.dob`, `users[*].profile.*`, `**.profile.dob`, `clinic["visit date"]`. Keys are separated by `.`; `*` and `?` match within one key, `**` any number of keys (none included). A leading `$` is optional and `[*]` array markers are ignored on both sides, so `users.profile.dob` matches `$.users[*].profile.dob`. Each key segment is matched like a header: case and separators (`_`, `-`, `.`, space, tab) are normalised on both sides, so `visit_date` matches `["visit date"]`. A rule with `path` matches JSON keys only; with `header` too, the key must match both. |
| `sheet` | string | no | A worksheet-name glob (`*`, `?`, any case). A rule with `sheet` matches XLSX columns only. `sheet` and `path` cannot both be set. |
| `file` | string | no | A glob on the input-relative path (`/`-separated): `*` and `?` within one folder, `**` across folders. Absent: every file. |
| `treatment` | `"keep"`, `"scan"`, `"drop"`, `"blind"`, `"value"` or `"redact"` | yes | What the matching columns get (the spec's treatments, [spec.md](spec.md#columns)). `keep` leaves every cell byte-identical, whatever it holds. `scan` keeps the cell as written except for what the free-text scanner finds in it: pattern matches (phone, email, IP), spec entities, values blinded elsewhere, people named only in prose and the value after a [context](#context) keyword; use it for notes, remarks and diagnoses. `drop` removes the column or key from the output; `redact` writes `REDACTED` in each non-empty value. The column itself is not in the map, so it cannot be revealed; but every non-empty value still recurs: the same text in another file or column is replaced with `REDACTED`, and so are a person's name parts. They are never pseudonymised and never written to `map.json` (whatever the rule's `class`, `secret` included), so `blind reveal` cannot restore them. |
| `class` | a spec class (`person`, `org`, `host`, `email`, `id`, `location`, `vocabulary`, `secret`, `unknown`) | no | Default: `vocabulary` for `keep`, `unknown` otherwise. `keep` with `unknown` is an error; `scan` needs no class (the audit reads a `scan` column as free text whatever its class). `blind` with a sensitive class gives that class's pseudonyms; with `unknown`, `Value` ones (`Value_` in the compact style); with `secret` (a password or key column), `REDACTED` in every non-empty cell, as `redact` does. `value` with `unknown` leaves the column to the engine's identifier-like test. |

How they apply:

- **When.** `blind plan` (and so `blind run`) writes them into the spec after the analyst or the
  heuristic has proposed its rules, on every plan, with `source: "policy"`. When several rules
  match a column, the most specific wins (see [Precedence](#precedence)); a [keep term](#keep)
  naming the header comes after every rule. `blind apply` reads only the spec, so re-plan after
  editing this table.
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

### Precedence

When two or more rules match the same column or JSON key, the most specific one decides it,
wherever it sits in the file. Rules are compared step by step, and the first step that tells them
apart decides:

1. **Scoped over unscoped.** A rule with `path`, `sheet` or `file` beats one with none of them.
2. **Exact over glob.** A rule whose matching globs have no `*` or `?` beats one with a wildcard.
3. **Fewer wildcards.** Counted over the globs that matched (`**` counts as two).
4. **More literal text.** The characters that are not wildcards, over the globs that matched.
5. **File order.** Only a full tie goes to the rule written first.

Of a rule's `header` globs, the most specific one that matches is the one compared; a rule with
both `path` and `header` is ranked on both together.

So `owner_city` beats `owner*` (exact over glob), a `msg_opt_in` keep rule beats a `*msg*` drop
rule written above it, and `path = "owner.*"` beats a plain `dob` keep rule at `owner.dob` while
`pet.dob` stays kept. A configuration where no two rules match the same column decides exactly
what it decided before precedence existed (when only the first match counted).

`blind plan` prints a note for every column or key that two or more rules match with different
treatments or classes, naming each rule by its place in the file (`columns[0]` is the first
`[[columns]]` table) and the glob that matched, winner first, and why it won:

```
note: "v.csv" "msg_opt_in": 2 blind.toml rules match: columns[3] (header "msg_opt_in", keep/vocabulary); columns[1] (header "*msg*", drop/unknown); columns[3] wins (an exact name beats a glob)
```

It prints a warning when a `keep` rule matches columns but decides none of them, because another
rule wins at every one (a keep rule that loses only to another keep rule of the same class is
not reported). Notes and warnings name files, headers, key paths and globs, never a value. With
`--json` they are in `notes`.

## `[defaults]`

```toml
[defaults]
columns = "scan"
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `columns` | `"fallback"` or `"scan"` | `"fallback"` | What a column (or JSON key) gets when no rule decides it: no spec rule, or an `unknown`/`value` one. `fallback` runs the engine's fail-closed identifier-like test ([spec.md](spec.md#how-blind-apply-uses-the-spec)): codes, names and other mostly distinct values are pseudonymised whole, the rest scanned as text. `scan` treats every such column as `scan`: nothing is pseudonymised whole unless a rule says so, and its text is still scanned. Use `scan` when your policy lists what *is* sensitive and everything else should stay. |

`blind apply` reads it at apply time (no re-plan needed); `[[columns]]` rules, keep terms and the
analyst's or heuristic's classified rules (an email, numeric-ID, licence-plate, username or phone
column, say; [spec.md](spec.md#re-planning-with-a-saved-spec)) still decide their
columns. The apply report shows such a column as `unknown → scanned (the [defaults] columns setting)`.

## `[images]`

```toml
[images]
keep = true
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `keep` | `true` or `false` | `false` | What happens to pictures inside a DOCX or XLSX (`word/media/*`, `xl/media/*`). blind cannot read a picture, and one can hold a scanned ID, a face, a signature or EXIF metadata (GPS position, device owner). By default each raster image (PNG, JPEG, GIF, BMP) and SVG is replaced with a neutral 1x1 placeholder of the same format under the same part name, so content types, relationships and layout stay valid and the original bytes and EXIF are gone. `true` copies them unchanged. |

The apply report says `N images replaced with placeholders (images are not blinded; set [images] keep = true to keep them)`.
A picture in a format blind has no placeholder for (TIFF, EMF, WMF, ICO, WebP) stops its file, which is
reported as not written, unless `keep = true`. With `keep = true` the report warns `N images copied
unchanged (images are not blinded)` and `blind audit` lists each picture as an `unscanned` candidate;
the placeholders blind writes are not listed.

## `[pseudonyms]`

```toml
[pseudonyms]
style = "readable"
```

| Key | Values | Default | Meaning |
|---|---|---|---|
| `style` | `"readable"` or `"compact"` | `"compact"` when the table is missing | The shape of every blinded name. `readable` writes `[Label LETTERS #HEX4]`, such as `[Org C #24D2]` or `[Person A #BCF6]`, with the role from the column header where there is one. `compact` writes `Org_24D2` or `Person_BCF6`. The grammar, the letters and the role labels are in [spec.md](spec.md#pseudonym-styles). |

- `blind init` writes `style = "readable"`. A `blind.toml` without the table (one written before the
  setting existed) is **compact**, so its output does not change.
- Any other value is refused and the message names the key: `pseudonyms.style must be one of
  "readable", "compact"` (`blind apply` exits 2).
- The style sets the shape of new pseudonyms. A value already in `.blind/map.json` keeps the pseudonym
  it was given, so switching a corpus from readable to compact and applying again leaves the readable
  forms the map holds; only values the map does not hold take the new style.
- What reads it: `blind apply` writes the chosen style. `blind audit` uses it only to pick the example
  pseudonyms in the model auditor's instructions; its rule-based checks recognise both styles.
  `blind reveal` does not read it: it restores both forms from the map.
- Under `readable`, `blind apply` refuses input that already holds readable-shaped text (exit 2, nothing
  written), naming the file and line. Compact does not refuse. See [spec.md](spec.md#pseudonym-styles).

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
| `phone` | `true` or `false` | phone numbers, including `/`, `?` and Unicode-dash separators and bare 10-digit numbers that a nearby phone word or relation vouches for (on when the spec says nothing: a spec written before `phone` existed has it on) |
| `address` | `true` or `false` | street addresses: a house number, street name and suffix, then an optional unit and `City ST ZIP` (off when the spec says nothing; `blind plan` turns it on when `location` is sensitive) |
| `card` | `true` or `false` | payment card numbers (13-19 digits, a card prefix and a valid Luhn checksum), written as `REDACTED` (follows `secret` when unset: on whenever `secret` is on) |
| `secret` | `true` or `false` | passwords, keys and tokens, written as `REDACTED` (off when the spec says nothing: a spec written before `secret` existed has it off) |

`blind plan` warns, once per switched-off pattern, when the profile finds that shape: `warning: [patterns] ip is off, but 20 ip-shaped value(s) were found in 1 file(s); they will be written as is`. It counts table and JSON columns no rule decides, and free text (documents and transcripts). Counts and file counts only; with `--json` the warnings are in `warnings`. `blind run` prints them too.

`blind init` writes `ip = true`, `host = true` and `secret = true`, so addresses, host names and
credential-shaped tokens in free text are replaced even when their class is not one of
`[sensitive] classes`, and leaves the others commented out (the spec decides). A `blind.toml` without the table behaves as before: the spec
decides every pattern. The [`address` pattern](#the-address-pattern) is described below. `blind plan` and `blind run` show the patterns in force, marking one that
blind.toml changed: `ip on (blind.toml; spec: off)`. The spec file itself is never changed. A
pattern turned off finds nothing new, but a value an earlier run already replaced is still in the
map and is replaced again wherever it recurs.

Turning a pattern off here also turns it off for `blind plan --from-audit`: a candidate accepted
as a pattern sets it in the spec, but a `false` here still wins.

### The `address` pattern

A street address written only in prose, a cell kept as text or a JSON value, with no learned value
behind it, is found by its shape: a house number, an optional direction, one to four capitalised
street-name words and a street suffix (`St`, `Rd`, `Ave`, `Blvd`, `Ln`, `Dr`, `Way`, `Ct`, `Pkwy`, `Hwy`,
`Loop` and the spelled-out forms; the full list is in [spec.md](spec.md#patterns)), then optionally a
unit (`Apt 4`, `Unit 12`, `#3`) and `, City ST 12345`. The whole match is one `Loc_` pseudonym (`Place` in the readable style), so
`77 Example Rd, Springfield UT 84000` never leaves a house number or suffix beside a token, even
when a street-name word was already replaced (a street with a replaced word in its name is one address too).

It is off when the spec says nothing, and `blind plan` turns it on when `location` is in
`[sensitive] classes` (set `address = false` here to keep it off). A column where at least 80% of
values hold an address is classed `location` by the heuristic, whatever its header (`line1`), so a
nested `profile.address.line1` is blinded with its sibling `city`.

Not an address: a street with no house number (`a car on Example Rd`); a measure, dose or time
(`2 Tabs`, `3 doses daily`, `10 Days`, `5 Units`, `10:30 Sample Way`); a number that names a room,
suite, bed or page (`Room 12 Oak Way`); `Dr` as an honorific (`Dr Sample`, `5 Mg Dr Sample`); a
street written in lower case. The audit reads the same shape: a surviving match is a
`pattern:address` leak.

### The `secret` pattern

A password, key or token written with no keyword in front of it (`wifi: ExampleNet /
Tr0ub4dor&3`), or said a turn after the keyword (one speaker mentions the password, the next reads
it out), is found by its shape. Each match is written as `REDACTED`, like a [`[context]`](#context)
value: no pseudonym, nothing in the map, nothing `blind reveal` can restore. In free text only (text
files, transcripts, DOCX, cells and JSON strings kept as text); file and folder names are never
searched for secrets. A word is a token between spaces and the characters `" ' ( ) [ ] { } < > | , ; =`,
with surrounding punctuation trimmed (a trailing `!` or `?` stays); `pw:Tr0ub4dor&3` is read as its
value.

- **Anywhere:** 8 to 64 characters mixing at least three of lowercase, uppercase, digit and symbol
  (`! @ # $ % ^ & * ~ ? |` inside the word; `-`, `_`, `.`, `/`, `:` and `+` are separators, not
  symbols, and a trailing `!` or `?` does not count), unless the word reads as words and numbers
  (`Windows11`, `FY2026Budget`, `iPhone15Pro`, `i18n`); or 20 characters or more of base64 / base64url
  that mix two of lowercase, uppercase and digit with high entropy (an API key, a JWT).
- **Near a keyword:** in the sentence or turn of `password` (`passwd`, `pwd`, `pw`, `passcode`,
  `passphrase`, `combo`, `combination`) and in the next two, 6 characters or more mixing two
  classes, one of them a digit or a symbol inside the word: `Example2031!`, `Summer2024`,
  `hunter22`; never `Thanks!` or `rotating`. After the commoner `key`, `api key` and `token` the
  same, but a word that reads as words and numbers (`Windows11`) is left. A sentence ends at a line
  break or at `.`, `!` or `?` followed by a capital or a digit; each transcript turn and DOCX
  paragraph is one too, and the reach carries from one to the next.
- **Never:** a URL, email, `user@host`, `@handle`, `#tag`, `Issue#42` or `policy.md#columns`, a
  path or file name, a dotted name (`config.$defs.entity`), a regex range (`A-Za-z0-9`), a date or
  time, a version (`v2.10.3`), a spreadsheet reference (`$B$2:$B$5`), a pseudonym or `REDACTED`, an amount or
  measure (`$1,250.00`, `38.6lb`, `Amoxi500mg`), hex of any length (hashes, commit ids, request ids),
  a GUID, a code of one case joined by separators (`AB-2026-0001`, `web-7d4b9c8f6-x2k9p`), letters
  then digits (`INC0012345`), a phone, IP, MAC or host, or a short technical term (`sha256`,
  `base64`).

It is a shape heuristic: a mixed-case id with no separators (`aB3xY9qL`) reads as a secret, and a
password that is an ordinary word (`dragon`) is only found after a keyword (`[context]`). The
audit reports every match that survives in document text as a `pattern:secret` leak (see
[spec.md](spec.md#how-blind-audit-checks-the-output)). A `Password` column is a column rule:
`[[columns]]` with `class = "secret"` and `treatment = "blind"` (or `treatment = "redact"`).

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

Built-in keywords: `DOB` / `date of birth` / `birthday`; `DL` / `driver's license`; `plate`;
`username` / `user name` / `login` / `handle` / `screen name`; `badge` / `employee id` /
`member id` / `staff id`; `spare key` / `house key` / `door key` / `key` followed by a place
(`under`, `in`, `inside`, `behind`, `above`, `on top of`, `beneath`); `gate code` (also
door, garage, alarm, entry, access, keypad and lockbox `code`/`pin`); `password` / `passcode` /
`passphrase` / `pw`; `combo` / `combination`; `routing`; `account` / `acct`; `card` / `visa` /
`mastercard` / `amex`; `CVV` / `CVC`; `policy`.

What counts as the value, after the keyword and any separators or filler (`:`, `=`, `#`, `is`,
`number`, `no.`, `ending in`):

- `password`, `pw`, `combo`, `gate code` and every extra `triggers` word take the next token,
  whatever it is, unless it is an ordinary word (`the password was reset` redacts nothing), or a
  plain lowercase or capitalised word straight after the keyword with nothing between
  (`its password rotated yet` redacts nothing; `password: dragon` and `password is dragon` do). A
  quoted value is taken to its closing quote.
- The others (`account`, `card`, `routing`, `DL`, `CVV`, `badge`, `employee id`, `member id`,
  `staff id`) take the next token only if it holds a digit and is at least three characters, so
  `account manager` and `badge of honour` stay.
- `plate` takes a plate of up to three tokens: an optional uppercase two-letter region code, then
  one or two groups of 2-4 letters or digits (a space or dash between) that together hold a digit,
  and the whole plate, region included, is redacted: `plate ST 7AB C12`, `plate ST 12-3456`,
  `plate 7ABC123`. A second group needs a digit or capitals, so `plate 7AB was blue` takes
  `7AB`. `plate 2` and `plate of food` stay.
- `username`, `user name`, `login`, `handle` and `screen name` take one token of three or more
  characters that mixes letters and digits or is dotted or underscored (`dana42`, `d.quill`,
  `dana_42`, `@dana42`). After a separator or filler (`login: admin`, `username is root`) a plain
  word of three or more letters counts too. Straight after the keyword, `login page` and
  `please handle it` stay.
- A key's hiding place: after `spare key`, `house key`, `door key` or a bare `key` (optionally
  `is`/`are` and `kept`/`left`/`hidden`) a place that starts with `under`, `in`, `inside`,
  `behind`, `above`, `on top of` or `beneath` is redacted from that word to the end of the clause
  (a comma, full stop, semicolon, `!`, `?` or the line end), at most eight words:
  `Spare key under the green mat by the back door.` becomes `Spare key REDACTED.` Abstract
  places (`key under review`, `key in the report`) and compounds such as `primary key in` stay,
  and so do `keyboard` and `key findings`.
- `policy` also needs a number marker (`policy #AB-77123`, `policy number: 99120344`), so
  `the policy 2024 update` stays.
- Card, account and routing numbers and combinations take following digit groups too:
  `card number 4111 1111 1111 1111`, `safe combo 12 34 56`.
- A date after `DOB` (or `date of birth`, `birthday`) may be numeric, `April 12, 1980`,
  `12 April 1980` or spoken: a month name with a day as an ordinal or cardinal word or number
  (`third`, `the third`, `3rd`, `twenty-first`, `12`) and an optional year (`forty-two`,
  `nineteen forty-two`, `two thousand five`, `'42`, `1942`): `June third forty-two`,
  `the third of June nineteen forty-two`. A spoken year needs two parts (`forty-two`, or a century
  word and one more), so `June third forty people` takes `June third`.
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
`DOB`, a digit and three characters for a number keyword, any non-prose text for a secret, a handle for `username`). The `spare key`,
`house key` and `door key` labels (also `key location`) take the place in the next cell; a bare
`Key` header is not a label. A label
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
- `blind init` writes `[pseudonyms] style = "readable"`. A `blind.toml` without that table stays
  compact; see [`[pseudonyms]`](#pseudonyms).
- The salt is a secret. Never commit `.blind/`.
