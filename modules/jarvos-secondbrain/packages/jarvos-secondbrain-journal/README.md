# jarvos-secondbrain-journal

Package-owned Journal contract and maintenance logic for the `jarvos-secondbrain` monorepo.

## What lives here

- `config/journal-module.json` — canonical daily journal structure contract
- `src/journal-maintenance.js` — journal creation/repair entrypoint
- `docs/` — package boundary and contract decisions

## What stays outside the package core

These remain outside the package because they are bridge/provenance or adapter wiring, not core journal ownership:

- `$CLAWD_DIR/scripts/journal-paperclip-inbox.js` — Paperclip bridge projection into the journal
- `$CLAWD_DIR/scripts/journal-note-audit.js` — provenance audit across journal and notes
- `$CLAWD_DIR/scripts/lobster-utils/link-to-journal.js` — provenance helper for note backlinks
- `$CLAWD_DIR/references/heartbeat-procedures.md` — OpenClaw heartbeat wiring

`CLAWD_DIR` defaults to `~/clawd`; override with the `CLAWD_DIR` env var.

## Compatibility shims

Current `clawd` automation still expects these root paths:

- `$CLAWD_DIR/config/journal-module.json`
- `$CLAWD_DIR/scripts/journal-maintenance.js`

For this extraction pass:

- the root config remains as a compatibility mirror for existing heartbeat wiring
- the root maintenance script becomes a thin shim that delegates to the package-owned implementation

That keeps the current journal creation/repair flow working while making the package boundary real in code/layout.
