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
- `src/content-origin-contract.js` — the portable `jarvos-content-origin/v1`
  vocabulary, receipt validation, and the hidden journal marker
- `src/content-origin-evidence.js` — the clean evidence projection consumers read
  instead of parsing notes or markers themselves
- `src/content-origin-writers.js` — the machine-checkable canonical writer and
  transform inventory
- `src/content-origin-audit.js` — read-only audit plus the apply-gated backfill
- `src/lib/provenance-config.js` — shared path/config resolution for provenance helpers

## Content-origin contract

`jarvos-content-origin/v1` records intellectual origin, not authorship
metadata. Origins are closed: `human`, `assistant`, `mixed`, `unknown`. Bases
are `verbatim_user`, `user_derived`, `assistant_generated`,
`mixed_composition`, `unknown`, and the read-time-only `legacy_author`.

A programmatic `human` claim requires a resolvable user capture event, actor
`user`, a source digest, and a stored-content digest that still binds the
stored bytes. Missing, malformed, conflicting, or digest-mismatched proof
resolves to `unknown` and stays context-only. No runtime identity —
`author`, personality, model, harness, or prose style — substitutes for that
evidence.

Notes persist five frontmatter fields (`content_origin_schema`,
`content_origin`, `content_origin_basis`, optional `content_origin_source`,
`human_evidence_eligible`). Every supported write to an existing note persists
that record in the same operation that writes the prose: when the normalized
declaration differs from the stored one — including when the note stores none —
the canonical writer replaces the whole note rather than selecting an
append-only transform, so a pre-contract note cannot keep taking new prose and
stay undeclared. Journal bullets carry an adjacent hidden marker
bound to the digest of the clean bullet text; the marker never contains source
prose and is stripped from any clean text used for embeddings or prompts.

## Writer inventory

`src/content-origin-writers.js` holds the declared inventory. Enforcement has
two halves, both asserted by `tests/content-origin-writer-conformance.test.js`:

- **Modules.** `discoverCanonicalWriterModules` scans the tree for calls to
  `writeNoteFile`, `createNoteMutationOperation`, and
  `appendLineToJournalSection`. Every discovered module must appear in
  `CANONICAL_WRITERS` with a declaration mode, and every declared module must
  still be a writer. A new writer that never declares how it emits the contract
  fails the suite.
- **Transforms.** Every transform registered by `createJarvosVaultTransforms`
  must appear in `JOURNAL_BULLET_TRANSFORMS`. New material journal bullets go
  through `journal-section-line@2`, which requires a `contentOrigin` payload and
  writes the marker. `journal-section-line@1` is retained only so operations
  already recorded in the mutation ledger still replay.

An unmarked material bullet is not neutral: `parseJournalEntry` reads it as an
unmarked manual entry, which is the read path for Andrew's own typing. That is
why journal writers must declare rather than omit. A bullet that is only a note
wikilink is the one exception — it carries no content of its own, and the
linked note's frontmatter holds the declaration.

## Audit and backfill

`src/content-origin-audit.js` is a read-only reporter and a separate,
explicitly gated repair path. The walk is recursive and never follows a
symlink; paths appear only when the operator opts in, and opting in adds
normalized relative paths only. Writer attribution is reported through a closed
vocabulary — a supported personality, a declared writer id, `other_attributed`,
or `unattributed` — because `source_personality` and `source` are free text and
a report that echoed them would leak vault content through its own keys. Apply
runs a fail-closed
preflight that proves the post-write body bytes are identical before anything is
committed, so no note is mutated in the hope that its body survives. The repair
goes through the canonical writer's `preserveExistingBodyBytes` option — the
supported metadata-only capability that keeps the stored body remainder byte for
byte — which the writer refuses for anything but a frontmatter rewrite. See
`docs/operations/content-origin-audit.md` for the operator procedure.

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

## Coding-tool capture role

AI coding tools should normally enter through `bridge/capture` and
`scripts/jarvos-capture.js`. When a host still uses the compatibility
note/journal contract, this bridge is the guardrail that keeps the write
deterministic: canonical Notes directory, canonical `Journal/YYYY-MM-DD.md`,
exactly one daily journal backlink, canonical frontmatter, and QMD
pending-refresh evidence. OpenClaw, Codex, Claude Code, Hermes, and future
coding agents should share this behavior instead of raw-writing vault Markdown.

## Verification

Safe compatibility verification can be done against temp directories with env overrides:

- `JOURNAL_DIR=/tmp/... node scripts/lobster-utils/link-to-journal.js`
- `printf '%s' '{"personality":"michael","title":"Smoke","content":"Body"}' | VAULT_NOTES_DIR=/tmp/notes JOURNAL_DIR=/tmp/journal JARVOS_KNOWLEDGE_DIR=/tmp/knowledge node scripts/obsidian-note-journal-contract.js`
- `JOURNAL_DIR=/tmp/... VAULT_NOTES_DIR=/tmp/... node scripts/journal-note-audit.js --json`
