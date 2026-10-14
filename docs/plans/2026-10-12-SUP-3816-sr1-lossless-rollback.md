# SR1 lossless rollback source plan

Work reference: SUP-3816 SR1. This records the settled, bounded rollback design
and its proof-first test, not a new planning round or a live rollback.

## Accepted scope

Give the work-run store an exact-predecessor rollback path from v2 back to v1
without losing any record. The public file store gains `retireWorkspaceIndex()`;
nothing else changes. This turn adds only the RED proof
(`modules/jarvos-coding/test/work-run-rollback.test.js`) and this plan; the
production change and the README map come in a later turn.

## Settled design

- `retireWorkspaceIndex()` mutates under the existing transaction and lock.
- Already v1: idempotent, no commit (bytes and revision unchanged).
- Refuses any held or `handoff_pending` binding and any non-null
  `run.workspaceId`, returning `{ ok: false, reason }` without writing.
- Released v2: removes `workspaceBindings`, deletes null `workspaceId` keys,
  sets `schemaVersion` to v1, keeps `workspaceFenceSeq` and every other record,
  and advances `revision` by one.
- v1 validation accepts an optional nonnegative safe-integer
  `workspaceFenceSeq`, and still rejects bindings and non-null
  `run.workspaceId` (so `v1HidingBindings` still fails closed).
- The next bind re-upgrades from the retained high-water, never from 0.
- No sidecar, snapshot restore, label-only trick, workflow, export or caller
  change. The status reader does not gain `retireWorkspaceIndex`.

## Predecessor pins

- Commit `26fe64ff9be7b9533e9a04f7868d1a25bb448ac3`.
- Store blob `d61106265bd0ba0cf4f4b11b7c013bb069916a5c`.
- Require closure, under `modules/jarvos-coding/`: `src/features/work-run-store/index.js`,
  `src/providers/workflow-provider.js` and `src/providers/compound-engineering.js`.
  The old factory is `createFileWorkRunStore`.

## Acceptance (source only)

- AC1: genuine old26fe creates v1 run, event and follow-through records. The
  candidate reads and writes them, and the first bind upgrades the state to v2.
  The pin check runs first.
- AC2: retirement is refused while a binding is bound or `handoff_pending`,
  with bytes unchanged. An incumbent lock gives a busy refusal and keeps the
  lock. An interrupted save (EISDIR) keeps the bytes and releases the lock.
  Retiring an already-v1 state changes neither bytes nor revision. An invalid
  fence high-water (negative, fractional, unsafe or string) fails closed.
- AC3: old26fe read and write both refuse released v2 with the real
  invalid-schema error. After retirement, old26fe reads every original record
  and writes, releases and reclaims a new run. All pre-rollback records
  deep-equal their earlier values, except the deleted null `workspaceId`
  pointers. Every successful mutation advances the revision.
- AC4: the high-water survives old writes, and the rebind issues the prior
  high-water + 1. Every old workspace token returns `stale_binding_fence`, and
  superseded run owners and fences return `stale_fence`.
- AC5: re-upgraded v2 refuses old reads and writes without changing bytes. The
  optional frozen ae723 proof is named as omitted; the exact 26fe proof cannot
  be omitted.
- AC6: existing tests and config stay unchanged, including `v1HidingBindings`.
  The host runs them later.
- AC7: the pure status reader reads converted v1 without taking the lock,
  creating anything or writing, and has no `retireWorkspaceIndex`.

## Quiescence and the old26fe lock defect

The old26fe writer does not have the modern single-lock
load/decide/commit semantics. Run rollback only when the store is quiescent and
has exactly one writer: stop managed writers, retire with the candidate, then
let only the old build write. Rolling forward again needs the same quiescence.
The proof uses a single in-process writer at a time and does not claim old26fe
concurrency safety.

## Methods (pstack, native FILE plus host-run tests; not COMMAND)

- Launch: the host runs `node --test modules/jarvos-coding/test/work-run-rollback.test.js`.
  Set `JARVOS_REQUIRE_PREDECESSOR=1` to make an absent predecessor fail instead
  of skip.
- Doctor: the pin check runs `git rev-parse --verify` for the commit and blob,
  then `git cat-file blob`, and re-hashes the bytes against the blob id. It uses
  argv arrays only, with no shell, checkout or index mutation.
- Drive: the old store is required from a fresh `jarvos-rollback-*` temp root,
  and the candidate comes from `require('../src')`. Only exported factories and
  methods are used.
- Evidence: optional `JARVOS_ROLLBACK_EVIDENCE_DIR`. It is refused if it resolves
  inside a fixture root. Each stage writes one JSONL line with the label,
  state sha256, revision, record inventory and fence high-water. The file is
  kept after cleanup.
- Cleanup: `t.after` removes only the exact `jarvos-rollback-*` roots this file
  created directly under `os.tmpdir()`, never production roots.
- Helpers: `loadPredecessor`, `seedWithOld`, `driveCandidate`, `oldWrites`,
  `committed` and `recorder`. These are test-local, with no new library, CLI or
  production option.

## Limits and continuation

Expected RED until `retireWorkspaceIndex()` lands, and no result is claimed
here. Source merge does not show installed or live rollback. Steward review,
the private checkout and production-data gates, and any live rollback are
separate and need their own owner and authority. There is no installer,
controller or scheduler change. Stop on failed gates, a pin mismatch, scope
expansion or missing authority.
