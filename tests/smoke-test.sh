#!/usr/bin/env bash
# Smoke test: run bootstrap.js in non-interactive mode against a temp directory
# and verify it exits 0 and produces the expected structure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$SCRIPT_DIR/bootstrap.js"
TMPDIR_BASE="$(mktemp -d)"
WORKSPACE="$TMPDIR_BASE/workspace"
VAULT="$TMPDIR_BASE/vault"

cleanup() {
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

echo "→ Running bootstrap smoke test in $TMPDIR_BASE"

# Run non-interactively via env vars + --yes flag
JARVOS_YES=1 \
JARVOS_ASSISTANT_NAME=TestJarvis \
JARVOS_USER_NAME=TestUser \
JARVOS_COACH_NAME=TestCoach \
JARVOS_VAULT_PATH="$VAULT" \
JARVOS_WORKSPACE_PATH="$WORKSPACE" \
  node "$BOOTSTRAP" --yes

PASS=0
FAIL=0

check_exists() {
  local label="$1"
  local path="$2"
  if [ -e "$path" ]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label  (missing: $path)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "→ Verifying outputs"
check_exists "AGENTS.md"      "$WORKSPACE/AGENTS.md"
check_exists "BOOTSTRAP.md"   "$WORKSPACE/BOOTSTRAP.md"
check_exists "HEARTBEAT.md"   "$WORKSPACE/HEARTBEAT.md"
check_exists "MEMORY.md"      "$WORKSPACE/MEMORY.md"
check_exists "jarvos.config.json" "$WORKSPACE/jarvos.config.json"
check_exists "memory dir"     "$WORKSPACE/memory"
check_exists "vault/Notes"    "$VAULT/Notes"
check_exists "vault/Journal"  "$VAULT/Journal"
check_exists "vault/Tags"     "$VAULT/Tags"

# Template substitution check
for f in AGENTS.md BOOTSTRAP.md; do
  if grep -q '{{' "$WORKSPACE/$f" 2>/dev/null; then
    echo "  ✗ $f still contains {{placeholders}}"
    FAIL=$((FAIL + 1))
  else
    echo "  ✓ $f has no unreplaced placeholders"
    PASS=$((PASS + 1))
  fi
done

# Config values check
if grep -q '"TestJarvis"' "$WORKSPACE/jarvos.config.json" 2>/dev/null; then
  echo "  ✓ jarvos.config.json has correct assistantName"
  PASS=$((PASS + 1))
else
  echo "  ✗ jarvos.config.json missing assistantName"
  FAIL=$((FAIL + 1))
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All ${PASS} smoke tests passed."
  exit 0
else
  echo "${PASS} passed, ${FAIL} failed."
  exit 1
fi
