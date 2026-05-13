# jarvOS — Claude Runtime

This adapter connects Claude Code and Claude Desktop to jarvOS through the
shared `@jarvos/agent-context` MCP server. Claude Code also gets bounded startup
hydration through a `SessionStart` hook.

## Setup

From the jarvOS repo root:

```bash
./runtimes/claude/setup.sh
```

The setup script:

- registers a user-scoped Claude Code MCP server named `jarvos`
- installs a Claude Code `SessionStart` hook in `~/.claude/settings.json`
- adds the same MCP server to Claude Desktop's local MCP config on macOS
- backs up existing config files before writing changes

Claude Code MCP registration uses:

```bash
claude mcp add --scope user jarvos -- node "$PWD/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
```

## Claude Code Hydration

Target: `claude-code`.

Claude Code supports `SessionStart` hook `additionalContext`, so the adapter
uses `runtimes/claude/jarvos-session-start-hook.js` to emit the same jarvOS
Working Context Packet used by Codex.

Claude Code caps hook-injected context at 10,000 characters. This adapter uses a
9,500 character default budget, configurable with
`JARVOS_CLAUDE_HYDRATION_MAX_CHARS`. Hook failures are logged to
`~/.claude/jarvos-hydration.log` and fail open with an empty hook result so
Claude startup is not blocked.

## Claude Desktop

Target: `claude-desktop`.

Claude Desktop uses local MCP server configuration. This v1 adapter configures
`mcpServers.jarvos` in:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Claude Desktop startup hydration is manual/unsupported in v1 because this pass
does not verify an official Desktop startup additional-context hook. Use the
`jarvos_hydrate` MCP tool manually when a Desktop session needs the current
working-context packet.

### Boot jarvOS in Claude Desktop

For a new Claude Desktop chat, use this short starter phrase:

```text
boot jarvOS
```

Claude should route that request to the `jarvos_hydrate` MCP tool with a bounded
Desktop budget, then confirm the Working Context Packet and Hydration Report
were loaded. The jarvOS MCP server also exposes a `boot_jarvos` prompt with the
same instructions for clients that surface MCP prompts directly.

This is still manual hydration. It makes one-step Desktop boot reliable, but it
does not imply automatic startup context injection for Claude Desktop.

## Available Tools

- `jarvos_current_work` — current Paperclip work summary.
- `jarvos_recall` — GBrain/QMD/graph recall.
- `jarvos_create_note` — Obsidian note creation, journal wikilink, and verification.
- `jarvos_startup_brief` — bounded startup context.
- `jarvos_hydrate` — bounded working-context packet with Paperclip current work,
  today's journal, linked notes, jarvOS ontology spine, redaction, and a
  hydration report.
- `boot_jarvos` prompt — user-facing "Boot jarvOS" starter prompt for Claude
  Desktop manual hydration.

## Verification

```bash
claude mcp get jarvos
node runtimes/claude/jarvos-session-start-hook.js
node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check claude
```
