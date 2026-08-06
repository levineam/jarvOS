# Managed-software stewardship

jarvOS 1.0 introduces an optional stewardship profile for people who work in
several coding sessions at once. It keeps each session isolated, preserves
unfinished work in Git, and helps route reusable local improvements toward the
appropriate public repository.

## What changes

- Git is the authority for work, branches, checkpoints, and reconciliation.
- A local coordination adapter reports which sessions are active. The initial
  host implementation uses a pinned, localhost-only Agent Mail runtime.
- Claude Code, Codex, OpenClaw, and Hermes use the same lifecycle contract.
- Projects, Beads, and Paperclip are optional downstream records. Disabling or
  omitting them does not disable stewardship or release classification.
- Public merge, tag, release, and upstream submission still require approval
  for the exact action.

## Existing installations

Existing branches and worktrees remain untouched during setup. Before enabling
the quiet default, the host inventories them and classifies each as active,
checkpoint-required, safely reconcilable, deliberately preserved, or needing a
decision. Unknown coordination state always preserves work.

Harness setup merges jarvOS hooks with existing configuration and keeps a
backup before changing it. Runtimes without a verified native worktree default
use a reversible managed launcher only in repositories explicitly selected by
the owner. Other repositories and non-session commands continue to use the
original executable unchanged.

## Rollback

Rollback disables the stewardship hooks, launcher, and local coordination
service. It does not delete branches, worktrees, checkpoint refs, coordination
history, or release-candidate evidence. Re-enable the profile only after its
health and cross-harness checks pass again.

The normal experience should remain quiet. jarvOS interrupts the owning coding
session only when a conflict, recovery choice, or other genuine judgment is
required; a configured notification channel is a fallback when that session is
unavailable.
