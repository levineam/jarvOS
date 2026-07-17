# jarvos-coding

Portable coding-work triage for jarvOS-style operating systems.

This module owns reusable decisions about whether a coding issue belongs to a
jarvOS product lane, a release lane, a ready execution lane, or manual triage.
It is intentionally separate from Paperclip so the same shape can be adapted to
other issue trackers or AI execution systems.

## Public Interface

```js
const {
  triageCodingWork,
  runTakeIssueToDone,
  createClawpatchAutoreviewAdapter,
  runtimeCheckoutPreflight,
  inspectRuntimeCheckout,
  submissionGateContract,
  evaluateSubmissionGate,
  buildSubmissionGate,
  formatSubmissionGateMarkdown,
  validateSubmissionEvidence,
  releaseFitFromPaperclipReleaseIntake,
} = require('./src');

const triage = triageCodingWork({
  identifier: 'SUP-2000',
  title: 'Update /Users/andrew/jarvOS bootstrap docs',
  description: 'Change the public jarvOS repo install flow.',
}, {
  releaseClassification: releaseIntakeClassification,
});
```

`triageCodingWork(issue, options)` returns:

- `productFit`: `jarvos`, `support-local-ops`, `unrelated`, or `unknown`
- `releaseFit`: release-intake-backed fields such as `release-candidate`,
  `release-ops`, `release-parent`, `invalid-config`, `not-release`, or `unknown`
- `readiness`: whether the issue is ready, skipped, or needs triage
- `routing`: the portable target lane
- `decision`: `apply`, `skip`, `needs-review`, or `fail-closed`
- `evidence`: matched fields and markers used to make the decision

Adapters should persist this object as evidence, then translate the portable
decision into their own labels, documents, comments, or workflow state.

`submissionGateContract(options)` returns the stable agent-agnostic contract for
submitting coding work. It is not Michael-specific: any code-producing agent can
provide the same evidence shape before opening or completing a pull request.

`runTakeIssueToDone(input, adapters)` is the executable orchestration surface. It
runs the portable loop:

```text
claim -> branch -> sliceReview -> holisticReview -> fixRerun -> pullRequest -> postMergeSweep -> verifyClose
```

The orchestrator depends on injected tracker/git/PR/post-merge adapters and a
generic review-engine interface. The default review engine is
`createClawpatchAutoreviewAdapter(...)`, which maps `sliceReview` to `clawpatch`
and `holisticReview` to `autoreview` through an injected command runner. It does
not depend on clawd `scripts/` paths; hosts provide the commands or runners that
make sense in their runtime.

Claude Code and Codex are represented as real thin host adapters through
`createClaudeCodeHostAdapter(...)` and `createCodexHostAdapter(...)`. Both can
register the same `jarvos_coding_take_issue_to_done` MCP-style tool and
`jarvos-coding` skill descriptor when the host supplies a registry, then invoke
the same `runTakeIssueToDone` orchestrator with host-provided tracker, git, PR,
fixer, post-merge, review-engine, and session-state adapters.

```js
const {
  createCodexHostAdapter,
  createClawpatchAutoreviewAdapter,
  createMemorySessionStateStore,
} = require('@jarvos/coding');

const codex = createCodexHostAdapter({
  registry: codexRegistry,
  adapters: {
    sessionState: createMemorySessionStateStore(),
    reviewEngine: createClawpatchAutoreviewAdapter({ runner }),
    tracker,
    git,
    fixer,
    pullRequest,
    postMerge,
  },
});

await codex.register();
await codex.runTakeIssueToDone({ issueIdentifier: 'SUP-2214' });
```

`codingHostAdapterContract('claude-code' | 'openclaw' | 'codex')` remains the descriptor-only
contract for registries, docs, and setup tools that need to inspect support
without instantiating a runtime adapter.

## Control-plane compatibility

`createCodingControlPlanePort(...)` is the public, fenced compatibility port
for a control-plane manager. It accepts only the scoped
`coding.take-issue-to-done` command, invokes a selected portable host adapter,
and returns the orchestrator's final checkpoint plus pull-request,
post-merge, and close evidence. It does not create extra PR lifecycle states or
import any private host behavior.

```js
const { createCodingControlPlanePort } = require('@jarvos/coding');

const port = createCodingControlPlanePort({ host: 'openclaw', hostAdapter });
const execution = await port.executeFenced(command, {
  fence: 7,
  assertCurrentFence: () => leaseIsCurrent(),
});
const verification = await port.verify(command, { execution });
```

The port checks the fence before dispatch and again before returning. Repeated
delivery of the same command returns its original evidence rather than running
the coding/PR lifecycle again. Session-loss recovery stays pointer-first: a
command checkpoint and its existing issue, worktree branch, and PR reference
are forwarded to the host adapter as `resumeFrom`.

```js
const gate = evaluateSubmissionGate({
  issue: { identifier: 'SUP-2138' },
  git: {
    branch: 'SUP-2138/submission-gate',
    baseBranch: 'origin/main',
    clean: true,
    intendedFiles: ['jarvos-coding/src/lifecycle/policy.js'],
  },
  checks: {
    tests: [{ command: 'npx vitest run tests/scripts/jarvos-coding-submission-gate.test.js', status: 'passed' }],
    clawpatch: { status: 'passed', artifact: '.clawpatch/runs/latest.json' },
    autoreview: { status: 'recorded', artifact: 'PR review summary' },
    pullRequest: { status: 'created', url: 'https://github.com/owner/repo/pull/1' },
    paperclipEvidence: { status: 'recorded', issueIdentifier: 'SUP-2138' },
  },
});
```

The submit phase requires issue linkage, issue-named branch hygiene, tests,
clawpatch, autoreview, pull request evidence, and durable tracker evidence. The
complete phase adds post-merge clawsweeper evidence or an explicit
`not_applicable` deferral reason. Accepted statuses are stage-specific:
`recorded` is valid for autoreview and tracker evidence, but not for required
tests, clawpatch, or pull request creation; `not_applicable` is valid only for
the post-merge clawsweeper completion stage. Tool responsibilities are
deliberately non-overlapping: clawpatch is the pre-submit slice reviewer/fix
loop, autoreview is a separate automated review signal, pull requests are the
durable code-review surface, Paperclip is the source of truth for evidence, and
clawsweeper is the post-merge follow-up sweep.

`runtimeCheckoutPreflight(input, options)` returns a separate execution gate for
runtime automation. It does not create issues, mutate git state, reset working
trees, or clean files. It only classifies whether the current checkout is safe
for automation to execute.

```js
const preflight = runtimeCheckoutPreflight({
  repo: '/runtime/checkouts/clawd-main',
  branch: 'main',
  repoState: {
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    trackedChanges: [],
    untrackedFiles: [],
    nestedDirtyRepos: [],
    conflicts: [],
  },
}, {
  protectedDevCheckouts: ['/Users/andrew/clawd'],
  runtimeCheckoutMarkers: ['/runtime/checkouts/'],
});

if (!preflight.safeToExecute) throw new Error(preflight.userMessage);
```

`inspectRuntimeCheckout(repo, options)` is the git-backed adapter helper for
local runtimes that want the same shape from a real checkout. Callers should
fetch the remote before invoking it so `ahead` and `behind` are fresh, then use a
fast-forward-only update if the result is `behind_origin_main`.

Runtime preflight states include:

- `clean_origin_main_runtime_checkout`: safe to execute from the runtime checkout.
- `dev_checkout_preserve`: protected shared workspace; create or reuse a
  separate runtime checkout instead of cleaning or resetting it.
- `behind_origin_main`: fail execution until the runtime checkout is refreshed
  with a fast-forward-only update.
- `dirty_runtime_checkout`: fail execution until local work is deliberately
  preserved or removed.
- `divergent_checkout`: fail closed and recreate the runtime checkout from the
  remote base.
- `unsafe_checkout`: conflicts or nested dirty repositories block execution.

## Architecture

The module boundary is intentionally future-feature friendly:

- `src/index.js` is the explicit public API boundary. New helpers stay private
  until a caller needs a stable contract.
- `src/core/` owns portable text, label, marker, and evidence helpers.
- `src/features/triage/` owns coding-work triage decisions.
- `src/features/runtime-checkout-preflight/` owns the runtime execution checkout
  gate. This is intentionally separate from issue triage: a task can be ready
  for coding while the current checkout is still unsafe for automation.
- `src/features/review-engine/` owns the generic `sliceReview`/`holisticReview`
  interface and the default clawpatch/autoreview adapter.
- `src/features/orchestrator/` owns the executable take-an-issue-to-done loop.
- `src/features/session-state/` owns pointer-first continuity state for live
  artifact handoff and code-thread checkpoints.
- `src/adapters/hosts.js` owns host selection plus the narrow control-plane
  compatibility port; the control plane never imports coding internals.
- `src/adapters/` translates external systems into portable shapes. The current
  Paperclip adapter maps SUP-1956 release-intake classifications into
  `releaseFit` without changing the release-intake source of truth.
- `src/lifecycle/` owns maturity, fail-closed policy, and the submission gate
  contract. Supported maturity states are `experimental`, `local-dogfood`,
  `internal`, `release-candidate`, and `stable`. `jarvos-coding` currently ships
  as an `experimental` module with a `local-dogfood` Paperclip adapter, and must
  fail closed when release-intake configuration is invalid.

Marker policy is deliberately narrow. Product-fit markers prove jarvOS product
work. Release-fit comes from the release-intake adapter. Support/local ops markers
route operational work away from release lanes. Unrelated markers skip jarvOS
coding triage entirely.

## Paperclip Adapter

Paperclip consumes this module through `scripts/lib/jarvos-coding-paperclip.js`.
That adapter writes the durable `coding-triage` document on issue create/update
and keeps the historical `release-intake` behavior as a compatibility layer.

Runtime adapters should compose this with the canonical Paperclip intake/origin
contract: first create or ensure the Paperclip work with its origin envelope,
then run checkout preflight before execution. The checkout side of that adapter
should:

1. Use a dedicated runtime execution checkout, not the shared dev/state checkout.
2. Fetch the remote and update only with fast-forward semantics.
3. Call `inspectRuntimeCheckout` with `protectedDevCheckouts` for any shared
   workspace paths and `runtimeCheckoutMarkers` for managed execution roots.
4. Refuse to execute unless `safeToExecute === true`.
5. Preserve local state explicitly; never clean or reset a protected checkout as
   part of the preflight.

## Submission Gate

`submissionGateContract(options)` and `evaluateSubmissionGate(input, options)`
are the canonical portable contract/evaluator for coding work submission.

`buildSubmissionGate({ identifier })`, `validateSubmissionEvidence(...)`, and
`formatSubmissionGateMarkdown(...)` are lightweight handoff helpers used by
spawn/task-injection adapters. They are agent-agnostic: Michael, Charlie,
Codex-native subagents, and future executors get the same required evidence
before code work can be reported complete.

The required evidence keys are:

- `issue`: durable tracker issue exists before code starts.
- `branch`: issue-named feature branch, not `main`, `master`, or detached HEAD.
- `tests`: focused test/lint/build/smoke output, or an explicit no-test rationale.
- `clawpatch`: pre-PR clawpatch advisory or a documented kill-switch/intake-only exception.
- `autoreview`: pre-PR local autoreview result.
- `pullRequest`: PR URL/number, or explicit `intake-only` status when no code was submitted.

`validateSubmissionEvidence(evidence, { identifier })` fails closed when any
required evidence is missing. Use `mode: 'intake-only'` only for routing or
planning packets that intentionally do not submit code. `clawsweeper` remains a
post-merge sweep and must not replace pre-submit clawpatch, autoreview, tests,
or PR evidence.

## Continuity Contract

`jarvos_session_state` is intentionally a pointer-first surface. For markdown and
status work, the live artifact is the checkpoint: the current markdown file or
the current issue is read directly on entry, and no separate snapshot is copied.
For code work, the module checkpoints only the thin ephemeral thread that is not
already durable elsewhere:

- where the orchestrator is in the loop
- the last decision/result at that gate
- the next step
- the live issue/branch/PR pointer

Use `buildLiveArtifactPointer(...)`, `buildSessionCheckpoint(...)`,
`buildCodeThreadCheckpoint(...)`, `buildArticleThreadCheckpoint(...)`,
`createFileSessionStateStore(...)`, `readJarvosSessionState(...)`, and
`writeJarvosSessionState(...)` to expose the same shape through MCP, a vault
handoff note, or another host-local store.

Current Paperclip flow:

1. `scripts/paperclip-api.js create` builds the issue payload, asks
   `jarvos-release-intake` for the authoritative release classification, passes
   that into `triageCodingWork`, and pre-adds release labels when labels are enabled.
2. After Paperclip returns the created issue, `applyPaperclipCodingTriage`
   writes the `coding-triage` document. Non-jarvOS or unknown-fit work still
   gets a document explaining the skip or review decision.
3. `scripts/paperclip-api.js update` applies the same adapter after a successful
   issue patch, so changed titles, descriptions, or labels refresh the durable
   triage record.
4. Release-candidate and release-ops cases continue through the SUP-1956
   `jarvos-release-intake` document/update path, including `releasePlacement`,
   `targetVersion`, `releaseParentIssue`, `releaseRationale`, and
   `verificationGate`.
