#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
HOOK_SCRIPT="$ROOT/runtimes/claude/jarvos-session-start-hook.js"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
CLAUDE_DESKTOP_CONFIG="${CLAUDE_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"

if [ ! -f "$MCP_SERVER" ]; then
  echo "jarvOS MCP server not found: $MCP_SERVER" >&2
  exit 1
fi

if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "jarvOS Claude hook script not found: $HOOK_SCRIPT" >&2
  exit 1
fi

warn_if_claude_mcp_shadowed() {
  local details
  details="$(claude mcp get jarvos 2>/dev/null || true)"
  if [ -z "$details" ]; then
    echo "Warning: Claude Code could not resolve the jarvOS MCP server after user-scope registration." >&2
    return
  fi
  if ! printf "%s\n" "$details" | grep -F "$MCP_SERVER" >/dev/null; then
    echo "Warning: the effective Claude Code jarvOS MCP entry does not point at $MCP_SERVER." >&2
    echo "A local or project scoped Claude MCP server named jarvos may be shadowing the user-scoped jarvOS server." >&2
  fi
}

if [ "${JARVOS_SKIP_CLAUDE_CODE_MCP:-0}" = "1" ]; then
  echo "Skipping Claude Code MCP registration because JARVOS_SKIP_CLAUDE_CODE_MCP=1."
elif command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user jarvos >/dev/null 2>&1 || true
  claude mcp add --scope user jarvos -- node "$MCP_SERVER" >/dev/null
  warn_if_claude_mcp_shadowed
  echo "Registered jarvOS MCP server for Claude Code: $MCP_SERVER"
else
  echo "Claude Code CLI not found on PATH; skipping Claude Code MCP registration." >&2
fi

node - "$CLAUDE_SETTINGS" "$HOOK_SCRIPT" "$CLAUDE_DESKTOP_CONFIG" "$MCP_SERVER" <<'NODE'
const fs = require('fs');
const path = require('path');

const [settingsPath, hookScript, desktopConfigPath, mcpServer] = process.argv.slice(2);
const hookCommand = `node ${JSON.stringify(hookScript)}`;

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const content = fs.readFileSync(filePath, 'utf8').trim();
  return content ? JSON.parse(content) : fallback;
}

function backupAndWriteJson(filePath, value, label) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (previous === next) {
    console.log(`${label} already configured: ${filePath}`);
    return;
  }
  if (previous !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
    const backupPath = `${filePath}.bak-jarvos-${stamp}`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`Backup: ${backupPath}`);
  }
  fs.writeFileSync(filePath, next, 'utf8');
  console.log(`Updated ${label}: ${filePath}`);
}

function upsertClaudeCodeHook(settings) {
  const next = { ...settings };
  const hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? { ...next.hooks } : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? [...hooks.SessionStart] : [];
  const jarvosEntry = {
    matcher: 'startup',
    hooks: [
      {
        type: 'command',
        command: hookCommand,
        timeout: 30,
      },
    ],
  };

  const index = sessionStart.findIndex((entry) => JSON.stringify(entry).includes(hookScript));
  if (index >= 0) sessionStart[index] = jarvosEntry;
  else sessionStart.push(jarvosEntry);
  hooks.SessionStart = sessionStart;
  next.hooks = hooks;
  return next;
}

function upsertClaudeDesktopMcp(config) {
  const next = { ...config };
  next.mcpServers = next.mcpServers && typeof next.mcpServers === 'object' && !Array.isArray(next.mcpServers)
    ? { ...next.mcpServers }
    : {};
  next.mcpServers.jarvos = {
    command: 'node',
    args: [mcpServer],
  };
  return next;
}

backupAndWriteJson(settingsPath, upsertClaudeCodeHook(readJsonFile(settingsPath, {})), 'Claude Code settings');
backupAndWriteJson(desktopConfigPath, upsertClaudeDesktopMcp(readJsonFile(desktopConfigPath, {})), 'Claude Desktop MCP config');
NODE

echo "Claude adapter setup complete."
