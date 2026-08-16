# Managed-software stewardship

jarvOS 1.0 introduces an optional stewardship profile for people who work in
several coding sessions at once. It keeps each session isolated, preserves
unfinished work in Git, and helps route reusable local improvements toward the
appropriate public repository.

## What changes

- Git is the authority for work, branches, checkpoints, and reconciliation.
- A local coordination adapter reports which sessions are active. The initial
  host implementation uses a pinned, localhost-only Agent Mail runtime.
- Claude Code, Codex, OpenClaw, and Hermes share the same stewardship
  **capability** contract (start/resume, heartbeat, checkpoint, stop, next-turn
  input, availability). They do **not** share one process or activation
  mechanism:
  - Claude and Codex are **native-hook** owned; a managed launcher is only a
    per-session fallback where native isolation is unavailable — not a daemon.
  - Hermes and OpenClaw are **harness-process** owned; their host/gateway owns
    process lifetime. jarvOS does not add a supervisor or restart loop for
    symmetry.
- Managed harness **activation** is separate from install, skill discovery,
  health, and registration. Public activation truth is each runtime’s
  `managedActivation` block in `runtimes/*/adapter.json` (validated by
  runtime-kit). A local `managed-launcher.json` is installation evidence only,
  not an activation flag. See
  [`docs/runbooks/managed-harness-activation.md`](../runbooks/managed-harness-activation.md).
- Beads is the required durable execution ledger for the supported profile. If
  it is unavailable, preserved work remains visibly pending and retries safely.
- Projects is optional context. Paperclip is an optional one-way record only;
  neither can admit, block, or own stewardship execution.
- Public merge, tag, release, and upstream submission still require approval
  for the exact action.

## Existing installations

Existing branches and worktrees remain untouched during setup. Before enabling
the quiet default, the host inventories them and classifies each as active,
checkpoint-required, safely reconcilable, deliberately preserved, or needing a
decision. Unknown coordination state always preserves work.

Harness setup merges jarvOS hooks with existing configuration and keeps a
backup before changing it. Where a runtime lacks a verified native worktree
default, a reversible managed launcher applies only in repositories explicitly
selected by the owner. Other repositories and non-session commands continue to
use the original executable unchanged. That launcher install is not live
managed activation; activation still requires a fresh causal receipt bound to
the selected public tuple after merge and selected-runtime staging.

## Rollback

Stewardship rollback disables the stewardship hooks, any managed launcher
binding for selected roots, and the local coordination service. It does not
delete branches, worktrees, checkpoint refs, coordination history, or
release-candidate evidence. It is not a jarvOS-wide process kill: Hermes and
OpenClaw process lifetime stays with their host/gateway. Re-enable the profile
only after its health and cross-harness checks pass again. Managed-activation
dogfood rollback is a separate exact-owned cleanup of disposable challenge
material (see the activation runbook).

The normal experience should remain quiet. jarvOS interrupts the owning coding
session only when a conflict, recovery choice, or other genuine judgment is
required; a configured notification channel is a fallback when that session is
unavailable.
