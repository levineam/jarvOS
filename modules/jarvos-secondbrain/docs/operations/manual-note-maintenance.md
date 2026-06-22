# Manual Note Maintenance

Intentional capture through `jarvos-capture` is the primary path for notes and ideas created by AI agents. Notes created manually in Obsidian can still enter the secondbrain stack through the manual-note maintenance command.

## Contract

Run `manual-notes-maintenance` against the canonical `Notes/` directory. The command audits Markdown files, normalizes fixable frontmatter, writes knowledge sidecars, updates the QMD pending queue, and queues eligible units for generated wiki and GBrain promotion.

Safe defaults:

- `--dry-run` is the default audit mode.
- `--apply` is required before any note or sidecar write.
- `--since-state` limits ongoing maintenance to changed or not-yet-audited files.
- `--watch` is available for a long-running worker, but a scheduler should normally invoke bounded runs.

Example dry run:

```bash
node packages/jarvos-secondbrain-notes/src/manual-notes-maintenance.js \
  --notes-dir "$JARVOS_NOTES_DIR" \
  --knowledge-dir "$JARVOS_KNOWLEDGE_DIR" \
  --since-state \
  --dry-run \
  --json
```

Example apply run:

```bash
node packages/jarvos-secondbrain-notes/src/manual-notes-maintenance.js \
  --notes-dir "$JARVOS_NOTES_DIR" \
  --knowledge-dir "$JARVOS_KNOWLEDGE_DIR" \
  --since-state \
  --apply \
  --json
```

## Routine Placement

Prefer a tracker-owned routine over local cron when one is available. The routine should create or run a bounded daily maintenance task with visible success/failure output.

Routine shape:

- Scope: manually-created or externally-created Markdown notes under the configured `Notes/` directory.
- Cadence: daily, plus manual on-demand runs before release checks.
- Cost posture: local Node process; no model call required.
- Success signal: nonzero scanned count or clean unchanged report, no errors, QMD pending queue updated when applicable.
- Failure signal: command exit nonzero, frontmatter unfixable files, or sidecar write errors.
- Follow-up: run QMD update/embed after apply mode before treating QMD search as fresh.

Do not use this routine to ingest every AI conversation. It is only for notes that already exist or were intentionally created.
