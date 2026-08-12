# @jarvos/workspace-manager

Portable, fail-closed Workspace Manager contracts for jarvOS.

The package accepts only opaque public identities and versioned lifecycle and release-clearance evidence. It contains no Git adapter, filesystem path, tracker authority, credential, scheduler, or private host integration.

Lifecycle evidence must be produced by a lifecycle authority and bind a source version, subject identity, digest, observation time, freshness boundary, and outcome. Missing, stale, malformed, or mismatched evidence cannot authorize cleanup.

Release clearance is an injected port with the same opaque subject identity. Its bounded outcomes are `satisfied`, `not-required`, `pending`, `blocked`, `uncertain`, and `incompatible`; only fresh `satisfied` or `not-required` bindings can join a cleanup candidate. Clearance bindings carry their immutable receipt digest, generation, and current-pointer identifier so approval and recovery can revalidate the exact release state without importing Beads, Paperclip, or a private provider.

Capability states are `disabled`, `observe-only`, `archive-enabled`, and `cleanup-enabled`. Archive is metadata-only; `workspace.worktree-remove` is a distinct physical mutation class. Branch deletion is represented as deferred and is not enabled by this package.

Use `deriveSubjectIdentity({ repositoryId, checkoutId, worktreeId, branchId, candidateId })` in each adapter. The public package derives no release authority and never treats an absent release port as permission; inventory remains available while cleanup-dependent disposition is deferred.
