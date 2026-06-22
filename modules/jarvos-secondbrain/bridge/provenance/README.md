# bridge/provenance

Bridge-owned provenance helpers for **cross-package** note ↔ journal linking and audit.

## Why this lives here

This logic does **not** belong to either package core:

- `jarvos-secondbrain-journal` owns daily chronology and journal structure
- `jarvos-secondbrain-notes` owns durable note writing and note schema
- `bridge/provenance` owns the contract that preserves linkage **between** them

That keeps provenance first-class without re-blurring package ownership.

## Canonical source files

- `src/link-to-journal.js` — add a note backlink into the daily journal
- `src/journal-note-audit.js` — audit/fix note ↔ journal link integrity
- `src/note-journal-contract.js` — one executable note creation/update contract
  that writes the note, verifies canonical frontmatter, verifies exactly one
  daily journal backlink, and records QMD pending-refresh state
- `src/lib/provenance-config.js` — shared path/config resolution for provenance helpers

## Compatibility shims kept in `clawd`

Existing automation still calls these root-level paths:

- `scripts/lobster-utils/link-to-journal.js`
- `scripts/obsidian-note-journal-contract.js`
- `scripts/journal-note-audit.js`

Those files now act as shims that delegate to the canonical bridge-owned sources above.
This preserves current behavior while making bridge ownership explicit in the monorepo.

## Contract

`bridge/provenance` may:

- resolve note and journal locations
- write backlinks into the journal
- audit/fix note ↔ journal integrity
- expose one fail-closed note/journal contract for AI personalities
- expose narrow CLI entrypoints for provenance workflows

`bridge/provenance` should **not**:

- become the canonical note writer
- own journal section structure
- absorb Paperclip execution logic
- broaden into generic routing or package-core behavior

## Verification

Safe compatibility verification can be done against temp directories with env overrides:

- `JOURNAL_DIR=/tmp/... node scripts/lobster-utils/link-to-journal.js`
- `printf '%s' '{"personality":"michael","title":"Smoke","content":"Body"}' | VAULT_NOTES_DIR=/tmp/notes JOURNAL_DIR=/tmp/journal JARVOS_KNOWLEDGE_DIR=/tmp/knowledge node scripts/obsidian-note-journal-contract.js`
- `JOURNAL_DIR=/tmp/... VAULT_NOTES_DIR=/tmp/... node scripts/journal-note-audit.js --json`
