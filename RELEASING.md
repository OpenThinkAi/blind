# Releasing @openthink/blind

Releases come from GitHub Actions (`.github/workflows/release.yml`) using npm
OIDC Trusted Publishing: no `NPM_TOKEN` is stored anywhere, and every publish
carries a provenance attestation.

The GitHub repo is a mirror of the stamp origin. `main` only reaches GitHub
through `stamp push`, and the workflow runs from that mirror.

## One-time setup (before the first publish)

1. Publish the first version of `@openthink/blind` to npm by hand so the package exists (npm only lets you configure a Trusted Publisher on an existing package).
2. On npmjs.com open the package, then Settings, then Trusted Publishers, and add a GitHub Actions publisher:
   - Organization or user: `OpenThinkAi`
   - Repository: `blind`
   - Workflow filename: `release.yml`
   - Environment: leave empty
3. Optionally set the package's publishing access to "Require two-factor authentication and disallow tokens".

The workflow filename must match exactly; renaming `release.yml` breaks publishing until the publisher is updated.

## Before every release: docs sweep

Docs are verified against behaviour, in the same PR as the version bump. On a synthetic kit
(`bun src/bench/synth.ts /tmp/kit --kit 2`, never real data) run every command and example the
docs show, compare each `blind <command> --help` with `README.md`, `docs/` and `SECURITY.md`, and
fix the docs to match what the CLI does. If the code looks wrong, file an issue instead of
bending the docs. Then check what ships: `npm pack --dry-run` lists `bin/`, `src/`, `schema/`,
`LICENSE` and `README.md` (not `docs/`, so the README's `docs/` links work on GitHub, not on the
npm page).

## Cutting a release

1. Bump `version` in `package.json` on a branch (a prerelease such as `0.1.0-rc.1` publishes under the `rc` dist-tag; a plain version publishes under `latest`).
2. Land it through stamp: `stamp review`, `stamp merge <branch> --into main`, `stamp push main`.
3. In GitHub, open Actions, select the `release` workflow, and run it with "Run workflow" on the `main` branch. A dispatch from any other branch runs the checks but skips the publish job.
4. The `check` job runs `bun run typecheck` and `bun test --timeout 30000`. The `publish` job then skips if that version is already on npm, otherwise runs a pinned `npm publish --access public --provenance --tag <dist-tag>` (npm 11.5.1 or later is needed for OIDC; the workflow fetches one with `npx`). There is no build step: the package ships source and runs on Bun.

Tag pushes (`v*`) also trigger the workflow, but tags only reach GitHub if you uncomment `tags:` in `.stamp/mirror.yml`. The tag must equal `v<version>`.

## Verify

- `npm view @openthink/blind version dist-tags` shows the new version.
- The package page on npmjs.com shows the "Provenance" badge linking to the workflow run.
- `npm audit signatures` in a project that installs it reports verified attestations.
