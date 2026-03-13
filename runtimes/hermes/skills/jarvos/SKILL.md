---
name: jarvos
description: "jarvOS personal AI operating system — project management, ontology alignment, governance, and behavioral rules for your assistant."
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [productivity, governance, project-management, personal-os]
    category: productivity
---

# jarvOS — Personal AI Operating System

## When to Use
- When managing projects, tasks, or plans
- When the user asks about goals, priorities, or alignment
- When making decisions about what to work on next
- When escalating blockers or decisions to the user
- When creating new projects, boards, briefs, or plans
- When doing reflection or alignment checks

## Core Concepts

### Project Management System (PMS)
Projects live in a hierarchy: **Portfolios → Programs → Project Boards → Tasks.**

Every active project has three companions:
- **Project Board** — milestones, status, recent work log
- **Project Brief** — scope, goals, success criteria (the "contract")
- **Plan** — execution phases with four sections:
  - *Decisions Confirmed* — no re-litigating
  - *Execution Phases* — ordered steps with verification
  - *Autonomous Now* — work you can do without asking
  - *Needs You* — decisions only the user can make

**Key rule:** Every task must link to a Project Board. No board = ungoverned.

### ONTOLOGY.md
The alignment map: Purpose → Beliefs → Mission → Values → Goals → Projects.

Use it for:
- **Goal tracing** — every project should trace to a Goal
- **Orphan detection** — flag projects/goals not connected to anything
- **Alignment checks** — compare recent work against Mission and Values
- **Prioritization** — Mission > Values > Goals > Projects

### Governance
- **Escalation ladder** for decisions: Blocked / Why now / Options / Recommended / Default
- **Approval gates**: external sends, spending, deletion, config changes require explicit approval
- **Autonomy levels**: L0 Observe → L1 Draft → L2 Auto-execute → L3 Approval required

## Procedure

### When creating a new project:
1. Create a Project Board with milestones
2. Create a Project Brief with scope and success criteria
3. Link to the relevant Portfolio and Program
4. Create a Plan if the work is non-trivial

### When the user asks "what should I work on?":
1. Check ONTOLOGY.md for active Goals
2. Check Project Boards for "Autonomous Now" items
3. Check Tasks for In Progress / highest priority items
4. Surface any blockers from "Needs You" sections

### When blocked on a decision:
Use the escalation ladder format:
```
**Blocked:** [what's stuck]
**Why now:** [why this matters today]
**Options:** A) ... B) ... C) ...
**Recommended:** [best option and why]
**Default if no response by [time]:** [what I'll do]
```

### During reflection / alignment checks:
1. Read ONTOLOGY.md
2. Compare recent work against stated Goals
3. Flag orphaned projects (no Goal link)
4. Flag stale Goals (no active project)
5. Check Predictions for review dates
6. Surface any drift between stated values and actual time allocation

## Pitfalls
- Don't create projects without Board + Brief — ungoverned work gets lost
- Don't re-litigate Decisions Confirmed unless new evidence appears
- Don't skip the "Needs You" section — decisions that aren't captured get dropped
- Don't auto-approve external sends — always use the approval gate

## Verification
- Every active project has Board + Brief + Plan
- Every task links to a Board
- ONTOLOGY.md Goals have at least one active linked project
- Escalation items include all five fields
