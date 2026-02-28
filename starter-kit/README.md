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

Runtime onboarding behavior is inherited from jarvOS core templates (`templates/agents-template.md` + `templates/bootstrap-template.md`):
- activation-first onboarding finish (1-3 concrete activation tasks)
- brief-first setup (daily brief/review early)
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

## Lobster Workflow Gates (Optional)

`workflows/` contains Lobster gate examples for common high-stakes actions:

- `write-prose.lobster` — Humanizer gate for publishable prose. Checks for AI writing patterns, enforces voice, requires human approval before saving or sending.
- `spawn-code-subagent.lobster` — Code quality gate. Enforces branch-first, PR-required, test-pass, and review-before-merge discipline.

**To use Lobster gates:**

1. Install Lobster: `npm install -g @openclaw/lobster` (or follow [Lobster docs](https://openclaw.ai/lobster))
2. Copy workflow files to `workflows/` in your workspace
3. Add gate invocations to `TOOLS.md` per the pattern in the main templates
4. Invoke via: `lobster run workflows/write-prose.lobster --input '{"draft":"...","title":"..."}'`

Gates are optional but strongly recommended for:
- Any publishable prose (prevents AI-sounding content from going public)
- Any code subagent spawn (prevents PRs without branches, tests, or reviews)

## See Also

- `../docs/optional/jsonl-memory.md` — Structured memory schema (adopt at scale)
- `../docs/optional/context-engineering.md` — Context engineering skill pack (adopt for multi-agent work)
