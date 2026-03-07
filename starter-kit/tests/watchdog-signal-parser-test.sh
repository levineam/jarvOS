#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=jarvos-starter-kit/scripts/lib/watchdog-signal-parser.sh
. "$SCRIPT_DIR/../scripts/lib/watchdog-signal-parser.sh"

pass_count=0

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi

  pass_count=$((pass_count + 1))
}

assert_true() {
  local label="$1"
  shift

  if ! "$@"; then
    echo "FAIL: $label"
    exit 1
  fi

  pass_count=$((pass_count + 1))
}

assert_false() {
  local label="$1"
  shift

  if "$@"; then
    echo "FAIL: $label"
    exit 1
  fi

  pass_count=$((pass_count + 1))
}

sample_log_all="$(cat <<'EOF'
2026-03-07T08:05:00Z lane wait exceeded after 120000ms
2026-03-07T08:05:01Z embedded run timeout while waiting on worker
2026-03-07T08:05:02Z session-write-lock held too long for session agent:main:main
EOF
)"

signals_all="$(watchdog_collect_recent_signals_from_text "$sample_log_all")"
assert_eq "$signals_all" "stale-session-lock, embedded-timeout, lane-wait, main-session" "collects all expected signals in stable order"
assert_true "cooldown triggers on full bundle" watchdog_should_cooldown_main_session "$signals_all"

sample_log_embedded="$(cat <<'EOF'
2026-03-07T08:10:00Z lane wait exceeded after 120000ms
2026-03-07T08:10:01Z embedded run timeout for request 42
2026-03-07T08:10:02Z context mentions agent:main:main in stack trace
EOF
)"

signals_embedded="$(watchdog_collect_recent_signals_from_text "$sample_log_embedded")"
assert_eq "$signals_embedded" "embedded-timeout, lane-wait, main-session" "collects embedded-timeout bundle without stale lock"
assert_true "cooldown triggers with embedded timeout variant" watchdog_should_cooldown_main_session "$signals_embedded"

sample_log_stale_lock="$(cat <<'EOF'
2026-03-07T08:11:00Z lane wait exceeded after 120000ms
2026-03-07T08:11:01Z session-write-lock held too long for session agent:main:main
EOF
)"

signals_stale_lock="$(watchdog_collect_recent_signals_from_text "$sample_log_stale_lock")"
assert_eq "$signals_stale_lock" "stale-session-lock, lane-wait, main-session" "collects stale-lock bundle without embedded timeout"
assert_true "cooldown triggers with stale lock variant" watchdog_should_cooldown_main_session "$signals_stale_lock"

sample_log_missing_main="$(cat <<'EOF'
2026-03-07T08:12:00Z lane wait exceeded after 120000ms
2026-03-07T08:12:01Z embedded run timeout for request 42
EOF
)"

signals_missing_main="$(watchdog_collect_recent_signals_from_text "$sample_log_missing_main")"
assert_false "cooldown does not trigger without main-session tag" watchdog_should_cooldown_main_session "$signals_missing_main"

sample_log_missing_lane="$(cat <<'EOF'
2026-03-07T08:14:01Z embedded run timeout for request 42
2026-03-07T08:14:02Z session-write-lock held too long for session agent:main:main
EOF
)"

signals_missing_lane="$(watchdog_collect_recent_signals_from_text "$sample_log_missing_lane")"
assert_false "cooldown does not trigger without lane-wait tag" watchdog_should_cooldown_main_session "$signals_missing_lane"

assert_true "token match finds main-session" watchdog_has_signal "$signals_all" "main-session"
assert_false "token match does not accept partial token" watchdog_has_signal "$signals_all" "main"
assert_false "token match does not accept wrong delimiter" watchdog_has_signal "main-session lane-wait" "main-session"

echo "ok - ${pass_count} watchdog signal parser checks passed"
