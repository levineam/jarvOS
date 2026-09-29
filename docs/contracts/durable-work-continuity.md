# Durable work continuity contract

**Status:** public contract, source-level. Installed activation is a separate,
host-owned step.

This contract lets metadata-only evidence of durable work flow from a harness
lifecycle collector into Projects, and lets a fresh session in another harness
hydrate the exact target Project — without transcripts, prompts, commands, or
copied history crossing the boundary.

## 1. Durable work event — `jarvos.durable-work-event/v1`

Module: `modules/jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/durable-work-event.js`.

| Field | Shape |
|---|---|
| `eventKind` | exactly one of `commit`, `merged_pr`, `migration_applied`, `deployment_ready`, `production_verified` |
| `harness` | bounded lowercase token (`claude`, `codex`, …) |
| `sessionDigest`, `repositoryDigest` | 64-hex host-keyed digests |
| `worktreeDigest`, `branchDigest` | 64-hex digest or `null` |
| `pullRequest` | positive integer or `null` (required for `merged_pr`) |
| `commitOid` | 40/64-hex Git object id or `null` (required for `commit`) |
| `subjectRef` | opaque id such as a migration version or deployment id (required for the three external kinds) |
| `causalKey` | `dwe_<32 hex>`, derived — never asserted by the caller |
| `evidenceRefs` | 1–16 opaque `class:id` tokens, e.g. `git-commit:<oid>`, `marker:<id>` |
| `occurredAt`, `observedAt` | ISO timestamps, `occurredAt ≤ observedAt` |
| `invocationRef` | `inv_<32 hex>`, a one-way digest of the dispatcher invocation nonce |

Validation rejects unknown keys, paths, URLs, whitespace-bearing (command- or
prompt-shaped) values, credential shapes, oversize strings (event ≤ 4 KiB), and
a `causalKey` that does not match the durable fact.

The causal key is deterministic over `eventKind`, `repositoryDigest`,
`commitOid`, `pullRequest`, and `subjectRef` only. It deliberately excludes
session, harness, worktree, branch, evidence, and times, so the same commit seen
from Claude and Codex, or from a linked worktree, is one causal fact.

`projectDurableWorkEvent(event, { canonicalId, producerId })` projects a valid
event into the unchanged `jarvos.verified-activity/v1` receipt: `eventId` and
`dedupeKey` are the causal key, `kind` is `durable_work_<eventKind>`,
`sensitivity` is `metadata-only`, and `evidenceRefs` are the event's refs plus
`harness:<harness>`. Session digest, invocation reference, worktree, and branch
never enter the canonical record. The host signs the projection with its
existing `createHostAdmission` authority.

## 2. ActivityStore replay

An identical replay is now a true no-op: no new generation, no `CURRENT`
rewrite, unchanged state digest (`status: 'deduped', replay: 'identical'`). A
replay that adds evidence references still merges and advances the generation
(`replay: 'evidence_merged'`). Signed admission, the `expectedGeneration`
guard, causal-conflict quarantine, and the unattributed lane are unchanged.

## 3. Repository binding — `jarvos.repo-binding/v1`

Module: `src/repo-binding.js`. Bindings and observations carry only host-keyed
digests (`bindingToken(kind, value, secret)`); `normalizeRemote()` folds https,
ssh, scp-like, and credential-bearing remotes to `host/owner/repo`. A binding
carries at most one qualifier.

Precedence: **explicit worktree → repository + pull request → repository +
branch → single unqualified repository.** Results are `bound` with the tier, or
`unattributed` with a typed reason:

- `unmapped` — no binding names the repository;
- `unqualified` — the repository is shared by qualified bindings only and the
  observation carried no matching qualifier (no child is guessed);
- `ambiguous` — one tier matched more than one canonical record;
- `invalid` — malformed input.

A linked worktree shares its primary checkout's repository identity (the
normalized remote, or the resolved Git common directory when there is no
remote), so it resolves to the same Project unless an explicit worktree
binding pins it elsewhere.

## 4. Target hydration — `jarvos.target-hydration/v1`

Module: `src/target-hydration.js`. `assessTargetHydration()` checks a packet
build result for the exact target record and the durable-work causal keys the
host expects, and reports `present`, `partial`, or `omitted` with typed
omissions:

`scope`, `generation_mismatch`, `item_limit`, `byte_limit`, `age_window`,
`render_truncation`, `provider_unavailable`, `unbound`.

A missing target is never reported as a healthy quiet packet.

`presentCausalKeys` is structured packet presence. When rendered text is
supplied, `renderedCausalKeys` is the subset that appears in that text, and
each structurally present key missing from it is a `render_truncation`
omission keyed by that causal key. The agent-context renderer appends the
causal key to a titled durable-work summary line so it can be acknowledged.

## 5. Conformance

`src/durable-work-conformance.js` with
`fixtures/durable-work/conformance.json` runs, against an isolated work
directory: redaction rejections, signed admission, generation guard, identical
replay no-op, evidence merge, causal-conflict quarantine, unsigned and
wrong-producer rejection, every binding precedence/ambiguity case including
linked-worktree equivalence, and every typed target omission. A harness adapter
passes its own `admission` and `producerId` to prove it meets the same bar.

## 6. Runtime seam

Module: `modules/jarvos-runtime-kit/src/durable-work-collect.js`.

- `session-event` is an **optional** dispatcher action
  (`OPTIONAL_STEWARDSHIP_ACTIONS`). The ordered required action ABI is
  unchanged; adapters list it under `bootstrap.optionalActions`.
- `validateCollectResponse()` admits only the exact
  `jarvos.durable-work-collect/v1` receipt: status, trigger, invocation
  reference, ≤ 16 causal keys, bounded counts, and a receipt digest.
- `extractCandidateRoots()` inspects hook input in memory only for explicit
  absolute roots; command text is never returned, logged, or persisted.

Harness wiring:

| Harness | Collection point | Registration |
|---|---|---|
| Claude Code | `PostToolUse` (Bash, git/gh/marker commands) and `Stop` via `jarvos-session-event-hook.js` | setup registers only when the selected dispatcher's provenance probe advertises `session-event`; fail-open wrapped; rollback removes owned entries only |
| Codex | the existing automatic `UserPromptSubmit` turn hook, before the Projects refresh | no new Codex hook events; runs only when the managed dispatcher sets `JARVOS_DURABLE_WORK_COLLECT=1` |

Both paths use a 2-second hard budget, never inject context, and fail open.

The `projectsContextStart` / `projectsContextRefresh` calls in both harnesses
also pass the harness-reported session `cwd` as a transient candidate root
(`JARVOS_DURABLE_WORK_CANDIDATE_ROOTS`), so a host bridge can bind a fresh
session to its repository's Project and hydrate that exact target. A host that
does not implement binding ignores the variable.

## Authority boundaries

Observing an event is not authority to cause or complete it. This contract
never completes a Todo, closes a Project, merges, migrates, deploys, publishes,
or spends. Ambiguous or unmapped evidence stays in the unattributed lane.
