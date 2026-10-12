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
```

`[sensitive]`, `[keep]`, `[models.analyst]`, `[profile]` and `[privacy]` must be present.
`[models.auditor]` and `profile.samples` are optional.

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
turn off a rule you wrote in the spec.

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
- **Audit.** The audit does not report a keep term, a Title-Case phrase made of keep terms, or a
  host under a kept domain, and the model auditor is told to leave them.
- **Models.** The analyst and auditor are sent the list so they do not propose or report them.

A keep term does **not** override your spec: a value or entity the spec blinds is blinded even when
it also appears in the keep list. To keep it, take it out of the spec (or classify it as
`vocabulary`).

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
| `samples` | whole number, 0 or more | no | Sample values the profile carries for each column, key, document and transcript. `0` means headers and statistics only. |

Unset, `samples` follows the privacy mode: **5** under `local-only` and `none`, **0** under
`profile-only`, where the profile goes to a remote model. Setting it overrides the mode. `--samples
N` on `blind profile` overrides the file for one run. Each sample is cut to 120 characters, ending
in `…`. Samples are the only document text a profile carries (apart from the outlines and speaker
names that `local-only` also sends, and which `profile-only` leaves out).

## `[privacy]`

| Key | Type | Required | Meaning |
|---|---|---|---|
| `mode` | `"local-only"`, `"profile-only"` or `"none"` | yes | How far a model call may reach. |

| Mode | Models | What is sent |
|---|---|---|
| `local-only` | Only a loopback server: `127.0.0.1` (the whole `127.0.0.0/8`), `::1` or `localhost`. `claude-cli`, the hosted Anthropic API and any other host are refused. | Analyst: the profile and the policy. Auditor: the blinded output's text in lines of at most 120 characters, in chunks of at most 8 kB, and the policy. |
| `profile-only` | Remote servers over https, and `claude-cli`. A loopback server may use http. | Exactly the profile and the policy, nothing else; anything else is refused. No document outlines, no speaker names; file, folder and sheet names and some keys and headers as opaque tokens. Auditor: the profile of the output tree. |
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

## Choosing a setup

| You want | Set |
|---|---|
| Nothing leaves this machine, with a local model | `mode = "local-only"`, both models `openai-compatible` at a loopback `url` |
| Nothing leaves this machine, no model at all | `mode = "none"` (or `blind plan --no-model` and `blind audit --no-model` per run) |
| A hosted analyst that sees only the profile | `mode = "profile-only"`, analyst `backend = "anthropic"`, `model = "<id>"`, `key_env = "ANTHROPIC_API_KEY"` (example below) |

`privacy.mode` is one setting for the whole file: the analyst and the auditor both obey it. Under
`profile-only` the auditor, which reuses the analyst when `[models.auditor]` is absent, is sent
only the profile of the output, a coarse check: parts of the output that a profile does not
describe (such as a DOCX that is not a transcript) are listed as not sent. To have a local model
read the output text instead, audit from a `blind.toml` whose mode is `local-only` and whose
`[models.auditor]` is a loopback server; the analyst table is not used by `blind audit`. Or audit
without a model (`blind audit --no-model`), which still runs the rule-based layers.

For example, a hosted analyst that only ever sees the profile:

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
```

## `blind init`

`blind init [dir]` writes `blind.toml` and `.blind/salt` (32 random bytes, mode 0600) in `dir`
(default `.`).

- On a terminal it asks for the main settings (mode, the two models, samples, classes, keep terms);
  Enter takes the default. `--defaults`, or input that is not a terminal, writes the defaults.
- An existing `blind.toml` is kept. An existing salt makes `init` refuse (exit 1): a new salt gives
  every value a different pseudonym, so it breaks the match with earlier runs and with the map.
  `--force` replaces both files, and the old pseudonyms no longer match.
- `[sensitive] description` and `examples` get the defaults above; edit them to say what matters
  for your documents.
- The salt is a secret. Never commit `.blind/`.
