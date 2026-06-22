# jarvos-secondbrain-notes Package Decision (2026-03-25)

**Issue:** SUP-247
**Updated local decision:** 2026-04-05

## Decision

`jarvos-secondbrain-notes` owns the durable note contract for the local
`jarvos-secondbrain` content layer.

## Owns

- note frontmatter/body contract
- canonical note writer behavior
- frontmatter lint / normalization
- note migration helpers
- durable long-form knowledge artifacts

## Does not own

- journal chronology
- compact durable memory (`jarvos-memory` owns that)
- ontology state
- Paperclip execution state

## Canonical package-owned surfaces

- `jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/write-to-vault.js`
- `jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/lint-frontmatter.js`
- `jarvos-secondbrain/packages/jarvos-secondbrain-notes/migrations/note_contract_migration.py`
- `jarvos-secondbrain/packages/jarvos-secondbrain-notes/migrations/backfill_notes_frontmatter.py`

## Root compatibility shims kept intentionally

- `scripts/lobster-utils/write-to-vault.js`
- `scripts/lint-frontmatter.js`
- `scripts/note_contract_migration.py`
- `scripts/backfill_notes_frontmatter.py`

These must remain thin delegators only.

## Adjacent bridges

- `scripts/lobster-utils/link-to-journal.js` — provenance link back into journal
- `scripts/journal-note-audit.js` — journal ↔ note integrity audit
- `scripts/capture-router-hook.js` — route capture into notes vs other destinations

## Canonical naming rule

Use `jarvos-secondbrain-notes` in current docs, code comments, and compatibility
surfaces. `claw-secondbrain-notes` is legacy naming only.
