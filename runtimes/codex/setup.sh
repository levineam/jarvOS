#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
HOOKS_JSON="$ROOT/runtimes/codex/hooks.json"
HOOK_SCRIPT="$ROOT/runtimes/codex/jarvos-session-start-hook.js"
TURN_HOOK_SCRIPT="$ROOT/runtimes/codex/jarvos-session-turn-hook.js"
TRUST_SCRIPT="$ROOT/runtimes/codex/trust-session-start-hook.js"
CODEX_CONFIG="${CODEX_CONFIG:-$HOME/.codex/config.toml}"
CONTROL_PLANE_SERVICE_MODULE="${JARVOS_CONTROL_PLANE_SERVICE_MODULE:-}"
# Setup registers only a non-secret file path. Never pass the credential value
# through `codex mcp add --env` — that puts it on argv and persists it in config.
CONTROL_PLANE_CREDENTIAL_FILE="${JARVOS_CONTROL_PLANE_CREDENTIAL_FILE:-}"

# A quiet managed-launcher install supplies reviewed public hook bytes here.
# Refuse to activate configured managed roots with checkout-resident hooks.
if [ -n "${JARVOS_MANAGED_REPOSITORIES:-}" ]; then
  : "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:?stage the reviewed launcher tuple before enabling managed repositories}"
  HOOK_SCRIPT="$JARVOS_STAGED_PUBLIC_RUNTIME_ROOT/runtimes/codex/jarvos-session-start-hook.js"
  TURN_HOOK_SCRIPT="$JARVOS_STAGED_PUBLIC_RUNTIME_ROOT/runtimes/codex/jarvos-session-turn-hook.js"
fi

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

if [ ! -f "$TURN_HOOK_SCRIPT" ]; then
  echo "jarvOS Codex turn hook script not found: $TURN_HOOK_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$TRUST_SCRIPT" ]; then
  echo "jarvOS Codex hook trust script not found: $TRUST_SCRIPT" >&2
  exit 1
fi

# Control-plane host bindings are optional on public/minimal installs.
# - Neither set → register the shared MCP server without host env bindings.
# - Either set  → require a complete valid pair, verify the host, then bind both
#   non-secret paths. Never register the raw credential value.
# The MCP server never accepts a model-supplied credential; it authenticates
# every control-plane call with a host-bound credential read at runtime. Setup
# registers only the credential *file path* so the secret never lands on argv
# or in ~/.codex/config.toml. Ambient JARVOS_CONTROL_PLANE_CREDENTIAL remains
# valid for non-persisted host sessions, but setup must never pass its value.
MCP_ENV_ARGS=()
if [ -n "$CONTROL_PLANE_SERVICE_MODULE" ] || [ -n "$CONTROL_PLANE_CREDENTIAL_FILE" ]; then
  if [ -z "$CONTROL_PLANE_SERVICE_MODULE" ]; then
    echo "JARVOS_CONTROL_PLANE_SERVICE_MODULE must name the installed authenticated control-plane host service when control-plane host bindings are configured" >&2
    exit 1
  fi

  case "$CONTROL_PLANE_SERVICE_MODULE" in
    /*) ;;
    *)
      echo "JARVOS_CONTROL_PLANE_SERVICE_MODULE must be an absolute path" >&2
      exit 1
      ;;
  esac

  if [ ! -f "$CONTROL_PLANE_SERVICE_MODULE" ]; then
    echo "Configured control-plane host service module does not exist" >&2
    exit 1
  fi

  if [ -z "$CONTROL_PLANE_CREDENTIAL_FILE" ]; then
    echo "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE must point to a host credential file the MCP server reads at runtime when control-plane host bindings are configured" >&2
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

  # Fail closed on unsafe credential files before registration. Same bar as the
  # human CLI and MCP server: absolute path (already checked), owner-only leaf,
  # trusted ownership, trusted non-writable ancestry, non-empty. Errors never
  # echo the path or secret; setup rejects early so we never persist a path that
  # cannot be used safely.
  if ! node -e '
const { readTrustedCredentialFile } = require(process.argv[1]);
readTrustedCredentialFile(process.argv[2]);
' "$ROOT/modules/jarvos-control-plane/scripts/jarvos-manager.js" "$CONTROL_PLANE_CREDENTIAL_FILE"; then
    echo "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE must be a non-empty, owner-only credential file in a trusted non-writable location (mode 0600/0400)" >&2
    exit 1
  fi

  if ! node "$ROOT/modules/jarvos-control-plane/scripts/jarvos-manager.js" verify-host-service \
    --service-module "$CONTROL_PLANE_SERVICE_MODULE" >/dev/null; then
    echo "Configured control-plane host service is not ready" >&2
    exit 1
  fi

  # Register non-secret paths only — never the raw credential env value.
  MCP_ENV_ARGS=(
    --env "JARVOS_CONTROL_PLANE_SERVICE_MODULE=$CONTROL_PLANE_SERVICE_MODULE"
    --env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=$CONTROL_PLANE_CREDENTIAL_FILE"
  )
fi

if [ "${JARVOS_STEWARDSHIP_ONLY:-0}" != "1" ]; then
  if codex mcp get jarvos >/dev/null 2>&1; then
    codex mcp remove jarvos >/dev/null
  fi

  if [ ${#MCP_ENV_ARGS[@]} -gt 0 ]; then
    codex mcp add "${MCP_ENV_ARGS[@]}" jarvos -- node "$MCP_SERVER"
    echo "Registered jarvOS MCP server for Codex with control-plane host bindings: $MCP_SERVER"
  else
    codex mcp add jarvos -- node "$MCP_SERVER"
    echo "Registered jarvOS MCP server for Codex: $MCP_SERVER"
  fi
fi

mkdir -p "$(dirname "$CODEX_CONFIG")"
if [ ! -f "$CODEX_CONFIG" ]; then
  touch "$CODEX_CONFIG"
fi

node - "$CODEX_CONFIG" "$HOOK_SCRIPT" "$TURN_HOOK_SCRIPT" <<'NODE'
const fs = require('fs');

const [configPath, hookScript, turnHookScript] = process.argv.slice(2);
const commandHook = (script, matcher) => {
  const parts = [];
  if (matcher) parts.push(`matcher = ${JSON.stringify(matcher)}`);
  parts.push(`hooks = [{ type = "command", command = ${JSON.stringify(`node ${JSON.stringify(script)}`)}, async = false, timeout = 30 }]`);
  return `{ ${parts.join(', ')} }`;
};
const sessionStartHook = commandHook(hookScript, 'startup');
const turnHook = commandHook(turnHookScript);
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

function topLevelHookEntries(value) {
  const entries = []; let start = 0; let braces = 0; let brackets = 0; let quote = null; let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === ',' && braces === 0 && brackets === 0) { entries.push(value.slice(start, index).trim()); start = index + 1; }
  }
  const tail = value.slice(start).trim(); if (tail) entries.push(tail); return entries;
}

function setHook(content, event, hookScript, hook) {
  const lines = content.split(/\n/);
  const hookLine = `${event} = [${hook}]`;
  let start = lines.findIndex((line) => /^\[hooks\]\s*$/.test(line));
  if (start < 0) {
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    return `${content}${suffix}\n[hooks]\n${hookLine}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  for (let i = start + 1; i < end; i += 1) {
    if (!new RegExp(`^\\s*${event}\\s*=`).test(lines[i])) continue;
    const managedHookName = hookScript.split(/[\\/]/).pop();
    if (lines[i].includes(managedHookName)) {
      const open = lines[i].indexOf('['); const close = lines[i].lastIndexOf(']');
      if (open < 0 || close <= open) throw new Error(`invalid ${event} hook list`);
      const preserved = topLevelHookEntries(lines[i].slice(open + 1, close))
        .filter((entry) => !entry.includes(managedHookName));
      lines[i] = `${lines[i].slice(0, open + 1)}${[...preserved, hook].join(', ')}${lines[i].slice(close)}`;
      return lines.join('\n');
    }

    const close = lines[i].lastIndexOf(']');
    if (close >= 0) {
      const before = lines[i].slice(0, close).trimEnd();
      const separator = before.endsWith('[') ? '' : ',';
      lines[i] = `${before}${separator} ${hook}${lines[i].slice(close)}`;
      return lines.join('\n');
    }
  }

  lines.splice(end, 0, hookLine);
  return lines.join('\n');
}

next = setHook(next, 'SessionStart', hookScript, sessionStartHook);
next = setHook(next, 'UserPromptSubmit', turnHookScript, turnHook);
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
  if node "$TRUST_SCRIPT" "$ROOT" "$HOOK_SCRIPT" && node "$TRUST_SCRIPT" "$ROOT" "$TURN_HOOK_SCRIPT"; then
    echo "Trusted jarvOS Codex lifecycle hooks."
  else
    echo "Could not automatically trust jarvOS Codex lifecycle hooks; review them in Codex hooks settings." >&2
  fi
else
  echo "Skipping automatic hook trust for custom CODEX_CONFIG: $CODEX_CONFIG"
fi
