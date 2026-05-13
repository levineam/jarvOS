# jarvOS — Codex Runtime

This adapter connects local Codex CLI and Codex app sessions to jarvOS through
the shared `@jarvos/agent-context` MCP server and a Codex `SessionStart` hook.

## Setup

From the jarvOS repo root:

```bash
./runtimes/codex/setup.sh
```

The script registers a local stdio MCP server named `jarvos`, enables a Codex
`SessionStart` hook in `~/.codex/config.toml`, backs up the config before any
write, and persists the hook's current trusted hash through Codex's app-server
config path so the hook is runnable in Codex app Local sessions:

```bash
codex mcp add jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

The repo also includes an equivalent hook manifest template for review/reference:

```text
runtimes/codex/hooks.json
```

It runs `runtimes/codex/jarvos-session-start-hook.js`, which emits
`hookSpecificOutput.additionalContext` for `SessionStart`. Hook failures are
logged to `~/.codex/jarvos-hydration.log` and fail open with an empty hook
result so Codex startup is not blocked.

## Available Tools

- `jarvos_current_work` — current Paperclip work summary.
- `jarvos_recall` — GBrain/QMD/graph recall.
- `jarvos_create_note` — Obsidian note creation, journal wikilink, and verification.
- `jarvos_startup_brief` — bounded startup context for future Codex hooks/wrappers.
- `jarvos_hydrate` — bounded Codex startup packet with Paperclip current work,
  today's journal, linked notes, jarvOS ontology spine, redaction, and a
  hydration report.

## Hydration Scope

Default budget is about 12,000 characters. The packet includes:

- Paperclip issues in `in_progress` and PR-backed `in_review`.
- Today's journal entry.
- Notes wikilinked from today's journal entry.
- A compact `jarvos-ontology` meaning spine.
- A report with sources, omissions, budget use, stale/missing data, and handles.

## Operating Rule

Codex should treat jarvOS as the source of truth for memory and capture
semantics. Do not reimplement note writing or memory persistence in Codex
instructions; call the jarvOS tools.
