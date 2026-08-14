# jarvOS Release Process

jarvOS releases are milestone-driven. Ship when the active release scope is verified, not on a fixed calendar.

## Version Policy

- `v0.1.0` is the first public preview.
- `v0.1.x` is for bug fixes, documentation corrections, and small install-flow fixes.
- `v0.2.0` is for meaningful new capabilities or workflow improvements.
- `v0.6.x` was the secondbrain hardening lane: the v0.6.0 focused release,
  v0.6.1 capitalization patch, v0.6.2 AI coding-tool capture determinism
  patch, and v0.6.3 GBrain-first provider/reconciled-public-surface patch.
- `v0.7.0` is the latest shipped public release (SUP-3497): an authenticated
  control-plane application service, a protected-resource mutation policy
  layer, public human/agent parity for that service, and a portable
  `@jarvos/coding` control-plane compatibility layer for supported agent
  hosts.
- `v1.0.0` is the active target lane (SUP-3548): clean-machine confidence.
  Draft notes live at `docs/releases/v1.0.0.md`; post-v0.7.0 merged work is
  tracked under `CHANGELOG.md` `[Unreleased]` until Andrew approves a cut.
- Future release lanes should name their selected release plan and target
  version before release readiness is claimed. Beads carries the durable work;
  Paperclip may mirror it as an optional record.
- Before `v1.0.0` is published, minor releases may include breaking changes, but the release notes must call them out plainly.

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

## Source-Bound Release Status

To inspect a release without relying on an old message or a task-board status,
run the on-demand observer against an explicit upstream source revision:

```bash
npm run release:status -- --version v1.0.0 --source-ref origin/main --verify
```

The observer resolves the ref to an immutable commit, reads GitHub's published
release facts, and combines the current drift and readiness checks into one
machine-readable result. `READY`, `NOT READY`, and `PARTIAL` are successful
observations with current evidence; `UNAVAILABLE` means the source, GitHub, or
verification boundary could not be trusted. Use `--json` for an agent-facing
payload. `--reduced-cost` is available for an explicit bounded check, but it
reports partial coverage and cannot claim full readiness verification. Verified
mode confirms the source SHA against GitHub, creates a disposable detached
checkout, refreshes dependencies from `package-lock.json` with
`npm ci --ignore-scripts`, and runs the full check there. The caller's working
tree is never used for verified dependency execution.

This command only observes. It does not choose release scope, create tags,
approve publication, publish a GitHub Release, or treat Paperclip as a source
of truth. Beads remains the executable repair ledger; Projects and the Active
Assistant consume the private reconciler's admitted context rather than this
human/Telegram rendering.

## Release Checklist

1. Confirm the selected release plan lists the intended scope and blockers.
2. Confirm every included Beads work item has evidence for the user-facing
   change, verification performed, and documentation impact.
3. Confirm `package.json` version matches the intended tag.
4. Update `CHANGELOG.md` with the version, date, user-facing changes, fixes, and known limitations.
5. Prepare the GitHub Release notes at `docs/releases/<version>.md` using `.github/release-template.md`.
6. Confirm front-door release prose is current when it changed: `README.md`
   current release status, `docs/release-process.md` active lane wording,
   install/update instructions, module inventory, core capabilities,
   limitations, and the public/private boundary.
7. Run the release readiness check:

   ```bash
   npm run release:check
   ```

   During release preparation, before the changelog date is final and before the working tree is clean, use:

   ```bash
   npm run release:check:candidate
   ```

8. Run `npm run release:drift` to confirm there is no release drift (untagged release or unlogged work).
9. Check for local-only or machine-specific files in the release diff.
10. Create the git tag only after the release checklist is green:

   ```bash
   git tag <version>
   git push origin <version>
   ```

   Example: `<version>` is `v0.1.0` for the first public preview.

11. Publish a GitHub Release using `docs/releases/<version>.md`.
12. Record the release URL, final verification evidence, and documentation
    impact in the release evidence and its Beads work item. An enabled
    Paperclip adapter may mirror that record afterward.

## Release Gates

A release is not ready while any of these are true:

- The smoke test fails.
- `package.json` and the git tag disagree.
- `CHANGELOG.md` has no section for the release.
- `docs/releases/<version>.md` is missing or still contains placeholders.
- README or release-process prose still describes a prior current release or the target release as an active candidate after finalization.
- Install or update instructions do not match the shipped files.
- Any release-blocking Beads work item lacks documentation-impact evidence or
  a follow-up item for deferred documentation work.
- Any release-blocking Beads work item lacks verification evidence.
- Andrew has not approved public publication.

## Documentation Impact Closeout

Every public jarvOS PR or release issue should record one documentation impact
classification before closeout:

- `none`
- `changelog`
- `release-notes`
- `README`
- `module-docs`
- `architecture-docs`
- `operator-docs`
- `follow-up`

Use `README` only when a front-door claim changes: current version,
install/update path, first-run story, module inventory, core capabilities,
limitations, or the public/private boundary.

`follow-up` must name the Beads work item or blocker carrying the deferred
documentation work. An optional Paperclip record may also be named. `none`
must include a short rationale.

Closeout evidence should use this shape:

```text
Documentation impact: README, release-notes
Evidence: README release-status section updated; docs/releases/vX.Y.Z.md updated.
Follow-up: none.
```

## Optional Paperclip Projection

Git and the selected release plan define the candidate; Beads carries durable
execution state. Paperclip is an optional, one-way human-facing record. It
cannot admit work, choose release scope, block execution, or authorize public
publication. If enabled, mirrored issues related to the public
`levineam/jarvOS` repo should carry:

- `jarvos`
- `jarvos-release-candidate`
- the current active release label, such as `release-v1.0.0`

Internal release process work should carry:

- `jarvos`
- `jarvos-release-ops`
- the current active release label, such as `release-v1.0.0`

Only an already-authoritative candidate may be mirrored. The Paperclip record
reflects its included, release-blocking, post-release, or internal-only status;
editing that record does not change the candidate.

If the optional Paperclip instance is unavailable or cannot expose labels, the
authoritative Git, release-plan, and Beads records continue unchanged. No
Paperclip fallback is required for the supported path.

As of the v0.6.1 ship, v0.3-era release parents are historical and should not
receive new records. A new jarvOS public-release candidate uses the selected
release plan and its Beads work item. If Paperclip projection is enabled, it may
mirror the current release label and parent, but a missing parent does not
block candidate preparation or readiness checks.
