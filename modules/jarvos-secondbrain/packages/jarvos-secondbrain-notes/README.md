# jarvos-secondbrain-notes

Package-owned durable Notes contract and tooling for the `jarvos-secondbrain` monorepo.

## What lives here

- `docs/CLAW_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md` — package boundary and contract decision
- `src/write-to-vault.js` — canonical automated note writer path; writes the note, links the journal, and emits local KB sidecars in one call
- `src/knowledge-optimizer.js` — lossless WS4/WS5 sidecar artifacts for GBrain, QMD refresh, memory-wiki, and continuity queues
- `src/lint-frontmatter.js` — schema lint / normalization entrypoint for durable notes
- `src/manual-notes-maintenance.js` — dry-run/apply scanner for manually-created Obsidian notes
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

The note body remains the source of truth. Retrieval and synthesis systems consume deterministic sidecars under `<vault-root>/.jarvos/knowledge/` so OpenClaw, Claude, Codex, and Hermes do not each need a separate note pipeline.

## Durable Note Creation Behavior

New notes written through the canonical writer are not saved as title/body-only
files. The writer normalizes canonical frontmatter for Obsidian and memory-wiki
consumers:

- `status`
- `type`
- `project`
- `created`
- `updated`
- `author`

The note body remains the source of truth and is not rewritten with derivative
sections. Retrieval and memory systems get sidecar artifacts under
`<vault-root>/.jarvos/knowledge/` instead:

- `artifacts/*.json` records retrieval metadata, aliases, wikilinks, entities,
  summary, claims, and stack readiness.
- `gbrain-import-queue.json` queues safe notes for structured GBrain import.
- `memory-wiki-queue.json` queues safe notes for memory-wiki import.
- `qmd-refresh-pending.json` records that search/index freshness needs a
  refresh after optimization.
- `lossless-continuity.json` records the note create/update event for
  continuity capture.

Notes marked `private`, `sensitive`, or tagged with sensitive terms still get
the local artifact and continuity record, but are removed from automatic GBrain
and memory-wiki queues.

Set `JARVOS_NOTE_OPTIMIZATION=0` to disable sidecar artifact generation for a
write. Set `JARVOS_KNOWLEDGE_DIR=/path/to/knowledge` to redirect sidecar output.

## Manual Obsidian Note Maintenance

Notes created directly in Obsidian bypass `src/write-to-vault.js`, so they need
a safe maintenance path into the same stack. Run the package-owned scanner in
dry-run mode first:

```bash
cd modules/jarvos-secondbrain
npm run maintain:manual-notes
```

Dry-run mode scans Notes, reports missing/invalid canonical frontmatter, checks
`.jarvos/knowledge/optimization-audit.json` coverage, and predicts GBrain,
memory-wiki, and QMD queue decisions without writing files.

Apply mode is explicit:

```bash
cd modules/jarvos-secondbrain
npm run maintain:manual-notes:apply
```

Apply mode only fixes frontmatter drift that the normal linter can infer, then
calls the shared optimizer for each candidate. The optimizer writes local
artifacts, GBrain and memory-wiki queues for safe notes, sensitivity skip
decisions for private notes, lossless continuity, and
`qmd-refresh-pending.json`. Run QMD update/embed commands after apply mode
before treating search as fresh.

For one-shot supervised maintenance from cron or a service supervisor, run a
bounded poll:

```bash
node packages/jarvos-secondbrain-notes/src/manual-notes-maintenance.js --apply --since-state --watch --max-runs 1
```

The scanner is portable by design: it needs only a Notes directory, optional
knowledge/state paths, the package linter, and the shared sidecar optimizer. It
does not wire local cron jobs, Paperclip reporting, or user-specific vault paths.
