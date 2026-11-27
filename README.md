# blind

Hand documents to someone who must not learn who they are about. blind replaces the people,
organisations, hosts, emails and IDs you choose with consistent pseudonyms, in CSV, JSON, Excel,
Word, text and transcripts, keeps the files usable, and tells you honestly what it could not
check. A model proposes what is sensitive, you review it, a deterministic engine applies it, and
an independent auditor checks the result. Local by default: no document leaves your machine, and a
remote model, if you choose one, sees only a summary of the corpus.

## Quick start

blind runs on [Bun](https://bun.sh) 1.1 or later.

```sh
blind init                  # blind.toml (your policy) and .blind/salt
blind plan ./in             # profile, analyst, spec: review .blind/spec.json
blind apply ./in -o ./out   # blind the files; writes .blind/map.json
blind audit ./out           # exit 0 clean, 1 candidates to review, 2 leak
blind run ./in -o ./out     # plan, apply and audit in one go
blind reveal ./out          # restore the originals into .blind/revealed/
blind forget "Avery Quill"  # remove one subject from .blind/ (map, spec, profile, revealed)
blind purge                 # remove the map, profile, run record and revealed files
```

Run the commands in the directory that holds `blind.toml`. Once its `[keep] terms` hold real
names, hosts or address ranges, `blind.toml` is sensitive too: keep it as private as
`.blind/spec.json`. `blind plan` asks the model set in
`blind.toml`, by default a server on your own machine; `blind plan --no-model` uses only the
built-in detectors and leaves everything else for you to decide. `blind run` stops for review the
first time (exit 3); once the spec is saved, the next run on the same kind of data needs no
attention. `blind run --accept-leaks` turns each leak the audit finds into a spec entity (a
secret or card number into a salted fingerprint, so it is redacted and the value is never stored)
and runs apply and audit again, so the loop closes without you or a model; candidates are still
yours to decide. `blind <command> --help` lists every option and exit status.

Columns you already know about can be decided in `blind.toml`, with no model at all: a
`[[columns]]` rule matches headers by glob (or a whole JSON key path with `path`, or a worksheet
with `sheet`) and keeps, scans, drops, blinds or redacts them; when rules overlap the most
specific wins, and `blind plan` notes each overlap (see [docs/policy.md](docs/policy.md#columns)). `scan` is the one for notes, remarks and diagnoses:
the cell is kept as written except for what the free-text scanner finds in it (phones, emails,
names, a plate, username, badge, gate code or hidden-key place after its keyword). `[defaults] columns = "scan"` gives every column no
rule decides that treatment too, instead of pseudonymising identifier-like ones whole. A column the
built-in detectors recognise by shape (emails, IDs, licence plates, usernames, phone numbers) is
still classified, and blinded when its class is sensitive (see [docs/spec.md](docs/spec.md#re-planning-with-a-saved-spec)).

## What a model sees

Your documents are never sent to a model. These are the only things that are:

- **The profile and your policy.** `blind plan` sends the profile of the corpus: file names,
  column headers, statistics, and a few short sample values (under `profile-only`: statistics
  only, with every name as a token). `blind profile` prints exactly that, so you can read it
  before anything is sent. The policy is the classes, description, examples and keep list from
  `blind.toml` (under `profile-only` the keep list stays on your machine: blind applies it to the
  reply itself).
- **The blinded output, for the model audit, and only on your machine.** Under `local-only`, the
  auditor model reads the already-blinded output (never the originals) in short lines. Under
  `profile-only` it gets only a profile of the output, like the analyst, which is a coarse check.

The privacy mode in `blind.toml` decides where a call may go. blind checks it before every call
and never falls back to a less private mode:

| Mode | Models | Sent |
|---|---|---|
| `local-only` (default) | Only a server on this machine (`127.0.0.1`, `::1`, `localhost`). `claude -p` and the hosted Anthropic API are refused, and so is a call while a proxy variable (`HTTP_PROXY` and the like) is set unless `NO_PROXY` (and `no_proxy`, if set) names that host. | The profile with up to 5 sample values per column (`[profile] samples`), and your policy. |
| `profile-only` | Any model over https, including `claude -p` and the Anthropic API. | The model never sees a value. Exactly the profile's statistics and the policy: no sample values (`[profile] samples` above 0 is refused), no document outlines, sentences or speaker names, and no keep terms (blind applies them locally). Every file, folder and sheet name, every column header and every JSON key goes as an opaque token (`file_3`, `sheet_1`, `col_2`, `["key_1"]`); blind maps the reply back locally. A call carrying anything else is refused before it is sent. |
| `none` | No model is called. The planner uses built-in detectors only and the audit has no model layer. | Nothing. |

Two limits hold in every mode. **Nothing over 120 characters is sent:** sample values are cut to
120 characters when the profile is built, and a call carrying any longer string is refused, not
shortened. And every call is announced on stderr (backend, model, mode, bytes) before it is sent; a call
to a host that is not loopback also names the host and the API key variable, even with `--quiet`.
How a reply is held to a schema, and what a model can and cannot change, is in
[SECURITY.md](SECURITY.md).

**When a model must help, use `profile-only`.** It is the recommended setup for a hosted model:
the analyst writes column rules from statistics (how many distinct values, how many digits, how
many dictionary words, which shapes match) and your policy, and never sees a value, a header or a
file name. Put what you already know in `blind.toml` as [`[[columns]]` rules](docs/policy.md#columns)
("keep species, weight and visit date"): they decide those columns locally, ahead of the model,
and the analyst's rules fill in the rest. Review the spec as usual. The model audit has little to
go on in this mode (it too sees no value), so the rule-based audit layers do the work.

**What the audit cannot promise.** `clean` means only that blind's checks found nothing they look
for: every value in your spec and the map, the shapes of emails, hosts, IPs, GUIDs and IDs, and
names or phrases it cannot explain. It does not mean nothing identifying remains. Text a column
rule keeps, context around kept values, images, and anything blind could not read is outside
those checks, and an audit that could not read a file says so and is never `clean`. The model
layer can only add candidates. Treat `clean` as "nothing found", and review the candidates.

## How it works

```
documents --profile--> corpus profile --analyst (model)--> spec <-- you review and edit
                                                             |
documents ------------ engine (deterministic) ---------------+--> blinded documents + map
                                                                          |
                                                      auditor (rules + model) --> report
```

- **Profiler** (no model): summarises each file, column and key: statistics and a few short
  samples. This is the only thing the analyst sees.
- **Analyst** (model, optional): reads the profile and your policy and proposes a *spec*: what each
  column or key is, the names to find in free text, and questions it cannot decide.
- **You**: read the spec (`blind plan` prints it, questions first), edit it, answer questions.
  Nothing is applied without a saved spec, and a later plan only sends what the spec does not
  already cover.
- **Engine** (no model): applies the spec byte for byte. The same value gets the same
  pseudonym everywhere (`[Person A #BCF6]`, `[Org C #24D2]`; `Person_BCF6` and `Org_24D2` in the
  compact style; `Person KQZTB` and `Org MRDHX`, with no digits, in the letters style; set with
  `[pseudonyms] style` in `blind.toml`), and so does one person however the name is
  written (`Quill, Avery`, `Avery+Quill`, `Dr. A. Quill` when nothing else fits), while a pet and
  an owner who share a name stay apart. A cell naming several people (`Nora Teasdale; Owen
  Brandvik`) gets one stand-in per person, separators kept, and a first-name / last-name column pair
  (proposed by `blind plan` as `joinWith`) splits the person's full-name stand-in across its two
  cells, so a staff list still joins to payroll ([docs/spec.md](docs/spec.md#first-and-last-name-columns)).
  IPs stay IPs and emails stay emails, formulas,
  joins and formatting survive. A column nobody classified that looks like identifiers is
  pseudonymised, not passed through; dates, amounts, quantities with units and small repeating
  categories (species, status) are not identifiers, and pass. People named only in prose are
  found without a model (an honorific, or a common given name and a surname) and blinded too; pet
  names, places, breeds, keep-list terms and names in kept columns are left alone. A value held in
  a `keep` column, and textbook placeholders (`John Doe`, `123 Main St`, `user@example.com`), are
  kept wherever else they appear ([docs/policy.md](docs/policy.md#kept-columns-shield-their-values-everywhere);
  [docs/spec.md](docs/spec.md#how-blind-apply-uses-the-spec)).
- **Auditor** (independent of the engine): reads the output as it is on disk and reports leaks and
  candidates. Its rule-based layers never depend on a model.

## Formats

| Handled | Notes |
|---|---|
| CSV, TSV | Delimiter, quoting and line endings kept; a file with an unclosed quote is refused, never truncated; a row with a stray delimiter (wider or narrower than the header, no quoted line break) is accepted, its extra cells scanned as free text of the last column and its original cells and delimiters kept |
| JSON, JSONL | Edits spliced into the original text |
| XLSX | Cells, sheet and defined names, formulas, comments (including their legacy VML drawing, scrubbed only inside `<x:ClientData>`), metadata, pivot caches; document dates and zip timestamps written as constants |
| DOCX | Text across runs, tables, headers, comments, tracked changes, metadata; document dates and zip timestamps written as constants ([`[metadata]`](docs/policy.md#metadata)) |
| Text, Markdown, logs | `.txt`, `.md`, `.log`; UTF-8 (with or without BOM) or UTF-16 with BOM. 8-bit text that is not UTF-8 is refused, not written: save it as UTF-8 and run again |
| VTT, SRT transcripts | Also transcript-shaped text and DOCX files, found by content (a prose DOCX is profiled as a document) |

File and folder names are blinded too. Files in any other format (PDF, images, PPTX, email, HTML,
legacy `.doc` and `.xls`, ...) are listed and not written, and the command exits 1; blind does not
edit PDFs or read text out of images. A workbook or document that contains something blind cannot
read (an embedded file, a macro, a custom XML data part with values) is listed and not written.

## Reversal and the map

`blind apply` writes `.blind/map.json` (mode 0600): every pseudonym with the original it stands
for. With it, `blind reveal ./out` restores the originals into `.blind/revealed/`: file and folder
names, and the content of CSV, JSON, text, transcript, XLSX and DOCX files (not a DOCX's or XLSX's
own dates, which are written as constants unless `[metadata] keep_dates = true`). Both forms of a readable
pseudonym (`[Org A #5CF4]` and its name-safe `Org_A_5CF4`) are restored, and so are both forms of a
letters one (`Org MRDHX` and `Org_MRDHX`). The map, the salt (`.blind/salt`) and the revealed files all
contain or unlock the real values: keep them secret and never commit `.blind/`. Applying again
reuses the map, so earlier pseudonyms do not change. Machines that share a salt produce the same
pseudonyms for the same values. Every file under `.blind/` that holds values, and how to delete it,
is listed in [SECURITY.md](SECURITY.md#what-stays-on-disk).

`blind forget <value...>` removes one data subject: their map entries, the spec entity (with its
aliases and the name parts no one else shares), the profile samples that mention them, and the
whole `.blind/revealed/` tree (reveal again and they stay pseudonymised). `blind purge` removes the
map, profile, run record and revealed files, after which nothing blinded so far can be revealed;
the salt and the spec are kept. Both list what they would remove and need `--yes` (or `yes` typed
at a terminal). Neither changes blinded output already shared. Details in
[docs/spec.md](docs/spec.md#how-blind-forget-and-blind-purge-remove-what-blind-keeps).

## Use as a library

The same engine is importable, for code that holds files in memory (a web app, a server, another
tool). Same stand-ins, same map and the same reveal as the CLI: for the same salt, spec, policy and
input, `applySpec` writes the bytes and the map `blind apply` writes. The package exports two entry
points, both plain ES modules with TypeScript types: `@openthink/blind` (Node 20 or later, Bun, or a
bundler) and `@openthink/blind/browser` (for a browser). Neither reads or writes a file, calls a
model or touches the network.

```sh
npm install @openthink/blind
```

Profile, propose, blind, audit and reveal, from code. Every file is a `"/"`-separated path and its
bytes. The policy is a plain object with the tables and keys of `blind.toml`
([docs/policy.md](docs/policy.md); camelCase where the key has an underscore, `keepDates`):

```js
import { applySpec, auditOutputs, explainProposal, newSalt, parseMap, profileInputs, revealFile, Revealer, revealText, serializeMap } from "@openthink/blind";

const csv = "name,email,team,hours\nAvery Quill,avery.quill@example.com,North,32\nRowan Pike,rowan.pike@example.com,South,40\n";
const inputs = [{ path: "staff.csv", bytes: new TextEncoder().encode(csv) }];
const policy = {
  sensitive: { classes: ["person", "email"] },
  columns: [
    { header: "name", treatment: "blind", class: "person" },
    { header: ["team", "hours"], treatment: "keep" },
  ],
};

// Profile and propose: the built-in detectors and your policy, no model. Show the proposal to a person.
const { profile } = profileInputs(inputs, { policy });
const proposal = explainProposal(profile, policy);
for (const c of proposal.columns) console.log(`${c.header}: ${c.treatment} (${c.source}) ${c.reason}`);

// Blind, with the spec the person approved.
const salt = newSalt();
const { outputs, map, skipped } = applySpec(inputs, proposal.spec, { salt, policy });
console.log(skipped.length, "skipped");

// Audit the output: the rule-based checks `blind audit --no-model` runs.
const report = auditOutputs(outputs, proposal.spec, map, { policy, salt });
console.log("audit:", report.status);

// Keep the map (and the salt) somewhere only the owner can read. Reveal later with the map alone.
const saved = serializeMap(map);
const revealer = new Revealer(parseMap(saved));
const back = revealFile(outputs[0].path, outputs[0].bytes, revealer);
console.log(new TextDecoder().decode(back.bytes) === csv);

// Text that quotes the stand-ins (a report written from the blinded file, say) is revealed the same way.
const name = new TextDecoder().decode(outputs[0].bytes).split("\n")[1].split(",")[0];
console.log(revealText(`${name} works the most hours.`, parseMap(saved)));
```

It prints:

```text
name: blind (policy) decided by blind.toml columns[0] (header "name", blind/person)
email: blind (heuristic) email blind, detector: email, 100%
team: keep (policy) decided by blind.toml columns[1] (header "team", keep/vocabulary)
hours: keep (policy) decided by blind.toml columns[1] (header "hours", keep/vocabulary)
0 skipped
audit: clean
true
Avery Quill works the most hours.
```

The CLI applies nothing until a person has seen the spec; from code, that review is yours to
build. Nothing stops `proposal.spec` going straight to `applySpec`, so show `proposal.columns` (each
with its reason) to the owner first. `proposeSpec(profile, policy)` returns the spec alone. `parseSpec(text)` reads a spec saved as JSON
(the format of `.blind/spec.json`) and checks it; pass a spec through it, or `validateSpec`, before
`applySpec`, which does not check one.

**The map and the salt are yours to keep, and both are secret.** The map pairs every stand-in with
the original value: anyone holding it can reveal everything. The salt holds no value, but with a
guessed value it confirms a match, and the same salt gives the same stand-ins. blind does not store
either: keep them where only the owner can read them, never beside the blinded files. Pass an earlier
map back as `applySpec(..., { salt, map })` and its stand-ins are reused, as `blind apply` reuses
`.blind/map.json`.

**`clean` means "nothing found by the rules", not "safe".** `auditOutputs` runs the rule-based layers
of `blind audit` (no model): every value in the spec and the map, and the shapes of emails, hosts,
IDs and names it cannot explain. Values in its report are masked. See [What the audit cannot
promise](#what-a-model-sees) above.

Stand-ins come in three styles, set with `pseudonyms.style` in the policy: `compact` (the default),
`readable` and `letters` (no digits). The salt below is fixed only so the output is repeatable; use
`newSalt()` for real work:

```js
import { applySpec } from "@openthink/blind";

const inputs = [{ path: "people.csv", bytes: new TextEncoder().encode("name\nAvery Quill\n") }];
const spec = {
  version: 1,
  columns: [{ file: "people.csv", header: "name", class: "person", treatment: "blind", confidence: 1, source: "human" }],
  entities: {},
  patterns: { ip: true, email: true, host: true, guid: true, mac: false },
  questions: [],
};
const salt = new Uint8Array(32).fill(7);
for (const style of ["compact", "readable", "letters"]) {
  const { outputs } = applySpec(inputs, spec, { salt, policy: { pseudonyms: { style } } });
  console.log(style, new TextDecoder().decode(outputs[0].bytes).split("\n")[1]);
}
```

It prints:

```text
compact Person_7C5E
readable [Person A #7C5E]
letters Person GSXGP
```

**In a browser**, import `@openthink/blind/browser`. It is the same library, and it uses only what a
browser has (`TextEncoder`, `crypto.getRandomValues`, `Uint8Array`): no `node:` module, `Buffer` or
`process`. It carries no compression code, so it does not handle Excel or Word files: `applySpec`
skips a `.xlsx` or `.docx` with the reason below, `revealFile` refuses one, and the audit reports
one as unread, never `clean`. CSV, TSV, JSON, JSONL and text work.

```js
import { applySpec, NO_ZIP_CODEC_REASON } from "@openthink/blind/browser";

const spec = { version: 1, columns: [], entities: {}, patterns: { ip: true, email: true, host: true, guid: true, mac: false }, questions: [] };
const inputs = [
  { path: "notes.txt", bytes: new TextEncoder().encode("Ask ops at 192.0.2.10.\n") },
  { path: "rota.xlsx", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) },
];
const { outputs, skipped } = applySpec(inputs, spec, { salt: crypto.getRandomValues(new Uint8Array(32)) });
for (const o of outputs) console.log("written:", o.path);
for (const s of skipped) console.log("skipped:", s.path, "-", s.reason);
console.log(skipped[0].reason === NO_ZIP_CODEC_REASON);
```

It prints:

```text
written: notes.txt
skipped: rota.xlsx - Office files are not supported in this build
true
```

**Excel and Word from Node.** `@openthink/blind` installs no compression code either. To handle
Office files, give it Node's zlib once, with the settings the CLI uses (level 6), so the bytes match
the CLI's:

```js
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { setZipCodec, zipCodec } from "@openthink/blind";

setZipCodec({
  inflateRaw: (data, maxOutputLength) => inflateRawSync(data, { maxOutputLength }),
  deflateRaw: (data) => deflateRawSync(data, { level: 6 }),
});
console.log(zipCodec() !== null);
```

It prints:

```text
true
```

`inflateRaw` must throw once its output would pass `maxOutputLength` (the size blind expects for
that archive member) rather than return a truncated result: that limit is what stops a zip bomb.
The codec is one value for the whole process (or page), so install it once at start-up.

Every example in this section is run by `test/pack.test.ts` against the packed package, under Node.

## Documentation

- [docs/policy.md](docs/policy.md): every `blind.toml` key.
- [docs/spec.md](docs/spec.md): the spec and profile formats, and exactly what each command does.
- [docs/bench.md](docs/bench.md): synthetic kits and `blind bench`, which scores a run against an
  answer key.
- [SECURITY.md](SECURITY.md): what reaches a model, and how model output is contained.
- [CHANGELOG.md](CHANGELOG.md): what changed in each release, and what you must do.
- [RELEASING.md](RELEASING.md): how releases are cut.

## License

MIT
