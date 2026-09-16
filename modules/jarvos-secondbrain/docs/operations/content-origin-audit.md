# Content-origin audit and backfill

Operator procedure for `jarvos-content-origin/v1` coverage in a vault.

Module: `modules/jarvos-secondbrain/bridge/provenance/src/content-origin-audit.js`

## What the audit does

It reads. That is the whole contract:

- It opens notes and `Journal/YYYY-MM-DD.md` files for reading only.
- It never writes a vault byte, never calls a model or an embedding service,
  and never invokes Active Assistant.
- It returns counts, not content: contract state, origin, basis, eligibility,
  and a **closed** writer bucket. Note bodies, journal bullets, marker text,
  source receipts, and stored frontmatter values never appear in the report.
- Filenames are omitted unless you pass `--include-paths`. A vault filename is
  itself private content, so opt in deliberately. When included they are
  normalized POSIX paths relative to the notes or journal root — opting in adds
  paths and nothing else.

## Writer buckets are a closed vocabulary

`source_personality` and `source` are free-text frontmatter. A real vault
carries URLs, file paths, capture receipts, and whole sentences in them, so a
bucket that echoed the stored value would put vault content into a report whose
entire contract is counts-only — and it would do it in the default report, which
does not even emit filenames.

A stored value is therefore reported only when it matches a known identifier
exactly. Everything else aggregates:

| Bucket | Meaning |
| --- | --- |
| `personality:<name>` | A supported personality (`claude-code`, `codex`, `hermes`, `michael`) |
| `source_kind:<id>` | A declared canonical writer id from the writer inventory |
| `other_attributed` | Some other attribution; the stored text is discarded, not reported |
| `unattributed` | Neither field carries anything |

An operator who needs to know *which* unrecognised writer is behind an
`other_attributed` count reads the notes themselves, deliberately — the audit
will not do it for them.

## Traversal

The walk is **recursive**, depth-bounded, and symlink-free:

- Nested notes (`Notes/Projects/Something.md`) are scanned. A flat scan
  under-reports coverage, and an under-report on a provenance audit reads as
  "everything is declared" when it is not. `notes.nested` counts how many
  scanned notes live below the root.
- Journal days are matched on the file name, so `Journal/2026/2026-09-02.md`
  counts and `Journal/archive/notes.md` does not.
- Symlinked directories and symlinked notes are **never followed**. A symlinked
  directory can point anywhere on disk, including outside the vault, and a
  symlinked note is not a file this audit can honestly claim to have read in
  place.
- Dotted entries (`.obsidian`, `.trash`) are skipped as tool state.

## Running the audit

```bash
node modules/jarvos-secondbrain/bridge/provenance/src/content-origin-audit.js \
  --notes-dir "$VAULT/Notes" --journal-dir "$VAULT/Journal"
```

Reported contract states:

| State | Meaning |
| --- | --- |
| `declared_v1` | Explicit `jarvos-content-origin/v1` frontmatter |
| `declared_other_version` | A declaration this build does not recognise |
| `legacy_author_only` | No declaration; only a legacy `author` field |
| `undeclared` | No declaration and no legacy author |

`degraded_declarations` counts notes that claim an origin their stored bytes no
longer support — for example a `human` note whose receipt digest no longer
matches the body after a later rewrite. Those resolve to `unknown` at read time.

`journal.marked` / `journal.unmarked` count bullets with and without the hidden
marker. An unmarked bullet reads downstream as an unmarked manual entry, so a
rising `unmarked` count on days when only agents wrote is a real finding.

## Backfill

Backfill is deliberately two steps, and neither one is implicit.

1. **Plan.** `planContentOriginBackfill` proposes a frontmatter-only change for
   every note that is not `declared_v1`. Every proposal is
   `unknown` / `unknown` / `human_evidence_eligible: false`. Nothing is
   inferred from `author`, personality, model, harness, or prose — ambiguity is
   recorded as ambiguity. Making the unknown explicit is the point: it stops a
   stored `author: andrew` from being read as human material later.

   Paths are withheld unless you pass `includePaths: true` (CLI:
   `--include-paths`), for the same privacy reason the audit withholds them.
   Apply needs them, so an operator who intends to apply plans with paths
   deliberately; a path-less plan is refused at apply time
   (`plan_paths_withheld`) rather than guessed at.

   Every proposal records `sourceDigest`, the SHA-256 of the exact bytes the
   proposal was computed from.
2. **Apply.** `applyContentOriginBackfill` refuses to touch anything unless
   `apply === true` *and* the caller supplies the canonical note writer. The
   module never opens a vault file for writing itself.

```bash
# Proposals plus per-proposal eligibility. Writes nothing.
node modules/jarvos-secondbrain/bridge/provenance/src/content-origin-audit.js \
  --backfill --include-paths --notes-dir "$VAULT/Notes"
```

The CLI has no apply mode on purpose. Applying a backfill is composed
explicitly against the supported note mutation path:

```js
const { planContentOriginBackfill, applyContentOriginBackfill } =
  require('./bridge/provenance/src/content-origin-audit');

const plan = planContentOriginBackfill({ notesDir, includePaths: true });

// Read-only: reports, per proposal, whether apply could prove byte preservation.
const dryRun = applyContentOriginBackfill({ plan, notesDir });

const result = applyContentOriginBackfill({ plan, apply: true, notesDir, writeNote, restoreNote });
```

`writeNote` is called with
`{ title, content, frontmatter, preserveExistingBodyBytes: true, expectedExistingContent }`
and must forward every one of those to the canonical note writer (`writeNoteFile`)
and return its result unchanged. `preserveExistingBodyBytes` is the supported
metadata-only capability described below; a seam that drops it makes the write a
legitimate but non-byte-identical re-render, which the post-write check then
reports as an integrity violation rather than an applied repair.
`expectedExistingContent` is the exact bytes the preflight proved against; see
[Concurrency](#concurrency-the-write-is-bound-to-the-preflight-bytes). A seam
that drops it gets no `stateBinding` back from the writer, and apply reports
`writer_did_not_bind_expected_state` and aborts.

### Apply runs a fail-closed preflight

A plan is data. It may have been produced minutes ago, written to a file,
re-read, or hand-edited, so apply treats every proposal as untrusted input and
proves each of the following **before** any mutation:

| Refusal | Meaning |
| --- | --- |
| `plan_paths_withheld` | The plan carries no path; re-plan with `includePaths` |
| `path_absolute` | The proposal named an absolute or drive-qualified path |
| `path_escape` | A `..` segment, a backslash segment, or a path resolving outside the notes root |
| `path_not_markdown` | Not a `.md` file |
| `symlink` | A symlink somewhere on the path, including the note itself |
| `not_a_regular_file` | The target is not a regular file |
| `proposal_unverifiable` | The proposal carries no `sourceDigest` |
| `stale_proposal` | The note's bytes no longer match `sourceDigest` |
| `no_longer_applicable` | The note is already `declared_v1` and not degraded |
| `writer_path_mismatch` | The supported writer resolves this title to a different file (nested notes land here) |
| `not_a_metadata_only_replace` | The supported writer would not produce a whole-content `replace` |
| `expected_state_mismatch` | The operation's pre-state does not match the bytes just read |
| `body_bytes_would_change` | The predicted post-write body is not byte-identical |
| `preflight_failed` | The supported writer could not build an operation for this note at all |

The decisive check is the last one. `createNoteMutationOperation` is pure: for a
frontmatter-only provenance change on an existing note it returns a `replace`
carrying both the exact next content and the `expectedHash` of the pre-state. So
the raw body remainder is compared byte-for-byte against the stored body before
anything is committed, and the commit is compare-and-swap against the preflight
bytes themselves (next section). The declaration written is always this module's
`unknown`/`unknown`/ineligible record, never the `next` block carried in the
plan, so a hand-edited plan cannot smuggle a `human` claim through backfill.

Note the comparison is **untrimmed**. Two bodies that differ only in trailing
bytes are not the same body, and reporting that as preserved is how a silent
rewrite gets recorded as a success.

### Concurrency: the write is bound to the preflight bytes

The writer re-reads the note when it runs. A fresh read is not proof that the
note still matches what the preflight proved, so apply does not rely on it:

- Apply passes the exact preflight bytes as `expectedExistingContent`.
- The writer builds the operation from those bytes, not from its own read, so the
  submitted `replace` carries `expectedHash` of the preflight state. If its own
  read already disagrees it refuses before submitting anything; an `append`
  transform or `create` cannot carry the guard and is refused too.
- The mutation executor commits only if the note still hashes to that guard.
- The writer returns `stateBinding: { expectedHash, contentHash }` — the guard it
  submitted and the hash of the content it asked to commit.

A change to frontmatter, declaration, or body at any point between preflight and
commit therefore ends as `status: conflict`, `reason: changed_since_preflight`.
Nothing is committed, nothing is restored, and the run continues: a guarded
conflict is the model working, not an integrity violation.

### The metadata-only writer capability

By default the canonical writer re-renders a note's body around canonical
frontmatter, which is a legitimate write but not a byte-identical one: the
renderer emits a blank separator line that the stored remainder already carries.
So the preflight builds the operation with `preserveExistingBodyBytes: true`, a
narrow supported option that puts canonical frontmatter in front of the stored
body remainder and leaves those bytes alone. The writer permits it only for an
existing note, a provenance/frontmatter rewrite, no append entry, and content
that already matches the stored body; anything else is refused — never quietly
downgraded — and the refusal surfaces here as `body_bytes_would_change` or
`not_a_metadata_only_replace`. `expectedHash` and the mutation boundary are the
same either way.

A note whose body does not begin with its `# <title>` heading is refused by this
same check (`body_bytes_would_change`): the canonical writer would insert a
heading, and that is a body edit, not a frontmatter repair.

### If the post-write check ever disagrees

Each written note is re-read and judged against the writer's `stateBinding`.
Recovery may only ever undo bytes this repair provably produced; anything else on
disk belongs to someone else and is preserved:

| Situation | Result | Restore? |
| --- | --- | --- |
| Receipt is not `committed` / `already_satisfied` / `saved_locally_sync_pending` | `conflict` (`changed_since_preflight`) or `failed` (`mutation_not_committed:<status>`) | Never |
| Persisted receipt, but no binding or a binding for a different pre-state | `failed`, `writer_did_not_bind_expected_state`; run aborts | Never |
| File hash is not the binding's `contentHash` (someone wrote after the commit) | `conflict`, `changed_after_write`; run aborts if the body moved | Never |
| File hash is exactly `contentHash` and the body changed (the writer misbehaved) | `failed`, `body_changed_after_write`; run aborts | Yes, guarded by `contentHash` |

In the last case the pre-image is handed to the optional `restoreNote` seam with
`expectedHash` set to the hash of that exact output — never the hash of whatever
was observed last — and the seam must go through the same guarded mutation
boundary, so an edit that lands before the restore turns it into a conflict
instead of being erased. `rollbackAttempted` / `rolledBack` report what happened.
With no seam supplied, `rollbackAvailable: false` says so plainly rather than the
run pretending it recovered.

An abort means every remaining proposal is `skipped` with
`aborted_after_integrity_violation`. One anomalous write must not cascade.

`mutated` is true as soon as the supported writer was invoked at all, so an
operator never reads `mutated: false` off a run that reached the mutation
boundary.

Journal backlinks are untouched. Backfill changes note frontmatter only.

There is no bulk journal rewrite and no bulk reclassification. If a specific
note needs a different origin, repair it through the supported note contract
with the evidence that justifies it. Nested notes are reported by the audit but
are never backfilled in place, because the canonical note writer is flat by
construction; repairing one means moving it or extending the writer, not letting
the backfill create a second copy at the root.
