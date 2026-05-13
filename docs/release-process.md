# jarvOS Release Process

jarvOS releases are milestone-driven. Ship when the active release scope is verified, not on a fixed calendar.

## Version Policy

- `v0.1.0` is the first public preview.
- `v0.1.x` is for bug fixes, documentation corrections, and small install-flow fixes.
- `v0.2.0` is for meaningful new capabilities or workflow improvements.
- Before `v1.0.0`, minor releases may include breaking changes, but the release notes must call them out plainly.

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

7. Check for local-only or machine-specific files in the release diff.
8. Create the git tag only after the release checklist is green:

   ```bash
   git tag <version>
   git push origin <version>
   ```

   Example: `<version>` is `v0.1.0` for the first public preview.

9. Publish a GitHub Release using `docs/releases/<version>.md`.
10. Record the release URL and final verification evidence on the Paperclip release issue.

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
- `release-v0.1.0` or the current active release label

Internal release process work should carry:

- `jarvos`
- `jarvos-release-ops`
- `release-v0.1.0` or the current active release label

Candidate issues enter release review automatically. Jarvis promotes each candidate to included, release-blocking, post-release, or internal-only during release review.

If the active Paperclip instance does not expose labels on issue reads, Jarvis writes a `release-intake` document on the issue with the same classification. That document is the durable fallback marker.
