# jarvOS Starter Kit

This folder is the **planning and governance subset** of jarvOS, not a complete runtime.

## Included files

- `templates/project-kickoff-pack-template.md`
- `templates/okr-task-board-template.md`
- `workflows/basic-ci.yml`

## Mandatory flow: kickoff before build

Before writing implementation code, complete the planning artifacts first:

1. Fill `templates/project-kickoff-pack-template.md`
2. Define outcome targets and guardrails
3. Initialize `templates/okr-task-board-template.md`
4. Ensure each task maps to a target and passes quality gates
5. Begin build only after the kickoff gate is fully checked

This keeps execution outcome-driven, auditable, and portable.

## Runtime onboarding defaults

If you want the full jarvOS runtime behavior, copy these root templates from `../templates/` into your OpenClaw workspace:

- `AGENTS-template.md`
- `HEARTBEAT-template.md`
- `BOOTSTRAP-template.md`

You will still need to provide your own local `USER.md`, `MEMORY.md`, and any persona/alignment files your setup requires.

## Project governance policy v1

All project work should follow this baseline:

- link projects to Portfolio + Program by default
- if no fit exists, set `Program: Incubator` with reason + review date
- keep `Project Board.md` + `Project Brief.md` as a required pair
- maintain 3-6 milestones or decision gates per project
- hotfixes can start fast, but governance backfill is required in the same session

## Included reusable templates

- `templates/project-kickoff-pack-template.md`
- `templates/okr-task-board-template.md`

## What this starter kit does not include

This folder intentionally does **not** include:

- the full runtime behavior templates
- personal overlay files like `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, or `ONTOLOGY.md`
- Andrew-specific local data or automation state

Treat it as the portable planning subset, then layer the runtime templates and your own local files on top.
