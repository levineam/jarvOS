# jarvOS — Codex CLI Runtime

This adapter connects local Codex CLI sessions to jarvOS through the shared
`@jarvos/agent-context` MCP server.

## Setup

From the jarvOS repo root:

```bash
./runtimes/codex/setup.sh
```

The script registers a local stdio MCP server named `jarvos`:

```bash
codex mcp add jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

## Available Tools

- `jarvos_current_work` — current Paperclip work summary.
- `jarvos_recall` — GBrain/QMD/graph recall.
- `jarvos_create_note` — Obsidian note creation, journal wikilink, and verification.
- `jarvos_startup_brief` — bounded startup context for future Codex hooks/wrappers.

## Operating Rule

Codex should treat jarvOS as the source of truth for memory and capture
semantics. Do not reimplement note writing or memory persistence in Codex
instructions; call the jarvOS tools.
