# Shared skill distribution

`@jarvos/skills` distributes explicitly selected portable skill bundles and can
locally converge rule-proven user-owned bundles across Codex, Claude Code,
OpenClaw, and Hermes. The public catalog names reviewed repository bundles; a
separate, owner-controlled local overlay may admit private bundles without
making their paths or bodies package content.

Each bundle is rooted at `SKILL.md` and carries a recursive digest over its allowlisted scripts, assets, references, and templates. Reconciliation copies real files atomically into each enrolled harness root, records a receipt, and preserves unmanaged or locally modified directories. Native harness skills are never imported or treated as missing jarvOS projections.

Names are catalog-level bindings. When a canonical name is occupied, jarvOS selects one safe alias for the entire enrolled matrix and persists it before pair writes. The catalog engine has no ambient workspace discovery path.

## Convergence pipeline

1. **Inventory** observes only registered absolute roots. It records complete,
   partial, missing, unsafe, and receipt-owned observations but authorizes
   nothing.
2. **Assessment** applies ownership, tree, privacy, trust, capability, and
   renderer gates. It captures only rule-proven candidates into an owner-only
   immutable source store; ambiguity and new risk remain preserved.
3. **Reconciliation** is the only projector. It adopts exact unmanaged copies
   without rewriting them and preserves divergent or locally modified targets.
4. **Autonomous repair** coalesces best-effort root events and runs periodically.
   Under the mutation lease it requires a complete generation over every
   available registered root; incomplete, overflowed, or stale evidence is
   non-mutating.

The periodic repair is the correctness backstop for watcher loss. A healthy
replay is a zero-write, notification-silent no-op.

Runtime adapters declare ordered scopes, renderer, alias limits, and their strongest safe verification tier. Exact-path adapters may record a receipt-bound model-visible proof. Interactive-only adapters remain `verification_pending` until an authorized interactive proof occurs; copied bytes alone are not availability proof.

## Operator CLI and scheduling

The `jarvos-skills` CLI exposes share/refresh/plan/apply/status/repair/enable/disable/rename,
inventory/inventory-assess/autonomous-repair,
and a scheduler planner that emits launchd (macOS) or systemd user timer (Linux)
unit files. Units stay disabled until the owner enables them. Protected mutations
that change enrollment or publish overlay admissions require an explicit human
principal when invoked through the control-plane manager.

Outward status is a common redacted contract for CLI, doctor, agent tools,
scheduler records, attention, and notifications. It may contain logical IDs,
digests, state, and allowlisted reason codes; it may not contain observed names,
absolute paths, bodies, parser errors, or credentials.

## Doctor and preflight

`jarvos-skills doctor-shared` validates config, catalogs, adapter projection
contracts, inventory state, source-root requirements, and a non-enabling scheduler plan.
`scripts/live-preflight-checklist.js` aggregates package tests, runtime-kit,
isolated dogfood, and doctor evidence while keeping owner live steps pending.
It is permanently read-only: public pre-merge evidence cannot mutate a live
skill root, enable a scheduler, or run a remote model probe.
