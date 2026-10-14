# SUP-4029 — approved plan → documentation → implementation → proof

## Goal and communication contract

An approved coding suggestion must retain a reviewable path from its owning plan to the documentation decision, implemented change, and behavioral proof. A completion claim must fail closed when that path is absent or stale. This issue proves the **public source behavior** only. Merge, installed runtime, live activation, and downstream adoption are separate claims; none follows from green source tests.

Owner: Codex lead. Durable record: SUP-4029. Branch: `codex/SUP-4029-approval-doc-trace` in the managed `projects-complete-roster` jarvOS worktree. The directory name predates this issue and is not a claim about the branch. No live runtime or skill projection is authorized here.

## Current state

- The public coding module has two v2 submission checks: `features/submission-gate/index.js` is a presence-oriented handoff validator; `lifecycle/policy.js` evaluates submit/complete stage status. The host control-plane verifier recomputes the latter from orchestrator evidence.
- The host's `buildSubmissionGateInput` does not carry the owning plan, changed documentation, or behavioral outcome. It can synthesize `goalAlignment: aligned` from a generic review/fix result and a passing tests entry from a fix skip. Existing successful terminal fixtures contain no plan or doc trace.
- `work-run-store` records an accepted plan digest for managed runs, but `complete` does not bind that digest to documentation and proof. Direct `runTakeIssueToDone` and managed `complete` can report `completed` based on `verifyClose` without the control-plane verifier. This is a separate, real completion surface and must not be described as gated until repaired.
- Git is the code authority. Beads is the default durable execution ledger. Projects can provide context; Paperclip is an optional one-way record, never the authorization or admission signal.

## Recommendation and alternative

Build one small, pure delivery-trace evaluator and reuse it at all source completion surfaces. The trace must name the work identity and Git plan path/digest, decide which docs changed or give a specific no-doc-impact reason, bind implementation to an observed revision/file set, and record a passed behavioral observation tied to that revision. Tests, lint, and review remain useful separate signals but cannot by themselves satisfy behavioral proof. Runtime/installed/live claims remain explicitly unproven.

The strongest alternative is to extend the managed implementation packet and accepted-plan store. That yields good provenance for managed calls, but changes a pinned packet schema and misses direct coding flows. Defer it unless source inspection shows that a single managed gate actually owns all completion paths. A compatibility flag that lets trace-less work complete is not an acceptable default.

## Stages and owned scope

1. Add focused failing cases at the real exported and terminal surfaces: absent/wrong/stale plan, omitted docs decision, affected doc missing from observed changes, specific no-doc-impact reason, implementation/proof mismatch, generic tests/review only, forged caller observation, tracker absence, and valid source trace. Record the pre-fix failure honestly.
2. Add a pure evaluator under `modules/jarvos-coding/src/features/` with a versioned pointer-only trace and concrete reason codes. Use stdlib path and SHA-256 checks. Keep the Git observation host-supplied from an existing authentic post-fix stage; never accept an observation supplied as MCP arguments or a cached `ready` blob. Reject unsafe plan paths before Git reads. A changed plan requires a new matching digest; where managed accepted-plan digest is available, require that exact match.
3. Wire the same evaluation into both submission checks and every source path that reports terminal coding completion. If a direct path cannot obtain authentic observation, return blocked/unverifiable, not completed. Preserve intake-only's no-code exception and report it as such. Bump the gate contract version because trace-less previously passing inputs must now fail.
4. Extend the existing live Git inspection only with bounded read-only argument-array commands if needed. Do not introduce shell interpolation, new runtime dependencies, tracker lookup, or private paths.
5. Update `modules/jarvos-coding/README.md` and the submission markdown, correcting known drift in goal-alignment examples. State the trace shape, what the evaluator can/cannot prove, and the source/merged/installed/live distinction. Do not modify `jarvos-skills` or its pinned manifest in this issue; a separate owner must handle any projected skill rollout.
6. Record a real SUP-4029 trace against the actual committed plan and implementation. Do not invent runtime or installed receipts. Use the PR and issue as durable links to the source proof and any justified no-doc-impact decision.

Expected source ownership: `modules/jarvos-coding/src/features/submission-gate/index.js`, `src/lifecycle/policy.js`, `src/adapters/hosts.js`, `src/features/orchestrator/index.js`, `src/features/workflow/index.js`, relevant live Git adapter and `src/index.js`; their focused tests and the module README. Add a new evaluator file only if no existing helper provides the same rule. This is an upper bound, not a mandate to edit every file.

## Acceptance evidence

- A previously successful terminal fixture with generic tests/review but no plan/doc/proof trace fails for the intended reason, then a valid trace passes. All source completion entrypoints either use the same evaluator or explicitly return a nonterminal result when they lack authentic evidence.
- The evaluator distinguishes `source` from `installed` and `live`; passing source proof never promotes either downstream level.
- A tracker record, URL, outage, or approval assertion cannot replace the Git plan/observation or alter admission. A stale plan or changed head/files blocks rather than silently re-pinning.
- Focused regression tests, the module suite, public module smoke test, full repo tests where proportional, and `git diff --check` pass. The PR records the failing baseline, passing commands, actual changed-file/doc decision, and reviewer finding disposition.
- An independent exact `gpt-6-astra`/medium read-only review of the frozen diff accepts the source claim before merge. Normal PR, CI, review and goal-alignment gates still apply.

## Risk, compatibility, rollback, stop

This intentionally makes the public submission contract stricter. Older hosts that cannot supply the trace/observation will fail closed; merging source does not install it. Existing accepted-plan store data is not migrated. Revert the source PR if incompatible; preserve issue and proof artifacts. A future host rollout needs its own compatibility/activation decision.

Stop before merge if a completion path remains spuriously successful, the baseline already rejects a claimed regression, a tracker changes the decision, Git inspection requires a shell or unsafe path, a trace cannot be produced without invented evidence, or the change would require editing private runtime/installed skill projection. Escalate that concrete gap to Andrew rather than lowering the gate.

## Planner and execution checkpoint

Full read-only plan from exact `claude-opus-5-5` on first-party Max. Result: `is_error=false`, `canonicalModel=claude-opus-5-5`, returned session `E3774B32-EC94-4739-A1A8-772B8A76A8C4`, matching the assigned persistent session. Codex lead tightened the draft's completion scope: the draft would have left direct and managed completion ungated, so that omission is now a stop condition. The same bounded CLI conversation may be resumed for the chosen Anthropic execution pass after the plan is linked and the owned paths are settled; no Desktop session is borrowed.
