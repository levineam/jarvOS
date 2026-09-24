#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
MANAGED_HOOKS_JSON="$ROOT/runtimes/codex/hooks.json"
HOOK_SCRIPT="$ROOT/runtimes/codex/jarvos-session-start-hook.js"
TURN_HOOK_SCRIPT="$ROOT/runtimes/codex/jarvos-session-turn-hook.js"
TRUST_SCRIPT="$ROOT/runtimes/codex/trust-session-start-hook.js"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="${CODEX_CONFIG:-$CODEX_HOME/config.toml}"
LEGACY_HOOKS_JSON="$CODEX_HOME/hooks.json"
CONTROL_PLANE_SERVICE_MODULE="${JARVOS_CONTROL_PLANE_SERVICE_MODULE:-}"
# Setup registers only a non-secret file path. Never pass the credential value
# through `codex mcp add --env` — that puts it on argv and persists it in config.
CONTROL_PLANE_CREDENTIAL_FILE="${JARVOS_CONTROL_PLANE_CREDENTIAL_FILE:-}"
STEWARDSHIP_BRIDGE_COMMAND="${JARVOS_STEWARDSHIP_BRIDGE_COMMAND:-}"
STEWARDSHIP_CODEX_SESSION_MAP_ROOT="${JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT:-}"
STEWARDSHIP_STABLE_ROOT="${JARVOS_STEWARDSHIP_STABLE_ROOT:-}"
STEWARDSHIP_DISPATCHER=""
CODEX_PROVIDER_MODE="${JARVOS_CODEX_PROVIDER_MODE:-}"
# Optional owner-controlled stable selector-aware entrypoint. When set, this
# is what gets persisted in Codex config instead of this immutable install's
# own MCP script -- so a later selected-runtime transition does not require
# rewriting persisted client config. Unset preserves the current portable
# behavior: register this run's own $MCP_SERVER directly.
STABLE_MCP_ENTRYPOINT="${JARVOS_MCP_STABLE_ENTRYPOINT:-}"

# The private installer materializes this owner-controlled bundle once. Native
# configuration must refer to it, never to a selected immutable runtime stage.
if [ -n "${JARVOS_MANAGED_REPOSITORIES:-}" ] && [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" != "1" ]; then
  : "${JARVOS_STEWARDSHIP_STABLE_ROOT:?materialize the stable stewardship bundle before enabling managed repositories}"
  STEWARDSHIP_DISPATCHER="$STEWARDSHIP_STABLE_ROOT/jarvos-stewardship-dispatcher"
  node - "$STEWARDSHIP_STABLE_ROOT" "$STEWARDSHIP_DISPATCHER" <<'NODE'
const fs = require('fs'); const path = require('path');
const [root, dispatcher] = process.argv.slice(2);
function trustedDirectory(value) {
  const stat = fs.lstatSync(value); const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return path.isAbsolute(value) && !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);
}
function trustedExecutable(value) {
  const stat = fs.lstatSync(value); const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o077) === 0 && (stat.mode & 0o111) !== 0 && (uid === null || stat.uid === uid);
}
function trustedAncestry(value) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!path.isAbsolute(value) || path.resolve(value) !== value || fs.realpathSync(value) !== value) return false;
  for (let current = value; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    const trustedOwner = uid === null || stat.uid === uid || stat.uid === 0;
    const safelyWritable = (stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0;
    if (stat.isSymbolicLink() || !stat.isDirectory() || !trustedOwner || !safelyWritable) return false;
    if (path.dirname(current) === current) return true;
  }
}
if (!trustedDirectory(root) || !trustedAncestry(root) || !trustedExecutable(dispatcher)) throw new Error('stable jarvOS stewardship dispatcher is missing or unsafe');
NODE
elif [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ] && [ -n "$STEWARDSHIP_STABLE_ROOT" ] && [ "${STEWARDSHIP_STABLE_ROOT#/}" != "$STEWARDSHIP_STABLE_ROOT" ]; then
  STEWARDSHIP_DISPATCHER="$STEWARDSHIP_STABLE_ROOT/jarvos-stewardship-dispatcher"
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH" >&2
  exit 1
fi

if [ ! -f "$MCP_SERVER" ]; then
  echo "jarvOS MCP server not found: $MCP_SERVER" >&2
  exit 1
fi

if [ ! -f "$MANAGED_HOOKS_JSON" ]; then
  echo "jarvOS Codex hooks config not found: $MANAGED_HOOKS_JSON" >&2
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

# The stable entrypoint is what setup registers with Codex, so it must be
# validated to the same bar as the stable stewardship dispatcher: absolute,
# not a symlink, an owner-only executable file. An owner-only leaf is not
# enough on its own -- an unprivileged co-tenant of a writable *ancestor*
# directory can delete and replace that "trusted" file at will, so every
# directory from the entrypoint's parent up to the filesystem root ("/",
# a boundary public setup can name without inventing a private path) must
# also be owned by us (or root) and not group/world-writable, mirroring the
# stewardship dispatcher and control-plane credential-file checks. Reject
# without echoing the path -- an unsafe binding is refused before it is ever
# persisted.
MCP_COMMAND=(node "$MCP_SERVER")
if [ -n "$STABLE_MCP_ENTRYPOINT" ]; then
  case "$STABLE_MCP_ENTRYPOINT" in
    /*) ;;
    *)
      echo "JARVOS_MCP_STABLE_ENTRYPOINT must be an absolute path" >&2
      exit 1
      ;;
  esac
  if ! node -e '
const fs = require("fs");
const path = require("path");
const value = process.argv[1];
let stat;
try { stat = fs.lstatSync(value); } catch { process.exit(1); }
const uid = typeof process.getuid === "function" ? process.getuid() : null;
if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o111) === 0 || (uid !== null && stat.uid !== uid)) process.exit(1);
function trustedAncestor(dirStat) {
  if (!dirStat.isDirectory()) return false;
  if (uid !== null && dirStat.uid !== 0 && dirStat.uid !== uid) return false;
  const writable = (dirStat.mode & 0o022) !== 0;
  const sticky = (dirStat.mode & 0o1000) !== 0;
  return !writable || sticky;
}
let dir = path.dirname(value);
for (;;) {
  let dirStat;
  try { dirStat = fs.statSync(dir); } catch { process.exit(1); }
  if (!trustedAncestor(dirStat)) process.exit(1);
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
' "$STABLE_MCP_ENTRYPOINT"; then
    echo "JARVOS_MCP_STABLE_ENTRYPOINT must be an absolute, owner-only executable file with trusted, non-writable ancestry up to the filesystem root" >&2
    exit 1
  fi
  MCP_COMMAND=("$STABLE_MCP_ENTRYPOINT")
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

# Optional Todo work-action host bindings. Unset keeps public/minimal behavior.
# When set, persist the non-secret absolute paths on the MCP child. Trust
# checks stay in the MCP server (fail closed on an untrusted path).
append_optional_mcp_env() {
  local name="$1"
  local value="${2:-}"
  if [ -z "$value" ]; then
    return 0
  fi
  case "$value" in
    /*) ;;
    *)
      echo "${name} must be an absolute path when set" >&2
      exit 1
      ;;
  esac
  MCP_ENV_ARGS+=(--env "${name}=${value}")
}

append_optional_mcp_env JARVOS_WORK_ACTION_SERVICE_MODULE "${JARVOS_WORK_ACTION_SERVICE_MODULE:-}"
append_optional_mcp_env JARVOS_PROJECTS_CONTEXT_CONFIG "${JARVOS_PROJECTS_CONTEXT_CONFIG:-}"
append_optional_mcp_env JARVOS_COMMON_WORK_SERVICE_MODULE "${JARVOS_COMMON_WORK_SERVICE_MODULE:-}"
MCP_HAS_HOST_BINDING=${#MCP_ENV_ARGS[@]}
MCP_ENV_ARGS+=(--env "JARVOS_COMMON_WORK_HARNESS=codex")

if [ "${JARVOS_STEWARDSHIP_ONLY:-0}" != "1" ]; then
  if codex mcp get jarvos >/dev/null 2>&1; then
    codex mcp remove jarvos >/dev/null
  fi

  if [ ${#MCP_ENV_ARGS[@]} -gt 0 ]; then
    codex mcp add "${MCP_ENV_ARGS[@]}" jarvos -- "${MCP_COMMAND[@]}"
    if [ "$MCP_HAS_HOST_BINDING" -gt 0 ]; then
      echo "Registered jarvOS MCP server for Codex with host bindings: ${MCP_COMMAND[*]}"
    else
      echo "Registered jarvOS MCP server for Codex: ${MCP_COMMAND[*]}"
    fi
  else
    codex mcp add jarvos -- "${MCP_COMMAND[@]}"
    echo "Registered jarvOS MCP server for Codex: ${MCP_COMMAND[*]}"
  fi
fi

mkdir -p "$(dirname "$CODEX_CONFIG")"
if [ ! -f "$CODEX_CONFIG" ]; then
  touch "$CODEX_CONFIG"
fi

node - "$CODEX_CONFIG" "$LEGACY_HOOKS_JSON" "$HOOK_SCRIPT" "$TURN_HOOK_SCRIPT" "$STEWARDSHIP_DISPATCHER" "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" "$STEWARDSHIP_BRIDGE_COMMAND" "$STEWARDSHIP_CODEX_SESSION_MAP_ROOT" "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:-}" <<'NODE'
const fs = require('fs');
const path = require('path');

const [configPath, legacyHooksPath, hookScript, turnHookScript, dispatcher, rollback, bridgeCommand, codexSessionMapRoot, stagedRoot] = process.argv.slice(2);
const original = fs.readFileSync(configPath, 'utf8');
let next = original;

function fail(message) {
  throw new Error(`refusing Codex hook migration: ${message}`);
}

function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function isScalar(value) {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function tomlScalar(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  fail('hook fields must be string, boolean, or finite number scalars');
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function renderHookEntry(entry) {
  return `{ ${Object.entries(entry).map(([key, value]) => {
    if (key === 'hooks') return `${tomlKey(key)} = [${value.map(renderCommandHook).join(', ')}]`;
    return `${tomlKey(key)} = ${tomlScalar(value)}`;
  }).join(', ')} }`;
}

function renderCommandHook(hook) {
  return `{ ${Object.entries(hook).map(([key, value]) => `${tomlKey(key)} = ${tomlScalar(value)}`).join(', ')} }`;
}

function validateHookEntry(entry, label) {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') fail(`${label} must be an object`);
  if (!Array.isArray(entry.hooks) || entry.hooks.length === 0) fail(`${label}.hooks must be a non-empty array`);
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'hooks') continue;
    if (!isScalar(value)) fail(`${label}.${key} is unsupported`);
  }
  entry.hooks.forEach((hook, index) => {
    if (!hook || Array.isArray(hook) || typeof hook !== 'object') fail(`${label}.hooks[${index}] must be an object`);
    if (typeof hook.type !== 'string' || typeof hook.command !== 'string') fail(`${label}.hooks[${index}] requires string type and command`);
    for (const [key, value] of Object.entries(hook)) if (!isScalar(value)) fail(`${label}.hooks[${index}].${key} is unsupported`);
  });
  return entry;
}

function validateHookMap(hooks, label) {
  if (!hooks || Array.isArray(hooks) || typeof hooks !== 'object') fail(`${label} must be an object`);
  const validated = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!/^[A-Za-z0-9_-]+$/.test(event) || !Array.isArray(entries)) fail(`${label}.${event} must be a supported event array`);
    validated[event] = entries.map((entry, index) => validateHookEntry(entry, `${label}.${event}[${index}]`));
  }
  return validated;
}

function parseLegacyHooks(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot parse ${file}: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'hooks')) {
    fail(`${file} must contain only a hooks object`);
  }
  return validateHookMap(parsed.hooks, 'hooks');
}

function topLevelHookEntries(value) {
  if (!value.startsWith('[') || !value.endsWith(']')) fail('hooks must use a one-line inline array');
  const entries = []; let start = 1; let braces = 0; let brackets = 0; let quote = null; let escaped = false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\' && quote === '"') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    if (braces < 0 || brackets < 0) fail('invalid hooks inline array');
    if (character === ',' && braces === 0 && brackets === 0) { entries.push(value.slice(start, index).trim()); start = index + 1; }
  }
  if (quote || braces !== 0 || brackets !== 0) fail('unsupported hooks inline array');
  const tail = value.slice(start, -1).trim(); if (tail) entries.push(tail);
  return entries;
}

function hookIdentity(entry) {
  const matcher = /\bmatcher\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/.exec(entry);
  const commands = [...entry.matchAll(/\bcommand\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/g)].map((match) => match[1]);
  return commands.length === 1 ? `${matcher ? matcher[1] : ''}\u0000${commands[0]}` : null;
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const identity = hookIdentity(entry);
    if (!identity) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

const ownedHookPaths = [hookScript, turnHookScript, dispatcher].filter(Boolean);
if (path.isAbsolute(stagedRoot || '')) {
  ownedHookPaths.push(path.join(stagedRoot, 'runtimes', 'codex', 'jarvos-session-start-hook.js'));
  ownedHookPaths.push(path.join(stagedRoot, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'));
}
function isManagedJarvosHook(entry) {
  return ownedHookPaths.some((target) => new RegExp(`(?:^|[^A-Za-z0-9._/-])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9._/-])`).test(entry));
}

function hookTableRange(lines) {
  const start = lines.findIndex((line) => /^\[hooks\]\s*$/.test(line));
  if (start < 0) return { start, end: lines.length };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) if (/^\s*\[/.test(lines[index])) { end = index; break; }
  return { start, end };
}

function validateHookTable(content) {
  const lines = content.split(/\n/); const { start, end } = hookTableRange(lines);
  for (let index = start + 1; start >= 0 && index < end; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    const match = /^\s*[A-Za-z0-9_-]+\s*=\s*(\[.*\])\s*(?:#.*)?$/.exec(lines[index]);
    if (!match) fail('hooks table must use one-line inline-array assignments');
    topLevelHookEntries(match[1]);
  }
}

function setHook(content, event, hook, removeManaged) {
  const lines = content.split(/\n/); const { start, end } = hookTableRange(lines);
  if (start < 0) {
    if (!hook) return content;
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    return `${content}${suffix}\n[hooks]\n${tomlKey(event)} = [${hook}]\n`;
  }
  const eventLine = new RegExp(`^\\s*${event}\\s*=\\s*(\\[.*\\])\\s*(?:#.*)?$`);
  for (let index = start + 1; index < end; index += 1) {
    const match = eventLine.exec(lines[index]);
    if (!match) continue;
    const existing = topLevelHookEntries(match[1]);
    const retained = removeManaged ? existing.filter((entry) => !isManagedJarvosHook(entry)) : existing;
    const entries = hook ? dedupe([...retained, hook]) : retained;
    lines[index] = `${event} = [${entries.join(', ')}]`;
    return lines.join('\n');
  }
  if (!hook) return content;
  lines.splice(end, 0, `${event} = [${hook}]`);
  return lines.join('\n');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', 'Z');
}

function backup(file, suffix) {
  const target = `${file}.bak-jarvos-${suffix}`;
  fs.copyFileSync(file, target);
  fs.chmodSync(target, fs.statSync(file).mode);
  return target;
}

function writeAtomically(file, content) {
  const mode = fs.statSync(file).mode;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.jarvos-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

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

function tomlTableRange(lines, header) {
  const headerRe = new RegExp(`^\\[${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`);
  const matches = lines.map((line, index) => headerRe.test(line) ? index : -1).filter((index) => index >= 0);
  if (matches.length > 1) fail(`${header} must be declared at most once`);
  const start = matches[0] ?? -1;
  if (start < 0) return { start, end: lines.length };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) if (/^\s*\[/.test(lines[index])) { end = index; break; }
  return { start, end };
}

function parseEnvironmentSet(value) {
  if (!value.startsWith('{') || !value.endsWith('}')) fail('shell_environment_policy.set must use a one-line inline table');
  const entries = topLevelHookEntries(`[${value.slice(1, -1)}]`);
  const result = {};
  for (const entry of entries) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*")\s*$/.exec(entry);
    if (!match) fail('shell_environment_policy.set supports only string environment values');
    try { result[match[1]] = JSON.parse(match[2]); } catch { fail('shell_environment_policy.set contains an invalid string'); }
  }
  return result;
}

function renderEnvironmentSet(entries) {
  return `{ ${Object.entries(entries).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }`;
}

const STEWARDSHIP_ENVIRONMENT_KEYS = [
  'JARVOS_STEWARDSHIP_BRIDGE_COMMAND',
  'JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT',
  'JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE',
];

function environmentSetAssignment(lines, range) {
  let index = -1; let entries = {}; let comment = '';
  for (let candidate = range.start + 1; candidate < range.end; candidate += 1) {
    const match = /^\s*set\s*=\s*(\{.*\})\s*(#.*)?\s*$/.exec(lines[candidate]);
    if (!match) continue;
    if (index >= 0) fail('shell_environment_policy must contain at most one set assignment');
    index = candidate; entries = parseEnvironmentSet(match[1]); comment = match[2] || '';
  }
  return { index, entries, comment };
}

function environmentSubtableEntries(lines, range) {
  const entries = new Map();
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (/^\s*(?:#.*)?$/.test(lines[index])) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/.exec(lines[index]);
    if (!match) fail('shell_environment_policy.set supports only string environment values');
    if (entries.has(match[1])) fail(`shell_environment_policy.set contains duplicate ${match[1]} assignments`);
    try { entries.set(match[1], { value: JSON.parse(match[2]), index }); } catch { fail('shell_environment_policy.set contains an invalid string'); }
  }
  return entries;
}

function setStewardshipBridgeEnvironment(content, bridge) {
  if (bridge === undefined) return content;
  let lines = content.split(/\n/);
  const policyRange = tomlTableRange(lines, 'shell_environment_policy');
  const subtableRange = tomlTableRange(lines, 'shell_environment_policy.set');
  if (policyRange.start < 0 && subtableRange.start < 0) {
    if (!bridge) return content;
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    return `${content}${suffix}\n[shell_environment_policy]\nset = ${renderEnvironmentSet(bridge)}\n`;
  }

  const inline = policyRange.start >= 0 ? environmentSetAssignment(lines, policyRange) : { index: -1, entries: {}, comment: '' };
  if (subtableRange.start < 0) {
    const entries = { ...inline.entries };
    for (const key of STEWARDSHIP_ENVIRONMENT_KEYS) delete entries[key];
    if (bridge) Object.assign(entries, bridge);
    if (Object.keys(entries).length) {
      const line = `set = ${renderEnvironmentSet(entries)}${inline.comment ? ` ${inline.comment}` : ''}`;
      if (inline.index >= 0) lines[inline.index] = line;
      else lines.splice(policyRange.end, 0, line);
      return lines.join('\n');
    }
    if (inline.index >= 0) {
      if (inline.comment) lines[inline.index] = inline.comment;
      else lines.splice(inline.index, 1);
    }
    return lines.join('\n');
  }

  // TOML permits either `set = { ... }` or `[shell_environment_policy.set]`,
  // but never both. Prefer the existing nested table and repair a stale inline
  // representation by moving its unrelated values into that table.
  const nested = environmentSubtableEntries(lines, subtableRange);
  for (const [key, value] of Object.entries(inline.entries)) {
    const existing = nested.get(key);
    if (existing && existing.value !== value) fail(`shell_environment_policy.set conflicts with inline set for ${key}`);
  }
  const remove = [];
  if (inline.index >= 0) {
    // A trailing comment belongs to the user, not the invalid inline table.
    // Keep it as a standalone comment while removing only the assignment.
    if (inline.comment) lines[inline.index] = inline.comment;
    else remove.push(inline.index);
  }
  for (const key of STEWARDSHIP_ENVIRONMENT_KEYS) {
    const existing = nested.get(key);
    if (existing) remove.push(existing.index);
  }
  for (const index of remove.sort((a, b) => b - a)) lines.splice(index, 1);

  // An empty parent header is not useful, and is invalid when it follows the
  // nested table it implicitly defined. Remove only that header: comments in
  // an otherwise-empty user section remain useful documentation and must not
  // be swept up with jarvOS's stale inline assignment.
  const repairedPolicyRange = tomlTableRange(lines, 'shell_environment_policy');
  if (repairedPolicyRange.start >= 0 && !lines.slice(repairedPolicyRange.start + 1, repairedPolicyRange.end).some((line) => !/^\s*(?:#.*)?$/.test(line))) {
    lines.splice(repairedPolicyRange.start, 1);
  }

  // Re-find the nested table after removals, then append only values absent
  // from it. This keeps unrelated nested-table lines and their comments intact.
  const repairedRange = tomlTableRange(lines, 'shell_environment_policy.set');
  const repaired = environmentSubtableEntries(lines, repairedRange);
  const additions = [];
  for (const [key, value] of Object.entries(inline.entries)) {
    if (STEWARDSHIP_ENVIRONMENT_KEYS.includes(key) || repaired.has(key)) continue;
    additions.push(`${key} = ${JSON.stringify(value)}`);
  }
  if (bridge) for (const [key, value] of Object.entries(bridge)) additions.push(`${key} = ${JSON.stringify(value)}`);
  if (additions.length) lines.splice(repairedRange.end, 0, ...additions);
  return lines.join('\n');
}

function stewardshipBridgeEnvironment(command, codexMapRoot) {
  if (!command && !codexMapRoot) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command || '')) fail('JARVOS_STEWARDSHIP_BRIDGE_COMMAND must be a bounded executable name');
  if (!path.isAbsolute(codexMapRoot || '')) fail('JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT must be an absolute path');
  return {
    JARVOS_STEWARDSHIP_BRIDGE_COMMAND: command,
    JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: codexMapRoot,
  };
}

let migrated = null;
if (fs.existsSync(legacyHooksPath)) {
  migrated = parseLegacyHooks(legacyHooksPath);
  validateHookTable(next);
  for (const [event, entries] of Object.entries(migrated)) for (const entry of entries) next = setHook(next, event, renderHookEntry(entry), false);
}

const bridgeEnvironment = stewardshipBridgeEnvironment(bridgeCommand, codexSessionMapRoot);

if (rollback === '1') {
  validateHookTable(next);
  next = setHook(next, 'SessionStart', null, true);
  next = setHook(next, 'UserPromptSubmit', null, true);
  next = setStewardshipBridgeEnvironment(next, null);
} else {
  validateHookTable(next);
  const startCommand = dispatcher
    ? `${shellQuote(dispatcher)} --harness codex --action session-start`
    : `node ${shellQuote(hookScript)}`;
  const turnCommand = dispatcher
    ? `${shellQuote(dispatcher)} --harness codex --action session-turn`
    : `node ${shellQuote(turnHookScript)}`;
  next = setHook(next, 'SessionStart', renderHookEntry({ matcher: 'startup|resume', hooks: [{ type: 'command', command: startCommand, async: false, timeout: 30 }] }), true);
  next = setHook(next, 'UserPromptSubmit', renderHookEntry({ hooks: [{ type: 'command', command: turnCommand, async: false, timeout: 30 }] }), true);
  next = setStewardshipBridgeEnvironment(next, bridgeEnvironment);
}
next = setFeature(next, 'hooks', 'true');
next = removeFeature(next, 'codex_hooks');

if (next !== original || migrated) {
  const backupStamp = stamp();
  const backupPath = next !== original ? backup(configPath, backupStamp) : null;
  const legacyBackupPath = migrated ? backup(legacyHooksPath, backupStamp) : null;
  writeAtomically(configPath, next);
  if (migrated) fs.unlinkSync(legacyHooksPath);
  console.log(`Updated Codex config for jarvOS hooks: ${configPath}`);
  if (backupPath) console.log(`Backup: ${backupPath}`);
  if (legacyBackupPath) console.log(`Migrated legacy Codex hooks with backup: ${legacyBackupPath}`);
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

# Compound Engineering is a managed external provider, not an ambient setup
# side effect. New managed coding profiles pass `new-managed`; existing
# profiles must pass `opt-in`. With no explicit mode setup preserves the
# profile, while rollback removes only a recorded jarvOS-owned activation.
# Run this after the hook transaction so a provider reconciliation failure
# cannot prevent jarvOS from rolling back its own lifecycle configuration.
if [ -n "$CODEX_PROVIDER_MODE" ] || [ "${JARVOS_PROFILE:-}" = "codex" ] || [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
  node "$ROOT/runtimes/codex/compound-engineering-activation.js"
fi
