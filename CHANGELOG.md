# Changelog

## Unreleased

- **Fix: a dropped column with a different value on every row no longer makes blinding quadratic.**
  Each dropped value is looked for wherever it recurs, and every word in a kept cell was checked
  against every dropped value sharing its first letter, so a file with transaction or payment id
  columns took time growing with the square of its rows (40,000 rows took minutes; 130,000 never
  finished). The scanner now indexes those values by their first word: a 131,536-row file with two
  such columns blinds in a few seconds under Bun and Node. Output is unchanged.
- **People cells with several names match across files (AGT-2787).** A person cell that holds two
  or more full names separated by `;`, a line break, `&`, `+` or `and` (`Nora Teasdale; Owen
  Brandvik`) is now written one stand-in per person, separators and spacing kept byte for byte, and
  each stand-in is the one that person gets written alone elsewhere. Before, the whole cell was one
  stand-in that matched no one. A cell where a name borrows a surname (`Dana & Lee Quillfeather`)
  keeps one stand-in, as before. blind never splits on `,` or `/`. `blind plan` and `proposeSpec`
  now ask a question (`names-1`, options `person` / `value`) about a column whose samples put a
  full name on each side of a comma, which blind reads as one person written `Surname, Given`, and
  the apply report warns about such cells (`commaNames`) and counts split ones (`people`).
- **First-name and last-name columns join to the full name (AGT-2787).** A new column rule field,
  `joinWith` (blind.toml `join_with`; `joinWith` on the library's `ColumnRuleInput`), on a
  given-name column names its surname column in the same CSV or TSV table. Each row's two cells are
  one person: the given-name cell gets the person's full-name stand-in up to its last space, the
  surname cell the rest, so `given + " " + surname` equals that person's stand-in in any other file
  (compact style, which has no space: split at the last `_`). Headers and columns are unchanged.
  `blind plan` and `proposeSpec` propose the pair for headers like `first_name`/`last_name`,
  `First Name`/`Last Name` or `Given`/`Surname` when people are sensitive. The map records each part
  (new entry kinds `person-given` and `person-family`, which reuse the person's stand-in), and
  `blind reveal` restores each cell exactly. A `joinWith` on a worksheet column is refused. See
  "Cells of several people" and "First and last name columns" in [docs/spec.md](docs/spec.md).

## 0.4.0-rc.2

Fixes found by running the library on small-business exports (job history, payroll, bank and till files).

- **Fix: a hidden number no longer damages kept numbers and dates.** A value written only in digits
  (`1048`, `2026`) from a dropped, redacted or blinded column, or from an earlier map, was replaced
  wherever the same digits appeared, so a kept amount `-1048.93` became `-REDACTED.93` and a kept date
  `2026-01-05` became `REDACTED-01-05`. Now such a value is never matched inside a longer number
  (`1048.93`, `1,048`), anywhere, and is never replaced in a `keep` cell whose whole value reads as a
  number, an amount, a date or a time. It is still replaced in free text ("see invoice 1048") and in
  kept cells that are free text; names, emails and mixed IDs such as `A1048` recur as before. The
  audit reports a blinded number left in place this way as a candidate. A dropped or redacted value
  is not in the map, so the audit cannot report one that survives. See "Numbers stay whole" in
  [docs/spec.md](docs/spec.md).
- **Fix: large files no longer overflow the stack.** `applySpec` threw `RangeError: Maximum call stack
  size exceeded` on a CSV of about 125,000 rows under Node and in Chromium-based browsers. Every place
  that passed one argument per row, cell or value is now a loop, and 500,000-row CSV and JSONL files
  are tested under Bun and Node through both entries. The audit of a large kept table and applying a
  large JSONL file with a blinded field are also much faster.
- **Fix: a column header is no longer renamed by a word of someone's name.** With a person column
  blinded, a header such as `Tax`, `Bonus` or `Tips` was replaced when it equalled one word of a blinded
  name ("PayHarbor Tax Service", "Ivy Bonus"), in the same file or another. A detected header cell and
  a JSON key are now never changed by a lone name part. A whole blinded value in a header is still
  replaced. The apply report lists the header cells it changed (`headerCellsReplaced`) and those it
  kept although they hold a word of a blinded name (`headerPartsKept`); the audit reports the kept ones
  as candidates, not leaks. A sheet whose headers are bare first names or surnames therefore keeps
  them: name them as spec entities to have them replaced. See "Header cells and JSON keys" in
  [docs/spec.md](docs/spec.md).
- **Fix: numeric IDs no longer run out of stand-ins.** A column of short numeric IDs blinded with
  class `id` failed with "no free id pseudonym after 10000 attempts" when the files already held most
  numbers of that length. A stand-in now takes a longer number when every number of the ID's own
  length is in use (`101` becomes a four-digit number); otherwise stand-ins are exactly what they were,
  so earlier maps still match. Where a stand-in space can still run out (IPv4 addresses, and more than
  65,536 distinct values in one run under the `compact` or `readable` style), the error names the file
  and column and says what to change.

## 0.4.0-rc.1

- **Use blind as a library.** `import ... from "@openthink/blind"` gives the engine as functions over
  files held in memory: `profileInputs`, `proposeSpec` and `explainProposal` (built-in detectors and
  the policy, no model; each proposed column says who decided it and why), `applySpec`, `revealFile`,
  `revealText` and `Revealer`, `auditOutputs` (the rule-based audit layers), `newSalt`, `parseMap`,
  `serializeMap`, `parseSpec` and `validateSpec`. The policy is a plain object shaped like
  `blind.toml`. For the same salt, spec, policy and input the stand-ins and the map are the CLI's. The
  caller keeps the map and the salt; both are secret. See "Use as a library" in the README.
- **A browser entry**, `@openthink/blind/browser`: the same library, with no `node:` module, `Buffer`
  or `process`. The package now ships compiled ES modules and type declarations for both entries in
  `dist/`; the CLI is unchanged and still runs on Bun.
- **Office files need a zip codec in the library.** Neither entry carries compression code. Without
  one installed (`setZipCodec`; the README shows Node's), `applySpec` and `profileInputs` skip a DOCX
  or XLSX with the reason "Office files are not supported in this build", `revealFile` refuses one,
  and the audit reports one as unread, never `clean`. The CLI installs Node's codec itself, so `blind`
  commands handle Office files as before.
- **The `letters` stand-in style** (`[pseudonyms] style = "letters"`): the role label, a space and five
  consonants, with no digit (`Staff KQZTB`, `Org MRDHX`), and `Staff_KQZTB` in file names. Reveal and
  audit recognise it. See [docs/policy.md](docs/policy.md#pseudonyms).
- **A cell whose whole value is a `[keep]` term is kept** in a column blinded whole: written as it was,
  not recorded in the map, and counted per column in the apply report. Only an exact whole-cell match
  (ignoring case and spacing) counts; a spec entity, a redact entry or a dropped or redacted value still
  wins. CSV, TSV, JSON and XLSX.
- **Fix: a host label with digits, written bare in prose, is now replaced.** Once a host such as
  `123456789012.registry.example` was blinded, the same label written alone elsewhere (the account
  number on its own in a sentence) stayed as written. It now takes the label's stand-in, for column
  hosts, hosts the patterns find and an earlier map's host-label entries. Output blinded by an earlier
  version can still hold such a label: apply again from the originals to replace it.

## 0.3.0

- **`blind forget <value...>`** removes one data subject from what blind keeps under `.blind/`:
  the map entries that record the value, the spec entity it names (with its aliases and the name
  parts no other entity uses), the profile samples, sentences, lines and speakers that mention it,
  `.blind/run.json` when a real path carries it, and the whole `.blind/revealed/` tree (reveal again
  and the subject stays pseudonymised). It says when the value is still in the spec outside the
  entities, for you to edit by hand.
- **`blind purge`** removes the map, the profile, the run record and the revealed files. The salt
  and the spec are kept. Afterwards `blind reveal` has no map and refuses; the next `blind apply`
  starts a new one.
- Both list what they would remove and go ahead only with `--yes` or `yes` typed at a terminal.
  There is no encryption at rest and no expiry setting: run `blind purge` when a project ends. See
  [docs/spec.md](docs/spec.md#how-blind-forget-and-blind-purge-remove-what-blind-keeps) and
  [SECURITY.md](SECURITY.md#what-stays-on-disk). Nothing to do on upgrade.

## 0.2.1

- **XLSX: a pivot cache's `refreshedBy` is replaced whole.** It names the person who last refreshed
  the cache. It used to be scanned only, so a name the corpus knew (often the same as the core
  `lastModifiedBy`) stopped the whole workbook, and any other name was copied unblinded. It is now
  replaced with a `Person` pseudonym, the same one wherever the name recurs, and `blind reveal`
  restores it. Nothing to do; a workbook refused for this reason by 0.2.0 is now written.

## 0.2.0

Hardening from the November 2026 audit.

### Behaviour changes: what you must do

- **Document dates are written as constants.** Every blinded DOCX and XLSX now has its own dates
  and edit history (`dcterms:created`, `dcterms:modified`, `cp:lastPrinted`, `cp:revision`, app.xml
  `TotalTime`, `w:date` on tracked changes and comments, threaded-comment and pivot-cache refresh
  dates) and its zip metadata (each member's DOS time and date, extra fields, the archive comment)
  written as constants, so a blinded file cannot be matched to its source by them. Output is still
  deterministic, but its bytes differ from 0.1.0's for the same input, and a file whose only change
  is its dates is now reported as changed, with a `document dates:` line. `blind reveal` does not
  restore them. To keep the original dates, set `[metadata] keep_dates = true` in `blind.toml`
  ([docs/policy.md](docs/policy.md#metadata); the full list is in
  [docs/spec.md](docs/spec.md#document-dates-and-zip-metadata)).
- **Non-model credentials are refused as `key_env`.** Well-known credentials for other services
  (`GITHUB_TOKEN`, `GH_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `NPM_TOKEN`, `STRIPE_*`,
  `SLACK_*` and the like) are refused although they end in `_TOKEN` or `_KEY`. If one really holds
  your model's key (GitHub Models with `GITHUB_TOKEN`, say), set `BLIND_ALLOW_KEY_ENV=<name>`.
- **claude-cli calls are announced.** A `claude-cli` call prints
  `<role>: calling claude-cli (claude -p, which sends the prompt to Anthropic under your Claude login)`
  first, even with `--quiet`, as calls to a non-loopback host already did.

### Other changes

- `blind audit` checks the output for every value the spec lists to redact, by its salted
  fingerprint (it reads `.blind/salt`). One still there is a `leak` of class `redact`, whatever its
  shape. Without the salt the audit says the redact entries were not checked.
- `blind init --force` warns when `.blind/spec.json` lists values to redact: under the new salt
  their fingerprints match nothing, so accept them again after the next audit.

## 0.1.0

The first release meant for use. 0.0.2 only proved the publishing path, so most of blind's
behaviour is new since then: column rules in `blind.toml` (`[[columns]]` with keep, scan, drop,
blind, value and redact), the `phone`, `address` and `secret` patterns, context redaction after
keywords such as gate code or password, people named only in prose, readable pseudonyms,
`plan --from-audit` and `run --accept-leaks`, image placeholders in DOCX and XLSX, masked values
in every report, and the `profile-only` mode in which a model never sees a value. See the README
and `docs/` for each.

### Behaviour changes: what you must do

- **Accepted secrets and card numbers are redacted, never stored.** A secret- or card-shaped leak
  accepted with `--accept-leaks` or `plan --from-audit` goes into the spec's `redact` list as a
  salted fingerprint and is written as `REDACTED`. It is never an entity and never in the map.
  Accept one by hand with `--accept cN=redact`; `--accept cN=<class>` is refused for such a value.
  - A spec from before this release may hold a secret as an `id` entity. Delete that entity from
    `.blind/spec.json` by hand, then accept the value again as redact.
  - `blind init --force` writes a new salt, after which every existing fingerprint matches nothing.
    Re-accept the redacted values after replacing the salt.
- **Pseudonym shapes count only when the map issued them.** With a map, the audit treats a value
  as a pseudonym only if that map issued it. Text that merely looks like a pseudonym is reported.
- **`key_env` must look like a key variable.** It must end in `_API_KEY`, `_TOKEN` or `_KEY`
  (any case). For another name, set `BLIND_ALLOW_KEY_ENV=<name>` in your environment.
- **Non-loopback calls are always named.** Every model call to a host that is not loopback first
  prints the host and the key variable, even with `--quiet`.
- **`local-only` connects to the verified loopback address.** Behind a proxy, `NO_PROXY` must
  list that address as well as the host name (`NO_PROXY=localhost,127.0.0.1`). `local-only`
  refuses any call a proxy variable would carry.
- **Stricter spec checks.** An analyst reply with `class: secret, treatment: keep` is rejected;
  `seen` entries must be 16 lowercase hex characters (blind has always written them so; delete a
  hand-edited entry that fails and the next plan re-reads that excerpt); `blind plan` warns when
  the card or secret pattern is off but the profile finds such values.
- **More XLSX refusals.** A workbook is refused (listed, not written) when it has a worksheet with
  no cell plan (one `xl/workbook.xml` does not list) or two zip members with the same name.
