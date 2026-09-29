---
name: workflow-execution
description: "Mode-aware workflow for non-trivial work: iterate cheaply in an exploratory lane, or plan, track, execute, and verify work that is being hardened for real use."
triggers:
  - make a plan
  - plan this
  - build this
  - scaffold
  - prototype
  - vibe code
  - vibe-code
  - multi-step execution
  - workflow-execution
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
    managedCodingProvider: compound-engineering
    codex:
      implicitInvocation: managed coding intent only
---

# Workflow Execution

Use this skill for meaningful work. Match process weight to the artifact's
current lifecycle instead of treating every edit as production code.

## Keep the result in view

Separate the next useful result from the eventual finished product. Reuse and
surface relevant existing work before adding machinery. The checkpoint is a
usable passage for writing, a rendered concept for design, a source-backed
answer for research, or the requested working behavior for software—not the
outline, design system, source collection, or test suite supporting it.

Before expanding, show what the checkpoint establishes and the important
uncertainty that remains. Direct the next iteration toward that uncertainty;
if the approach becomes expensive without useful evidence, narrow or change
it. Routine reversible choices within scope remain autonomous; material scope
changes and existing authority boundaries require the user's decision.

Persist the current mode, immediate question, next visible result, bounded
budget, and excluded work in the existing handoff or durable project artifact.
Recover these on resume before taking action; the eventual product goal must
not silently replace the current checkpoint. No new tracking layer is needed.

## Choose the lane

Choose once at the start and state the choice. Reclassify when the boundary
changes.

### Exploratory / vibe-code lane

Use this lane when the immediate goal is learning, taste, a directional model,
or a disposable prototype; the work is private, reversible, and not yet relied
on by a production runtime, external consumer, release, migration, security or
authorization boundary, financial action, or publication.

Keep only the controls needed for useful learning:

1. Name the question or visible result being explored and the surfaces that
   must not change.
2. Preserve dirty work and use an existing isolated branch, worktree, scratch
   artifact, or other reversible lane.
3. Produce the smallest visible checkpoint early. Prefer a working screen,
   sample output, provisional calculation, or concrete draft over a complete
   plan.
4. Run local smoke checks proportional to the current claim. Record important
   assumptions and label the output exploratory, provisional, or unverified.
5. Iterate from user feedback. Do not require a tracker issue, full plan,
   planner/executor/reviewer stack, exhaustive tests, or release-quality docs
   before the direction is accepted.

Routine exploratory iterations should use deterministic local tools and one
model context. Avoid repeated full-context reloads, model ensembles, and
review passes whose precision does not change the next user decision.

Exploratory completion means delivering a useful answer to the named question,
with proportionate checks and disclosed uncertainty—or a concrete limitation
and the smallest next experiment. Code existing does not promote the work to
hardening, and approving a direction alone is not a request to ship it.

This lane never relaxes authority or safety. It cannot be used to bypass an
approval, security, privacy, spending, destructive-action, publication,
release, migration, or live-runtime gate.

A consequential defect requires the necessary narrowly scoped containment and
verification; it does not promote unrelated exploratory work to production.

### Hardening / production lane

Use the full workflow below when the work already crosses a consequential
boundary, or when the user says the direction looks right and asks to ship,
merge, harden, productionize, make it robust, or make it bulletproof.

At promotion, freeze or identify the exploratory candidate, create or reuse the
tracker issue, and plan the remaining hardening work. Earlier smoke checks do
not become production evidence retroactively; add the tests, review,
documentation, migration and rollback proof the real boundary requires.

## Hardening contract

For hardening work, the workflow is complete only when:

- work has a clear goal and scope boundary
- execution work is tracked in the local tracker before code changes begin
- the plan and context live on the tracker issue or another durable project
  artifact, not only in chat
- code work uses an issue-named branch or equivalent review lane
- completion is verified with concrete evidence
- the issue ends in a real final disposition: done, in review, blocked with an
  owner/action, or delegated to a linked follow-up issue

## Hardening loop

1. **Classify.** Decide whether the request is coordination or execution. Pure
   Q&A can be answered directly. Execution needs tracking.
2. **Track.** Create or reuse the smallest issue that matches the work. Check for
   active or completed duplicates before opening a new one.
3. **Plan.** Capture goal linkage, scope boundary, definition of done,
   constraints, risks, and ordered steps.
4. **Package context.** Attach the plan, relevant design notes, links, and test
   expectations where the executing agent can retrieve them without chat memory.
5. **Route.** Decide which repo/workspace owns the change before editing.
6. **Execute.** Make the smallest coherent change that can satisfy the definition
   of done. Preserve unrelated local changes.
7. **Verify.** Run targeted checks, inspect the diff, and record evidence of the
   intended user outcome. Green builds and tests support, but do not replace,
   proof that the requested behavior works at the claimed boundary.
8. **Close or hand off.** Move the issue to done only when no follow-up remains.
   Use in-review only when a real reviewer path exists.

## Test authoring check

Before adding or changing a test, reason through four questions: what behavior
or independent contract does it protect; what credible regression makes it
fail; why does existing coverage miss that failure; and would the test require
a production API, flag, wrapper, or injection hook used only to inspect
internals? These are a thinking aid, not four required written answers or a
review ceremony. Preserve useful dependency injection that exercises a real
boundary, and reject only production seams that exist solely for test
introspection.

Prefer the cheapest useful check through the real owning boundary. Retain
useful unit tests and independent security, storage, and API boundary tests.
When adding a regression test for a bug fix, demonstrate when reproducible that
the focused regression fails on the broken code for the intended reason and
passes after the fix; otherwise record the honest unavailable or flaky limit.
A success check must fail when the intended behavior breaks; `unavailable` is
not success. Routine verification must not start shared live or subscription
runtimes; use disposable local fixtures when an integration path is needed.

## Managed coding workflow (hardening)

These managed run, submission, and merge obligations apply to hardening work,
not merely because an exploratory artifact contains code. Existing safety and
authority gates apply in both lanes.

When this skill is running inside a jarvOS coding profile, the natural verbs
`plan`, `work`, and `complete` use the jarvOS-managed provider route. A healthy,
approved Compound Engineering provider supplies the planning and implementation
discipline behind the scenes; jarvOS still owns the work-run, branch/worktree,
accepted plan revision, review evidence, submission gate, and completion
decision. `compound` is an explicit, post-verification learning-capture step,
not a substitute for completion evidence.

In a jarvOS-managed Codex profile, start with `jarvos_coding_repositories` when
an opaque repository identifier is needed, then use one durable run through
`jarvos_coding_plan`, `jarvos_coding_accept_plan`, `jarvos_coding_work`, and
`jarvos_coding_finish`. Use `jarvos_coding_status` or `jarvos_coding_resume` to
continue that run. Never infer a repository root, provider, executable,
credential, or registry path from the request.

If the provider is unavailable, modified, unsupported, or fails during a run,
fall back through the generic workflow in the same work run and worktree. Do
not start a second plan, branch, or pull request. Treat provider checkpoints as
reattachment hints only and revalidate current Git, review, test, and PR
evidence before claiming completion.

Inside a jarvOS-managed coding run, code work finishes through this managed workflow
rather than stopping at a local commit or open pull request. When the exact
pull-request head is aligned with the tracked goal and every required submission
gate is clean, merge it autonomously and close the tracked work; routine non-author approval is not a
gate. Outside such a run, follow the host's normal
submission and merge authority. Stop only for unclear goal alignment, a required failed or missing gate,
branch or path policy, or separate authority for publication, live activation,
spending, destructive action, or an external send.

## Hardening definition of done template

```md
## Definition of Done
- [ ] Intended user outcome is demonstrated at the claimed boundary
- [ ] Artifact or code path exists in the intended repo/workspace
- [ ] Documentation explains how to use or adapt it
- [ ] Tests or smoke checks pass
- [ ] Bug regressions include reproducible fail-then-pass proof or an honest limit
- [ ] Diff contains only intended files
- [ ] Review/merge path is clear
```

## Tracker-neutral notes

Use whatever tracker the workspace has chosen: Paperclip, GitHub Issues, Linear,
or a local markdown issue file. The invariant is not the tool. The invariant is
that hardening execution state, plan, blockers, and proof survive the current
chat. Exploration may use its existing artifact or handoff for the smaller
checkpoint; it does not require a tracker issue.
