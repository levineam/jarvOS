# claw-secondbrain Package Map (2026-03-25)

Umbrella issue: SUP-333

Purpose: identify which existing `clawd` artifacts already map cleanly to package
contracts, bridge/adapters, or migration-only surfaces so the future
`claw-secondbrain` monorepo can be bootstrapped without broad refactors first.

## Classification rule

- **package contract** = intrinsic to Journal, Notes, or Memory ownership
- **bridge** = cross-package routing, provenance, or Paperclip boundary logic
- **adapter** = OpenClaw/Obsidian/runtime wiring around a package
- **migration / compatibility** = transitional artifact that should not define the future boundary

## Current artifact map

| Current path | Target home in `claw-secondbrain` | Class | Why |
| --- | --- | --- | --- |
| `docs/architecture/claw-secondbrain-monorepo-spec.md` | `docs/architecture/` | umbrella architecture | Source-of-truth spec for package boundaries. |
| `docs/openclaw/CLAW_SECONDBRAIN_MONOREPO_ARCHITECTURE_DECISION_2026-03-25.md` | `docs/architecture/` or `docs/contracts/` | umbrella decision | Executable ADR-style restatement of the spec. |
| `docs/openclaw/CLAW_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md` | `packages/claw-secondbrain-notes/docs/` | package contract | Notes package contract and toolchain split. |
| `docs/openclaw/CLAW_SECONDBRAIN_JOURNAL_PACKAGE_DECISION_2026-03-25.md` | `packages/claw-secondbrain-journal/docs/` | package contract | Journal package contract and automation boundary. |
| `docs/openclaw/CLAW_SECONDBRAIN_MEMORY_PACKAGE_DECISION_2026-03-25.md` | `packages/claw-secondbrain-memory/docs/` | package contract | Memory package contract and retention boundary. |
| `docs/openclaw/QMD_RETRIEVAL_STACK_DECISION_2026-03-23.md` | `adapters/openclaw/` or `docs/adapters/` | adapter | Retrieval support decision; not package ownership. |
| `config/journal-module.json` | `packages/claw-secondbrain-journal/` | package contract | Canonical daily journal structure already lives here. |
| `scripts/journal-maintenance.js` | `packages/claw-secondbrain-journal/` | package implementation | Core journal creation/repair logic. |
| `scripts/lobster-utils/write-to-vault.js` | `packages/claw-secondbrain-notes/` | package implementation | Canonical automated note writer path. |
| `scripts/lint-frontmatter.js` | `packages/claw-secondbrain-notes/` | package implementation | Canonical schema lint / normalization entrypoint for durable notes. |
| `scripts/note_contract_migration.py` | `packages/claw-secondbrain-notes/` | migration utility | Safe migration toward the notes contract. |
| `scripts/backfill_notes_frontmatter.py` | `packages/claw-secondbrain-notes/` | migration utility | Legacy note normalization support. |
| `scripts/journal-note-audit.js` | `bridge/provenance/` | bridge | Checks note ↔ journal integrity across package boundaries. |
| `scripts/lobster-utils/link-to-journal.js` | `bridge/provenance/` | bridge | Adds cross-package backlinks from notes into the daily journal. |
| `scripts/journal-paperclip-inbox.js` | `bridge/paperclip/` | bridge | Read-only Paperclip projection into Journal. |
| `scripts/paperclip-api.js` | `bridge/paperclip/` | bridge | Execution-system boundary, not secondbrain package logic. |
| `scripts/paperclip-pr-bridge.js` | `bridge/paperclip/` | bridge | Paperclip execution reflection / synchronization surface. |
| `scripts/paperclip-activity-feed-poll.js` | `bridge/paperclip/` | bridge | Paperclip event intake for bounded reflections. |
| `scripts/journal-task-sync.js` | migration / compatibility | migration / compatibility | Still carries legacy task mirroring and should not define the future journal contract. |
| `MEMORY.md` | `packages/claw-secondbrain-memory/` | package contract | Current curated durable memory registry. |
| `memory/decisions/*.md` | `packages/claw-secondbrain-memory/` | package contract | Structured durable decision artifacts. |
| `memory/lessons/*.md` | `packages/claw-secondbrain-memory/` | package contract | Durable corrections / lessons. |
| `memory/YYYY-MM-DD.md` | input surface / migration | migration / compatibility | Raw daily operating logs; useful inputs, but not the final package boundary. |
| `~/.openclaw/openclaw.json` lossless-claw config | `adapters/openclaw/` | adapter | Runtime continuity integration, not memory package ownership. |
| `references/heartbeat-procedures.md` | `adapters/openclaw/` | adapter | OpenClaw operational wiring around the package surfaces. |
| `$JARVOS_JOURNAL_DIR` (default: `~/Documents/Vault v3/Journal/`) | package data surface | package data | Current real Journal artifact store. |
| `$JARVOS_VAULT_NOTES` (default: `~/Documents/Vault v3/Notes/`) | package data surface | package data | Current real Notes artifact store. |

## Practical bootstrap interpretation

What this means right now:

- enough contract material now exists to treat **Journal**, **Notes**, and **Memory** as
  separate packages conceptually
- the next implementation step should be **monorepo bootstrap + file extraction**, not more
  boundary debates
- Paperclip-specific scripts should stay outside package cores from day one
- `memory/YYYY-MM-DD.md` and `journal-task-sync.js` are the two clearest compatibility
  surfaces that should not be mistaken for final package design

## First-pass folder targets

When the actual monorepo is created, the lowest-risk initial landing shape is:

```text
claw-secondbrain/
  packages/
    claw-secondbrain-journal/
      docs/
      src/
    claw-secondbrain-notes/
      docs/
      src/
    claw-secondbrain-memory/
      docs/
      src/
  bridge/
    paperclip/
    provenance/
    routing/
  adapters/
    openclaw/
    obsidian/
  docs/
    architecture/
    contracts/
    migration/
```

That layout is enough to start moving contracts and scripts without forcing any storage
or schema rewrite up front.
