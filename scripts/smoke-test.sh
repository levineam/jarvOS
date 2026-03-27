#!/usr/bin/env bash
# jarvOS smoke test — verifies the repo is structurally complete and usable from a clean checkout.
#
# Usage:
#   bash scripts/smoke-test.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
#
# This script intentionally has no external dependencies beyond bash and standard POSIX tools.
# It is designed to run on both macOS and Linux (CI).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

check() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

check_file() {
  local rel="$1"
  check "file exists: $rel" test -f "$REPO_ROOT/$rel"
}

check_executable() {
  local rel="$1"
  check "executable: $rel" test -x "$REPO_ROOT/$rel"
}

check_nonempty() {
  local rel="$1"
  check "non-empty: $rel" test -s "$REPO_ROOT/$rel"
}

echo ""
echo "jarvOS smoke test"
echo "================="
echo "Repo: $REPO_ROOT"
echo ""

# ── Core behavioral layer ──────────────────────────────────────────────────────
echo "→ Core behavioral layer"
check_file "core/AGENTS.md"
check_file "core/SOUL.md"
check_file "core/IDENTITY.md"
check_nonempty "core/AGENTS.md"
check_nonempty "core/SOUL.md"

# ── Templates ─────────────────────────────────────────────────────────────────
echo ""
echo "→ Templates"
check_file "templates/AGENTS-template.md"
check_file "templates/BOOTSTRAP-template.md"
check_file "templates/HEARTBEAT-template.md"

# ── PMS ───────────────────────────────────────────────────────────────────────
echo ""
echo "→ Project Management System"
check_file "core/pms/README.md"
check_file "core/pms/project-board.template.md"
check_file "core/pms/project-brief.template.md"
check_file "core/pms/plan.template.md"
check_file "core/pms/tasks.template.md"

# ── Governance ────────────────────────────────────────────────────────────────
echo ""
echo "→ Governance"
check_file "core/governance/README.md"

# ── Hermes runtime ────────────────────────────────────────────────────────────
echo ""
echo "→ Hermes runtime"
check_file "runtimes/hermes/README.md"
check_file "runtimes/hermes/setup.sh"
check_executable "runtimes/hermes/setup.sh"
check_nonempty "runtimes/hermes/setup.sh"
check_file "runtimes/hermes/skills/jarvos/SKILL.md"

# ── OpenClaw runtime ──────────────────────────────────────────────────────────
echo ""
echo "→ OpenClaw runtime"
check_file "runtimes/openclaw/README.md"
check_nonempty "runtimes/openclaw/README.md"

# ── Starter kit ───────────────────────────────────────────────────────────────
echo ""
echo "→ Starter kit"
check_file "starter-kit/README.md"
check_file "starter-kit/templates/PROJECT-KICKOFF-PACK.template.md"
check_file "starter-kit/templates/OKR-TASK-BOARD.template.md"

# ── Top-level repo hygiene ────────────────────────────────────────────────────
echo ""
echo "→ Repo hygiene"
check_file "README.md"
check_file "LICENSE"
check_file "CHANGELOG.md"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "FAIL — $FAIL check(s) failed. See above for details."
  exit 1
else
  echo "PASS — All checks passed. The repo is ready to use."
  exit 0
fi
