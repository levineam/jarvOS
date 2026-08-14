# jarvOS Release Process

jarvOS releases are prepared from the public `main` history. The Steward
admits safe changes to the forming batch; Release Please derives the next
version and prepares the release proposal; publication remains an explicit
release-level decision.

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
- Post-v0.7.0 work belongs to one versionless forming batch. The batch has no
  target version or Paperclip parent; Beads carries the durable membership and
  Paperclip, when enabled, is only a one-way projection.
- Release Please is the sole version authority. It derives the next SemVer
  from the immutable last release and conventional commits on `main` (the
  current unreleased range is expected to produce `v0.8.0`). No routine
  `Release-As` footer or manually selected target is valid.

## Unreleased Work and Drift

Between releases, record merged user-facing changes under the `## [Unreleased]`
section at the top of `CHANGELOG.md`. This keeps "merged on `main`" distinct from
"shipped in a tagged release" and prevents release-state confusion (for example,
assuming a version is published when only the version number moved).

Release Please owns version files, changelog sections, tags, and GitHub Release
creation. The Steward reconciles its exact proposal, public commit range,
notes, and workflow provenance before asking for publication approval.

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

1. Confirm the forming batch and every included Beads work item have evidence
   for the user-facing
   change, verification performed, and documentation impact.
2. Confirm the Release Please workflow, manifest, configuration digest, and
   trusted App actor are unchanged and pinned.
3. Reconcile the exact Release Please proposal version, base/head, complete
   post-tag range, notes, and membership before approval.
4. Confirm `package.json`, `CHANGELOG.md`, and the GitHub Release are produced
   by that exact proposal; do not edit them to force a version.
5. Confirm front-door release prose is current when it changed: `README.md`
   current release status, `docs/release-process.md` active lane wording,
   install/update instructions, module inventory, core capabilities,
   limitations, and the public/private boundary.
6. Run the release readiness check:

   ```bash
   npm run release:check
   ```

   During release preparation, before the changelog date is final and before the working tree is clean, use:

   ```bash
   npm run release:check:candidate
   ```

7. Run `npm run release:drift` to confirm there is no release drift.
8. Record the release URL, final verification evidence, and documentation
    impact in the release evidence and its Beads work item. An enabled
    Paperclip adapter may mirror that record afterward.

## Release Gates

A release is not ready while any of these are true:

- The smoke test fails.
- `package.json` and the git tag disagree.
- `CHANGELOG.md` has no section for the release.
- `docs/releases/<version>.md` is missing or still contains placeholders.
- README or release-process prose still describes a prior current release or a
  guessed target instead of the observed published release/proposal.
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
- the current forming-batch projection, if one is configured

Internal release process work should carry:

- `jarvos`
- `jarvos-release-ops`

Only an already-authoritative candidate may be mirrored. The Paperclip record
reflects its included, release-blocking, post-release, or internal-only status;
editing that record does not change the candidate.

If the optional Paperclip instance is unavailable or cannot expose labels, the
authoritative Git, release-plan, and Beads records continue unchanged. No
Paperclip fallback is required for the supported path.

As of the v0.6.1 ship, v0.3-era release parents are historical and should not
receive new records. A new jarvOS public-release candidate uses the selected
forming batch and its Beads work item. If Paperclip projection is enabled, it
may mirror that status, but a missing parent or label never blocks candidate
preparation or readiness checks.
