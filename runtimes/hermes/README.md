# jarvOS — Hermes Agent Runtime

This directory contains Hermes-specific setup for jarvOS.

## What's Here

Hermes Agent has built-in learning loops, memory nudges, skill auto-creation, session search, and Honcho user modeling. jarvOS on Hermes is deliberately lean — it provides the behavioral backbone and lets Hermes handle the mechanism.

- **setup.sh** — Workspace setup script (copies core files, configures Hermes)
- **plugins/jarvos-context/** — Bounded first-turn context hydration plugin
- **cron/** — Briefing and proactive check job definitions (coming soon; optional)

## Setup

1. Install [Hermes Agent](https://github.com/NousResearch/hermes-agent)
2. Clone this repo
3. Run `hermes setup` first to configure your model/API keys and create `~/.hermes/config.yaml`
4. Run `./runtimes/hermes/setup.sh` (or manually copy core/ files to your Hermes workspace)
5. Fill in your personal details in `USER.md` and `ONTOLOGY.md`
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

## Shared context and skill projection

The setup script registers the shared jarvOS MCP server with Hermes using the
native stdio transport, then verifies the connection with `hermes mcp test
jarvos`. Registration is idempotent: an existing `jarvos` entry is preserved
and never overwritten. The setup script backs up `~/.hermes/config.yaml` before
any configuration write.

The setup installs an opt-in Hermes plugin that uses the documented
`on_session_start` and `pre_llm_call` hooks. On the first turn for each
platform/session pair it calls `jarvos_hydrate` through the registered MCP
tool and injects at most 6000 characters into that turn only. Timeout, tool
errors, malformed packets, and oversized packets fail open without logging
packet content or delaying the turn. There is no polling or duplicate
scheduler. If the plugin is not installed or enabled, call `jarvos_hydrate`
manually at session start.

The portable skills are projected through the manifest-driven installer. A
projection is dry-run by default and only writes with `--apply`; unknown,
locally modified, conflicting, or symlinked targets are preserved. Before any
projection, setup verifies the single artifact generation in `adapter.json`:
the skills manifest, bounded context plugin, and Hermes `@jarvos/coding` host
adapter must all match their pinned digests. A mixed generation refuses setup.

Hermes exposes `jarvos_coding_take_issue_to_done` as the existing
`@jarvos/coding` entrypoint. Its continuity input is pointer-and-digest only;
the host does not receive copied transcripts, allocate worktrees, or own coding
leases, pull requests, or completion state.

## Runtime Adapter Status

Target: `hermes-agent`.

The shared MCP context, verified skill projection, and bounded first-turn
hydration plugin are supported on Hermes versions that expose these plugin
hooks. Manual `jarvos_hydrate` remains the fallback when the plugin is not
installed or enabled.
