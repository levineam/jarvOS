# Project Management System vision and iteration contract

**Status:** Current product-contract baseline. This document defines the vision
and the next finite milestone; it does not rename packages, change canonical
records, activate automation, or claim that source features are live.

## Vision

The jarvOS **Project Management System (PMS)** is a general-purpose loop for
writing, research, operations, and software work. It helps a person and their
agents capture meaningful work, organize it under durable goals, choose the
next authorized action, advance it through the right executor, and record an
accepted result or explicit blocker. `@jarvos/coding` is one executor
integration, not the shape of the PMS core.

## Terms and ownership

- **Project:** a durable area of responsibility or endeavor with a goal and a
  lifecycle-appropriate definition of done.
- **Child Project:** a durable Project nested under another Project. It is not
  a task merely because it is smaller.
- **Outcome:** a finite, observable result under a Project. Outcomes are the
  preferred unit for milestones that can become complete.
- **Todo:** an actionable next step linked to a Project or Outcome. A Todo is
  executable only through its separately authorized work authority and
  executor.
- **Backlog item:** captured work intentionally held outside active execution.
  Promotion to Todo needs an explicit disposition; capture is not scheduling or
  authorization.

Projects owns meaning and hierarchy. The configured work authority owns Todo
state. An authorized executor advances work. Acceptance evidence closes an
Outcome. Overseer coordination, assignment, source code, and interface tests do
not substitute for those later stages.

Any package rename, hierarchy change, or new canonical Project or Outcome
suggested by this document remains a proposal requiring review.

## Current finite goal and definition of done

Agree on this product contract and preserve an honest baseline so later slices
can harden the PMS incrementally rather than presenting the ideal end state as
already implemented.

This milestone is done when:

1. the product name, terms, and authority boundaries above are accepted;
2. public documentation distinguishes portable source capability, selected or
   configured runtime state, and live end-to-end proof; and
3. one next Outcome is selected with observable acceptance evidence, without a
   new tracker, package rename, or automation framework.

Writing and research examples illustrate the general-purpose intent. They are
not mandatory audit fixtures for this milestone.

## Honest current baseline

- The Projects source defines generic Project and Outcome records,
  parent/child relationships, goals, definitions of done, lifecycle, priority,
  bounded context packets, and evidence-provider contracts. These core records
  do not require Git, pull requests, worktrees, or a coding harness.
- Git/worktree/PR/review assumptions live in `@jarvos/coding`. They should
  remain a software executor adapter rather than become PMS invariants.
- Todo and Backlog contracts exist in source, but source availability is not
  installed proof. The current bounded orientation is incomplete: provider
  omissions, staleness, and packet truncation can leave current work absent
  from a view. That must be reported as incomplete evidence, not as no work.
- A complete autonomous loop requires a selected runtime, fresh provider
  evidence, an authorized native executor attempt, restart-safe resumption,
  and accepted result or blocker evidence. Not all of that is proven today.

## Incremental Outcomes

### 1. Capture and organize work

**Acceptance:** one fixture or explicitly authorized real item is captured once,
resolved to a canonical Project, Child Project, or Outcome, classified as
Backlog or Todo, and read back with goal, definition of done, provenance, and
duplicate disposition. No second tracker or automatic execution is created.

### 2. Advance authorized work or surface the blocker

**Acceptance:** one explicitly authorized Todo either produces a native executor
attempt and accepted result, or reaches a durable blocked state naming the
owner, reason, and next action. Restart/resume does not duplicate pickup, and
assignment is not reported as execution.

### 3. Harden verified recurring failures

**Acceptance:** one recurrence supported by real evidence receives the smallest
repair at its owning boundary, a regression check, and—when the claim is
operational—selected-runtime and visible-outcome proof. Do not generalize one
incident into a new framework without a second concrete case.

## Next slice

After this contract is accepted, reuse the existing jarvOS ownership and work
ledger to run Outcome 1 as a fixture/readback slice. Do not create a separate
PMS Project or tracker. Automation, provider migration, and package renaming
remain deferred until evidence from that slice justifies them.
