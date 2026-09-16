# SUP-3820: concise skill decision digest

Status: implementation and independent acceptance complete; submission gates pending. Owner: current Codex task, reporting to permanent Overseer.
Mode: hardening. Existing Skill Sync outcome; source-only follow-up to the merged owner-decision implementation.

## Outcome and boundary

One hourly occurrence produces one comprehensible digest instead of a burst of detailed messages. Bound the visible detail, disclose the complete unresolved count, and provide working next actions and access to every durable decision. Preserve source safety, per-decision authorization, recurrence, dedupe, acknowledge/defer/resume and reply correlation.

No runtime activation, scheduler changes, live decision mutations, or external notification proof is authorized by this follow-up. Verification uses disposable fixtures and rendered output. Merging follows required repository gates; activation and live proof remain separate.

## Execution

- Start from merged public commit d9cbce239f8293c13e66272886d98059b7f89e15 on codex/SUP-3820-concise-skill-digest.
- Fable reads the actual public notification, decision and CLI contracts and proposes the smallest compatible design.
- One Anthropic executor implements the settled design and focused regression tests.
- Codex verifies real rendered output, durable decision preservation and transport compatibility, then obtains independent Astra-medium acceptance.
- Commit, submit and merge only when aligned and required checks pass. Report source completion separately from activation and live proof.

Budget: one bounded planning call, one implementation pass, one acceptance review; corrections only for concrete defects.

## Accepted design and continuity

The completed full Fable plan was served by `claude-fable-5-1` on the first-party subscription route (session `2a791d09-a92e-42bd-9354-69b7edc70a80`, successful, no permission denials). Do not duplicate that call after resume. Implementation uses Opus for the paired transport integration risk; independent Astra-medium acceptance is the documented review-of-record equivalent for this workflow.

Emit one batch preview of at most four decisions, with an additive `pendingCount` and a supported owner list request for all remaining decisions. Keep the complete per-decision ledger and reminder claims, existing single-decision handling, and legacy chunk compatibility. The private sender records acceptance of a digest and prevents later membership changes in that occurrence from producing another decision prompt. Later occurrences remain eligible. No preview rotation or new command surface is needed for this bounded fix.

The existing issue was read successfully. A progress-comment attempt was rejected by the tracker authorization boundary; no credential or ownership workaround was attempted. The permanent Overseer owns tracker reconciliation. Preserve source, test and review evidence here until that write boundary is resolved by an authorized owner.

Next: satisfy exact-head submission gates or report the precise blocked gate to the permanent Overseer. Live activation remains excluded.

## Verification and acceptance

- Opus implementation completed successfully with exact first-party `claude-opus-5`, session `1b09aba4-4c9b-4321-a9dd-b14e10b42c80`, no permission denials. No fallback was used.
- Focused public notification and scheduled-repair tests: 58 passed. Decision lifecycle: 33 passed. Operator/source assessment: 49 passed.
- Broader public skills/runtime-kit run: 508 of 509 passed; the unchanged HTTP gateway timing test failed under parallel load and its complete file passed 18 of 18 independently. Sequential full-module rerun is pending.
- Paired private sender/transport suites: 301 passed. Capture-router regression suite: 61 passed.
- Real public renderer to private parser and fake transport: 110 pending, four shown, 106 hidden, 1,406 characters; one accepted send for the occurrence, zero additional sends on exact retry, changed preview or batch-to-single, one send next hour. No live network calls.
- Independent Astra-medium review accepted the frozen paired diffs with no P1/P2 findings. Public diff SHA-256: `243a71eb861aa0f1bc88daae591a6b9dc9ff88f9d6bc439daa5dcdc316e5bc26`; private: `c502daf55c23bd07e7c715d5dc4c8d71ff331798ed08bbdeef3ac6b34ad48f51`. These hashes exclude this execution-evidence document.
- Goal alignment: the change directly reduces the observed message burst, keeps complete durable decisions and owner-only action semantics, and adds no scheduling or send authority. No unrelated source changes are included.

## Acceptance

- One message for a production-sized backlog, with bounded text, accurate counts and working detail/list instructions.
- All pending decisions remain retrievable; no omitted item is resolved, acknowledged or dropped.
- Single decisions and empty runs remain correct.
- Same occurrence does not duplicate delivery; later occurrences remain eligible.
- Paused, deferred and resolved decisions retain their existing behavior; unsafe sources gain no sharing authority.
- Existing private transport can parse and correlate the new digest, or a minimal paired correction is required before merge.

## Rollback and stop

Revert the source change before a later managed deployment if acceptance fails. Preserve existing live selections. A future deployment must pair the public producer with the compatible private sender. Once `digest: true` delivery receipts exist, rollback must preserve reader support for that field; the older private runner fails closed on it, so reverting the runner alone is not a valid rollback. Never delete accepted receipts to enable rollback. Stop for a missing provider route, unresolved integrity defect, failing required gate or new activation/send authority.
