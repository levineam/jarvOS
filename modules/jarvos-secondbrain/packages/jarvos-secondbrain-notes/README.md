# jarvos-secondbrain-notes

Package-owned durable Notes contract and tooling for the `jarvos-secondbrain` monorepo.

## What lives here

- `docs/CLAW_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md` — package boundary and contract decision
- `src/write-to-vault.js` — canonical automated note writer path; writes the note, links the journal, and emits local KB sidecars in one call
- `src/knowledge-optimizer.js` — lossless WS4/WS5 sidecar artifacts for GBrain, QMD refresh, memory-wiki, and continuity queues
- `src/lint-frontmatter.js` — schema lint / normalization entrypoint for durable notes
- `src/manual-notes-maintenance.js` — dry-run/apply scanner for manually-created markdown notes
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
- `$CLAWD_DIR/scripts/manual-notes-maintenance.js`
- `$CLAWD_DIR/scripts/note_contract_migration.py`
- `$CLAWD_DIR/scripts/backfill_notes_frontmatter.py`

For this extraction pass, those root files remain as thin shims that delegate into the package-owned implementations above.

That keeps the current note creation and lint/migration paths working while making the package boundary explicit in the monorepo.

The note body remains the source of truth. Retrieval and synthesis systems consume deterministic sidecars under `<vault-root>/.jarvos/knowledge/` so OpenClaw, Claude, Codex, and Hermes do not each need a separate note pipeline.

## Durable note sidecars

The optimizer keeps derivative data out of the markdown body and writes local sidecars instead:

- `artifacts/*.json` records retrieval metadata, aliases, wikilinks, entities, claims, summary, and stack readiness.
- `gbrain-import-queue.json` queues safe notes for structured GBrain import.
- `memory-wiki-queue.json` queues safe notes for memory-wiki import.
- `qmd-refresh-pending.json` records notes whose search/index freshness must be refreshed.
- `optimization-audit.json` records source-note body hashes and downstream status decisions.
- `lossless-continuity.json` records the note create/update event for continuity capture.

Notes marked `private`, `sensitive`, or tagged with sensitive terms still get the local artifact, QMD freshness, audit, and continuity records, but are removed from automatic GBrain and memory-wiki queues.

Set `JARVOS_NOTE_OPTIMIZATION=0` to disable sidecar artifact generation for a write. Set `JARVOS_KNOWLEDGE_DIR=/path/to/knowledge` to redirect sidecar output.

## Manual note maintenance

Notes created directly in Obsidian or another markdown editor bypass `src/write-to-vault.js`, so they need a safe maintenance path into the same stack. Dry-run mode is the default:

```bash
npm run maintain:manual-notes -- --notes-dir /path/to/Vault/Notes
```

Dry-run mode scans notes, reports missing or invalid canonical frontmatter, checks `.jarvos/knowledge/optimization-audit.json` coverage, and predicts GBrain, memory-wiki, QMD, and continuity decisions without writing files.

Apply mode is explicit:

```bash
npm run maintain:manual-notes:apply -- --notes-dir /path/to/Vault/Notes
```

Apply mode only fixes frontmatter drift that the linter can infer, then calls the shared optimizer for each candidate. The optimizer writes local artifacts, queue decisions for safe notes, sensitivity skip decisions for private notes, lossless continuity, `qmd-refresh-pending.json`, and `optimization-audit.json`. Run `qmd update` and `qmd embed` after apply mode before treating search as fresh.

For ongoing maintenance, run a bounded poll from cron or a service supervisor:

```bash
node scripts/manual-notes-maintenance.js --apply --since-state --watch --max-runs 1
```

The portable pattern is one scanner for markdown notes that missed the canonical writer, one conservative frontmatter normalizer, one sidecar optimizer for downstream routing, one audit file for coverage, and one explicit freshness queue for search/index refresh.
