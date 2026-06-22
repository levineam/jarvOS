# jarvos-secondbrain Monorepo Bootstrap Checklist (2026-03-25)

**Umbrella issue:** SUP-333
**Local cutover refresh:** 2026-04-05

Purpose: record the final local cutover state rather than the original bootstrap-only plan.

## Exit criteria

- [x] active root entrypoints delegate into `jarvos-secondbrain`
- [x] active canonical docs use `jarvos-*` naming
- [x] `jarvos-memory` is documented as an adjacent jarvOS module, not a secondbrain package
- [x] Paperclip remains the execution system of record
- [x] compatibility shims are explicit and thin
- [ ] optional external historical vault note rename outside `clawd` (follow-up only if Andrew wants local vault note titles normalized)

## Current compatibility surfaces kept intentionally

- `scripts/journal-maintenance.js`
- `scripts/lobster-utils/write-to-vault.js`
- `scripts/lint-frontmatter.js`
- `scripts/note_contract_migration.py`
- `scripts/backfill_notes_frontmatter.py`
- `config/journal-module.json` mirror

Each of these exists only so older callers keep working while package-owned code
lives under `jarvos-secondbrain`.

## Verification commands

Run the live root entrypoints, not package files directly:

```bash
node scripts/journal-maintenance.js --help
node scripts/lobster-utils/write-to-vault.js --help
node scripts/lint-frontmatter.js --help
python3 scripts/note_contract_migration.py --help
python3 scripts/backfill_notes_frontmatter.py --help
node scripts/capture-router-hook.js --help
node scripts/journal-note-audit.js --help
```

## Rollback note

If a root caller regresses, fix the shim or caller path. Do **not** restore
`claw-secondbrain` as the canonical live surface.

## Historical note

Older bootstrap docs used `claw-secondbrain*` naming and placed Memory inside the
secondbrain package map. That model is superseded locally.
