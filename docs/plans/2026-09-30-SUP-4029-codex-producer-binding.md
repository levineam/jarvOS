# SUP-4029: authenticated Codex completion binding

## Outcome and scope

Continue the merged plan-to-proof contract with one optional Codex host binding.
The host owns authentication, approval, work-run ownership, accepted plan, Git
observation and behavioral observation. Tool arguments supply only an operation,
approved request identifier, work identifier and declared delivery trace.

This public slice provides transport and the required shared-library repairs.
The private host composes the existing manager, workflow, durable stores and live
adapters. No scheduler, tracker, provider, credentials or runtime activation is
introduced. Other hosts remain unbound unless separately admitted.

Behavioral criterion: an authenticated disposable host call completes only for the accepted plan and observed behavior; missing, stale or forged evidence is refused through the same boundary.

## Changes

- Advertise a closed `jarvos_coding_take_issue_to_done` input and load only a
  protected host binding. Bind the credential server-side and drop caller
  authority fields.
- Expose an authoritative approval binding only to its creator while preserving
  existing record and field sensitivity rules.
- Repair the default managed-workflow manifest path and distinguish Beads claim
  and close operation identities.
- Reuse a verified host-owned checkout already on the requested branch without
  changing or deleting it. Keep the host-selected integration base authoritative.

Documentation Impact: module-docs, operator-docs.
Documentation Impact Evidence: agent-context README and the host owner's
disposable acceptance runbook. The prior source-contract plan is preserved.

## Acceptance and boundaries

Verify authentication and field projection, sensitivity, fresh approval fences,
managed accepted-plan binding, real Git observation, good/broken behavior despite
green generic tests, concurrency exclusion, stale replay, open-PR waiting and
worktree preservation. The disposable fixture replaces external review, PR and
tracker effects explicitly; it proves no production merge or tracker action.

Run focused control-plane, coding and MCP tests, module smoke checks and required
CI. Retain fail-first evidence for reproducible shared-library bugs. One
independent Astra-medium review covers the frozen public/private candidate.

Source merge, installation and native acceptance are separate receipts. The
existing runtime steward owns any separately authorized stage/select/install.
Stop for an unresolved authority or sensitivity bypass, fabricated completion,
unverified behavior, lost ownership, failed required gate or shared-runtime edit.
Before installation, rollback is withdrawal/reversion of these source changes;
after installation, use the existing runtime rollback and preserve evidence.
