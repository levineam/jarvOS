#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MCP_SERVER="$ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
HOOK_SCRIPT="$ROOT/runtimes/claude/jarvos-session-start-hook.js"
TURN_HOOK_SCRIPT="$ROOT/runtimes/claude/jarvos-session-turn-hook.js"
PRECOMPACT_HOOK_SCRIPT="$ROOT/runtimes/claude/jarvos-precompact-hook.js"
CLAUDE_MD_TEMPLATE="$ROOT/runtimes/claude/templates/CLAUDE.md.template"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
CLAUDE_DESKTOP_CONFIG="${CLAUDE_DESKTOP_CONFIG:-$HOME/Library/Application Support/Claude/claude_desktop_config.json}"
CLAUDE_MD_PATH="${CLAUDE_MD_PATH:-$HOME/.claude/CLAUDE.md}"
STEWARDSHIP_BRIDGE_COMMAND="${JARVOS_STEWARDSHIP_BRIDGE_COMMAND:-}"
STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT="${JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT:-}"
STEWARDSHIP_BRIDGE_PATH="${JARVOS_STEWARDSHIP_BRIDGE_PATH:-}"
STEWARDSHIP_STABLE_ROOT="${JARVOS_STEWARDSHIP_STABLE_ROOT:-}"
STEWARDSHIP_DISPATCHER=""
# Optional Todo work-action host bindings. Unset keeps public/minimal behavior.
# When set, persist the non-secret absolute paths on the MCP child. Trust
# checks stay in the MCP server (fail closed on an untrusted path).
WORK_ACTION_SERVICE_MODULE="${JARVOS_WORK_ACTION_SERVICE_MODULE:-}"
PROJECTS_CONTEXT_CONFIG="${JARVOS_PROJECTS_CONTEXT_CONFIG:-}"
MCP_ENV_ARGS=()

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

append_optional_mcp_env JARVOS_WORK_ACTION_SERVICE_MODULE "$WORK_ACTION_SERVICE_MODULE"
append_optional_mcp_env JARVOS_PROJECTS_CONTEXT_CONFIG "$PROJECTS_CONTEXT_CONFIG"

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
if (!trustedDirectory(root) || !trustedExecutable(dispatcher)) throw new Error('stable jarvOS stewardship dispatcher is missing or unsafe');
NODE
elif [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ] && [ -n "$STEWARDSHIP_STABLE_ROOT" ] && [ "${STEWARDSHIP_STABLE_ROOT#/}" != "$STEWARDSHIP_STABLE_ROOT" ]; then
  # The bundle may already be gone. Its absolute former path is still the only
  # dispatcher path rollback is allowed to remove.
  STEWARDSHIP_DISPATCHER="$STEWARDSHIP_STABLE_ROOT/jarvos-stewardship-dispatcher"
fi

if [ ! -f "$MCP_SERVER" ]; then
  echo "jarvOS MCP server not found: $MCP_SERVER" >&2
  exit 1
fi

if [ ! -f "$HOOK_SCRIPT" ]; then
  echo "jarvOS Claude hook script not found: $HOOK_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$TURN_HOOK_SCRIPT" ]; then
  echo "jarvOS Claude turn hook script not found: $TURN_HOOK_SCRIPT" >&2
  exit 1
fi

if [ ! -f "$PRECOMPACT_HOOK_SCRIPT" ]; then
  echo "jarvOS Claude precompact hook script not found: $PRECOMPACT_HOOK_SCRIPT" >&2
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
  if [ ${#MCP_ENV_ARGS[@]} -gt 0 ]; then
    claude mcp add --scope user "${MCP_ENV_ARGS[@]}" jarvos -- node "$MCP_SERVER" >/dev/null
  else
    claude mcp add --scope user jarvos -- node "$MCP_SERVER" >/dev/null
  fi
  warn_if_claude_mcp_shadowed
  echo "Registered jarvOS MCP server for Claude Code: $MCP_SERVER"
else
  echo "Claude Code CLI not found on PATH; skipping Claude Code MCP registration." >&2
fi

node - "$CLAUDE_SETTINGS" "$HOOK_SCRIPT" "$TURN_HOOK_SCRIPT" "$PRECOMPACT_HOOK_SCRIPT" "$STEWARDSHIP_DISPATCHER" "$CLAUDE_DESKTOP_CONFIG" "$MCP_SERVER" "${JARVOS_STEWARDSHIP_ONLY:-0}" "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" "$STEWARDSHIP_BRIDGE_COMMAND" "$STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT" "$STEWARDSHIP_BRIDGE_PATH" "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:-}" <<'NODE'
const fs = require('fs');
const path = require('path');

const [settingsPath, hookScript, turnHookScript, precompactHookScript, dispatcher, desktopConfigPath, mcpServer, stewardshipOnly, rollback, bridgeCommand, claudeSessionMapRoot, bridgePath, stagedRoot] = process.argv.slice(2);

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

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function privateDirectory(value, name) {
  if (!path.isAbsolute(value || '')) throw new Error(`${name} must be an absolute path`);
  const stat = fs.lstatSync(value);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== null && stat.uid !== uid)) {
    throw new Error(`${name} must be an owner-only directory`);
  }
  return fs.realpathSync(value);
}

function stewardshipBridgeEnvironment() {
  if (!bridgeCommand && !claudeSessionMapRoot && !bridgePath) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bridgeCommand || '')) throw new Error('JARVOS_STEWARDSHIP_BRIDGE_COMMAND must be a bounded executable name');
  const mapRoot = privateDirectory(claudeSessionMapRoot, 'JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT');
  const bin = privateDirectory(bridgePath, 'JARVOS_STEWARDSHIP_BRIDGE_PATH');
  const executable = path.join(bin, bridgeCommand);
  const stat = fs.lstatSync(executable);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o111) === 0) throw new Error('JARVOS_STEWARDSHIP_BRIDGE_PATH must contain an owner-only bridge executable');
  return { command: bridgeCommand, mapRoot, bin };
}

function upsertClaudeCodeHook(settings, bridge) {
  const next = { ...settings };
  const hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? { ...next.hooks } : {};

  const ownedPaths = [hookScript, turnHookScript, precompactHookScript, dispatcher].filter(Boolean);
  if (path.isAbsolute(stagedRoot || '')) {
    ownedPaths.push(path.join(stagedRoot, 'runtimes', 'claude', 'jarvos-session-start-hook.js'));
    ownedPaths.push(path.join(stagedRoot, 'runtimes', 'claude', 'jarvos-session-turn-hook.js'));
    ownedPaths.push(path.join(stagedRoot, 'runtimes', 'claude', 'jarvos-precompact-hook.js'));
  }
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasOwnedPath = (command, target) => new RegExp(`(?:^|[\\s'\"])${escapeRegex(target)}(?=$|[\\s'\"])`).test(command);

  function upsert(event, script, entry) {
    const entries = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const retained = entries.map((candidate) => {
      if (!Array.isArray(candidate?.hooks)) return candidate;
      const retainedHooks = candidate.hooks.filter((hook) => typeof hook?.command !== 'string' || !ownedPaths.some((target) => hasOwnedPath(hook.command, target)));
      if (retainedHooks.length === candidate.hooks.length) return candidate;
      return retainedHooks.length ? { ...candidate, hooks: retainedHooks } : null;
    }).filter(Boolean);
    if (entry) hooks[event] = [...retained, entry];
    else if (retained.length) hooks[event] = retained;
    else delete hooks[event];
  }

  function commandEntry(script, action, matcher) {
    const target = dispatcher
      ? `${shellQuote(dispatcher)} --harness claude --action ${action}`
      : `node ${shellQuote(script)}`;
    const command = bridge
      ? `env JARVOS_STEWARDSHIP_BRIDGE_COMMAND=${shellQuote(bridge.command)} JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT=${shellQuote(bridge.mapRoot)} PATH=${shellQuote(bridge.bin)}:\"$PATH\" ${target}`
      : target;
    const entry = {
      hooks: [{ type: 'command', command, timeout: 30 }],
    };
    if (matcher) entry.matcher = matcher;
    return entry;
  }

  if (rollback === '1') {
    upsert('SessionStart', hookScript, null);
    upsert('UserPromptSubmit', turnHookScript, null);
    upsert('PreCompact', precompactHookScript, null);
  } else {
    upsert('SessionStart', hookScript, commandEntry(hookScript, 'session-start', 'startup|resume|compact'));
    upsert('UserPromptSubmit', turnHookScript, commandEntry(turnHookScript, 'session-turn'));
    upsert('PreCompact', precompactHookScript, commandEntry(precompactHookScript, 'session-precompact'));
  }
  next.hooks = hooks;
  return next;
}

function optionalMcpHostEnv() {
  const env = {};
  for (const name of ['JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_PROJECTS_CONTEXT_CONFIG']) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) env[name] = value.trim();
  }
  return env;
}

function upsertClaudeDesktopMcp(config) {
  const next = { ...config };
  next.mcpServers = next.mcpServers && typeof next.mcpServers === 'object' && !Array.isArray(next.mcpServers)
    ? { ...next.mcpServers }
    : {};
  const hostEnv = optionalMcpHostEnv();
  next.mcpServers.jarvos = {
    command: 'node',
    args: [mcpServer],
  };
  if (Object.keys(hostEnv).length > 0) next.mcpServers.jarvos.env = hostEnv;
  return next;
}

backupAndWriteJson(settingsPath, upsertClaudeCodeHook(readJsonFile(settingsPath, {}), rollback === '1' ? null : stewardshipBridgeEnvironment()), 'Claude Code settings');
if (stewardshipOnly !== '1') backupAndWriteJson(desktopConfigPath, upsertClaudeDesktopMcp(readJsonFile(desktopConfigPath, {})), 'Claude Desktop MCP config');
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
