#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=jarvos-starter-kit/scripts/lib/watchdog-signal-parser.sh
. "$SCRIPT_DIR/lib/watchdog-signal-parser.sh"

WORKDIR="${JARVOS_WORKDIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
LOGDIR="${JARVOS_LOGDIR:-$WORKDIR/logs/openclaw}"
STATE_DIR="${JARVOS_STATE_DIR:-$WORKDIR/tmp}"
LOCKFILE="$STATE_DIR/openclaw-health-check.lock"
STATE_FILE="${OPENCLAW_HEALTH_STATE_FILE:-$STATE_DIR/openclaw-health-state}"
STATE_DETAIL_FILE="${OPENCLAW_HEALTH_DETAIL_FILE:-$STATE_DIR/openclaw-health-state-detail}"
GATEWAY_LOG="$LOGDIR/gateway-health-check-$(date '+%Y%m%d-%H%M%S').log"
GATEWAY_ERR_LOG="${OPENCLAW_GATEWAY_ERR_LOG:-$HOME/.openclaw/logs/gateway.err.log}"
GATEWAY_LABEL="${OPENCLAW_GATEWAY_LABEL:-ai.openclaw.gateway}"
GATEWAY_PLIST="${OPENCLAW_GATEWAY_PLIST:-$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist}"
GATEWAY_HOST="${OPENCLAW_GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
RPC_TIMEOUT_MS="${OPENCLAW_HEALTH_RPC_TIMEOUT_MS:-4000}"
RPC_RETRY_SLEEP_SECONDS="${OPENCLAW_HEALTH_RPC_RETRY_SLEEP_SECONDS:-2}"
WATCHDOG_SIGNAL_LINES="${OPENCLAW_HEALTH_SIGNAL_LINES:-1500}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
NC_BIN="${NC_BIN:-nc}"
MAIN_SESSION_KEY="${OPENCLAW_MAIN_SESSION_KEY:-agent:main:main}"
MAIN_SESSIONS_DIR="${OPENCLAW_MAIN_SESSIONS_DIR:-$HOME/.openclaw/agents/main/sessions}"
MAIN_SESSION_STORE="${OPENCLAW_MAIN_SESSION_STORE:-$MAIN_SESSIONS_DIR/sessions.json}"
MAIN_SESSION_ARCHIVE_DIR="${OPENCLAW_MAIN_SESSION_ARCHIVE_DIR:-$MAIN_SESSIONS_DIR/archived-main}"
MAIN_SESSION_COOLDOWN_STATE="${OPENCLAW_MAIN_SESSION_COOLDOWN_STATE:-$STATE_DIR/openclaw-main-session-cooldown.json}"
MAIN_SESSION_COOLDOWN_MIN_SECONDS="${OPENCLAW_MAIN_SESSION_COOLDOWN_MIN_SECONDS:-1800}"
LOCK_STALE_SECONDS="${OPENCLAW_HEALTH_LOCK_STALE_SECONDS:-300}"
JQ_BIN="${JQ_BIN:-jq}"
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/bin:$HOME/.local/bin:$HOME/.npm-global/bin:${PATH:-}"

lock_recovery_detail=""

mkdir -p "$LOGDIR" "$STATE_DIR"

stat_mtime() {
  local path="$1"
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path"
    return
  fi
  stat -c '%Y' "$path" 2>/dev/null || echo 0
}

lock_owner_pid() {
  local pid_file="$LOCKFILE/pid"
  if [[ -f "$pid_file" ]]; then
    tr -cd '0-9' <"$pid_file" 2>/dev/null || true
  fi
}

lock_age_seconds() {
  local mtime="$(stat_mtime "$LOCKFILE")"
  local now_ts="$(date +%s)"
  if [[ "$mtime" =~ ^[0-9]+$ ]] && (( mtime > 0 )); then
    echo $(( now_ts - mtime ))
    return
  fi
  echo 0
}

pid_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

release_lock() {
  rm -f "$LOCKFILE/pid" "$LOCKFILE/started-at" >/dev/null 2>&1 || true
  rmdir "$LOCKFILE" >/dev/null 2>&1 || true
}

acquire_lock() {
  local owner_pid=""
  local lock_age=0
  local stale_reason=""

  if mkdir "$LOCKFILE" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCKFILE/pid"
    printf '%s\n' "$(date +%s)" >"$LOCKFILE/started-at"
    return 0
  fi

  if [[ ! -d "$LOCKFILE" ]]; then
    return 1
  fi

  owner_pid="$(lock_owner_pid)"
  lock_age="$(lock_age_seconds)"
  if [[ -n "$owner_pid" ]] && ! pid_is_running "$owner_pid"; then
    stale_reason="dead pid ${owner_pid}"
  elif [[ "$lock_age" =~ ^[0-9]+$ ]] && (( lock_age >= LOCK_STALE_SECONDS )); then
    stale_reason="age ${lock_age}s"
  fi

  if [[ -z "$stale_reason" ]]; then
    return 1
  fi

  rm -rf "$LOCKFILE" >/dev/null 2>&1 || true
  if mkdir "$LOCKFILE" 2>/dev/null; then
    printf '%s\n' "$$" >"$LOCKFILE/pid"
    printf '%s\n' "$(date +%s)" >"$LOCKFILE/started-at"
    lock_recovery_detail="Recovered stale watchdog lock (${stale_reason})."
    return 0
  fi

  return 1
}

if ! acquire_lock; then
  exit 0
fi
trap 'release_lock' EXIT INT TERM HUP

prepare_path() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    nvm use --silent 24 >/dev/null 2>&1 || nvm use --silent default >/dev/null 2>&1 || true
  fi
}

ensure_openclaw_tmpdir() {
  if [[ ! -d "/tmp" || ! -w "/tmp" ]]; then
    return 0
  fi

  mkdir -p /tmp/openclaw 2>/dev/null || true
  chmod 700 /tmp/openclaw 2>/dev/null || true
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

probe_gateway_port() {
  if ! have_cmd "$NC_BIN"; then
    return 1
  fi
  "$NC_BIN" -z -w 2 "$GATEWAY_HOST" "$GATEWAY_PORT" >/dev/null 2>&1
}

run_rpc_probe_once() {
  local tmp_file="$STATE_DIR/openclaw-health-rpc.$$"

  rpc_output=""
  rpc_failure_output=""

  if ! have_cmd "$OPENCLAW_BIN"; then
    rpc_failure_output="$OPENCLAW_BIN not found in PATH"
    return 1
  fi

  if "$OPENCLAW_BIN" gateway call status --json --timeout "$RPC_TIMEOUT_MS" >"$tmp_file" 2>&1; then
    rpc_output="$(cat "$tmp_file" 2>/dev/null || true)"
    rm -f "$tmp_file"
    return 0
  fi

  rpc_failure_output="$(cat "$tmp_file" 2>/dev/null || true)"
  rm -f "$tmp_file"
  return 1
}

probe_gateway_rpc() {
  if run_rpc_probe_once; then
    return 0
  fi
  sleep "$RPC_RETRY_SLEEP_SECONDS"
  run_rpc_probe_once
}

collect_recent_signals() {
  watchdog_collect_recent_signals_from_file "$GATEWAY_ERR_LOG" "$WATCHDOG_SIGNAL_LINES"
}

current_main_session_id() {
  if ! have_cmd "$JQ_BIN" || [[ ! -f "$MAIN_SESSION_STORE" ]]; then
    return 0
  fi
  "$JQ_BIN" -r --arg key "$MAIN_SESSION_KEY" '.[$key].sessionId // empty' "$MAIN_SESSION_STORE" 2>/dev/null || true
}

main_session_recently_cooled() {
  local session_id="$1"

  if [[ -z "$session_id" || ! -f "$MAIN_SESSION_COOLDOWN_STATE" ]] || ! have_cmd "$JQ_BIN"; then
    return 1
  fi

  local last_session_id=""
  local cooled_at=""
  local now_ts="$(date +%s)"

  last_session_id="$("$JQ_BIN" -r '.sessionId // empty' "$MAIN_SESSION_COOLDOWN_STATE" 2>/dev/null || true)"
  cooled_at="$("$JQ_BIN" -r '.cooledAt // 0' "$MAIN_SESSION_COOLDOWN_STATE" 2>/dev/null || true)"

  if [[ "$last_session_id" != "$session_id" ]]; then
    return 1
  fi
  if ! [[ "$cooled_at" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  if (( now_ts - cooled_at < MAIN_SESSION_COOLDOWN_MIN_SECONDS )); then
    return 0
  fi
  return 1
}

record_main_session_cooldown() {
  local session_id="$1"
  local archive_dir="$2"
  local reason="$3"
  local tmp_file="$STATE_DIR/openclaw-main-session-cooldown.$$"

  if ! have_cmd "$JQ_BIN"; then
    return 0
  fi

  "$JQ_BIN" -n \
    --arg sessionId "$session_id" \
    --arg archiveDir "$archive_dir" \
    --arg reason "$reason" \
    --argjson cooledAt "$(date +%s)" \
    '{sessionId:$sessionId, archiveDir:$archiveDir, reason:$reason, cooledAt:$cooledAt}' >"$tmp_file"
  mv "$tmp_file" "$MAIN_SESSION_COOLDOWN_STATE"
}

stat_mode() {
  local file_path="$1"
  if stat -f '%Lp' "$file_path" >/dev/null 2>&1; then
    stat -f '%Lp' "$file_path"
    return
  fi
  stat -c '%a' "$file_path" 2>/dev/null || echo 600
}

rotate_main_session_store() {
  local archive_dir="$1"
  local tmp_store="$archive_dir/sessions.json.after"
  local original_mode="600"

  mkdir -p "$archive_dir"

  if [[ -f "$MAIN_SESSION_STORE" ]]; then
    original_mode="$(stat_mode "$MAIN_SESSION_STORE")"
    cp "$MAIN_SESSION_STORE" "$archive_dir/sessions.json.before"
  fi

  "$JQ_BIN" --arg key "$MAIN_SESSION_KEY" 'del(.[$key])' "$MAIN_SESSION_STORE" >"$tmp_store"
  chmod "$original_mode" "$tmp_store" 2>/dev/null || true
  mv "$tmp_store" "$MAIN_SESSION_STORE"
}

archive_main_session_files() {
  local session_id="$1"
  local archive_dir="$2"
  local moved_any="no"
  local candidate

  mkdir -p "$archive_dir"
  shopt -s nullglob
  for candidate in "$MAIN_SESSIONS_DIR/${session_id}"*; do
    [[ -e "$candidate" ]] || continue
    mv "$candidate" "$archive_dir/"
    moved_any="yes"
  done
  shopt -u nullglob

  if [[ "$moved_any" == "no" ]]; then
    echo "no session transcript files found for $session_id" >>"$GATEWAY_LOG"
  fi
}

should_cooldown_main_session() {
  local session_id=""

  if ! have_cmd "$JQ_BIN"; then
    return 1
  fi
  if [[ ! -f "$MAIN_SESSION_STORE" ]]; then
    return 1
  fi
  if ! watchdog_should_cooldown_main_session "$recent_signals"; then
    return 1
  fi

  session_id="$(current_main_session_id)"
  [[ -n "$session_id" ]]
}

launchctl_available() {
  have_cmd "$LAUNCHCTL_BIN"
}

restart_gateway_via_launchd() {
  if ! launchctl_available; then
    return 1
  fi
  if ! "$LAUNCHCTL_BIN" print "gui/${UID_NUM}/${GATEWAY_LABEL}" >/dev/null 2>&1; then
    "$LAUNCHCTL_BIN" bootstrap "gui/${UID_NUM}" "$GATEWAY_PLIST" >>"$GATEWAY_LOG" 2>&1 || true
  fi
  "$LAUNCHCTL_BIN" kickstart -k "gui/${UID_NUM}/${GATEWAY_LABEL}" >>"$GATEWAY_LOG" 2>&1 || true
}

cooldown_main_session() {
  local session_id="$(current_main_session_id)"
  local stamp="$(date '+%Y%m%d-%H%M%S')"
  local archive_dir="$MAIN_SESSION_ARCHIVE_DIR/${stamp}-${session_id}"

  if [[ -z "$session_id" ]]; then
    return 1
  fi
  if main_session_recently_cooled "$session_id"; then
    echo "-> skipping main-session cooldown; session ${session_id} was cooled recently" >>"$GATEWAY_LOG"
    return 1
  fi
  if ! launchctl_available; then
    echo "-> launchctl unavailable; skipping main-session cooldown" >>"$GATEWAY_LOG"
    return 1
  fi

  mkdir -p "$MAIN_SESSION_ARCHIVE_DIR"

  {
    echo "-> main-session cooldown start"
    echo "-> session_id=${session_id}"
    echo "-> archive_dir=${archive_dir}"
    echo "-> bootout gateway service"
  } >>"$GATEWAY_LOG"

  "$LAUNCHCTL_BIN" bootout "gui/${UID_NUM}/${GATEWAY_LABEL}" >>"$GATEWAY_LOG" 2>&1 || true
  sleep 2

  rotate_main_session_store "$archive_dir"
  archive_main_session_files "$session_id" "$archive_dir"
  record_main_session_cooldown "$session_id" "$archive_dir" "rpc-timeout + stale main session signals"

  {
    echo "-> rebootstrapping gateway after main-session cooldown"
  } >>"$GATEWAY_LOG"
  "$LAUNCHCTL_BIN" bootstrap "gui/${UID_NUM}" "$GATEWAY_PLIST" >>"$GATEWAY_LOG" 2>&1 || true
  restart_gateway_via_launchd
  sleep 5

  cooled_session_id="$session_id"
  cooled_archive_dir="$archive_dir"

  if probe_gateway_port && run_rpc_probe_once; then
    gateway_state="recovered"
    gateway_detail="Gateway recovered after rotating stuck main session ${session_id}. Archive: ${archive_dir}."
    return 0
  fi

  return 1
}

log_status_snapshot() {
  {
    echo "[$TS_HUMAN] status snapshot"
    echo "-> gateway_state=${gateway_state}"
    echo "-> gateway_issue=${gateway_issue}"
    echo "-> gateway_detail=${gateway_detail}"
    if [[ -n "$recent_signals" ]]; then
      echo "-> recent_signals=${recent_signals}"
    fi
    if [[ -n "$rpc_failure_output" ]]; then
      echo "-> rpc_failure_output"
      printf '%s\n' "$rpc_failure_output" | tail -n 40
    fi
    if [[ -n "$cooled_session_id" ]]; then
      echo "-> cooled_session_id=${cooled_session_id}"
      echo "-> cooled_archive_dir=${cooled_archive_dir}"
    fi
  } >>"$GATEWAY_LOG" 2>&1
}

recover_gateway() {
  recovery_attempted="yes"

  {
    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] recovery start"
    echo "-> issue: ${gateway_issue}"
    echo "-> detail: ${gateway_detail}"
  } >>"$GATEWAY_LOG" 2>&1

  if have_cmd "$OPENCLAW_BIN"; then
    {
      echo "-> openclaw gateway restart"
      "$OPENCLAW_BIN" gateway restart
      echo "-> wait 5s"
      sleep 5
    } >>"$GATEWAY_LOG" 2>&1 || true

    if probe_gateway_port && run_rpc_probe_once; then
      gateway_state="recovered"
      gateway_detail="Gateway recovered via openclaw gateway restart."
      if [[ -n "$recent_signals" ]]; then
        gateway_detail+=" Signals: ${recent_signals}."
      fi
      return 0
    fi
  fi

  {
    echo "-> launchctl kickstart -k service"
  } >>"$GATEWAY_LOG" 2>&1
  restart_gateway_via_launchd || true
  echo "-> wait 5s" >>"$GATEWAY_LOG"
  sleep 5

  if probe_gateway_port && run_rpc_probe_once; then
    gateway_state="recovered"
    gateway_detail="Gateway recovered via launchctl kickstart -k."
    if [[ -n "$recent_signals" ]]; then
      gateway_detail+=" Signals: ${recent_signals}."
    fi
    return 0
  fi

  if should_cooldown_main_session; then
    echo "-> invoking main-session cooldown fallback" >>"$GATEWAY_LOG"
    if cooldown_main_session; then
      if [[ -n "$recent_signals" ]]; then
        gateway_detail+=" Signals: ${recent_signals}."
      fi
      return 0
    fi
  fi

  gateway_state="bad"
  if probe_gateway_port; then
    gateway_detail="Gateway TCP listener is reachable but RPC remains unhealthy after restart attempts."
  else
    gateway_detail="Gateway is still unreachable after restart attempts."
  fi
  if [[ -n "$recent_signals" ]]; then
    gateway_detail+=" Signals: ${recent_signals}."
  fi
  if [[ -n "$cooled_session_id" ]]; then
    gateway_detail+=" Main session cooldown attempted for ${cooled_session_id}."
  fi
  return 1
}

prepare_path
ensure_openclaw_tmpdir

TS_HUMAN="$(date '+%Y-%m-%d %H:%M:%S %Z')"
UID_NUM="$(id -u)"

gateway_state="ok"
gateway_issue="healthy"
gateway_detail="Gateway reachable via TCP and RPC."
recovery_attempted="no"
recent_signals="$(collect_recent_signals)"
rpc_output=""
rpc_failure_output=""
cooled_session_id=""
cooled_archive_dir=""

{
  echo "[$TS_HUMAN] gateway health check"
  if [[ -n "$lock_recovery_detail" ]]; then
    echo "-> ${lock_recovery_detail}"
  fi
  echo "-> probing ${GATEWAY_HOST}:${GATEWAY_PORT}"
} >"$GATEWAY_LOG"

if probe_gateway_port; then
  if probe_gateway_rpc; then
    gateway_state="ok"
    gateway_issue="healthy"
    gateway_detail="Gateway reachable via TCP and RPC."
  else
    gateway_state="degraded"
    gateway_issue="rpc-timeout"
    gateway_detail="Gateway TCP listener is up but RPC probe timed out after ${RPC_TIMEOUT_MS}ms."
    if [[ -n "$recent_signals" ]]; then
      gateway_detail+=" Signals: ${recent_signals}."
    fi
    recover_gateway || true
  fi
else
  gateway_state="bad"
  gateway_issue="listener-down"
  gateway_detail="Gateway TCP listener is down."
  if [[ -n "$recent_signals" ]]; then
    gateway_detail+=" Signals: ${recent_signals}."
  fi
  recover_gateway || true
fi

log_status_snapshot

echo "$gateway_state" >"$STATE_FILE"
echo "$gateway_detail" >"$STATE_DETAIL_FILE"

exit 0
