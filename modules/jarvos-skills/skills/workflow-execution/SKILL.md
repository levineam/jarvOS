---
name: workflow-execution
description: Plan-first jarvOS workflow for non-trivial coding work. Use it for planning, implementing, resuming, checking status, or finishing a managed coding run; it calls the jarvOS coding MCP tools and does not require Compound Engineering commands.
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
    codex:
      implicitInvocation: managed coding intent only
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

## Managed coding workflow (Codex)

In a jarvOS-managed Codex profile, use the `jarvos-coding` MCP tools for ordinary
coding intent: plan, accept the plan when the repository policy allows it, work,
finish, check status, or resume. Start with `jarvos_coding_repositories` when a
repository identifier is needed, then use this sequence for one subject:

1. `jarvos_coding_plan`
2. `jarvos_coding_accept_plan`
3. `jarvos_coding_work`
4. `jarvos_coding_finish`

Use `jarvos_coding_status` or `jarvos_coding_resume` to continue an existing
run. The MCP contract accepts only an owner-provisioned opaque repository ID;
never supply or infer a repository root, executable, credential, provider, or
registry path from the request. The deterministic direct invocation is the
recovery path when implicit skill selection does not occur.

jarvOS owns the durable run, accepted plan revision, canonical worktree,
verification, and completion decision. If the approved managed provider is
unavailable, modified, unsupported, or fails, jarvOS uses its bounded native
coding fallback in that same managed run and worktree. Do not start a second
plan, branch, or pull request. Compound Engineering is an implementation detail;
users do not need to invoke it manually. Automatic learning capture is guaranteed
only after eligible jarvOS-managed runs that reach jarvOS-verified completion,
not for arbitrary unmanaged Codex edits.

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
