# jarvOS Starter Kit

## Mandatory Flow: Kickoff Before Build

Before writing implementation code, complete project planning artifacts:

1. Fill `templates/project-kickoff-pack-template.md`
2. Define OKRs (objective + measurable KRs)
3. Initialize `templates/okr-task-board-template.md`
4. Ensure each task maps to a KR and passes quality gates
5. Begin build only after kickoff gate is fully checked

This keeps execution outcome-driven, auditable, and portable.

## Runtime Onboarding Defaults (Core)

Runtime onboarding behavior is inherited from jarvOS core templates (`../templates/agents-template.md` + `../templates/bootstrap-template.md`):
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

- `templates/project-kickoff-pack-template.md`
- `templates/okr-task-board-template.md`
- `workflows/basic-ci.yml`
