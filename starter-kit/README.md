# jarvOS Starter Kit

## Mandatory Flow: Kickoff Before Build

Before writing implementation code, complete project planning artifacts:

1. Fill `templates/PROJECT-KICKOFF-PACK.template.md`
2. Define OKRs (objective + measurable KRs)
3. Initialize `templates/OKR-TASK-BOARD.template.md`
4. Ensure each task maps to a KR and passes quality gates
5. Begin build only after kickoff gate is fully checked

This keeps execution outcome-driven, auditable, and portable.

## Runtime Onboarding Defaults (Core)

Runtime onboarding behavior is inherited from jarvOS core templates (`jarvos/templates/AGENTS-template.md` + `jarvos/templates/BOOTSTRAP-template.md`):
- activation-first onboarding finish (1-3 concrete activation tasks)
- brief-first setup (daily + weekly brief/review early)
- proactive next-work closeouts (1-3 concrete options, unless user explicitly ends)
- "search the last X days" interpreted as web-first lastXdays research, with local recall as support

## Project Governance Policy v1 (Default)

All project work should follow this baseline:
- link projects to Portfolio + Program by default
- if no fit exists, set `Program: Incubator` with reason + review date
- keep `Project Board.md` + `Project Brief.md` as a required pair
- maintain 3-6 milestones/decision gates per project
- hotfixes can start fast, but governance backfill is required in the same session

## Included Reusable Templates

- `templates/PROJECT-KICKOFF-PACK.template.md`
- `templates/OKR-TASK-BOARD.template.md`

## Modules

The starter kit is backed by three executable modules in `modules/`. To verify they work:

```bash
# From the repo root
node tests/modules-smoke-test.js
```

To use a module in your project code:

```js
// Track a lesson learned
const { createMemoryRecord } = require('../modules/jarvos-memory/src');
const mem = createMemoryRecord({
  class: 'lesson',
  content: 'Brief-first setup reduces context switching.',
  source: 'project-kickoff',
});

// Record a project goal in the worldview
const { createLayer } = require('../modules/jarvos-ontology/src');
const goal = createLayer('goal', {
  statement: 'Ship v1 of the new feature by end of Q2 2026.',
  targetDate: '2026-06-30',
});

// Create a journal entry
const { createJournalEntry } = require('../modules/jarvos-secondbrain/src');
const entry = createJournalEntry({
  date: new Date().toISOString().slice(0, 10),
  title: 'Project kickoff',
  body: 'Completed kickoff pack. Defined 3 KRs.',
  tags: ['kickoff', 'project'],
});
```

See [`modules/README.md`](../modules/README.md) for the full module reference.
