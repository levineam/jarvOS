# jarvOS Project Management System (PMS)

A structured project hierarchy your AI assistant can read, write, and reason about — without you managing it manually.

## The Hierarchy

```
Portfolio          (strategic theme — e.g., "Mission Control")
  └── Program      (cluster of related projects — e.g., "AI Coaching")
        └── Project Board    (active project — the main tracking doc)
              ├── Project Brief   (scope, goals, success criteria)
              ├── Plan            (execution phases + decision log)
              └── Tasks           (concrete work items)
```

Every active project has three companion documents: a **Board** (status + milestones), a **Brief** (why it exists and what done looks like), and a **Plan** (how to get there).

## How It Works

### The Board tracks state
The Project Board is the living document. Milestones with checkboxes, recent work log, current status. Your assistant reads this to know what's happening and updates it as work completes.

### The Brief defines scope
The Project Brief is the contract. Goals, success criteria, stakeholders, what's in/out of scope. When work drifts, the Brief is what pulls it back.

### The Plan drives execution
The Plan has four locked sections:
1. **Decisions Confirmed** — what's been decided (no re-litigating)
2. **Execution Phases** — ordered steps with verification per step
3. **Autonomous Now** — work the assistant can do without asking
4. **Needs You** — decisions, approvals, or input only you can provide

This division is the point. Your assistant works from **Autonomous Now** without being asked, routes blockers through **Needs You**, and doesn't confuse the two.

### Tasks flow through lanes
Every task has a board linkage and a status:
- **Backlog** — captured but not started
- **In Progress** — actively being worked
- **Blocked / Needs You** — waiting on user input
- **Done** — completed with verification

## Governance (Optional but Recommended)

For projects that matter, add governance minimums:
- **Portfolio + Program link** — connects to your strategic hierarchy
- **3-6 milestones** with concrete exit criteria
- **Decision gates** — points where you review before the next phase
- **Stop/pivot conditions** — when to kill or redirect the project

The governance layer means your assistant can flag when a project drifts from its goals, has stale milestones, or orphaned tasks that don't connect to anything.

## OKRs (Optional)

For quarterly planning, OKR boards connect to the project hierarchy:
- **Objectives** — what you want to achieve this quarter
- **Key Results** — measurable proof of progress
- **Linked Projects** — which projects drive which KRs

Your assistant can surface: "This project isn't linked to any OKR — is it still a priority?"

## Session Lifecycle (Advanced)

When you have multiple active projects, your assistant can spend significant time re-parsing every board on every request. The **session lifecycle pattern** solves this by creating a single structured snapshot of your project state that all consumers read instead.

See [`session-lifecycle.md`](./session-lifecycle.md) for:
- The snapshot field schema (`working_on`, `blocked`, `decisions`, `next`)
- How sync and freshness checking work
- How to implement it in any runtime
- Consumer contract and fallback requirements

This is an optional layer — the core PMS works fine without it. Add it when you have 5+ active projects or when multiple agents/scripts need consistent board state within a session.

## Getting Started

1. Copy the templates from this directory into your workspace
2. Create your first Portfolio (just a name and mission)
3. Create a Project Board for whatever you're working on
4. Let your assistant read the README and templates — it will understand the structure

The system is designed to be readable by both humans and AI. When something doesn't work the way you expect, reading the relevant file usually tells you why.
