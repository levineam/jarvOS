#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
HOOKS_JSON="$ROOT/runtimes/codex/hooks.json"
HOOK_SCRIPT="$ROOT/runtimes/codex/jarvos-session-start-hook.js"
TRUST_SCRIPT="$ROOT/runtimes/codex/trust-session-start-hook.js"
CODEX_CONFIG="${CODEX_CONFIG:-$HOME/.codex/config.toml}"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH" >&2
  exit 1
fi

if [ ! -f "$MCP_SERVER" ]; then
  echo "jarvOS MCP server not found: $MCP_SERVER" >&2
  exit 1
fi

if [ ! -f "$HOOKS_JSON" ]; then
  echo "jarvOS Codex hooks config not found: $HOOKS_JSON" >&2
  exit 1
fi

if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "jarvOS Codex hook script not found: $HOOK_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$TRUST_SCRIPT" ]; then
  echo "jarvOS Codex hook trust script not found: $TRUST_SCRIPT" >&2
  exit 1
fi

if codex mcp get jarvos >/dev/null 2>&1; then
  codex mcp remove jarvos >/dev/null
fi

codex mcp add jarvos -- node "$MCP_SERVER"
echo "Registered jarvOS MCP server for Codex: $MCP_SERVER"

mkdir -p "$(dirname "$CODEX_CONFIG")"
if [ ! -f "$CODEX_CONFIG" ]; then
  touch "$CODEX_CONFIG"
fi

node - "$CODEX_CONFIG" "$HOOK_SCRIPT" <<'NODE'
const fs = require('fs');

const [configPath, hookScript] = process.argv.slice(2);
const hookCommand = `node ${JSON.stringify(hookScript)}`;
const sessionStartLine = `SessionStart = [{ matcher = "startup", hooks = [{ type = "command", command = ${JSON.stringify(hookCommand)}, async = false, timeout = 30 }] }]`;
const original = fs.readFileSync(configPath, 'utf8');
let next = original;

function setFeature(content, key, value) {
  const headerRe = /^\[features\]\s*$/m;
  if (!headerRe.test(content)) {
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    return `${content}${suffix}\n[features]\n${key} = ${value}\n`;
  }

  const lines = content.split(/\n/);
  const start = lines.findIndex((line) => /^\[features\]\s*$/.test(line));
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = start + 1; i < end; i += 1) {
    if (keyRe.test(lines[i])) {
      lines[i] = `${key} = ${value}`;
      return lines.join('\n');
    }
  }
  lines.splice(end, 0, `${key} = ${value}`);
  return lines.join('\n');
}

function removeFeature(content, key) {
  const lines = content.split(/\n/);
  const start = lines.findIndex((line) => /^\[features\]\s*$/.test(line));
  if (start < 0) return content;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const keyRe = new RegExp(`^\\s*${key}\\s*=`);
  return lines.filter((line, index) => {
    if (index <= start || index >= end) return true;
    return !keyRe.test(line);
  }).join('\n');
}

function setSessionStartHook(content) {
  const lines = content.split(/\n/);
  let start = lines.findIndex((line) => /^\[hooks\]\s*$/.test(line));
  if (start < 0) {
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    return `${content}${suffix}\n[hooks]\n${sessionStartLine}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const filtered = lines.filter((line, index) => {
    if (index <= start || index >= end) return true;
    return !/^\s*SessionStart\s*=/.test(line);
  });
  start = filtered.findIndex((line) => /^\[hooks\]\s*$/.test(line));
  end = filtered.length;
  for (let i = start + 1; i < filtered.length; i += 1) {
    if (/^\s*\[/.test(filtered[i])) {
      end = i;
      break;
    }
  }
  filtered.splice(end, 0, sessionStartLine);
  return filtered.join('\n');
}

next = setSessionStartHook(next);
next = setFeature(next, 'hooks', 'true');
next = removeFeature(next, 'codex_hooks');

if (next !== original) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const backupPath = `${configPath}.bak-jarvos-${stamp}`;
  fs.copyFileSync(configPath, backupPath);
  fs.writeFileSync(configPath, next, 'utf8');
  console.log(`Updated Codex config for jarvOS hooks: ${configPath}`);
  console.log(`Backup: ${backupPath}`);
} else {
  console.log(`Codex config already has jarvOS hooks enabled: ${configPath}`);
}
NODE

if [ "$CODEX_CONFIG" = "$HOME/.codex/config.toml" ]; then
  if node "$TRUST_SCRIPT" "$ROOT" "$HOOK_SCRIPT"; then
    echo "Trusted jarvOS Codex SessionStart hook."
  else
    echo "Could not automatically trust jarvOS Codex SessionStart hook; review it in Codex hooks settings." >&2
  fi
else
  echo "Skipping automatic hook trust for custom CODEX_CONFIG: $CODEX_CONFIG"
fi
