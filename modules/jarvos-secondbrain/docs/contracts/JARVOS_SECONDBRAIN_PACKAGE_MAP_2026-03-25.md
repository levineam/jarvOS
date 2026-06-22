# jarvos-secondbrain Package Map (2026-03-25)

**Umbrella issue:** SUP-333
**Updated for local cutover:** 2026-04-05

Purpose: map current `clawd` artifacts to the active jarvOS boundary.

## Classification rule

- **package implementation** = owned runtime code inside a package
- **package contract** = doc/config intrinsic to that package
- **bridge / adapter** = cross-package or external-system wiring
- **compatibility shim** = old root caller kept only to delegate
- **adjacent module** = jarvOS module outside `jarvos-secondbrain`

## Current artifact map

| Current path | Canonical home | Class | Notes |
| --- | --- | --- | --- |
| `jarvos-secondbrain/bridge/config/` | `jarvos-secondbrain/bridge/config` | bridge / adapter | Canonical portable config resolver. Exports `resolveConfig()` and Paperclip env helpers. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-journal/config/journal-module.json` | `jarvos-secondbrain-journal` | package contract | Canonical journal structure. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js` | `jarvos-secondbrain-journal` | package implementation | Canonical journal maintenance logic. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/write-to-vault.js` | `jarvos-secondbrain-notes` | package implementation | Canonical note writer path. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/lint-frontmatter.js` | `jarvos-secondbrain-notes` | package implementation | Canonical note lint / normalization path. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/lint-source-material.js` | `jarvos-secondbrain-notes` | package implementation | Canonical Source Material provenance lint. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-notes/docs/SOURCE_MATERIAL_PROVENANCE_CONTRACT.md` | `jarvos-secondbrain-notes` | package contract | External source-material metadata contract. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-notes/migrations/note_contract_migration.py` | `jarvos-secondbrain-notes` | package implementation | Canonical contract migrator. |
| `jarvos-secondbrain/packages/jarvos-secondbrain-notes/migrations/backfill_notes_frontmatter.py` | `jarvos-secondbrain-notes` | package implementation | Canonical backfill helper. |
| `scripts/journal-maintenance.js` | `jarvos-secondbrain-journal` | compatibility shim | Delegates to package-owned journal logic. |
| `scripts/lobster-utils/write-to-vault.js` | `jarvos-secondbrain-notes` | compatibility shim | Delegates to package-owned notes writer. |
| `scripts/lint-frontmatter.js` | `jarvos-secondbrain-notes` | compatibility shim | Delegates to package-owned notes lint. |
| `scripts/lint-source-material.js` | `jarvos-secondbrain-notes` | compatibility shim | Delegates to package-owned Source Material provenance lint. |
| `scripts/note_contract_migration.py` | `jarvos-secondbrain-notes` | compatibility shim | Delegates to package-owned migration helper. |
| `scripts/backfill_notes_frontmatter.py` | `jarvos-secondbrain-notes` | compatibility shim | Delegates to package-owned backfill helper. |
| `scripts/capture-router-hook.js` | `jarvos-secondbrain/bridge/routing` | bridge / adapter | Root caller for capture routing. |
| `scripts/journal-note-audit.js` | `jarvos-secondbrain/bridge/provenance` | bridge / adapter | Journal ↔ note integrity audit. |
| `scripts/lobster-utils/link-to-journal.js` | `jarvos-secondbrain/bridge/provenance` | bridge / adapter | Note backlinks into journal. |
| `jarvos-secondbrain/bridge/paperclip/client.js` | `jarvos-secondbrain/bridge/paperclip` | bridge / adapter | Canonical Paperclip HTTP client for bridge callers and root script compatibility shims. |
| `scripts/journal-paperclip-inbox.js` | `jarvos-secondbrain/bridge/paperclip` | bridge / adapter | Paperclip reflection into journal. |
| `scripts/paperclip-promote-capture.js` | `jarvos-secondbrain/bridge/paperclip` | bridge / adapter | Capture → Paperclip promotion helper; now emits `jarvos-secondbrain` markers while still reading old markers for compatibility. |
| `scripts/lib/config.js` | `jarvos-secondbrain/bridge/config` | compatibility shim | Delegates to the shared resolver while preserving the existing root import path. |
| `MEMORY.md` | `jarvos-memory/` | adjacent module | Curated durable memory, not secondbrain content. |
| `memory/decisions/*.md` | `jarvos-memory/` | adjacent module | Durable decision artifacts. |
| `memory/lessons/*.md` | `jarvos-memory/` | adjacent module | Durable reusable corrections. |
| `memory/projects/*.md` | `jarvos-memory/` | adjacent module | Project-state memory artifacts. |
| `jarvos-ontology/` | `jarvos-ontology/` | adjacent module | Ontology layer. |
| `~/Vaults/<vault>/Journal/` | journal data surface | package data | Live journal artifact store; actual local vault paths stay private config. |
| `~/Vaults/<vault>/Notes/` | notes data surface | package data | Live notes artifact store; actual local vault paths stay private config. |

## Rule of interpretation

If a surface owns human-readable content, it belongs in `jarvos-secondbrain`.
If it owns compact durable recall, it belongs in `jarvos-memory`.
If it owns execution state, it belongs in Paperclip.
