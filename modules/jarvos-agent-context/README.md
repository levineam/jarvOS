# @jarvos/agent-context

Shared runtime-facing adapter for jarvOS agent clients.

This module gives Codex CLI, Claude Code, Hermes Agent, and future runtimes one
small call surface for jarvOS context and actions. It wraps the existing jarvOS
modules rather than replacing them:

- `@jarvos/gbrain` for recall bundles.
- `@jarvos/secondbrain` for note writing and journal linking.
- Paperclip for current execution state.

## Tools

The bundled stdio MCP server exposes:

| Tool | Purpose |
|---|---|
| `jarvos_current_work` | Compact Paperclip current-work summary |
| `jarvos_recall` | GBrain/QMD/graph recall bundle rendered as Markdown |
| `jarvos_create_note` | Obsidian note creation + today journal wikilink + verification |
| `jarvos_startup_brief` | Bounded startup context for agent sessions |
| `jarvos_hydrate` | Bounded working-context packet for startup hydration |

## Codex

From the repo root:

```bash
codex mcp add jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

Then a Codex session can call the jarvOS tools instead of guessing from local
files or relying on static memory.
