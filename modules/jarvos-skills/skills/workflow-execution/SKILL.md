---
name: workflow-execution
description: Plan-first workflow for non-trivial work: define the goal, create or reuse a tracker issue, package context, execute on an issue-named branch when code changes, and verify completion with evidence.
triggers:
  - make a plan
  - plan this
  - build this
  - scaffold
  - multi-step execution
  - workflow-execution
metadata:
  jarvos:
    bundle: operating-system-skills
    portability: generic
    managedCodingProvider: compound-engineering
---

# Workflow Execution

Use this skill for meaningful work: implementation, multi-step investigation,
architecture changes, iterative bug fixing, scheduled automation, or anything
that needs durable follow-through.

## Contract

The workflow is complete only when:

- work has a clear goal and scope boundary
- execution work is tracked in the local tracker before code changes begin
- the plan and context live on the tracker issue or another durable project
  artifact, not only in chat
- code work uses an issue-named branch or equivalent review lane
- completion is verified with concrete evidence
- the issue ends in a real final disposition: done, in review, blocked with an
  owner/action, or delegated to a linked follow-up issue

## Default loop

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
7. **Verify.** Run targeted checks, inspect the diff, and record evidence.
8. **Close or hand off.** Move the issue to done only when no follow-up remains.
   Use in-review only when a real reviewer path exists.

## Managed coding verbs

When this skill is running inside a jarvOS coding profile, the natural verbs
`plan`, `work`, and `complete` use the jarvOS-managed provider route. A healthy,
approved Compound Engineering provider supplies the planning and implementation
discipline behind the scenes; jarvOS still owns the work-run, branch/worktree,
accepted plan revision, review evidence, submission gate, and completion
decision. `compound` is an explicit, post-verification learning-capture step,
not a substitute for completion evidence.

If the provider is unavailable, modified, unsupported, or fails during a run,
fall back through the generic workflow in the same work run and worktree. Do
not start a second plan, branch, or pull request. Treat provider checkpoints as
reattachment hints only and revalidate current Git, review, test, and PR
evidence before claiming completion.

## Definition of done template

```md
## Definition of Done
- [ ] Artifact or code path exists in the intended repo/workspace
- [ ] Documentation explains how to use or adapt it
- [ ] Tests or smoke checks pass
- [ ] Diff contains only intended files
- [ ] Review/merge path is clear
```

## Tracker-neutral notes

Use whatever tracker the workspace has chosen: Paperclip, GitHub Issues, Linear,
or a local markdown issue file. The invariant is not the tool. The invariant is
that execution state, plan, blockers, and proof survive the current chat.
