# jarvOS — Hermes Agent Runtime

This directory contains Hermes-specific setup for jarvOS.

## What's Here

Hermes Agent has built-in learning loops, memory nudges, skill auto-creation, session search, and Honcho user modeling. jarvOS on Hermes is deliberately lean — it provides the behavioral backbone and lets Hermes handle the mechanism.

- **setup.sh** — Workspace setup script (copies core files, configures Hermes)
- **cron/** — Briefing and proactive check job definitions (coming soon; optional)

## Setup

1. Install [Hermes Agent](https://github.com/NousResearch/hermes-agent)
2. Clone this repo
3. Run `./runtimes/hermes/setup.sh` (or manually copy core/ files to your Hermes workspace)
4. Copy templates and fill in your personal details
5. Run `hermes setup` to configure your model and API keys
6. Start chatting: `hermes`

## What Hermes Handles Natively (don't duplicate)

Hermes has built-in systems for things jarvOS custom-builds on OpenClaw:

| Hermes Native | OpenClaw Equivalent |
|---|---|
| Skill auto-creation after complex tasks | CIL loop scripts |
| Memory nudges (configurable interval) | HEARTBEAT memory maintenance |
| FTS5 session search + LLM summarization | QMD vault search + daily memory files |
| Honcho dialectic user modeling | USER.md + ONTOLOGY.md manual profiling |
| Skills self-improve during use | Reflection passes + skill governance |

**Do not add custom memory/learning instructions to AGENTS.md that would fight these systems.**

## What jarvOS Adds to Hermes

- **Identity and persona** (SOUL.md) — who the agent is
- **Behavioral principles** (AGENTS.md) — how it should think and act
- **User context** (USER.md) — who it's helping
- **Governance rules** — when to ask permission, when to act
- **Communication style** — conversational clarity, no corporate speak
- **Alignment map** (ONTOLOGY.md) — what the user cares about
