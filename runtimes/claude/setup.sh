#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
HOOK_SCRIPT="$ROOT/runtimes/claude/jarvos-session-start-hook.js"
CLAUDE_MD_TEMPLATE="$ROOT/runtimes/claude/templates/CLAUDE.md.template"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
CLAUDE_DESKTOP_CONFIG="${CLAUDE_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
CLAUDE_MD_PATH="${CLAUDE_MD_PATH:-$HOME/.claude/CLAUDE.md}"

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

if [ "${JARVOS_SKIP_CLAUDE_MD:-0}" = "1" ]; then
  echo "Skipping Claude Code CLAUDE.md materialization because JARVOS_SKIP_CLAUDE_MD=1."
else
  if [ ! -f "$CLAUDE_MD_TEMPLATE" ]; then
    echo "jarvOS Claude CLAUDE.md template not found: $CLAUDE_MD_TEMPLATE" >&2
    exit 1
  fi
  node - "$CLAUDE_MD_TEMPLATE" "$CLAUDE_MD_PATH" <<'NODE'
const fs = require('fs');
const path = require('path');

const [templatePath, claudeMdPath] = process.argv.slice(2);
const LOCAL_EXTENSIONS_MARKER = '<!-- LOCAL-EXTENSIONS-BELOW -->';
const ADOPTED_NOTICE =
  '\n<!-- The block below was preserved from your prior ~/.claude/CLAUDE.md ' +
  'when jarvOS adopted this file. Review, then edit or remove as needed. -->\n';

function readFileOrNull(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function extractLocalExtensions(existingContent) {
  if (!existingContent) return { mode: 'none', body: '' };
  const idx = existingContent.indexOf(LOCAL_EXTENSIONS_MARKER);
  if (idx === -1) {
    // No marker = this file existed before jarvOS adopted it.
    // Preserve the full existing body as adopted local extensions so we
    // never silently drop the user's prior Claude Code instructions.
    return { mode: 'adopted', body: existingContent };
  }
  return { mode: 'marker', body: existingContent.slice(idx + LOCAL_EXTENSIONS_MARKER.length) };
}

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

const template = fs.readFileSync(templatePath, 'utf8');
const existing = readFileOrNull(claudeMdPath);
const { mode, body } = extractLocalExtensions(existing);

let extensionsBlock;
if (mode === 'adopted' && body.trim()) {
  extensionsBlock = `${ADOPTED_NOTICE}\n${body.replace(/^\n+/, '')}`;
} else {
  extensionsBlock = body.replace(/^\n/, '');
}

const nextContent = template.endsWith('\n')
  ? template + extensionsBlock
  : `${template}\n${extensionsBlock}`;

if (existing === nextContent) {
  console.log(`Claude Code CLAUDE.md already up to date: ${claudeMdPath}`);
} else {
  fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
  if (existing !== null) {
    const backupPath = `${claudeMdPath}.bak-jarvos-${timestampSuffix()}`;
    fs.copyFileSync(claudeMdPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  }
  fs.writeFileSync(claudeMdPath, nextContent, 'utf8');
  console.log(`Updated Claude Code CLAUDE.md: ${claudeMdPath}`);
  if (mode === 'adopted' && body.trim()) {
    console.log('Adopted prior CLAUDE.md content as local extensions (no marker found).');
  } else if (mode === 'marker' && body.trim()) {
    console.log('Preserved local extensions found below LOCAL-EXTENSIONS-BELOW marker.');
  }
}
NODE
fi

echo "Claude adapter setup complete."
