# jarvOS Release Management

This repo uses Paperclip as the release ledger and GitHub as the publication
surface. Release work should be easy to audit from a clean checkout plus the
active Paperclip release issue.

## Active Release

- Version: `v0.1.0`
- Release type: public preview
- Paperclip release lane: `SUP-1648`
- GitHub labels: `jarvos`, `jarvos-release`, `release-v0.1.0`

## Release Stewardship Rules

1. Keep process coordination in the Paperclip release lane.
2. Keep code and docs changes in their own issues and pull requests.
3. Treat release candidates as candidates until a steward classifies them.
4. Require a passing smoke test before publishing a release.
5. Require explicit final approval before creating the GitHub Release.

## Candidate Intake

New work enters release review when it has one of these signals:

- It changes the public `levineam/jarvOS` repository.
- It changes setup, bootstrap, runtime adapter, smoke-test, or distribution docs.
- It is labeled `jarvos-release-candidate`.
- It is explicitly nominated in the active Paperclip release lane.

Candidate classification:

| Classification | Meaning | Release notes impact |
|---|---|---|
| `release-blocker` | Must land before the release can publish | Usually yes |
| `included` | Landed and belongs in this release | Yes if user-visible |
| `post-release` | Valid, but not required for this release | No |
| `internal-only` | Process or governance work only | No |
| `not-release-related` | Does not belong to this release lane | No |

## Readiness Checklist

Before tagging `v0.1.0`, verify:

- `package.json` reports `0.1.0`.
- `CHANGELOG.md` has a `v0.1.0` section.
- `docs/releases/v0.1.0-public-preview.md` is current.
- `bash scripts/smoke-test.sh` passes from a clean checkout.
- `npm test` passes when Node is available.
- No local-only files, private paths, secrets, or user data are included.
- GitHub labels exist for `jarvos`, `jarvos-release`, and `release-v0.1.0`.
- Paperclip release candidates are classified with blockers called out.
- Andrew has explicitly approved publication.

## Publication Steps

1. Confirm the readiness checklist in Paperclip with links to CI and local test
   evidence.
2. Confirm the release notes body from
   `docs/releases/v0.1.0-public-preview.md`.
3. Tag the approved commit as `v0.1.0`.
4. Create the GitHub Release using the release notes.
5. Move the Paperclip release lane to `done` only after the release exists.
