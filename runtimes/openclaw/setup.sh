#!/usr/bin/env bash
# jarvOS — OpenClaw Setup
# Sets up a complete jarvOS workspace for an OpenClaw agent.
#
# Usage:
#   ./runtimes/openclaw/setup.sh [WORKSPACE_DIR]
#
# Default workspace is the current working directory.
# Run from the repo root after cloning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE_DIR="$REPO_ROOT/core"
TEMPLATES_DIR="$REPO_ROOT/templates"

WORKSPACE_INPUT="${1:-$(pwd)}"
mkdir -p "$WORKSPACE_INPUT"
WORKSPACE="$(cd "$WORKSPACE_INPUT" && pwd)"

echo "┌──────────────────────────────────────────────────┐"
echo "│          jarvOS — OpenClaw Setup                 │"
echo "│    Personal AI Operating System                  │"
echo "└──────────────────────────────────────────────────┘"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Workspace:  $WORKSPACE"
echo ""

# ── Dependency checks ──────────────────────────────────────────────────────────
echo "→ Checking dependencies..."

MISSING=""

if ! command -v node >/dev/null 2>&1; then
  MISSING="$MISSING\n  ✗ Node.js not found — install from https://nodejs.org (v18+)"
else
  NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
  if [ "${NODE_VER:-0}" -lt 18 ]; then
    MISSING="$MISSING\n  ✗ Node.js v18+ required (found v$NODE_VER)"
  else
    echo "  ✓ Node.js $(node --version)"
  fi
fi

if ! command -v openclaw >/dev/null 2>&1; then
  MISSING="$MISSING\n  ✗ OpenClaw not found — install with: npm install -g openclaw"
else
  echo "  ✓ OpenClaw $(openclaw --version 2>/dev/null || echo '(version unknown)')"
fi

if [ -n "$MISSING" ]; then
  echo ""
  echo "Missing prerequisites:"
  printf "$MISSING\n"
  echo ""
  echo "Install them, then re-run this script."
  exit 1
fi

echo ""

# ── Helper ────────────────────────────────────────────────────────────────────
copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [ -f "$dst" ]; then
    echo "  ⚠ $(basename "$dst") exists — keeping yours"
  else
    cp "$src" "$dst"
    echo "  + $(basename "$dst") installed"
  fi
}

# ── Shared secondbrain vault onboarding ──────────────────────────────────────
echo "→ Detecting shared secondbrain vault..."
DETECT_VAULT="$REPO_ROOT/modules/jarvos-secondbrain/scripts/detect-vault.js"
if [ -f "$DETECT_VAULT" ]; then
  node "$DETECT_VAULT" --runtime=openclaw
else
  echo "  ⚠ detect-vault.js not found — skipping vault detection"
fi
echo ""

# ── Core behavioral layer ─────────────────────────────────────────────────────
echo "→ Installing core behavioral layer..."
for f in AGENTS.md SOUL.md IDENTITY.md; do
  copy_if_missing "$CORE_DIR/$f" "$WORKSPACE/$f"
done
echo ""

# ── Personal overlay templates ────────────────────────────────────────────────
echo "→ Installing personal overlay templates..."
copy_if_missing "$TEMPLATES_DIR/USER.template.md"     "$WORKSPACE/USER.md"
copy_if_missing "$TEMPLATES_DIR/MEMORY.template.md"   "$WORKSPACE/MEMORY.md"
copy_if_missing "$TEMPLATES_DIR/ONTOLOGY.template.md" "$WORKSPACE/ONTOLOGY.md"
copy_if_missing "$TEMPLATES_DIR/TOOLS.template.md"    "$WORKSPACE/TOOLS.md"
echo ""

# ── Bootstrap ─────────────────────────────────────────────────────────────────
echo "→ Installing bootstrap..."
copy_if_missing "$TEMPLATES_DIR/bootstrap-template.md" "$WORKSPACE/BOOTSTRAP.md"
echo ""

# ── Heartbeat ─────────────────────────────────────────────────────────────────
echo "→ Installing heartbeat..."
copy_if_missing "$TEMPLATES_DIR/heartbeat-template.md" "$WORKSPACE/HEARTBEAT.md"
echo ""

# ── Memory directory ──────────────────────────────────────────────────────────
echo "→ Setting up memory directory..."
mkdir -p "$WORKSPACE/memory"
TODAY=$(date '+%Y-%m-%d')
DAILY="$WORKSPACE/memory/$TODAY.md"
if [ ! -f "$DAILY" ]; then
  cat > "$DAILY" <<EOF
# Memory - $TODAY

## Bootstrap
- jarvOS workspace set up via setup.sh
- Fill in USER.md and ONTOLOGY.md with your personal details
- Start the OpenClaw gateway and tell your agent to read BOOTSTRAP.md
EOF
  echo "  + memory/$TODAY.md created"
else
  echo "  ⚠ memory/$TODAY.md exists — keeping yours"
fi
echo ""

# ── Smoke test ────────────────────────────────────────────────────────────────
echo "→ Running smoke test..."

SMOKE_PASS=true
for f in AGENTS.md SOUL.md IDENTITY.md USER.md MEMORY.md ONTOLOGY.md TOOLS.md BOOTSTRAP.md HEARTBEAT.md; do
  if [ -f "$WORKSPACE/$f" ]; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f MISSING"
    SMOKE_PASS=false
  fi
done

if [ "$SMOKE_PASS" = false ]; then
  echo ""
  echo "Smoke test failed — some files were not installed. Check errors above."
  exit 1
fi

echo ""
echo "┌──────────────────────────────────────────────────┐"
echo "│  ✓ jarvOS workspace ready for OpenClaw!          │"
echo "│                                                  │"
echo "│  Installed:                                      │"
echo "│  • AGENTS.md  — behavioral rules                 │"
echo "│  • SOUL.md    — personality and tone             │"
echo "│  • IDENTITY.md — agent identity                  │"
echo "│  • USER.md    — fill in with your info           │"
echo "│  • MEMORY.md  — long-term memory seed            │"
echo "│  • ONTOLOGY.md — values and goals                │"
echo "│  • TOOLS.md   — tool notes and guardrails        │"
echo "│  • BOOTSTRAP.md — first-run ritual               │"
echo "│  • HEARTBEAT.md — proactive check-in config      │"
echo "│  • memory/    — daily memory directory           │"
echo "│                                                  │"
echo "│  Next steps:                                     │"
echo "│  1. Edit USER.md with your name, timezone, goals │"
echo "│  2. Edit ONTOLOGY.md with your mission + values  │"
echo "│  3. Run: openclaw gateway start                  │"
echo "│  4. Tell your agent: 'Read BOOTSTRAP.md'         │"
echo "│                                                  │"
echo "│  See runtimes/openclaw/README.md for wiring      │"
echo "│  notes (HEARTBEAT.md, scripts/, workflows/).     │"
echo "└──────────────────────────────────────────────────┘"
