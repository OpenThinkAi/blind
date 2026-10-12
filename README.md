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
```

Run the commands in the directory that holds `blind.toml`. `blind plan` asks the model set in
`blind.toml`, by default a server on your own machine; `blind plan --no-model` uses only the
built-in detectors and leaves everything else for you to decide. `blind run` stops for review the
first time (exit 3); once the spec is saved, the next run on the same kind of data needs no
attention. `blind <command> --help` lists every option and exit status.

## What a model sees

Your documents are never sent to a model. These are the only things that are:

- **The profile and your policy.** `blind plan` sends the profile of the corpus: file names,
  column headers, statistics, and a few short sample values. `blind profile` prints exactly that,
  so you can read it before anything is sent. The policy is the classes, description, examples and
  keep list from `blind.toml`.
- **The blinded output, for the model audit, and only on your machine.** Under `local-only`, the
  auditor model reads the already-blinded output (never the originals) in short lines. Under
  `profile-only` it gets only a profile of the output, like the analyst, which is a coarse check.

The privacy mode in `blind.toml` decides where a call may go. blind checks it before every call
and never falls back to a less private mode:

| Mode | Models | Sent |
|---|---|---|
| `local-only` (default) | Only a server on this machine (`127.0.0.1`, `::1`, `localhost`). `claude -p` and the hosted Anthropic API are refused. | The profile with up to 5 sample values per column (`[profile] samples`), and your policy. |
| `profile-only` | Any model over https, including `claude -p` and the Anthropic API. | Exactly the profile and the policy, with no sample values by default. No document outlines or speaker names. File, folder and sheet names go as opaque tokens such as `file_3` and `sheet_1`, and so does any header or JSON key that looks like a name or an identifier (`Avery`, `avery_q`, a spec entity, anything with a digit), one at a time (`col_2`, `["key_1"]`); blind maps the reply back locally. Ordinary headers and keys made of dictionary words or keep terms (`Status`, `user_id`), and the statistics, still go out. A lower-case name that is not yet a spec entity (`$.users.avery`) is not caught. |
| `none` | No model is called. The planner uses built-in detectors only and the audit has no model layer. | Nothing. |

Two limits hold in every mode. **Nothing over 120 characters is sent:** sample values are cut to
120 characters when the profile is built, and a call carrying any longer string is refused, not
shortened. And every call is announced on stderr (backend, model, mode, bytes) before it is sent.
How a reply is held to a schema, and what a model can and cannot change, is in
[SECURITY.md](SECURITY.md).

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
  pseudonym everywhere (`Person_A7F3`, `Org_2C9E`), IPs stay IPs and emails stay emails, formulas,
  joins and formatting survive. A column nobody classified that looks like identifiers is
  pseudonymised, not passed through.
- **Auditor** (independent of the engine): reads the output as it is on disk and reports leaks and
  candidates. Its rule-based layers never depend on a model.

## Formats

| Handled | Notes |
|---|---|
| CSV, TSV | Delimiter, quoting and line endings kept |
| JSON, JSONL | Edits spliced into the original text |
| XLSX | Cells, sheet and defined names, formulas, comments (including their legacy VML drawing, scrubbed only inside `<x:ClientData>`), metadata, pivot caches |
| DOCX | Text across runs, tables, headers, comments, tracked changes, metadata |
| Text, Markdown, logs | `.txt`, `.md`, `.log` |
| VTT, SRT transcripts | Also transcript-shaped text and DOCX files, found by content |

File and folder names are blinded too. Files in any other format (PDF, images, PPTX, email, HTML,
legacy `.doc` and `.xls`, ...) are listed and not written, and the command exits 1; blind does not
edit PDFs or read text out of images. A workbook or document that contains something blind cannot
read (an embedded file, a macro, an unknown part with text) is listed and not written.

## Reversal and the map

`blind apply` writes `.blind/map.json` (mode 0600): every pseudonym with the original it stands
for. With it, `blind reveal ./out` restores the originals into `.blind/revealed/`: file and folder
names, and the content of CSV, JSON, text, transcript, XLSX and DOCX files. The map, the salt (`.blind/salt`) and the revealed files all
contain or unlock the real values: keep them secret and never commit `.blind/`. Applying again
reuses the map, so earlier pseudonyms do not change. Machines that share a salt produce the same
pseudonyms for the same values.

## Documentation

- [docs/policy.md](docs/policy.md): every `blind.toml` key.
- [docs/spec.md](docs/spec.md): the spec and profile formats, and exactly what each command does.
- [docs/bench.md](docs/bench.md): synthetic kits and `blind bench`, which scores a run against an
  answer key.
- [SECURITY.md](SECURITY.md): what reaches a model, and how model output is contained.
- [RELEASING.md](RELEASING.md): how releases are cut.

## License

MIT
