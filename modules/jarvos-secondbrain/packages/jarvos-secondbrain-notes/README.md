# jarvos-secondbrain-notes

Package-owned durable Notes contract and tooling for the `jarvos-secondbrain` monorepo.

## What lives here

- `docs/CLAW_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md` — package boundary and contract decision
- `src/write-to-vault.js` — canonical automated note writer path
- `src/lint-frontmatter.js` — schema lint / normalization entrypoint for durable notes
- `migrations/note_contract_migration.py` — safe audit/apply migration runner toward the canonical contract
- `migrations/backfill_notes_frontmatter.py` — batch backfill helper for legacy notes

## What stays outside the package core

These remain outside the package core because they are bridge, adapter, or workflow wiring rather than Notes ownership:

- `$CLAWD_DIR/scripts/lobster-utils/link-to-journal.js` — provenance helper from notes back to the daily journal
- `$CLAWD_DIR/workflows/*.lobster` — current caller surfaces that still invoke the root compatibility shims
- `$CLAWD_DIR/scripts/sync-vault-to-supabase.js` — downstream adapter/export behavior

`CLAWD_DIR` defaults to `~/clawd`; override with the `CLAWD_DIR` env var.

## Compatibility shims

Current `clawd` callers still reference these root paths:

- `$CLAWD_DIR/scripts/lobster-utils/write-to-vault.js`
- `$CLAWD_DIR/scripts/lint-frontmatter.js`
- `$CLAWD_DIR/scripts/note_contract_migration.py`
- `$CLAWD_DIR/scripts/backfill_notes_frontmatter.py`

For this extraction pass, those root files remain as thin shims that delegate into the package-owned implementations above.

That keeps the current note creation and lint/migration paths working while making the package boundary explicit in the monorepo.
