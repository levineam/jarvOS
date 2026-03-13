#!/bin/bash
# jarvOS Hermes Setup
# Copies core jarvOS files into a Hermes workspace directory

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE_DIR="$REPO_ROOT/core"
TEMPLATES_DIR="$REPO_ROOT/templates"

# Default workspace is ~/jarvos-hermes, override with first argument
WORKSPACE="${1:-$HOME/jarvos-hermes}"

echo "┌─────────────────────────────────────────────────┐"
echo "│          jarvOS — Hermes Workspace Setup         │"
echo "└─────────────────────────────────────────────────┘"
echo ""
echo "  Core source:  $CORE_DIR"
echo "  Workspace:    $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE"

# Copy core files
echo "→ Copying core files..."
cp "$CORE_DIR/AGENTS.md" "$WORKSPACE/AGENTS.md"
cp "$CORE_DIR/SOUL.md" "$WORKSPACE/SOUL.md"
cp "$CORE_DIR/IDENTITY.md" "$WORKSPACE/IDENTITY.md"
echo "✓ Core files copied"

# Copy templates (don't overwrite existing personal files)
echo "→ Copying templates..."
for tmpl in "$TEMPLATES_DIR"/*.template.md; do
  base=$(basename "$tmpl" .template.md)
  target="$WORKSPACE/$base.md"
  if [ -f "$target" ]; then
    echo "  ⚠ $base.md already exists — skipping (won't overwrite your personal file)"
  else
    cp "$tmpl" "$target"
    echo "  + $base.md created from template"
  fi
done
echo "✓ Templates ready"

# Configure Hermes to use this workspace
echo ""
echo "→ Updating Hermes config to use workspace..."
if command -v hermes >/dev/null 2>&1; then
  HERMES_CONFIG="$HOME/.hermes/config.yaml"
  if [ -f "$HERMES_CONFIG" ]; then
    if grep -q "cwd:" "$HERMES_CONFIG"; then
      sed -i.bak "s|cwd:.*|cwd: $WORKSPACE|" "$HERMES_CONFIG"
      echo "✓ Updated cwd in $HERMES_CONFIG"
    else
      echo "  ⚠ Could not find cwd setting in config — set it manually:"
      echo "    terminal.cwd: $WORKSPACE"
    fi
  fi
else
  echo "  ⚠ hermes command not found — install Hermes first, then set terminal.cwd to $WORKSPACE"
fi

echo ""
echo "┌─────────────────────────────────────────────────┐"
echo "│  ✓ jarvOS workspace ready!                      │"
echo "│                                                 │"
echo "│  Next steps:                                    │"
echo "│  1. Edit USER.md with your info                 │"
echo "│  2. Edit ONTOLOGY.md with your goals            │"
echo "│  3. Run: hermes setup (configure model/keys)    │"
echo "│  4. Run: hermes (start chatting)                │"
echo "└─────────────────────────────────────────────────┘"
