#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
OPENCLAW_HEALTH_TIMEOUT_MS="${OPENCLAW_HEALTH_TIMEOUT_MS:-5000}"
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/bin:$HOME/.local/bin:$HOME/.npm-global/bin:${PATH:-}"

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

run_probe() {
  local label="$1"
  shift

  echo "$label"
  "$@"
  echo
}

prepare_path
ensure_openclaw_tmpdir

run_probe "openclaw health --json --timeout ${OPENCLAW_HEALTH_TIMEOUT_MS}" \
  "$OPENCLAW_BIN" health --json --timeout "$OPENCLAW_HEALTH_TIMEOUT_MS"

run_probe "openclaw gateway call status --json --timeout ${OPENCLAW_HEALTH_TIMEOUT_MS}" \
  "$OPENCLAW_BIN" gateway call status --json --timeout "$OPENCLAW_HEALTH_TIMEOUT_MS"
