# Journal Install Contract

jarvOS stores durable thoughts in one canonical Markdown file per local day:

```text
<configured-journal-dir>/YYYY-MM-DD.md
```

The file is a human-owned record. Automation may create a missing scaffold and
may add an explicitly authorized backlink or section entry, but the creation
path never repairs, normalizes, replaces, or overwrites an existing journal.

## Configure before mutation

Journal mutation is fail-closed. Configure both a journal target and an IANA
timezone before using the ensure, note, or Obsidian paths.

| Input | Precedence | Accepted values | If absent or invalid |
| --- | ---: | --- | --- |
| `JARVOS_JOURNAL_DIR` | 1 | Absolute path (a `~` path is expanded against the host home) | Skip if absent or empty; reject if nonempty but malformed |
| `JOURNAL_DIR` | 2 | Legacy explicit journal-directory environment variable | Skip if absent or empty; reject if nonempty but malformed |
| `paths.journal` in the discovered config | 3 | Absolute or `~` path | Skip if absent or empty; reject if nonempty but malformed |
| `JARVOS_VAULT_DIR` / `paths.vault` | 4 | Explicit vault path; the journal target is `<vault>/Journal` | Skip if absent or empty; reject if nonempty but malformed |
| none | — | — | Reject before filesystem mutation |

The configuration file is discovered from `JARVOS_CONFIG_PATH` or
`JARVOS_CONFIG_FILE`, then an explicitly configured workspace, then the XDG
jarvOS config location. A missing file is not a permission to invent a vault.

Timezone precedence is:

1. `JARVOS_TIMEZONE`
2. `user.timezone` or `user.timeZone` in the config
3. top-level `timezone` or `timeZone` in the config

The value must be a valid IANA timezone. The process `TZ` value is not used as
an implicit journal-mutation fallback. Conflicting explicit values resolve by
the order above; nonempty malformed higher-precedence values fail closed rather
than silently falling through. Empty shell/config values are treated as
absent so an injected-but-unset variable does not mask valid configuration.

Example portable config:

```json
{
  "assistantName": "jarvOS",
  "userName": "your-name",
  "coachName": "your-coach",
  "vaultPath": "~/Documents/MyVault",
  "workspacePath": "~/Documents/jarvos-workspace",
  "runtime": "your-host",
  "paths": {
    "vault": "~/Documents/MyVault",
    "journal": "~/Documents/MyVault/Journal",
    "notes": "~/Documents/MyVault/Notes"
  },
  "user": {
    "timezone": "Europe/London"
  }
}
```

The public schema is [jarvos.config.schema.json](../jarvos.config.schema.json).
Use `JARVOS_JOURNAL_DIR` and `JARVOS_TIMEZONE` for a host-injected setup when a
config file is not appropriate.

## Supported checks and creation commands

The health command reports canonical and derived-index state independently:

```bash
node modules/jarvos-secondbrain/scripts/journal-health.js --json
node modules/jarvos-secondbrain/scripts/journal-health-alarm.js
```

The creation-only path is available through the package maintenance entrypoint:

```bash
node modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-maintenance.js \
  --create-if-missing --json
```

It creates only the configured current date. The outcome is idempotent: a
verified existing journal is reported as existing, and a concurrent winner is
reported as such. When `derivedIndex.enabled` is true, the same run may add
missing embeds for the current date and any previously created dates absent
from an existing, pure generated `Journaling.md` file. It never creates,
rebuilds, reorders, or edits an index containing human-authored content, and it
never rewrites an authored dated file. Active edits are deferred and reported
for the next window; backups and staging files stay outside the synced Journal
folder.
If deferred note backlinks are queued, the command reports that backlog and
returns a failure status so a host can alert; it does not mutate authored
journals while flushing it. Use the separate human-approved maintenance
command to reconcile those backlinks.

The older maintenance/repair command remains a separate, human-approved
compatibility operation. It is not the agent ensure path and should not be
scheduled as a replacement for the creation-only lifecycle.

## Single-writer ownership

jarvOS is the only automated creator of files in the configured `Journal/`
directory and the only automated additive writer of the generated
`Journaling.md` navigation page. Humans may edit the Markdown, and Obsidian may
sync or display it, but another daily-note automation must not create the same
dated files or compete for the index.

Do not point a second writer at the journal directory, including:

- the Obsidian Journals community plugin
- core Daily Notes
- Periodic Notes daily notes
- startup or template scripts that create a dated file there

If those tools are useful, configure them to a different folder. The lifecycle
also checks for the configured Obsidian Daily Notes writer before creating a
missing journal and reports a writer conflict instead of racing it. If a person
adds prose to `Journaling.md`, the shape gate makes the index unmanaged and the
writer stops rather than risking that content.

## Agent and host-adapter boundary

The stdio MCP server exposes two bounded actions:

- `jarvos_journal_health` is read-only and is the default status check.
- `jarvos_ensure_today_journal` accepts an empty object and should be called
  only for an explicit user request or a host-declared journal-maintenance
  trigger. It is not startup boilerplate.

Both actions use the same package lifecycle and return only status, local date,
and a bounded outcome. They do not expose paths, journal content, hashes,
timestamps, receipt locations, or host provenance. Arbitrary paths, dates,
repair flags, provenance, and unknown fields are rejected before filesystem
access.

Host schedulers and runtime adapters own their own delivery, retry, and
operational evidence. They inject the public configuration; they do not become
part of this package's canonical journal or release contract.

## Recovery principle

If health reports a missing or invalid canonical file, stop and inspect the
configuration and writer ownership first. Do not use an automated repair to
make an authored journal look healthy. Restore authored content from the
vault's own history or backup, then run the read-only health check again.
