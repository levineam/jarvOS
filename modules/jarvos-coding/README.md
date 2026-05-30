# @jarvos/coding

Portable coding orchestration for jarvOS.

This module owns the generic "take an issue to done" loop:

1. claim the issue
2. create or select the branch
3. run a slice review
4. run a holistic review
5. fix and rerun when review findings block the work
6. open the pull request
7. run the post-merge sweep
8. verify the Definition of Done and close the issue

The orchestrator is host-agnostic. Paperclip, GitHub, git, and runtime-specific
behavior are passed in as drivers. Review is also swappable through a tiny
review-engine interface:

```js
const reviewEngine = {
  async sliceReview(request) {
    return { ok: true, findings: [], evidence: {} };
  },
  async holisticReview(request) {
    return { ok: true, findings: [], evidence: {} };
  },
};
```

## Default Review Engine

`createDefaultReviewEngine()` returns the default clawpatch + autoreview adapter.
It invokes generic commands from `PATH`:

- `clawpatch review --json` for slice review
- `autoreview --json` for holistic review

Those command names are configurable, and the runner is injectable for host
adapters and tests. The module does not depend on clawd's local `scripts/`
directory.

## Basic Usage

```js
const {
  createCodingOrchestrator,
  createDefaultReviewEngine,
} = require('@jarvos/coding');

const orchestrator = createCodingOrchestrator({
  reviewEngine: createDefaultReviewEngine(),
  issueDriver,
  branchDriver,
  fixDriver,
  pullRequestDriver,
  postMergeDriver,
  verificationDriver,
});

await orchestrator.runTakeIssueToDone({
  issueId: 'SUP-1234',
  branchName: 'SUP-1234/short-slug',
  definitionOfDone: 'Tests pass, PR reviewed, post-merge sweep complete.',
});
```

Each stage emits audit events through the configured `auditSink`. Without a
custom sink, the returned result includes an in-memory `auditTrail`.
