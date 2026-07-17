# @jarvos/agent-context

Shared runtime-facing adapter for jarvOS agent clients.

This module gives Codex CLI, Claude Code, Hermes Agent, and future runtimes one
small call surface for jarvOS context and actions. It wraps the existing jarvOS
modules rather than replacing them:

- `@jarvos/gbrain` for recall bundles.
- `@jarvos/secondbrain` for note writing and journal linking.
- `@jarvos/ontology` for bounded hierarchy-of-meaning context packets.
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
| `jarvos_hydrate` | Bounded working-context packet for startup hydration, including ontology context when configured |
| `jarvos_control_plane` | Authenticated request, inspection, evidence, and approval access through the installed host application service |

`jarvos_control_plane` is available only after the host has configured
`JARVOS_CONTROL_PLANE_SERVICE_MODULE`. `@jarvos/agent-context` declares
`@jarvos/control-plane` as a runtime dependency so this boundary resolves from
an installed package, not from a repository-relative path.

## Ontology Context

`jarvos_hydrate` includes a compact ontology context packet when an ontology
provider source is available. The packet is hierarchy-of-meaning context for AI
coding tools: values, motivations, reviewed beliefs, goals, predictions, and
project relationships.

The packet is intentionally bounded and source-labeled. It does not dump raw
private notes or require runtimes to parse `ONTOLOGY.md` directly. If no
ontology source is configured, hydration succeeds and reports the omission.

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

Prefer the runtime setup script, which registers non-secret host bindings only:

```bash
JARVOS_CONTROL_PLANE_SERVICE_MODULE=/absolute/path/to/authenticated-host-service.js \
JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=/absolute/path/to/control-plane.credential \
  ./runtimes/codex/setup.sh
```

Manual registration (for non-persisted sessions) may use an ambient credential
in the current shell, but persisted MCP config must never store the secret
value — register `JARVOS_CONTROL_PLANE_CREDENTIAL_FILE` instead:

```bash
codex mcp add \
  --env "JARVOS_CONTROL_PLANE_SERVICE_MODULE=/absolute/path/to/host-service.js" \
  --env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=/absolute/path/to/control-plane.credential" \
  jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

The MCP server binds the control-plane credential server-side from that file
(or from ambient `JARVOS_CONTROL_PLANE_CREDENTIAL` for non-persisted host
sessions). Never pass a credential as a tool argument.

Then a Codex session can call the jarvOS tools instead of guessing from local
files or relying on static memory.
