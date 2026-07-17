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

## Obsidian Default Pack

The default JarvOS experience uses `@jarvos/skills` with the
`obsidian-default` pack. Install the pack skills into your assistant runtime, set
your secondbrain paths, and run the doctor:

```bash
node jarvos-skills/bin/jarvos-skills.js doctor
```

Use `JARVOS_NOTES_DIR` and `JARVOS_JOURNAL_DIR`, or `paths.notes` and
`paths.journal` in `jarvos.config.json`, to point JarvOS at your Markdown vault.
Obsidian is optional but recommended: when the `obsidian` CLI is present, the
pack enables app-aware note workflows; when `defuddle` is present, it enables
clean web-page extraction. Bases and Canvas are review/artifact surfaces only,
not replacements for Paperclip status tracking.

## Local OpenClaw Profile

For a local OpenClaw runtime, register the adapter profile after setting up the
workspace:

```bash
npm install
node jarvos-skills/bin/jarvos-skills.js init --pack local-openclaw --workspace .
node jarvos-skills/bin/jarvos-skills.js doctor --pack local-openclaw
npm run canary:jarvos-install
```

This records the OpenClaw adapter and installed skill profile while preserving
any existing OpenClaw runtime config. `lossless-claw` is checked as an optional
continuity tool, not as a required JarvOS foundation.

This preview is source-checkout based. Treat it as announcement-ready only after
the clean install canary and public/private release scan pass.

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
