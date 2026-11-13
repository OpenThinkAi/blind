# Changelog

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
