#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${JARVOS_WORKDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOGDIR="${JARVOS_LOGDIR:-$WORKDIR/logs/openclaw}"
STATE_DIR="${JARVOS_STATE_DIR:-$WORKDIR/tmp}"
WATCHDOG_LABEL="${OPENCLAW_WATCHDOG_LABEL:-com.openclaw.gateway-watchdog}"
GATEWAY_LABEL="${OPENCLAW_GATEWAY_LABEL:-ai.openclaw.gateway}"
WATCHDOG_LOG="${OPENCLAW_WATCHDOG_LOG:-/tmp/openclaw-gateway-watchdog.log}"
STATE_FILE="${OPENCLAW_HEALTH_STATE_FILE:-$STATE_DIR/openclaw-health-state}"
DETAIL_FILE="${OPENCLAW_HEALTH_DETAIL_FILE:-$STATE_DIR/openclaw-health-state-detail}"
COOLDOWN_FILE="${OPENCLAW_MAIN_SESSION_COOLDOWN_STATE:-$STATE_DIR/openclaw-main-session-cooldown.json}"
LOCK_DIR="${OPENCLAW_HEALTH_LOCK_DIR:-$STATE_DIR/openclaw-health-check.lock}"
LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-launchctl}"
JQ_BIN="${JQ_BIN:-jq}"

latest_log="$(ls -1t "$LOGDIR"/gateway-health-check-*.log 2>/dev/null | head -n 1 || true)"

stat_mtime() {
  local path="$1"
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path"
    return
  fi
  stat -c '%Y' "$path" 2>/dev/null || echo 0
}

lock_age_seconds() {
  local mtime="$(stat_mtime "$LOCK_DIR")"
  local now_ts="$(date +%s)"
  if [[ "$mtime" =~ ^[0-9]+$ ]] && (( mtime > 0 )); then
    echo $(( now_ts - mtime ))
    return
  fi
  echo 0
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

print_launchd_summary() {
  local label="$1"
  local title="$2"

  echo "$title"
  if ! have_cmd "$LAUNCHCTL_BIN"; then
    echo "  status: launchctl unavailable"
    return
  fi
  if ! "$LAUNCHCTL_BIN" print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    echo "  status: not loaded"
    return
  fi

  "$LAUNCHCTL_BIN" print "gui/$(id -u)/$label" 2>/dev/null \
    | awk '
      /^[[:space:]]*state = / {print "  state: " substr($0, index($0, "=") + 2)}
      /^[[:space:]]*pid = / {print "  pid: " substr($0, index($0, "=") + 2)}
      /^[[:space:]]*runs = / {print "  runs: " substr($0, index($0, "=") + 2)}
      /^[[:space:]]*last exit code = / {print "  last exit code: " substr($0, index($0, "=") + 2)}
      /^[[:space:]]*path = / {print "  path: " substr($0, index($0, "=") + 2)}
    '
}

echo "OpenClaw Watchdog Status"
echo "checked_at: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo

print_launchd_summary "$WATCHDOG_LABEL" "watchdog"
echo
print_launchd_summary "$GATEWAY_LABEL" "gateway"
echo

echo "health"
echo "  state: $(cat "$STATE_FILE" 2>/dev/null || echo unknown)"
echo "  detail: $(cat "$DETAIL_FILE" 2>/dev/null || echo unavailable)"
if [[ -n "$latest_log" ]]; then
  echo "  latest log: $latest_log"
fi
if [[ -f "$WATCHDOG_LOG" ]]; then
  echo "  watchdog log: $WATCHDOG_LOG"
fi
echo

echo "lock"
if [[ -d "$LOCK_DIR" ]]; then
  echo "  state: present"
  echo "  age_seconds: $(lock_age_seconds)"
  if [[ -f "$LOCK_DIR/pid" ]]; then
    echo "  owner_pid: $(tr -cd '0-9' <"$LOCK_DIR/pid" 2>/dev/null || echo unknown)"
  fi
else
  echo "  state: clear"
fi
echo

echo "cooldown"
if [[ -f "$COOLDOWN_FILE" ]] && have_cmd "$JQ_BIN"; then
  "$JQ_BIN" -r '{sessionId, archiveDir, reason, cooledAt} | to_entries[] | "  " + .key + ": " + ((.value // "") | tostring)' "$COOLDOWN_FILE"
else
  echo "  state: none"
fi

echo
if [[ -n "$latest_log" ]]; then
  echo "recent tail"
  tail -n 20 "$latest_log" | sed 's/^/  /'
fi
