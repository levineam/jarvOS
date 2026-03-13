# jarvOS — OpenClaw Runtime

This directory contains OpenClaw-specific implementation files for jarvOS.

## What's Here

OpenClaw provides powerful scheduling, tool execution, and multi-channel messaging — but ships with blank templates. jarvOS fills the behavioral layer. This adapter wires jarvOS principles into OpenClaw-specific tooling:

- **HEARTBEAT.md** — Proactive check-in system with script paths and governance scans
- **TOOLS.md** — Operational cheat sheet for OpenClaw commands and patterns
- **CONSTITUTION.md** — Routing rules using OpenClaw sessions and tools
- **CRITICAL-RULES.md** — Runtime-specific critical rules (sessions_spawn, cron, QMD, ACP)
- **scripts/** — Operational scripts (governance, briefing, cron management, etc.)
- **workflows/** — Lobster approval workflows for high-stakes actions

## Setup

1. Install [OpenClaw](https://github.com/openclaw/openclaw)
2. Clone this repo into your workspace directory
3. Copy `core/` files to your workspace root
4. Copy templates and fill in your personal details
5. Copy this adapter's files into your workspace
6. Run `openclaw gateway start`

## What OpenClaw Handles Natively

OpenClaw does NOT have built-in learning loops. jarvOS adds:
- Memory maintenance via HEARTBEAT.md
- Daily memory files (`memory/YYYY-MM-DD.md`)
- CIL (Continuous Integration of Learning) loop
- Reflection passes
- Custom skill governance

These are OpenClaw-specific because Hermes handles them natively.
