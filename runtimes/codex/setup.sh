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
# The receipt is intentionally limited to the MCP registration created by
# this setup run. It authorizes receipt-scoped rollback reconciliation; it is
# not a copy of the Codex configuration and never contains credential values.
MCP_RECEIPT_MODULE="$ROOT/runtimes/codex/mcp-registration-receipt.js"
MCP_RECEIPT_PATH="$CODEX_HOME/jarvos-codex-mcp-receipt.json"
MCP_LOCK_PATH="$CODEX_HOME/.jarvos-codex-mcp.lock"
HOOK_FEATURE_RECEIPT_MODULE="$ROOT/runtimes/codex/hook-feature-receipt.js"
HOOK_FEATURE_RECEIPT_PATH="$CODEX_HOME/jarvos-codex-hook-feature-receipt.json"
export CODEX_HOME CODEX_CONFIG
CONTROL_PLANE_SERVICE_MODULE="${JARVOS_CONTROL_PLANE_SERVICE_MODULE:-}"
# Setup registers only a non-secret file path. Never pass the credential value
# through `codex mcp add --env` — that puts it on argv and persists it in config.
CONTROL_PLANE_CREDENTIAL_FILE="${JARVOS_CONTROL_PLANE_CREDENTIAL_FILE:-}"
STEWARDSHIP_BRIDGE_COMMAND="${JARVOS_STEWARDSHIP_BRIDGE_COMMAND:-}"
STEWARDSHIP_CODEX_SESSION_MAP_ROOT="${JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT:-}"
STEWARDSHIP_STABLE_ROOT="${JARVOS_STEWARDSHIP_STABLE_ROOT:-}"
STEWARDSHIP_DISPATCHER=""
CODEX_PROVIDER_MODE="${JARVOS_CODEX_PROVIDER_MODE:-}"
CODEX_EXECUTABLE="${JARVOS_CODEX_EXECUTABLE:-codex}"
# Optional owner-controlled stable selector-aware entrypoint. When set, this
# is what gets persisted in Codex config instead of this immutable install's
# own MCP script -- so a later selected-runtime transition does not require
# rewriting persisted client config. Unset preserves the current portable
# behavior: register this run's own $MCP_SERVER directly.
STABLE_MCP_ENTRYPOINT="${JARVOS_MCP_STABLE_ENTRYPOINT:-}"
ROLLBACK_MODE="${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}"
CODEX_EXECUTABLE_AVAILABLE=0
MCP_ROLLBACK_STATUS=0
HOOK_ROLLBACK_STATUS=0
PROVIDER_ROLLBACK_STATUS=0

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
  STEWARDSHIP_DISPATCHER="$STEWARDSHIP_STABLE_ROOT/jarvos-stewardship-dispatcher"
fi

if command -v "$CODEX_EXECUTABLE" >/dev/null 2>&1; then
  CODEX_EXECUTABLE="$(command -v "$CODEX_EXECUTABLE")"
  case "$CODEX_EXECUTABLE" in
    /*) ;;
    *) CODEX_EXECUTABLE="$(cd "$(dirname "$CODEX_EXECUTABLE")" && pwd)/$(basename "$CODEX_EXECUTABLE")" ;;
  esac
  CODEX_EXECUTABLE_AVAILABLE=1
  JARVOS_CODEX_EXECUTABLE="$CODEX_EXECUTABLE"
  export JARVOS_CODEX_EXECUTABLE
elif [ "$ROLLBACK_MODE" = "1" ]; then
  echo "Codex CLI is unavailable; continuing rollback phases that do not require it." >&2
else
  echo "codex CLI not found on PATH" >&2
  exit 1
fi

if [ "$ROLLBACK_MODE" != "1" ]; then
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

  if [ ! -f "$MCP_RECEIPT_MODULE" ]; then
    echo "jarvOS Codex MCP receipt helper not found: $MCP_RECEIPT_MODULE" >&2
    exit 1
  fi

  if [ ! -f "$HOOK_FEATURE_RECEIPT_MODULE" ]; then
    echo "jarvOS Codex hook-feature receipt helper not found: $HOOK_FEATURE_RECEIPT_MODULE" >&2
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

# Managed provider admission is checked before the first profile write. The
# provider manager repeats this check immediately before activation below.
  REQUESTED_PROVIDER_MODE="$CODEX_PROVIDER_MODE"
  if [ -z "$REQUESTED_PROVIDER_MODE" ] && [ "${JARVOS_PROFILE:-}" = "codex" ]; then
    REQUESTED_PROVIDER_MODE="new-managed"
  fi
  case "$REQUESTED_PROVIDER_MODE" in
    ""|existing|disabled) ;;
    *)
      JARVOS_CODEX_PROVIDER_MODE="$REQUESTED_PROVIDER_MODE" \
        JARVOS_CODEX_PROVIDER_PREFLIGHT=1 \
        node "$ROOT/runtimes/codex/compound-engineering-activation.js"
      ;;
  esac
fi

codex_mcp_fingerprint() {
  local payload fingerprint list_payload list_state
  if ! payload="$("$CODEX_EXECUTABLE" mcp get jarvos --json 2>/dev/null)"; then
    if ! list_payload="$("$CODEX_EXECUTABLE" mcp list --json 2>/dev/null)"; then
      return 2
    fi
    if ! list_state="$(printf '%s' "$list_payload" | node "$MCP_RECEIPT_MODULE" list-state)"; then
      return 2
    fi
    if [ "$list_state" = "absent" ]; then
      return 1
    fi
    return 2
  fi
  if ! fingerprint="$(printf '%s' "$payload" | node "$MCP_RECEIPT_MODULE" observe)"; then
    return 2
  fi
  printf '%s' "$fingerprint"
}

release_mcp_lock() {
  if [ "${MCP_LOCK_HELD:-0}" = "1" ]; then
    rmdir "$MCP_LOCK_PATH" 2>/dev/null || true
    MCP_LOCK_HELD=0
  fi
}

# `codex mcp remove` has no expected-fingerprint/CAS guard. Rollback therefore
# uses Codex's app-server config transaction when it is available: read the
# exact user-layer version, verify that layer's jarvos entry, and submit an
# atomic expectedVersion edit. Any unavailable, changed, or conflicting state
# is preserved for manual reconciliation. There is deliberately no CLI remove
# fallback: a successful exit from a name-only command is not proof that the
# registration was still the one jarvOS created.
codex_mcp_cas_remove() {
  local desired_fingerprint="$1"
  node - "$ROOT" "$MCP_RECEIPT_MODULE" "$CODEX_EXECUTABLE" "$CODEX_CONFIG" "$desired_fingerprint" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [root, receiptModule, executable, configPath, desiredFingerprint] = process.argv.slice(2);
const { fingerprintRegistration } = require(receiptModule);
const targetConfig = path.resolve(configPath);
let child;
let buffer = '';
let completed = false;
let timer;

function samePath(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); }
  catch (_) { return path.resolve(left) === path.resolve(right); }
}

function fail(message) {
  if (completed) return;
  completed = true;
  if (timer) clearTimeout(timer);
  if (child && !child.killed) child.kill();
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function finish() {
  if (completed) return;
  completed = true;
  if (timer) clearTimeout(timer);
  if (child && !child.killed) child.kill();
}

function send(message) {
  if (!child || child.killed || !child.stdin.writable) return fail('Codex app-server became unavailable during MCP rollback');
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  if (completed) return;
  if (message.error) {
    if (message.id === 3) return fail('Codex app-server CAS conflict; preserving the jarvOS MCP registration and receipt');
    return fail('Codex app-server could not inspect the Codex configuration; preserving the jarvOS MCP registration and receipt');
  }
  if (message.id === 1) {
    send({ method: 'initialized', params: {} });
    send({ method: 'config/read', id: 2, params: { includeLayers: true } });
    return;
  }
  if (message.id === 2) {
    const layers = message.result?.layers;
    if (!Array.isArray(layers)) return fail('Codex app-server returned no versioned configuration layers; preserving the jarvOS MCP registration and receipt');
    const layer = layers.find((entry) => entry?.name?.type === 'user' && typeof entry.name.file === 'string' && samePath(entry.name.file, targetConfig));
    if (!layer || typeof layer.version !== 'string') return fail('The configured Codex user layer was not available for CAS rollback; preserving the jarvOS MCP registration and receipt');
    const registration = layer.config?.mcp_servers?.jarvos;
    if (!registration) return fail('The jarvOS MCP registration is not present in the configured user layer; preserving its receipt for manual reconciliation');
    let fingerprint;
    try { fingerprint = fingerprintRegistration(registration); }
    catch (_) { return fail('The configured jarvOS MCP registration is not fingerprintable; preserving it and its receipt'); }
    if (fingerprint !== desiredFingerprint) return fail('The configured jarvOS MCP registration changed before CAS rollback; preserving it and its receipt');
    send({
      method: 'config/batchWrite',
      id: 3,
      params: {
        filePath: targetConfig,
        edits: [{ keyPath: 'mcp_servers.jarvos', value: null, mergeStrategy: 'replace' }],
        expectedVersion: layer.version,
        reloadUserConfig: true,
      },
    });
    return;
  }
  if (message.id === 3) {
    const result = message.result;
    if (!result || !['ok', 'okOverridden'].includes(result.status) || typeof result.version !== 'string'
      || typeof result.filePath !== 'string' || !samePath(result.filePath, targetConfig)) {
      return fail('Codex app-server did not confirm the expected atomic MCP rollback; preserving the registration and receipt');
    }
    finish();
  }
}

try {
  child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
    cwd: root,
    env: process.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
} catch (_) {
  fail('Codex app-server was unavailable for MCP CAS rollback');
}

if (!child) process.exitCode = 1;
else {
  child.on('error', () => fail('Codex app-server was unavailable for MCP CAS rollback'));
  child.on('exit', () => {
    if (!completed) fail('Codex app-server exited before MCP CAS rollback completed');
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      handle(message);
    }
  });
  timer = setTimeout(() => fail('Codex app-server timed out during MCP CAS rollback'), 30_000);
  send({
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: { name: 'jarvos_setup', title: 'jarvOS Codex setup', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    },
  });
}
NODE
}

rollback_mcp_registration() {
  local desired_fingerprint receipt_state current_fingerprint observe_status

  if [ ! -e "$MCP_RECEIPT_PATH" ] && [ ! -L "$MCP_RECEIPT_PATH" ]; then
    echo "No jarvOS-owned Codex MCP registration was found; preserving the profile."
    return 0
  fi

  if ! desired_fingerprint="$(node "$MCP_RECEIPT_MODULE" fingerprint "$MCP_RECEIPT_PATH" "$CODEX_HOME")"; then
    echo "The jarvOS MCP receipt is corrupt or unsafe; preserving it and the MCP registration for manual reconciliation." >&2
    return 1
  fi
  if ! receipt_state="$(node "$MCP_RECEIPT_MODULE" state "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$desired_fingerprint")"; then
    echo "The jarvOS MCP receipt could not be validated; preserving it and the MCP registration for manual reconciliation." >&2
    return 1
  fi
  if ! node "$MCP_RECEIPT_MODULE" profile "$CODEX_HOME" >/dev/null; then
    echo "The recorded Codex profile could not be validated; preserving the MCP registration and receipt." >&2
    return 1
  fi

  if ! mkdir -m 700 "$MCP_LOCK_PATH" 2>/dev/null; then
    echo "Another jarvOS Codex MCP setup or rollback is already in progress." >&2
    return 1
  fi
  MCP_LOCK_HELD=1
  trap release_mcp_lock EXIT

  if current_fingerprint="$(codex_mcp_fingerprint)"; then
    observe_status=0
  else
    observe_status=$?
  fi

  if [ "$observe_status" -eq 1 ]; then
    if ! node "$MCP_RECEIPT_MODULE" clear "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$desired_fingerprint"; then
      echo "The jarvOS MCP registration is absent, but its receipt could not be cleared; preserving the receipt." >&2
      release_mcp_lock
      trap - EXIT
      return 1
    fi
    echo "The recorded jarvOS MCP registration is already absent; cleared its receipt."
    release_mcp_lock
    trap - EXIT
    return 0
  fi

  if [ "$observe_status" -eq 2 ]; then
    echo "Could not verify the current jarvOS MCP registration; preserving it and its receipt." >&2
    release_mcp_lock
    trap - EXIT
    return 1
  fi

  if [ "$current_fingerprint" != "$desired_fingerprint" ]; then
    echo "The jarvOS MCP registration changed after setup; preserving it and its receipt." >&2
    release_mcp_lock
    trap - EXIT
    return 1
  fi

  if ! codex_mcp_cas_remove "$desired_fingerprint"; then
    release_mcp_lock
    trap - EXIT
    return 1
  fi

  if ! node "$MCP_RECEIPT_MODULE" clear "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$desired_fingerprint"; then
    echo "The MCP registration was removed by CAS, but its receipt could not be cleared; preserving the receipt." >&2
    release_mcp_lock
    trap - EXIT
    return 1
  fi
  echo "Removed the recorded jarvOS MCP registration through an atomic Codex app-server CAS transaction."
  release_mcp_lock
  trap - EXIT
  return 0
}

if [ "${JARVOS_STEWARDSHIP_ONLY:-0}" != "1" ]; then
  if [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
    if { [ ! -e "$MCP_RECEIPT_PATH" ] && [ ! -L "$MCP_RECEIPT_PATH" ]; }; then
      rollback_mcp_registration
    elif [ "$CODEX_EXECUTABLE_AVAILABLE" -ne 1 ] || [ ! -f "$MCP_RECEIPT_MODULE" ]; then
      echo "Codex MCP rollback prerequisites are unavailable; preserving the registration and receipt while continuing other rollback phases." >&2
      MCP_ROLLBACK_STATUS=1
    elif ! rollback_mcp_registration; then
      MCP_ROLLBACK_STATUS=1
    fi
  else
    MCP_DESIRED_FINGERPRINT=""
    MCP_RECEIPT_STATE="missing"
    MCP_DESIRED_FINGERPRINT="$(node "$MCP_RECEIPT_MODULE" desired-cli "${MCP_ENV_ARGS[@]}" -- "${MCP_COMMAND[@]}")"
    if [ -e "$MCP_RECEIPT_PATH" ] || [ -L "$MCP_RECEIPT_PATH" ]; then
      MCP_RECEIPT_STATE="$(node "$MCP_RECEIPT_MODULE" state "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$MCP_DESIRED_FINGERPRINT")"
    fi

    if [ "$MCP_RECEIPT_STATE" != "missing" ] || [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" != "1" ]; then
      node "$MCP_RECEIPT_MODULE" profile "$CODEX_HOME" create >/dev/null
      if ! mkdir -m 700 "$MCP_LOCK_PATH" 2>/dev/null; then
        echo "Another jarvOS Codex MCP setup or rollback is already in progress." >&2
        exit 1
      fi
      MCP_LOCK_HELD=1
      trap release_mcp_lock EXIT

      set +e
      MCP_CURRENT_FINGERPRINT="$(codex_mcp_fingerprint)"
      MCP_OBSERVE_STATUS=$?
      set -e

      if [ "$MCP_RECEIPT_STATE" = "missing" ]; then
        if [ "$MCP_OBSERVE_STATUS" -eq 0 ]; then
          echo "Codex already has an MCP registration named jarvos; preserving it because this setup did not create it." >&2
          exit 1
        elif [ "$MCP_OBSERVE_STATUS" -eq 2 ]; then
          echo "Could not inspect the existing jarvOS MCP registration; preserving it." >&2
          exit 1
        fi
        MCP_RECEIPT_STATE="$(node "$MCP_RECEIPT_MODULE" claim "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$MCP_DESIRED_FINGERPRINT")"
      elif [ "$MCP_OBSERVE_STATUS" -eq 0 ]; then
        if [ "$MCP_CURRENT_FINGERPRINT" != "$MCP_DESIRED_FINGERPRINT" ]; then
          echo "The recorded jarvOS MCP registration no longer matches setup; preserving it." >&2
          exit 1
        fi
        node "$MCP_RECEIPT_MODULE" activate "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$MCP_DESIRED_FINGERPRINT" >/dev/null
        echo "The recorded jarvOS MCP registration is already current."
        MCP_RECEIPT_STATE="active"
      elif [ "$MCP_OBSERVE_STATUS" -eq 2 ]; then
        echo "Could not inspect the recorded jarvOS MCP registration; preserving it." >&2
        exit 1
      elif [ "$MCP_RECEIPT_STATE" = "active" ]; then
        echo "The recorded jarvOS MCP registration is unexpectedly absent; preserving the receipt for reconciliation." >&2
        exit 1
      fi

      if [ "$MCP_RECEIPT_STATE" = "pending" ]; then
        "$CODEX_EXECUTABLE" mcp add "${MCP_ENV_ARGS[@]}" jarvos -- "${MCP_COMMAND[@]}" || true
        set +e
        MCP_AFTER_ADD="$(codex_mcp_fingerprint)"
        MCP_AFTER_ADD_STATUS=$?
        set -e
        if [ "$MCP_AFTER_ADD_STATUS" -eq 0 ] && [ "$MCP_AFTER_ADD" = "$MCP_DESIRED_FINGERPRINT" ]; then
          node "$MCP_RECEIPT_MODULE" activate "$MCP_RECEIPT_PATH" "$CODEX_HOME" "$MCP_DESIRED_FINGERPRINT" >/dev/null
          if [ "$MCP_HAS_HOST_BINDING" -gt 0 ]; then
            echo "Registered jarvOS MCP server for Codex with host bindings: ${MCP_COMMAND[*]}"
          else
            echo "Registered jarvOS MCP server for Codex: ${MCP_COMMAND[*]}"
          fi
        elif [ "$MCP_AFTER_ADD_STATUS" -eq 1 ]; then
          echo "Codex did not establish the requested jarvOS MCP registration; the pending receipt permits a safe retry." >&2
          exit 1
        else
          echo "Codex reported a different jarvOS MCP registration; preserving it for manual reconciliation." >&2
          exit 1
        fi
      fi

      release_mcp_lock
      trap - EXIT
    fi
  fi
fi

HOOK_PHASE_STATUS=0
mkdir -p "$(dirname "$CODEX_CONFIG")" || HOOK_PHASE_STATUS=1
if [ ! -f "$CODEX_CONFIG" ]; then
  touch "$CODEX_CONFIG" || HOOK_PHASE_STATUS=1
fi

if [ "$ROLLBACK_MODE" = "1" ] && [ ! -f "$HOOK_FEATURE_RECEIPT_MODULE" ]; then
  HOOK_PHASE_STATUS=1
  echo "Codex hook-feature rollback receipt helper is unavailable; preserving hook and feature state." >&2
elif [ "$HOOK_PHASE_STATUS" -eq 0 ]; then
  if ! node - "$CODEX_CONFIG" "$LEGACY_HOOKS_JSON" "$HOOK_SCRIPT" "$TURN_HOOK_SCRIPT" "$STEWARDSHIP_DISPATCHER" "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" "$STEWARDSHIP_BRIDGE_COMMAND" "$STEWARDSHIP_CODEX_SESSION_MAP_ROOT" "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:-}" "$HOOK_FEATURE_RECEIPT_MODULE" "$HOOK_FEATURE_RECEIPT_PATH" "$CODEX_HOME" <<'NODE'
const fs = require('fs');
const path = require('path');

const [configPath, legacyHooksPath, hookScript, turnHookScript, dispatcher, rollback, bridgeCommand, codexSessionMapRoot, stagedRoot, receiptModule, receiptPath, codexHome] = process.argv.slice(2);
const hookFeatureReceipt = require(receiptModule);
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

const MANAGED_CONFIG_TABLES = [
  ['hooks', 'hooks'],
  ['features', 'features'],
  ['shellEnvironmentPolicySet', 'shell_environment_policy.set'],
  ['shellEnvironmentPolicy', 'shell_environment_policy'],
];

function managedTableSnapshot(content) {
  const lines = content.split(/\n/);
  const snapshot = {};
  for (const [key, header] of MANAGED_CONFIG_TABLES) {
    const { start, end } = tomlTableRange(lines, header);
    snapshot[key] = start < 0 ? null : lines.slice(start, end).join('\n');
  }
  return hookFeatureReceipt.validateSnapshot(snapshot);
}

function replaceManagedTable(content, header, replacement) {
  const lines = content.split(/\n/);
  const { start, end } = tomlTableRange(lines, header);
  if (start >= 0) {
    lines.splice(start, end - start, ...(replacement === null ? [] : replacement.split('\n')));
    return lines.join('\n');
  }
  if (replacement === null) return content;
  const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  return `${content}${suffix}${replacement}\n`;
}

function restoreManagedTables(content, snapshot) {
  hookFeatureReceipt.validateSnapshot(snapshot);
  let restored = content;
  // Restore the nested table first so removing an absent parent never leaves
  // a dangling child table. All replacements are guarded by the full post-setup
  // snapshot before this function is reached.
  for (const [key, header] of MANAGED_CONFIG_TABLES) {
    restored = replaceManagedTable(restored, header, snapshot[key]);
  }
  return restored;
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

const beforeManagedTables = managedTableSnapshot(original);
const existingHookFeatureReceipt = hookFeatureReceipt.readReceipt(receiptPath, codexHome);
if (existingHookFeatureReceipt && !hookFeatureReceipt.snapshotsEqual(existingHookFeatureReceipt.after, beforeManagedTables)) {
  fail('jarvOS-owned hook or feature state changed after setup; preserving it and its receipt');
}

function hasUnreceiptedJarvosHookState(content) {
  // A missing receipt must never authorize cleanup of a pre-receipt install.
  // The feature flag alone is intentionally not evidence: it is a normal
  // Codex preference that a user may have set independently.
  return ownedHookPaths.some((target) => content.includes(target))
    || STEWARDSHIP_ENVIRONMENT_KEYS.some((key) => content.includes(key));
}

let migrated = null;
let rollbackWithoutReceipt = false;
if (rollback !== '1' && fs.existsSync(legacyHooksPath)) {
  migrated = parseLegacyHooks(legacyHooksPath);
  validateHookTable(next);
  for (const [event, entries] of Object.entries(migrated)) for (const entry of entries) next = setHook(next, event, renderHookEntry(entry), false);
}

if (rollback === '1') {
  if (!existingHookFeatureReceipt) {
    if (hasUnreceiptedJarvosHookState(original)) {
      fail('no jarvOS-owned hook-feature receipt was found for existing jarvOS hook state; preserving the Codex configuration');
    }
    // Setup can fail before touching hooks (for example an MCP or provider
    // preflight failure). That has no hook state to reconcile, so treat this
    // narrow, receipt-free case as a no-op rather than failing rollback.
    rollbackWithoutReceipt = true;
  } else {
    next = restoreManagedTables(original, existingHookFeatureReceipt.before);
  }
} else {
  const bridgeEnvironment = stewardshipBridgeEnvironment(bridgeCommand, codexSessionMapRoot);
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
  next = setFeature(next, 'hooks', 'true');
  next = removeFeature(next, 'codex_hooks');
}

const afterManagedTables = managedTableSnapshot(next);
if (rollback !== '1' && existingHookFeatureReceipt && !hookFeatureReceipt.snapshotsEqual(existingHookFeatureReceipt.after, afterManagedTables)) {
  fail('existing jarvOS hook-feature receipt does not describe the requested setup state');
}

if (next !== original || migrated) {
  if (rollback === '1') {
    // The current snapshot was checked against the receipt before any write.
    // A write failure retains the receipt and fails closed on the next attempt.
  } else if (!existingHookFeatureReceipt) {
    hookFeatureReceipt.claimReceipt(receiptPath, codexHome, beforeManagedTables, afterManagedTables);
  }
  const backupStamp = stamp();
  const backupPath = next !== original ? backup(configPath, backupStamp) : null;
  const legacyBackupPath = migrated ? backup(legacyHooksPath, backupStamp) : null;
  writeAtomically(configPath, next);
  if (migrated) fs.unlinkSync(legacyHooksPath);
  if (rollback === '1') hookFeatureReceipt.clearReceipt(receiptPath, codexHome, existingHookFeatureReceipt.after);
  console.log(`Updated Codex config for jarvOS hooks: ${configPath}`);
  if (backupPath) console.log(`Backup: ${backupPath}`);
  if (legacyBackupPath) console.log(`Migrated legacy Codex hooks with backup: ${legacyBackupPath}`);
} else {
  if (rollback === '1') {
    if (rollbackWithoutReceipt) {
      console.log(`Codex hook-feature rollback found no jarvOS-owned receipt or hook state: ${configPath}`);
    } else {
      hookFeatureReceipt.clearReceipt(receiptPath, codexHome, existingHookFeatureReceipt.after);
      console.log(`Codex hook-feature state was already restored: ${configPath}`);
    }
  } else {
    console.log(`Codex config already has jarvOS hooks enabled: ${configPath}`);
  }
}
NODE
  then
    HOOK_PHASE_STATUS=1
  fi
fi

if [ "$HOOK_PHASE_STATUS" -ne 0 ]; then
  if [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
    HOOK_ROLLBACK_STATUS=1
    echo "Codex hook rollback did not complete; continuing with independent provider cleanup." >&2
  else
    exit 1
  fi
elif [ "$ROLLBACK_MODE" != "1" ] && [ "$CODEX_CONFIG" = "$HOME/.codex/config.toml" ]; then
  if node "$TRUST_SCRIPT" "$ROOT" "$HOOK_SCRIPT" && node "$TRUST_SCRIPT" "$ROOT" "$TURN_HOOK_SCRIPT"; then
    echo "Trusted jarvOS Codex lifecycle hooks."
  else
    echo "Could not automatically trust jarvOS Codex lifecycle hooks; review them in Codex hooks settings." >&2
  fi
elif [ "$ROLLBACK_MODE" != "1" ]; then
  echo "Skipping automatic hook trust for custom CODEX_CONFIG: $CODEX_CONFIG"
fi

# Compound Engineering is a managed external provider, not an ambient setup
# side effect. New managed coding profiles pass `new-managed`; existing
# profiles must pass `opt-in`. With no explicit mode setup preserves the
# profile, while rollback removes only a recorded jarvOS-owned activation.
# Run this after the hook transaction so a provider reconciliation failure
# cannot prevent jarvOS from rolling back its own lifecycle configuration.
if [ -n "$CODEX_PROVIDER_MODE" ] || [ "${JARVOS_PROFILE:-}" = "codex" ] || [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
  if [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
    if ! node "$ROOT/runtimes/codex/compound-engineering-activation.js"; then
      PROVIDER_ROLLBACK_STATUS=1
    fi
  else
    node "$ROOT/runtimes/codex/compound-engineering-activation.js"
  fi
fi

if [ "$MCP_ROLLBACK_STATUS" -ne 0 ] || [ "$HOOK_ROLLBACK_STATUS" -ne 0 ] || [ "$PROVIDER_ROLLBACK_STATUS" -ne 0 ]; then
  echo "Codex rollback incomplete: mcp=$MCP_ROLLBACK_STATUS hooks=$HOOK_ROLLBACK_STATUS provider=$PROVIDER_ROLLBACK_STATUS. Review preserved subsystem state for manual reconciliation." >&2
  exit 1
fi
