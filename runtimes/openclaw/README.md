# jarvOS — OpenClaw Runtime

This directory contains OpenClaw-specific implementation files for jarvOS.

## What's Here

OpenClaw provides powerful scheduling, tool execution, and multi-channel messaging — but ships with blank templates. jarvOS fills the behavioral layer.

This folder currently ships as **documentation-only** (this README). The actual starter files live in repo root (`core/` and `templates/`) and are copied into your OpenClaw workspace.

Use this as an adapter checklist for files you place in your workspace root:

- **HEARTBEAT.md** — start from `templates/HEARTBEAT-template.md`
- **TOOLS.md** — start from `templates/TOOLS.template.md`
- **AGENTS.md / SOUL.md / IDENTITY.md** — copy from `core/`
- **CONSTITUTION.md / CRITICAL-RULES.md** — create for your runtime-specific routing and safety rules
- **scripts/** — operational scripts (governance, briefing, cron management, etc.)
- **workflows/** — approval workflows for high-stakes actions

## Setup

1. Install [OpenClaw](https://github.com/openclaw/openclaw)
2. Clone this repo into your workspace directory
3. Copy `core/` files to your workspace root
4. Copy templates and fill in your personal details
5. Create/apply the OpenClaw adapter files in your workspace (HEARTBEAT.md, TOOLS.md, CONSTITUTION.md, scripts/, workflows/)
6. Run `openclaw gateway start`

## What OpenClaw Handles Natively

OpenClaw does NOT have built-in learning loops. jarvOS adds:
- Memory maintenance via HEARTBEAT.md
- Daily memory files (`memory/YYYY-MM-DD.md`)
- CIL (Continuous Integration of Learning) loop
- Reflection passes
- Custom skill governance

These are OpenClaw-specific because Hermes handles them natively.
