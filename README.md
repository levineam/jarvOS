# jarvOS

**jarvOS is a set of tools that sit on top of OpenClaw which make it into a reliable, secure, and powerful personal assistant.**

---

jarvOS has 5 main components:
1. Project Management System
2. Governance
3. Ontology
4. Continuous Learning and Execution
5. Security


It was built on top of [OpenClaw](https://openclaw.ai), which ships with a capable AI assistant, tool access, scheduling, and delivery channels. jarvOS is the layer that tells it what to actually do with all that.

## The problem

Most AI assistants are reactive. You ask, they answer. Close the chat, and they forget everything — ready to start from scratch next time.

jarvOS changes the default. Instead of an assistant that waits, you get one that tracks projects across sessions, routes decisions to you instead of dropping them, runs work autonomously while you sleep, and connects everything you're building to why you're building it.

## The five systems

1. **Project Management System (PMS)** is structured project tracking your assistant can read and write without you. Projects live in a hierarchy: Portfolios contain Programs, Programs contain Project Boards, Boards drive Tasks. Every active project has two companion documents — a Project Brief with scope and goals, and a Plan with four locked sections: Decisions Confirmed, Execution Phases, Autonomous Now, and Needs You.

That division is the point. Your assistant works from Autonomous Now without being asked, routes blockers through Needs You, and doesn't confuse the two.

2. **Governance**. A governance layer runs underneath: compliance scanning, frontmatter standards, milestone gates, OKR integration. When a project drifts from its goals, the system flags it. Decisions queue with an escalation ladder — context, options, recommended path, and what happens automatically if you don't respond. The assistant handles the follow-up.

3. **ONTOLOGY.md** is the why layer. It's a single document that maps your belief system from the ground up: Higher Order purpose, Beliefs, Predictions, Core Self (Mission, Values, Strengths), Goals, then Portfolios and Projects at the bottom. Everything routes through it. A new project should trace back to a Goal. A Goal should trace back to your Mission. When reflection sessions surface new insights — a belief shift, a prediction proved wrong, a goal that no longer fits — those route into ONTOLOGY.md instead of getting lost in chat.

The practical output: orphan detection flags work that isn't connected to any stated Goal. Weekly health checks surface when your active projects have drifted from what you said matters. Prioritization has an actual basis.

4. **Continuous Learning and Execution (CLE)** is the autonomous work loop. On a schedule, your assistant picks up unblocked tasks from active project boards, executes them, and writes proof-of-work so you know what happened. After each session, a structured reflection pass extracts what was learned to memory, routes understanding shifts to ONTOLOGY.md, and queues open questions in the briefing system.

Briefings tie it together — morning, evening. Each one pulls the relevant slice of what's happening and what needs you, formatted for quick reading. Overnight maintenance mode handles lower-priority work while you sleep.

5. **Security** is automated daily scanning and incident response. Every morning a cron job checks the installed OpenClaw version against the latest release and surfaces findings through the briefing system — critical findings get urgent alerts, routine checks get logged quietly.

## OpenClaw is the prerequisite

OpenClaw provides the foundation: session management, cron scheduling, tool access, channel delivery, and a set of baseline workspace files. jarvOS runs on top of it. The governance layer, the briefing system, the project hierarchy — none of it replaces OpenClaw's infrastructure; it runs on it.

What this repo adds on the behavior side: an enhanced AGENTS.md with invisible orchestration, specialist mode detection, auto model tiering, a full writer pipeline, a Process section that enforces rule-wiring discipline, and red team checkpoints for development work. An enhanced HEARTBEAT.md that's a comprehensive multi-section playbook — what actually runs on OpenClaw's scheduler. A memory architecture that adds daily session files, heartbeat-state.json for check-in tracking, and a briefing queue for decisions that need your attention. Scripts that handle governance scanning, frontmatter linting, and maintenance work.

Your instance is the third layer: your persona, your schedule, your integrations. This repo gives you the second. OpenClaw provides the first.

## Quick start

Clone the repo. Copy the templates you need into your OpenClaw workspace, then tell your assistant to read `BOOTSTRAP.md` and follow it.

Minimal setup:

1. Copy `templates/AGENTS-template.md` (`templates/agents-template.md` in the export map) to `AGENTS.md`
2. Copy `templates/HEARTBEAT-template.md` (`templates/heartbeat-template.md` in the export map) to `HEARTBEAT.md`
3. Copy `templates/BOOTSTRAP-template.md` (`templates/bootstrap-template.md` in the export map) to `BOOTSTRAP.md`
4. Copy the planning templates you want from `templates/` or `starter-kit/templates/`
5. Provide your own local `USER.md`, `MEMORY.md`, and any persona/alignment files your setup requires

Note: `docs/meta/source-to-export-map.json` also records lowercase slug aliases used by export tooling. The copy commands above use the exact on-disk filenames in this repo.

This repo does not yet ship public templates for `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, or `ONTOLOGY.md`, so dogfood canaries should overlay local copies for those files.

From there: create your first project with a Board and Brief, let the Plan drive what gets worked on, and keep long-lived context in files instead of chat whenever possible.

## What's currently shipped

### Core templates

| File | Purpose |
|------|---------|
| `templates/AGENTS-template.md` | Core behavior — copy to `AGENTS.md` in your workspace |
| `templates/HEARTBEAT-template.md` | Proactive check-in — copy to `HEARTBEAT.md` in your workspace |
| `templates/BOOTSTRAP-template.md` | First-run instructions — copy to `BOOTSTRAP.md`, then delete after setup |

### Planning templates

| File | Purpose |
|------|---------|
| `okr-task-board-template.md` | Reusable OKR-linked task board |
| `project-kickoff-pack-template.md` | Reusable kickoff pack for project setup |

The root `templates/` directory is the canonical copy. `starter-kit/templates/` mirrors the planning templates so you can lift the starter kit on its own.

## What's in the starter-kit folder

The `starter-kit/` folder contains a small portable pack:

- `templates/` — mirrored planning templates
- `workflows/basic-ci.yml` — starter automation example you can adapt

## Troubleshooting and rollout notes

- `starter-kit/README.md` — starter-kit setup and rollout checklist (export slug: `starter-kit/readme.md`)
- `docs/architecture/jarvos-architecture.md` — architecture overview and operating model
- `docs/architecture/architecture-decision-records/architecture-decision-record-20260219-ars-contexta-patterns.md` — architecture decision context

## Current dogfood baseline status

This repo is now documented as a **public docs/template baseline candidate** (still validating public-safe readiness), not a zero-config clone of Andrew's live workspace.

Before Andrew can dogfood it as the real baseline, these conditions still need to be true:

1. README and starter-kit docs stay aligned with the files actually shipped here.
2. Public metadata stays sanitized — no Andrew-local absolute paths in exported docs.
3. Local overlay files exist for `USER.md`, `MEMORY.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, and `ONTOLOGY.md`.
4. A clean canary workspace proves `AGENTS.md`, `HEARTBEAT.md`, and `BOOTSTRAP.md` run correctly with those overlays.
5. Only after that can broader automation be enabled with confidence.

## Philosophy

The behaviors are on by default. You turn things off when they don't fit rather than manually activating each feature. An assistant that requires constant configuration isn't a system — it's a to-do list you maintain for your to-do list.

Everything is markdown. No database, no cloud service, no proprietary format. The files are readable, versionable with git, and moveable between AI platforms as the ecosystem shifts.

The design principle throughout: if a behavior can run without pulling you in, it should. If it can't, it surfaces a clear ask with a recommended default rather than a wall of options.

## Follow along

The creator shares how he uses and develops jarvOS on X: [@andrarchy](https://x.com/andrarchy).

If you build something on top of this, open an issue or find him there.
