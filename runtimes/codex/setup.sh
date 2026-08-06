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

node - "$CODEX_CONFIG" "$LEGACY_HOOKS_JSON" "$HOOK_SCRIPT" "$TURN_HOOK_SCRIPT" "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" <<'NODE'
const fs = require('fs');
const path = require('path');

const [configPath, legacyHooksPath, hookScript, turnHookScript, rollback] = process.argv.slice(2);
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

function tomlHookEntry(entry) {
  return `{ ${Object.entries(entry).map(([key, value]) => {
    if (key === 'hooks') return `${tomlKey(key)} = [${value.map(tomlCommandHook).join(', ')}]`;
    return `${tomlKey(key)} = ${tomlScalar(value)}`;
  }).join(', ')} }`;
}

function tomlCommandHook(hook) {
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
    if (!event || !Array.isArray(entries)) fail(`${label}.${event} must be an array`);
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

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = JSON.stringify(canonicalize(entry));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function skipWhitespace(value, index) {
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function parseTomlString(value, index) {
  const quote = value[index];
  let cursor = index + 1;
  let escaped = false;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote === '"' && escaped) escaped = false;
    else if (quote === '"' && character === '\\') escaped = true;
    else if (character === quote) break;
    cursor += 1;
  }
  if (cursor >= value.length) fail('unterminated TOML string in hooks table');
  const raw = value.slice(index, cursor + 1);
  try {
    return { value: quote === '"' ? JSON.parse(raw) : raw.slice(1, -1), end: cursor + 1 };
  } catch (error) {
    fail(`unsupported TOML string in hooks table: ${error.message}`);
  }
}

function parseTomlKey(value, index) {
  index = skipWhitespace(value, index);
  if (value[index] === '"' || value[index] === "'") return parseTomlString(value, index);
  const match = /^[A-Za-z0-9_-]+/.exec(value.slice(index));
  if (!match) fail('unsupported TOML key in hooks table');
  return { value: match[0], end: index + match[0].length };
}

function parseTomlValue(value, index) {
  index = skipWhitespace(value, index);
  if (value[index] === '"' || value[index] === "'") return parseTomlString(value, index);
  if (value[index] === '[') {
    const result = []; let cursor = skipWhitespace(value, index + 1);
    if (value[cursor] === ']') return { value: result, end: cursor + 1 };
    while (true) {
      const item = parseTomlValue(value, cursor); result.push(item.value); cursor = skipWhitespace(value, item.end);
      if (value[cursor] === ']') return { value: result, end: cursor + 1 };
      if (value[cursor] !== ',') fail('invalid TOML array in hooks table');
      cursor = skipWhitespace(value, cursor + 1);
    }
  }
  if (value[index] === '{') {
    const result = {}; let cursor = skipWhitespace(value, index + 1);
    if (value[cursor] === '}') return { value: result, end: cursor + 1 };
    while (true) {
      const key = parseTomlKey(value, cursor); cursor = skipWhitespace(value, key.end);
      if (value[cursor] !== '=') fail('invalid TOML inline table in hooks table');
      const item = parseTomlValue(value, cursor + 1);
      if (Object.prototype.hasOwnProperty.call(result, key.value)) fail('duplicate TOML key in hooks table');
      result[key.value] = item.value; cursor = skipWhitespace(value, item.end);
      if (value[cursor] === '}') return { value: result, end: cursor + 1 };
      if (value[cursor] !== ',') fail('invalid TOML inline table in hooks table');
      cursor = skipWhitespace(value, cursor + 1);
    }
  }
  const token = /^[^\s,}\]]+/.exec(value.slice(index));
  if (!token) fail('unsupported TOML value in hooks table');
  if (token[0] === 'true' || token[0] === 'false') return { value: token[0] === 'true', end: index + token[0].length };
  const number = Number(token[0]);
  if (Number.isFinite(number)) return { value: number, end: index + token[0].length };
  fail(`unsupported TOML value in hooks table: ${token[0]}`);
}

function tableRange(content, name) {
  const header = new RegExp(`^\\s*\\[${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\]\\s*(?:#.*)?$`, 'm');
  const match = header.exec(content);
  if (!match) return null;
  const start = match.index + match[0].length + (content[match.index + match[0].length] === '\n' ? 1 : 0);
  const nextTable = /^\s*\[/gm; nextTable.lastIndex = start;
  const next = nextTable.exec(content);
  return { start, end: next ? next.index : content.length };
}

function hookAssignment(content, event) {
  const range = tableRange(content, 'hooks');
  if (!range) return null;
  const assignments = /^[ \t]*(?:[A-Za-z0-9_-]+|"(?:\\.|[^"\\])*"|'[^']*')[ \t]*=/gm;
  const table = content.slice(range.start, range.end);
  let match;
  while ((match = assignments.exec(table))) {
    const assignmentStart = range.start + match.index;
    const key = parseTomlKey(content, assignmentStart);
    if (key.value !== event) continue;
    const equals = skipWhitespace(content, key.end);
    const valueStart = equals + 1;
    const parsed = parseTomlValue(content, valueStart);
    const lineEnd = content.indexOf('\n', parsed.end);
    const trailing = content.slice(parsed.end, lineEnd < 0 ? range.end : lineEnd).trim();
    if (trailing && !trailing.startsWith('#')) fail(`unexpected text after ${event} hook list`);
    return { range, valueStart, valueEnd: parsed.end, entries: validateHookMap({ [event]: parsed.value }, 'config hooks')[event] };
  }
  return { range };
}

function mergeHookEntries(content, event, additions, removeManaged) {
  const assignment = hookAssignment(content, event);
  const existing = assignment && assignment.entries ? assignment.entries : [];
  const retained = removeManaged ? existing.filter((entry) => !isManagedJarvosHook(entry)) : existing;
  const entries = dedupe([...retained, ...additions]);
  const rendered = `[${entries.map(tomlHookEntry).join(', ')}]`;
  if (!assignment) {
    const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    return `${content}${suffix}\n[hooks]\n${tomlKey(event)} = ${rendered}\n`;
  }
  if (!assignment.entries) return `${content.slice(0, assignment.range.end)}${tomlKey(event)} = ${rendered}\n${content.slice(assignment.range.end)}`;
  return `${content.slice(0, assignment.valueStart)}${rendered}${content.slice(assignment.valueEnd)}`;
}

function isManagedJarvosHook(entry) {
  return entry.hooks.some((hook) => typeof hook.command === 'string' && /jarvos-(?:session-start|session-turn)-hook\.js\b/.test(hook.command));
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

let migrated = null;
if (fs.existsSync(legacyHooksPath)) {
  migrated = parseLegacyHooks(legacyHooksPath);
  for (const [event, entries] of Object.entries(migrated)) next = mergeHookEntries(next, event, entries, false);
}

if (rollback === '1') {
  next = mergeHookEntries(next, 'SessionStart', [], true);
  next = mergeHookEntries(next, 'UserPromptSubmit', [], true);
} else {
  next = mergeHookEntries(next, 'SessionStart', [validateHookEntry({ matcher: 'startup', hooks: [{ type: 'command', command: `node ${JSON.stringify(hookScript)}`, async: false, timeout: 30 }] }, 'jarvOS SessionStart')], true);
  next = mergeHookEntries(next, 'UserPromptSubmit', [validateHookEntry({ hooks: [{ type: 'command', command: `node ${JSON.stringify(turnHookScript)}`, async: false, timeout: 30 }] }, 'jarvOS UserPromptSubmit')], true);
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
