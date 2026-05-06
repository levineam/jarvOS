# adapters/openclaw

OpenClaw runtime wiring around `jarvos-secondbrain` packages.

## journal-maintenance job

Use `src/journal-maintenance-job.js` when registering the daily journal
maintenance cron. It emits:

- `schedule`: defaults to `1 0 * * *` (12:01 AM, first safe minute of the local day)
- `timezone`: explicit IANA timezone to pass to the cron/job API
- `command`: `node $CLAWD_DIR/scripts/journal-maintenance.js` (the compatibility shim expected by current OpenClaw workspaces)

Resolution preserves explicit overrides:

1. `JARVOS_JOURNAL_MAINTENANCE_SCHEDULE` / `JARVOS_JOURNAL_MAINTENANCE_TIMEZONE`
2. `jarvos.config.json` → `jobs.journalMaintenance.schedule/timezone`
3. inherited local timezone from `JARVOS_TIMEZONE`, config, `USER.md`, system detection
4. `UTC` as the documented last-resort fallback

Passing `timezone` is intentional; the package default means “12:01 AM local,”
not UTC midnight.
