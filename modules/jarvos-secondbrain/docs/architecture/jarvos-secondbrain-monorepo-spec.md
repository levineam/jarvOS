# jarvos-secondbrain Monorepo Architecture Spec

**Issue:** SUP-333
**Date:** 2026-03-25
**Status:** Current local canonical spec (updated 2026-04-05)

## Purpose

Define the active local architecture for `jarvos-secondbrain` inside `clawd` so
runtime code, docs, and migration surfaces all describe the same boundary.

## Bottom-line decision

`jarvos-secondbrain` is the **content layer** for Andrew's local system.

It owns two first-class packages:

- `jarvos-secondbrain-journal`
- `jarvos-secondbrain-notes`

It does **not** own durable agent memory or ontology state.

Adjacent jarvOS modules:

- `jarvos-memory` = compact durable memory layer
- `jarvos-ontology` = structured belief / identity layer
- Paperclip = execution authority

## Current local shape

```text
clawd/
├── jarvos-secondbrain/
│   ├── packages/
│   │   ├── jarvos-secondbrain-journal/
│   │   └── jarvos-secondbrain-notes/
│   ├── bridge/
│   │   ├── paperclip/
│   │   ├── provenance/
│   │   └── routing/
│   ├── adapters/
│   │   ├── openclaw/
│   │   └── obsidian/
│   └── docs/
├── jarvos-memory/
├── jarvos-ontology/
├── config/
└── scripts/
```

## Ownership boundaries

### `jarvos-secondbrain-journal`
Owns:
- chronological intake
- daily journal structure and repair
- day-scoped awareness artifacts

Does not own:
- durable note schema
- compact durable memory
- Paperclip task state

### `jarvos-secondbrain-notes`
Owns:
- durable note schema / frontmatter contract
- note writing and linting
- note migration helpers
- long-form human-readable knowledge artifacts

Does not own:
- day-level journal structure
- memory retention policy
- execution state

### `jarvos-secondbrain` repo-level layer
Owns only cross-package concerns:
- routing between journal / notes / Paperclip candidates
- provenance and backlinks
- adapters and bridge wiring

### `jarvos-memory`
Owns:
- `MEMORY.md`
- `memory/decisions/`
- `memory/lessons/`
- `memory/projects/`
- durable memory schemas, promotion rules, and audits

### Paperclip
Owns:
- issue assignment
- status and prioritization
- done/not-done state
- execution evidence and closeout

## Runtime rule

Root `clawd` entrypoints may remain for compatibility, but active behavior must
delegate to package-owned implementations under `jarvos-secondbrain`.

Examples:

- `scripts/journal-maintenance.js` → `jarvos-secondbrain-journal`
- `scripts/lobster-utils/write-to-vault.js` → `jarvos-secondbrain-notes`
- `scripts/lint-frontmatter.js` → `jarvos-secondbrain-notes`
- `scripts/note_contract_migration.py` → `jarvos-secondbrain-notes`
- `scripts/backfill_notes_frontmatter.py` → `jarvos-secondbrain-notes`

## Historical naming note

`claw-secondbrain` is retired as the active canonical name.

Historical references may remain only when explicitly labeled as legacy or
compatibility context. They must not define the current architecture.
