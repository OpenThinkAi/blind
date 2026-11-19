# Changelog

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
