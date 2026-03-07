#!/usr/bin/env bash

watchdog_join_tags() {
  local joined=""
  local tag

  for tag in "$@"; do
    [[ -z "$tag" ]] && continue
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$tag"
  done

  printf '%s' "$joined"
}

watchdog_collect_recent_signals_from_text() {
  local err_tail="${1:-}"
  local tags=()

  if grep -q 'session-write-lock' <<<"$err_tail"; then
    tags+=("stale-session-lock")
  fi
  if grep -q 'embedded run timeout' <<<"$err_tail"; then
    tags+=("embedded-timeout")
  fi
  if grep -q 'lane wait exceeded' <<<"$err_tail"; then
    tags+=("lane-wait")
  fi
  if grep -q 'agent:main:main' <<<"$err_tail"; then
    tags+=("main-session")
  fi

  watchdog_join_tags "${tags[@]:-}"
}

watchdog_collect_recent_signals_from_file() {
  local file_path="$1"
  local tail_lines="${2:-${WATCHDOG_SIGNAL_LINES:-1500}}"
  local err_tail=""

  if [[ -f "$file_path" ]]; then
    err_tail="$(tail -n "$tail_lines" "$file_path" 2>/dev/null || true)"
  fi

  watchdog_collect_recent_signals_from_text "$err_tail"
}

watchdog_has_signal() {
  local signals="${1:-}"
  local needle="${2:-}"
  local normalized=",${signals//[[:space:]]/},"

  [[ "$normalized" == *",${needle},"* ]]
}

watchdog_should_cooldown_main_session() {
  local signals="${1:-}"

  watchdog_has_signal "$signals" "main-session" || return 1
  watchdog_has_signal "$signals" "lane-wait" || return 1

  if watchdog_has_signal "$signals" "stale-session-lock"; then
    return 0
  fi
  if watchdog_has_signal "$signals" "embedded-timeout"; then
    return 0
  fi

  return 1
}
