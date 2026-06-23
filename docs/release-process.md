# jarvOS Release Process

jarvOS releases are milestone-driven. Ship when the active release scope is verified, not on a fixed calendar.

## Version Policy

- `v0.1.0` is the first public preview.
- `v0.1.x` is for bug fixes, documentation corrections, and small install-flow fixes.
- `v0.2.0` is for meaningful new capabilities or workflow improvements.
- `v0.6.x` is the current secondbrain hardening lane after the v0.6.0 focused
  release and v0.6.1 capitalization patch.
- `v0.6.2` is the current patch-candidate lane for AI coding-tool capture
  determinism unless a newer Paperclip release parent supersedes it.
- Before `v1.0.0`, minor releases may include breaking changes, but the release notes must call them out plainly.

## Unreleased Work and Drift

Between releases, record merged user-facing changes under the `## [Unreleased]`
section at the top of `CHANGELOG.md`. This keeps "merged on `main`" distinct from
"shipped in a tagged release" and prevents release-state confusion (for example,
assuming a version is published when only the version number moved).

Cutting a release means moving the `## [Unreleased]` entries into a dated
`## v<version>` section and leaving a fresh empty `## [Unreleased]` behind.

Run the drift check at any time:

```bash
npm run release:drift
```

It fails when `package.json` is ahead of the latest git tag without a finalized
changelog section (an untagged release), or when commits exist since the latest
tag with nothing tracked under `## [Unreleased]` (unlogged work). It reports a
healthy "ready to tag" state and is advisory — intentionally not part of
`release:check`'s blocking gates.

## Release Checklist

1. Confirm the active release issue in Paperclip lists the intended scope and blockers.
2. Confirm every included issue has evidence for the user-facing change, verification performed, and release-note impact.
3. Confirm `package.json` version matches the intended tag.
4. Update `CHANGELOG.md` with the version, date, user-facing changes, fixes, and known limitations.
5. Prepare the GitHub Release notes at `docs/releases/<version>.md` using `.github/release-template.md`.
6. Run the release readiness check:

   ```bash
   npm run release:check
   ```

   During release preparation, before the changelog date is final and before the working tree is clean, use:

   ```bash
   npm run release:check:candidate
   ```

7. Run `npm run release:drift` to confirm there is no release drift (untagged release or unlogged work).
8. Check for local-only or machine-specific files in the release diff.
9. Create the git tag only after the release checklist is green:

   ```bash
   git tag <version>
   git push origin <version>
   ```

   Example: `<version>` is `v0.1.0` for the first public preview.

10. Publish a GitHub Release using `docs/releases/<version>.md`.
11. Record the release URL and final verification evidence on the Paperclip release issue.

## Release Gates

A release is not ready while any of these are true:

- The smoke test fails.
- `package.json` and the git tag disagree.
- `CHANGELOG.md` has no section for the release.
- `docs/releases/<version>.md` is missing or still contains placeholders.
- Install or update instructions do not match the shipped files.
- Any release-blocking Paperclip issue lacks verification evidence.
- Andrew has not approved public publication.

## Paperclip Intake

Paperclip is the release source of truth. Issues related to the public `levineam/jarvOS` repo should carry:

- `jarvos`
- `jarvos-release-candidate`
- the current active release label, such as `release-v0.6.2`

Internal release process work should carry:

- `jarvos`
- `jarvos-release-ops`
- the current active release label, such as `release-v0.6.2`

Candidate issues enter release review automatically. Jarvis promotes each candidate to included, release-blocking, post-release, or internal-only during release review.

If the active Paperclip instance does not expose labels on issue reads, Jarvis writes a `release-intake` document on the issue with the same classification. That document is the durable fallback marker.

As of the v0.6.1 ship, v0.3-era release parents are historical and should not
receive new candidates. New jarvOS public-release candidates should use the
current active release label and the live Paperclip release parent for that
lane. If no parent exists yet, create one before claiming release readiness.
