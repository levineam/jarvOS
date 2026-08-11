# jarvos-secondbrain-journal

Package-owned journal lifecycle and health contract for the public
`jarvos-secondbrain` monorepo.

## Canonical ownership

`Journal/YYYY-MM-DD.md` is the canonical daily thought record. The lifecycle
has one creation path:

1. resolve an explicitly configured journal directory and valid IANA timezone
2. calculate the configured local date
3. create the missing file with exclusive creation
4. re-read and verify the winner

If the file already exists, the creation path does not normalize, repair,
replace, or rewrite it. An authorized note/backlink caller may use the separate
active-day mutation seam after existence has been ensured; that seam is not a
repair authority.

When the Obsidian app is running, jarvOS owns journal policy but Obsidian's
`app.vault` API owns live file mutation. A write completes only after
app-owned readback confirms the intended section or exact content, so Obsidian
Sync observes the same content that reached disk.

Canonical journal health and the derived `Journaling.md` index are reported
separately. When enabled, the scheduled pass may add missing embeds for the
current date and previously created dates to an existing pure-generated index;
it never creates, rebuilds, reorders, or edits an index containing
human-authored prose. Health remains read-only, and active index edits are
deferred.

## Configuration boundary

Journal mutation requires explicit configuration. The supported precedence is:

1. `JARVOS_JOURNAL_DIR`, then legacy `JOURNAL_DIR`
2. `paths.journal` in the discovered `jarvos.config.json`
3. `JARVOS_VAULT_DIR` or `paths.vault`, deriving `<vault>/Journal`
4. fail closed when no explicit journal target exists

Timezone precedence is `JARVOS_TIMEZONE`, then `user.timezone`/
`user.timeZone`, then top-level `timezone`/`timeZone`. Every selected value must
be a valid IANA timezone. The process `TZ` value is not a mutation fallback.

The package does not contain a user-specific vault, home-directory, scheduler,
runtime, or provenance default. Host adapters inject configuration and own
delivery/retry evidence outside this package.

The manifest-owned OpenClaw scheduler must inject
`OPENCLAW_EXTERNAL_CRON_EXECUTION_PROVENANCE=scheduled` (or `catch-up`), plus
its run ID and source/runtime revisions. A creation run without that trusted
trigger is recorded as manual evidence and cannot quiet the scheduled health
alarm.

## Single-writer rule

JarvOS is the only automated creator for the configured journal directory.
Humans may edit the Markdown and Obsidian may sync or display it, but automated
Daily Notes, Periodic Notes, Journals, template startup scripts, and similar
writers must target another folder. The lifecycle reports a configured Daily
Notes writer as a conflict before creating a missing file.

## Human commands

Read-only health:

```bash
node modules/jarvos-secondbrain/scripts/journal-health.js --json
node modules/jarvos-secondbrain/scripts/journal-health-alarm.js
```

Creation-only ensure:

```bash
node modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js \
  --create-if-missing --json
```

If deferred note backlinks are queued, this command reports the backlog and
returns a failure status for host alerting; it does not flush or rewrite
authored journals.

The older maintenance command can still perform human-approved repair and
deferred-backlink reconciliation for compatibility. It is intentionally not
the scheduled or agent creation path.

If an authorized offline write is necessary, maintenance reports
`saved_locally_sync_pending` and retains a reconciliation operation outside the
vault. It must not report the journal synchronized until Obsidian later
acknowledges that operation.

## Agent access

The stdio MCP server exposes:

- `jarvos_journal_health`: read-only status for today
- `jarvos_ensure_today_journal`: empty-input, today-only ensure

Health is the default agent action. Ensure is reserved for an explicit user
request or a host-declared journal-maintenance trigger, not ambient startup.
Both tools return a bounded status/date/outcome projection and reject paths,
dates, repair flags, provenance, and unknown fields before filesystem access.
