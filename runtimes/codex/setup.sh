#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
HOOKS_JSON="$ROOT/runtimes/codex/hooks.json"
HOOK_SCRIPT="$ROOT/runtimes/codex/jarvos-session-start-hook.js"
TRUST_SCRIPT="$ROOT/runtimes/codex/trust-session-start-hook.js"
CODEX_CONFIG="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
CONTROL_PLANE_SERVICE_MODULE="${JARVOS_CONTROL_PLANE_SERVICE_MODULE:-}"
# Setup registers only a non-secret file path. Never pass the credential value
# through `codex mcp add --env` — that puts it on argv and persists it in config.
CONTROL_PLANE_CREDENTIAL_FILE="${JARVOS_CONTROL_PLANE_CREDENTIAL_FILE:-}"

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

# The control-plane MCP tool is only safe when the installed host provides the
# authenticated application service.  The module path is configuration, not a
# credential; the service itself owns credential resolution and authorization.
if [ -z "$CONTROL_PLANE_SERVICE_MODULE" ]; then
  echo "JARVOS_CONTROL_PLANE_SERVICE_MODULE must name the installed authenticated control-plane host service" >&2
  exit 1
fi

if [ ! -f "$CONTROL_PLANE_SERVICE_MODULE" ]; then
  echo "Configured control-plane host service module does not exist" >&2
  exit 1
fi

# The MCP server never accepts a model-supplied credential; it authenticates
# every control-plane call with a host-bound credential read at runtime. Setup
# registers only the credential *file path* so the secret never lands on argv
# or in ~/.codex/config.toml. Ambient JARVOS_CONTROL_PLANE_CREDENTIAL remains
# valid for non-persisted host sessions, but setup must never pass its value.
if [ -z "$CONTROL_PLANE_CREDENTIAL_FILE" ]; then
  echo "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE must point to a host credential file the MCP server reads at runtime" >&2
  exit 1
fi

case "$CONTROL_PLANE_CREDENTIAL_FILE" in
  /*) ;;
  *)
    echo "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE must be an absolute path" >&2
    exit 1
    ;;
esac

if [ ! -f "$CONTROL_PLANE_CREDENTIAL_FILE" ]; then
  echo "Configured control-plane credential file does not exist" >&2
  exit 1
fi

# Fail closed on group/other-readable credential files before registration.
# The MCP server re-checks this at runtime; setup rejects early so we never
# persist a path that cannot be used safely.
if ! node -e '
const fs = require("fs");
const path = process.argv[1];
const st = fs.statSync(path);
if (!st.isFile()) process.exit(2);
if (st.mode & 0o077) process.exit(3);
if (typeof process.getuid === "function" && st.uid !== 0 && st.uid !== process.getuid()) process.exit(4);
if (!fs.readFileSync(path, "utf8").replace(/\r?\n$/, "")) process.exit(5);
' "$CONTROL_PLANE_CREDENTIAL_FILE"; then
  echo "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE must be a non-empty, owner-only credential file (mode 0600/0400)" >&2
  exit 1
fi

if ! node "$ROOT/modules/jarvos-control-plane/scripts/jarvos-manager.js" verify-host-service \
  --service-module "$CONTROL_PLANE_SERVICE_MODULE" >/dev/null; then
  echo "Configured control-plane host service is not ready" >&2
  exit 1
fi

if codex mcp get jarvos >/dev/null 2>&1; then
  codex mcp remove jarvos >/dev/null
fi

# Register non-secret paths only — never the raw credential env value.
codex mcp add --env "JARVOS_CONTROL_PLANE_SERVICE_MODULE=$CONTROL_PLANE_SERVICE_MODULE" \
  --env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=$CONTROL_PLANE_CREDENTIAL_FILE" \
  jarvos -- node "$MCP_SERVER"
echo "Registered jarvOS MCP server for Codex: $MCP_SERVER"

mkdir -p "$(dirname "$CODEX_CONFIG")"
if [ ! -f "$CODEX_CONFIG" ]; then
  touch "$CODEX_CONFIG"
fi

node - "$CODEX_CONFIG" "$HOOK_SCRIPT" <<'NODE'
const fs = require('fs');

const [configPath, hookScript] = process.argv.slice(2);
const hookCommand = `node ${JSON.stringify(hookScript)}`;
const sessionStartHook = `{ matcher = "startup", hooks = [{ type = "command", command = ${JSON.stringify(hookCommand)}, async = false, timeout = 30 }] }`;
const sessionStartLine = `SessionStart = [${sessionStartHook}]`;
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

  for (let i = start + 1; i < end; i += 1) {
    if (!/^\s*SessionStart\s*=/.test(lines[i])) continue;
    if (lines[i].includes(hookScript)) {
      lines[i] = sessionStartLine;
      return lines.join('\n');
    }

    const close = lines[i].lastIndexOf(']');
    if (close >= 0) {
      const before = lines[i].slice(0, close).trimEnd();
      const separator = before.endsWith('[') ? '' : ',';
      lines[i] = `${before}${separator} ${sessionStartHook}${lines[i].slice(close)}`;
      return lines.join('\n');
    }
  }

  lines.splice(end, 0, sessionStartLine);
  return lines.join('\n');
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
