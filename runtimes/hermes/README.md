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
3. Run `hermes setup` first to configure your model/API keys and create
   `$HERMES_HOME/config.yaml` (defaults to `~/.hermes`)
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

Portable setup keeps GBrain optional. A private continuity profile registers a
separate `gbrain` stdio MCP through the shared jarvOS provider launcher and the
same owner-only runtime descriptor used by Codex and OpenClaw. The launcher
pins the GBrain source and interpreter, strips ambient database routing, and
forces `GBRAIN_SWEEP=0`; Hermes configuration contains only the descriptor path,
not the database credential. `hermes mcp test gbrain` proves connectivity, but
a native Hermes recall turn is still required for behavioral proof.

Hermes treats `--args` as the final option, so registration uses this exact
native command shape:

```bash
hermes mcp add gbrain --command node \
  --env JARVOS_GBRAIN_RUNTIME_DESCRIPTOR=<owner-only-descriptor> \
  --args <provider-launcher>
hermes mcp test gbrain
```

The native add command probes the server and asks which discovered tools to
enable. Accept that explicit private-profile choice; an add-command exit code
without a saved entry and a passing `hermes mcp test gbrain` is not success.

GBrain owns its provider skill resolver. Skillify is discovered through
`list_skills` and `get_skill`, not copied into the Hermes skill directory or
the jarvOS shared-skill projection.

The setup script registers the shared jarvOS MCP server with Hermes using the
native stdio transport, then verifies the connection with `hermes mcp test
jarvos`. Registration is idempotent for ordinary public setup: an existing
`jarvos` entry is preserved. When private route-binding paths are supplied, an
older entry is instead backed up, replaced with the complete binding
environment, and health-checked; a failed replacement restores the backup. The
setup script backs up `$HERMES_HOME/config.yaml` before any configuration
write. Set `HERMES_HOME` to a disposable directory for a rehearsal so skills,
plugins, and config stay isolated from the installed profile.

The setup installs an opt-in Hermes plugin that uses the documented
`on_session_start` and `pre_llm_call` hooks. On the first turn for each
platform/session pair it calls `jarvos_hydrate` through the registered MCP
tool and injects at most 6000 characters into that turn only. Timeout, tool
errors, malformed packets, and oversized packets fail open without logging
packet content or delaying the turn. There is no polling or duplicate
scheduler. If the plugin is not installed or enabled, call `jarvos_hydrate`
manually at session start. The shared MCP surface also exposes the canonical
`jarvos_session_thread_read` and `jarvos_session_thread_write` tools. When a
trusted Hermes route-capability bridge is configured, the plugin supplies an
opaque short-lived binding for its internal hydration; route-bound thread
calls without a valid binding fail closed rather than accepting caller-chosen
thread dimensions.

The private `services/hermes-jarvos-context-bridge/` service is the binding
authority for that mode. It listens on an owner-only Unix socket, authenticates
the trusted Hermes request, and returns only a short-lived opaque capability;
the route tuple and secrets never enter the model-visible hydration packet.
Changing a key epoch by itself is rejected because it would not revoke an
already-issued capability; rotate the route secret or adapter generation when
revocation is required.

The portable skills are projected through the manifest-driven installer. A
projection is dry-run by default and only writes with `--apply`; unknown,
locally modified, conflicting, or symlinked targets are preserved. Before any
projection, setup verifies the single artifact generation in `adapter.json`:
the skills manifest, bounded context plugin, and Hermes `@jarvos/coding` host
adapter must all match their pinned digests. A mixed generation refuses setup.

The Hermes host adapter can register `jarvos_coding_take_issue_to_done` as the
existing `@jarvos/coding` entrypoint. Its continuity input is
pointer-and-digest only; the host does not receive copied transcripts,
allocate worktrees, or own coding leases, pull requests, or completion state.
The base shared-context MCP server does not invent a live coding controller: a
host integration must inject the existing `@jarvos/coding` controller, and an
unregistered or unavailable provider is reported as blocked rather than
falling back to a second execution path.

## Runtime Adapter Status

Target: `hermes-agent`.

The shared MCP context, verified skill projection, and bounded first-turn
hydration plugin are supported on Hermes versions that expose these plugin
hooks. Manual `jarvos_hydrate` remains the fallback when the plugin is not
installed or enabled.
