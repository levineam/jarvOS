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
| `jarvos_recall` | GBrain/QMD/graph recall bundle rendered as Markdown; pass `synthesize: true` or `mode: "synthesis"` for WS5 synthesis |
| `jarvos_synthesize` | Concise WS5 synthesis over WS4 retrieval evidence with the source bundle preserved |
| `jarvos_create_note` | Obsidian note creation + today journal wikilink + KB sidecars + verification |
| `jarvos_session_thread_read` | Read the rolling live working thread for an issue, artifact, project, or host session |
| `jarvos_session_thread_write` | Append a checkpoint to that thread as a normal secondbrain note linked from today's journal |
| `jarvos_startup_brief` | Bounded startup context for agent sessions |
| `jarvos_hydrate` | Bounded working-context packet for startup hydration |

## Session Thread Continuity

The session thread is the lightweight handoff surface for work that moves across
Claude Code, OpenClaw, Codex, Hermes, or another host. It is not a hidden store:
each thread is a Markdown note named `JarvOS Session Thread - <threadId>` in the
configured Notes directory, and every write links that note from today's journal
through the same `@jarvos/secondbrain` note and journal helpers used by
`jarvos_create_note`.

Host reflex:

1. On entry, call `jarvos_session_thread_read` with the issue, artifact, project,
   or `JARVOS_SESSION_THREAD_ID`, then call `jarvos_current_work` or
   `jarvos_hydrate`.
2. During work, call `jarvos_session_thread_write` at task switches, decisions,
   artifact changes, and pre-compaction flushes.
3. Keep writes compact: summary, latest decision, and concrete next step. Link
   the live artifact instead of copying large snapshots.

## Prompts

The MCP server also exposes a `boot_jarvos` prompt with user-facing "Boot
jarvOS" instructions. It tells compatible clients to call `jarvos_hydrate` with
a bounded Desktop budget, summarize the Hydration Report, and use the returned
packet as working context without dumping raw private notes.

## Codex

From the repo root:

```bash
codex mcp add jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

Then a Codex session can call the jarvOS tools instead of guessing from local
files or relying on static memory.
