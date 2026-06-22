# jarvos-secondbrain-journal

Package-owned Journal contract and maintenance logic for the `jarvos-secondbrain` monorepo.

## What lives here

- `config/journal-module.json` — canonical daily journal structure contract
- `src/journal-maintenance.js` — journal creation/repair entrypoint with stub regression repair
- `docs/` — package boundary and contract decisions

## Single-writer contract

jarvOS is the automated writer for generated `Journal/YYYY-MM-DD.md` sections.
Obsidian Sync can sync the vault across devices, and humans can keep editing the
markdown file, but Obsidian daily-note plugins should not independently create
or populate the same journal path.

Disable or de-scope automated daily-note creation in:

- the Journals community plugin
- the core Daily Notes plugin
- Periodic Notes
- Templater startup scripts that create daily notes

`jarvos doctor --obsidian-vault /path/to/vault` reports those conflicts when an
Obsidian `.obsidian` directory is available. It also warns when
`jarvos.config.json` points at a stale vault, journal, or notes path.

## Stub and shrink repair

Maintenance records known-good daily journal snapshots under:

```text
<vault>/.jarvos/journal-maintenance/
```

Before any repair, the current file is copied into `audit-backups/`. If a
frontmatter-only stub replaces a populated journal, the next maintenance pass
restores the known-good content, normalizes the configured sections, and updates
the known-good snapshot. Non-stub files are normalized from the current file so
human-authored text remains the source of truth.

Cron/default runtime installs should run maintenance for both `today` and
`yesterday`, including a post-startup morning pass:

```bash
node scripts/journal-maintenance.js --dates=today,yesterday
```

The default cron manifest runs this at 00:01 and again at 09:07
America/New_York so device or Obsidian startup stubs get caught after sync.

## What stays outside the package core

These remain outside the package because they are bridge/provenance or adapter wiring, not core journal ownership:

- `~/clawd/scripts/journal-paperclip-inbox.js` — Paperclip bridge projection into the journal
- `~/clawd/scripts/journal-note-audit.js` — provenance audit across journal and notes
- `~/clawd/scripts/lobster-utils/link-to-journal.js` — provenance helper for note backlinks
- `~/clawd/references/heartbeat-procedures.md` — OpenClaw heartbeat wiring

## Compatibility shims

Current `clawd` automation still expects these root paths:

- `~/clawd/config/journal-module.json`
- `~/clawd/scripts/journal-maintenance.js`

For this extraction pass:

- the root config remains as a compatibility mirror for existing heartbeat wiring
- the root maintenance script becomes a thin shim that delegates to the package-owned implementation

That keeps the current journal creation/repair flow working while making the package boundary real in code/layout.
