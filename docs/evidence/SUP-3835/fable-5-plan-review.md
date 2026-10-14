---
title: SUP-3835 Fable 5 Plan Review
date: 2026-08-26
reviewed_plan: docs/plans/2026-08-26-2039-feat-gbrain-continuity-activation-plan.md
requested_model: claude-fable-5
served_model: claude-fable-5
verdict: accept-with-changes
---

<!-- markdownlint-disable-file MD025 -->
# SUP-3835 Fable 5 Plan Review

## Receipt

- Route: Claude CLI 2.1.247, safe mode, read-only `Read`, `Glob`, and `Grep` tools.
- Requested and primary served model: `claude-fable-5` at high effort.
- Model usage receipt: `claude-fable-5` was the primary model; `claude-haiku-4-5` appeared only in CLI model-usage accounting. No subagents were spawned.
- Result session: `4e889c9b-f640-4b63-85ae-8eb4358e6054`.
- Duration: 325,337 ms.
- Cost reported by the CLI: $5.645515.
- Egress scope: the plan, its jarvOS worktree, and the isolated public GBrain v0.46.32.0 checkout. No credentials, private brain contents, private config, Vault notes, Paperclip data, or dirty GBrain checkout were authorized.

## Verdict

**ACCEPT WITH CHANGES**

## Executive Assessment

The topology choice is right and is the provider's documented answer: GBrain v0.46.32 says a PGLite brain is single-process, and tells operators to either run one shared HTTP server or migrate to Postgres. Postgres plus three native stdio servers removes the daemon, bearer tokens, and any jarvOS broker. The ownership fences are consistent with jarvOS's external-integration and shared-skill boundaries.

The draft failed its own complexity test in three places: U3 added an MCP/HTTP transport inside `@jarvos/gbrain` that the chosen topology makes unnecessary; U1 spent a full three-client rig disconfirming provider-documented behavior; and U5 proposed a new per-harness evidence loader beside the existing health-module snapshot contract. Two correctness gaps also blocked execution: the identity tuple lacked a verified stable source, and maintenance ownership under three serves plus possible GBrain autopilot was not reconciled.

## Must Change

### 1. Drop the transport abstraction from U3

Under Postgres, concurrent CLI and serve access is supported. Current recall, graph, source listing, and doctor probes are CLI-based. A provider-connection abstraction with MCP/HTTP selection would add a second provider surface for the PGLite branch the plan rejects.

**Required change:** Keep CLI as the sole `@jarvos/gbrain` transport. Make U3 add machine-readable continuity provenance (`gbrainAnswered`, answering engines, failure class), runtime-resolution hardening, and sanitized failure classes. Move an MCP transport seam to the Postgres-declined branch only.

### 2. Define a stable identity source and exclude volatile counters

GBrain's `get_brain_identity` is a banner packet with version, engine, counts, and last-sync time. It does not document a stable brain ID. Counts drift between probes and cannot prove sameness.

**Required change:** Derive the redacted identity from engine kind, a canonical database identity read from owner-only GBrain config without credentials, and a jarvOS-namespaced sentinel page slug/content digest written once through the provider path. Use `get_brain_identity` only for version and engine. Prove two disposable brains yield different tuples and one brain is stable across three probes.

### 3. Harden runtime resolution and invocation context in `@jarvos/gbrain`

Current binary resolution prefers PATH before the Bun global location, CLI calls default to the dirty source checkout as cwd, GBrain can route brain/source from cwd ancestor dotfiles, and the full environment is inherited. That conflicts with pinned provenance and creates the same CWD-hijack class as GitHub PR #157, “Prevent CWD package hijacking.”

**Required change:** Resolve only an explicitly pinned or sanctioned executable, verify realpath/owner/mode/digest before each spawn, use a neutral cwd, pass brain/source explicitly, and pass a minimal allowlisted environment. Add tests for every failure case.

### 4. Reconcile maintenance ownership before three servers exist

A GBrain serve process can run idle maintenance using that process's environment and API keys. GBrain also ships an autopilot daemon that participates in engine migration. The draft named Paperclip SUP-3870, “Scheduler-owned bounded GBrain embedding delta-maintenance path,” as the sole scheduler but did not account for autopilot or serve idle sweeps.

**Required change:** U1 inventories autopilot and serve idle-sweep behavior on Postgres, records one maintenance owner, and pins disabling knobs or explicit acceptance. U6 refuses activation when more than one owner is live.

### 5. Reuse the health-module snapshot contract

jarvOS already defines producer-written, owner-only, freshness/generation/trust-validated, data-only snapshots that doctor reduces without executing probes. The draft's direct per-harness evidence loader would duplicate that contract.

**Required change:** A private owner-side producer writes a `gbrain-continuity` module snapshot per harness with ordered evidence state, tuple digest, and observation time. Public doctor reads it through the existing snapshot validator. Live-turn proof enters only as a receipt-derived snapshot field; doctor never runs a live turn or native probe.

## Should Change

### 1. Shrink the PGLite comparison

Use provider documentation as the main disconfirmation and optionally run one cheap disposable check that sync refuses against a PGLite HTTP server. Drop the three-client rig.

### 2. Default Codex to direct MCP

The native plugin uses the starter surface, while `list_skills` and `get_skill` require a wider surface and publication consent. Direct MCP should be the default owner bound to the pinned runtime. Select the plugin only if surface, gate, and pin are all proven. Use GBrain doctor's double-registration warning instead of reimplementing duplicate-owner detection.

### 3. Refuse database credentials in harness configuration or launch environment

Provider examples may pass database URLs through harness config. U4 should scan the effective configs and refuse this; credentials remain only in owner-only GBrain configuration.

### 4. State post-cutover rollback semantics

Use a write-freeze window for activation proof. Tier-one rollback restores the preserved PGLite configuration. If post-cutover writes exist, tier-two rollback uses the provider-supported migration back to PGLite rather than a lossy config flip.

### 5. Prove the exact local Postgres migration target

The provider docs clearly describe fresh local Postgres configuration but do not prove that the named generic migration target honors a local database URL. The first disposable test must establish the supported PGLite-to-local-Postgres command or stop.

### 6. Name Hermes verification precisely

Hermes add can exit successfully on failure. Use `hermes mcp test gbrain` for the connection and `hermes -z` for a live turn.

## Accepted Decisions

- Local Postgres plus provider-native stdio per harness; no jarvOS broker and no shared HTTP daemon.
- GBrain owns the store, resolver, and Skillify; no skill copying into jarvOS shared-skill distribution.
- Public jarvOS remains GBrain-optional and does not own Postgres lifecycle.
- Machine-proven and live-turn-proven evidence remain distinct.
- Preserve PGLite through migration; rehearse on disposable state; wait for Paperclip SUP-3869, “Bounded resumable local GBrain embed backfill with PGLite safety,” before engine mutation; preserve SUP-3870's scheduler ownership.
- Merge before private activation and use digest-only receipts.

## Decision Gate

**Choice:** Approve migrating the private brain to host-local, loopback-only Postgres with a least-privilege GBrain role, then connect Codex, Hermes, and OpenClaw through native stdio—or decline.

**If approved:** the private environment gains one local service and one reversible export/import migration with preserved PGLite. The simplified plan needs no provider transport abstraction and no new doctor evidence loader.

**If declined:** the remaining PGLite HTTP path requires client authentication, stops direct-CLI maintenance while serving, and forces a new MCP transport plus quiesce/restart ownership that conflicts with the plan's no-broker boundary.

**Recommendation:** Approve Postgres, conditional on a stable brain-identity contract and single maintenance-owner proof before cutover.

## Integration Disposition

All findings were integrated into the reviewed plan on 2026-08-26:

| Finding | Disposition |
| --- | --- |
| Drop the U3 transport abstraction | Applied. U3 retains CLI and adds pinned invocation plus machine-readable answering-engine provenance. |
| Define stable identity inputs | Applied. KTD4 separates a durable logical-brain sentinel digest from selected-store identity and excludes volatile counters. |
| Harden runtime resolution and invocation | Applied. U3 requires per-spawn realpath/owner/mode/digest validation, neutral cwd, explicit source selection, and minimal environment. |
| Reconcile maintenance ownership | Applied. U1 inventories autopilot, serve idle sweeps, and SUP-3870; U6 refuses multiple owners. |
| Reuse doctor health snapshots | Applied. U5 adds an owner-side producer and keeps public doctor on the existing validated data-only snapshot contract. |
| Shrink the PGLite comparison | Applied. U1 cites provider evidence and permits only one optional disposable sync-refusal check. |
| Default Codex to direct MCP | Applied. Plugin selection now requires proof of surface, consent gate, and runtime pin. |
| Refuse database credentials in harness config | Applied. U4 fails closed on `DATABASE_URL` and `GBRAIN_DATABASE_URL`. |
| State post-cutover rollback semantics | Applied. U2/U6 use a write freeze, config restore before writes, and provider-supported reverse migration after writes. |
| Prove the local Postgres target | Applied. U2's first disposable gate must establish the exact provider-supported command or stop. |
| Name Hermes verification | Applied. U4 uses `hermes mcp test gbrain`; U6 uses `hermes -z`. |
