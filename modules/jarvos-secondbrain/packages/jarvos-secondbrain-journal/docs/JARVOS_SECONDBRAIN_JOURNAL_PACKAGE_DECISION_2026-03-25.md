# jarvos-secondbrain-journal Package Decision (2026-03-25)

**Issue:** SUP-262
**Updated local decision:** 2026-04-05

## Decision

`jarvos-secondbrain-journal` owns chronological intake for the local
`jarvos-secondbrain` content layer.

## Owns

- daily journal structure
- journal creation / repair
- chronological capture and day-scoped awareness
- journal-facing projections that remain about content rather than execution authority

## Does not own

- durable note schema
- compact durable memory (`jarvos-memory` owns that)
- Paperclip execution state
- ontology state

## Canonical package-owned surfaces

- `jarvos-secondbrain/packages/jarvos-secondbrain-journal/config/journal-module.json`
- `jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js`

## Root compatibility surfaces kept intentionally

- `config/journal-module.json`
- `scripts/journal-maintenance.js`

These stay only to preserve existing callers while the package path remains the
source of truth.

## Adjacent bridges

- `scripts/journal-paperclip-inbox.js` — blocked-only Paperclip reflection into journal
- `scripts/journal-note-audit.js` — provenance audit across journal and notes
- `scripts/lobster-utils/link-to-journal.js` — note backlinks into the day record

## Canonical naming rule

Use `jarvos-secondbrain-journal` in current docs, code comments, and compatibility
surfaces. `claw-secondbrain-journal` is legacy naming only.
