# Journal Backlink Recovery

Use this workflow when the canonical note writer has recorded a deferred
journal backlink. It reconciles the queue through the supported CLI; do not
edit the queue JSON by hand.

## Safety contract

- Recovery defaults to a JSON dry run. Without `--apply`, it reports proposed
  outcomes and does not change a journal or deferred-backlink queue.
- `--apply` is the explicit write boundary. Review the dry-run report and take
  a queue backup before applying it to a live vault.
- Recovery links only validated notes. Version 2 queue entries require the
  exact `jarvos_note_id` at the recorded path; a moved note may be located only
  when that identity has one unambiguous match. Identity mismatches and
  duplicate matches remain unresolved and leave the journal unchanged.
- Legacy entries use exact title evidence only. Similar-looking titles are not
  a match.
- A manual reconciliation retains the queue record and its history, then
  reopens it as `pending`; it never deletes the evidence trail.

## Inspect the queue first

Run from the repository root. This is the default behavior, but spelling out
`--dry-run` makes an operational transcript unambiguous:

```bash
npm --prefix modules/jarvos-secondbrain run maintain:journal-backlinks -- \
  --dry-run --json
```

Review each proposed outcome before continuing. In particular, stop on
`unresolved` outcomes: they need a real identity or path decision, not a
best-effort retry.

## Apply reviewed retries

Only after review, run the same operation with the explicit write flag:

```bash
npm --prefix modules/jarvos-secondbrain run maintain:journal-backlinks -- \
  --apply --json
```

An apply can update the queue's state, retry a verified backlink, and write the
single canonical journal link when needed. Preserve the dry-run and apply JSON
receipts with the maintenance evidence.

## Reconcile one known path

Use manual reconciliation when an entry's note moved and an operator has
identified the correct canonical Notes-relative Markdown path. First validate
the candidate without writing:

```bash
npm --prefix modules/jarvos-secondbrain run maintain:journal-backlinks -- \
  --dry-run --key '<queue-key>' --note-path 'Notes/Projects/Actual Name.md' --json
```

Then intentionally reopen that one queue record for normal recovery:

```bash
npm --prefix modules/jarvos-secondbrain run maintain:journal-backlinks -- \
  --apply --key '<queue-key>' --note-path 'Notes/Projects/Actual Name.md' --json
```

The selected note must be a safe, vault-relative `Notes/.../*.md` path with a
`jarvos_note_id`. If the queue entry already records an identity, it must match
exactly; otherwise the command fails closed. A successful manual reconciliation
records the adopted or confirmed identity and leaves the entry pending for the
regular recovery pass.

## Optional live Obsidian smoke

Normal tests are deterministic and do not launch Obsidian. A workstation
release check may explicitly opt into the live smoke:

```bash
JARVOS_LIVE_OBSIDIAN_SMOKE=1 \
JARVOS_LIVE_OBSIDIAN_JOURNAL_PATH='Journal/YYYY-MM-DD.md' \
JARVOS_LIVE_OBSIDIAN_NOTE_PATH='Notes/Existing Note.md' \
  npm --prefix modules/jarvos-secondbrain run test:obsidian-live
```

Run this only against an already-linked real note and canonical journal in the
intended vault. The smoke requires a supported, registered Obsidian CLI and a
running app; it verifies vault identity, note identity, and the existing exact
backlink before issuing two production no-op mutations. The supplied paths may
be vault-relative as shown (or absolute paths within the configured vault).
It compares the journal before and after, so it must not create a test note,
journal, or backlink. This is an opt-in workstation gate, not CI or routine
queue maintenance.
