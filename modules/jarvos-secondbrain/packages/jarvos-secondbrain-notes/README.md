# jarvos-secondbrain-notes

Package-owned durable Notes contract and tooling for the `jarvos-secondbrain` monorepo.

## What lives here

- `docs/JARVOS_SECONDBRAIN_NOTES_PACKAGE_DECISION_2026-03-25.md` — package boundary and contract decision
- `src/write-to-vault.js` — canonical automated note writer path
- `src/knowledge-optimizer.js` — lossless sidecar artifact writer for newly durable notes
- `src/lint-frontmatter.js` — schema lint / normalization entrypoint for durable notes
- `src/manual-notes-maintenance.js` — dry-run/apply scanner for manually-created Obsidian notes
- `src/lint-source-material.js` — provenance lint for external Source Material markdown
- `migrations/note_contract_migration.py` — safe audit/apply migration runner toward the canonical contract
- `migrations/backfill_notes_frontmatter.py` — batch backfill helper for legacy notes

## What stays outside the package core

These remain outside the package core because they are bridge, adapter, or workflow wiring rather than Notes ownership:

- `~/clawd/scripts/lobster-utils/link-to-journal.js` — provenance helper from notes back to the daily journal
- `~/clawd/workflows/*.lobster` — current caller surfaces that still invoke the root compatibility shims
- `~/clawd/scripts/sync-vault-to-supabase.js` — downstream adapter/export behavior

## Compatibility shims

Current `clawd` callers still reference these root paths:

- `~/clawd/scripts/lobster-utils/write-to-vault.js`
- `~/clawd/scripts/lint-frontmatter.js`
- `~/clawd/scripts/manual-notes-maintenance.js`
- `~/clawd/scripts/lint-source-material.js`
- `~/clawd/scripts/note_contract_migration.py`
- `~/clawd/scripts/backfill_notes_frontmatter.py`

For this extraction pass, those root files remain as thin shims that delegate into the package-owned implementations above.

That keeps the current note creation and lint/migration paths working while making the package boundary explicit in the monorepo.

## Durable note creation behavior

New notes written through the canonical writer are not saved as title/body-only files. The writer normalizes canonical frontmatter for Obsidian and memory-wiki consumers:

- `status`
- `type`
- `project`
- `created`
- `updated`
- `author`

The note body remains the source of truth and is not rewritten with derivative sections. Retrieval and memory systems get sidecar artifacts under `<vault-root>/.jarvos/knowledge/` instead:

- `artifacts/*.json` records retrieval metadata, aliases, wikilinks, entities, summary, and stack readiness.
- `knowledgeUnits` inside each artifact model claims, summaries, decisions, preferences, quotes, or other future note facts through one source-backed shape with stable IDs, author/source attribution, evidence, confidence, privacy decisions, and downstream eligibility.
- `gbrain-import-queue.json` queues safe notes for structured GBrain import.
- `lossless-continuity.json` records the note create/update event for continuity capture.

Notes marked `private`, `sensitive`, or tagged with sensitive terms still get the local artifact and continuity record, but are removed from the automatic GBrain queue.

Set `JARVOS_NOTE_OPTIMIZATION=0` to disable sidecar artifact generation for a write. Set `JARVOS_KNOWLEDGE_DIR=/path/to/knowledge` to redirect sidecar output.

## Manual Obsidian note maintenance

Notes created directly in Obsidian bypass `src/write-to-vault.js`, so they need a safe maintenance path into the same stack. Run the package-owned scanner through the root shim:

```bash
npm run maintain:manual-notes
```

This is dry-run mode. It scans Notes, reports missing/invalid canonical frontmatter, checks `.jarvos/knowledge/optimization-audit.json` coverage, and predicts GBrain, memory-wiki, and QMD queue decisions without writing files.

Use a private-safe summary when the result will be pasted into Paperclip or another tracker:

```bash
node scripts/manual-notes-maintenance.js --dry-run --summary-path /tmp/manual-notes-maintenance-summary.json
```

The summary records counts and gate decisions only. The full JSON output can include note titles, paths, and hashes, so keep it local.

Apply mode is explicit:

```bash
npm run maintain:manual-notes:apply
```

Apply mode only fixes frontmatter drift that the normal linter can infer, then calls the shared optimizer for each candidate. The optimizer writes local artifacts, GBrain and memory-wiki queues for safe notes, sensitivity skip decisions for private notes, lossless continuity, and `qmd-refresh-pending.json`. Run `qmd update` and `qmd embed` after apply mode before treating QMD search as fresh.

For ongoing watcher-style maintenance, run a bounded poll from cron or a service supervisor:

```bash
node scripts/manual-notes-maintenance.js --apply --since-state --watch --max-runs 1
```

The generic pattern is portable: one scanner finds markdown notes that missed the canonical writer, one frontmatter normalizer repairs only obvious metadata drift, one sidecar optimizer routes downstream systems, and one freshness queue keeps search/index refresh explicit.

See `../../docs/operations/manual-note-maintenance.md` for the full backfill runbook: baseline audit, sample apply, batch apply, downstream refresh, and routine placement.

## AI personality entrypoint

AI personalities should not raw-write Obsidian markdown directly. Michael,
Claude Code, Hermes, and compatible assistants use the shared executable
contract:

```bash
printf '%s' '{"personality":"michael","title":"Example","content":"Body"}' \
  | node scripts/obsidian-note-journal-contract.js
```

The contract delegates to `src/write-to-vault.js`, then fails closed unless:

- the note path is under the canonical Notes directory
- canonical frontmatter is present, including the calling personality
- today's journal has exactly one `[[note title]]` backlink
- QMD/search freshness is recorded as `pending-refresh`

## Source Material provenance

External source material is linted separately from authored Notes. Durable notes use `author: jarvis|andrew|both`; Source Material markdown uses source provenance fields instead so external authorship is not collapsed into the note author schema.

See `docs/SOURCE_MATERIAL_PROVENANCE_CONTRACT.md` for the reusable metadata contract.
