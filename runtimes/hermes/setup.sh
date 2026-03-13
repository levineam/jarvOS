#!/bin/bash
# jarvOS Hermes Setup
# Sets up a complete jarvOS workspace for Hermes Agent

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE_DIR="$REPO_ROOT/core"
TEMPLATES_DIR="$REPO_ROOT/templates"
PMS_DIR="$REPO_ROOT/core/pms"
GOV_DIR="$REPO_ROOT/core/governance"
SKILL_DIR="$SCRIPT_DIR/skills/jarvos"

# Default workspace is ~/jarvos, override with first argument
WORKSPACE="${1:-$HOME/jarvos}"

echo "┌─────────────────────────────────────────────────┐"
echo "│            jarvOS — Hermes Setup                 │"
echo "│     Personal AI Operating System                 │"
echo "└─────────────────────────────────────────────────┘"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Workspace:  $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/pms" "$WORKSPACE/governance"

# ── Core files ──
echo "→ Installing core behavioral layer..."
cp "$CORE_DIR/AGENTS.md" "$WORKSPACE/AGENTS.md"
cp "$CORE_DIR/SOUL.md" "$WORKSPACE/SOUL.md"
cp "$CORE_DIR/IDENTITY.md" "$WORKSPACE/IDENTITY.md"
echo "  ✓ AGENTS.md, SOUL.md, IDENTITY.md"

# ── PMS templates ──
echo "→ Installing Project Management System..."
cp "$PMS_DIR/README.md" "$WORKSPACE/pms/README.md"
cp "$PMS_DIR/project-board.template.md" "$WORKSPACE/pms/project-board.template.md"
cp "$PMS_DIR/project-brief.template.md" "$WORKSPACE/pms/project-brief.template.md"
cp "$PMS_DIR/plan.template.md" "$WORKSPACE/pms/plan.template.md"
cp "$PMS_DIR/tasks.template.md" "$WORKSPACE/pms/tasks.template.md"
cp "$PMS_DIR/okr-board.template.md" "$WORKSPACE/pms/okr-board.template.md"
echo "  ✓ Project Board, Brief, Plan, Tasks, OKR templates"

# ── Governance ──
echo "→ Installing governance patterns..."
cp "$GOV_DIR/README.md" "$WORKSPACE/governance/README.md"
echo "  ✓ Escalation ladders, approval gates, autonomy levels"

# ── Personal templates (don't overwrite existing) ──
echo "→ Setting up personal files..."
for tmpl in "$TEMPLATES_DIR"/*.template.md; do
  base=$(basename "$tmpl" .template.md)
  target="$WORKSPACE/$base.md"
  if [ -f "$target" ]; then
    echo "  ⚠ $base.md exists — keeping yours"
  else
    cp "$tmpl" "$target"
    echo "  + $base.md created from template"
  fi
done

# ── Install jarvOS skill for Hermes ──
echo "→ Installing jarvOS skill..."
HERMES_SKILLS="$HOME/.hermes/skills/jarvos"
mkdir -p "$HERMES_SKILLS"
cp "$SKILL_DIR/SKILL.md" "$HERMES_SKILLS/SKILL.md"
echo "  ✓ jarvos skill installed to ~/.hermes/skills/"

# ── Configure Hermes workspace ──
echo ""
echo "→ Configuring Hermes..."
if command -v hermes >/dev/null 2>&1; then
  HERMES_CONFIG="$HOME/.hermes/config.yaml"
  if [ -f "$HERMES_CONFIG" ]; then
    if grep -q "cwd:" "$HERMES_CONFIG"; then
      sed -i.bak "s|cwd:.*|cwd: $WORKSPACE|" "$HERMES_CONFIG"
      echo "  ✓ Hermes workspace set to $WORKSPACE"
    else
      echo "  ⚠ Set terminal.cwd to $WORKSPACE in $HERMES_CONFIG"
    fi
  fi
else
  echo "  ⚠ hermes not found — install it first, then set terminal.cwd to $WORKSPACE"
fi

echo ""
echo "┌─────────────────────────────────────────────────┐"
echo "│  ✓ jarvOS installed!                            │"
echo "│                                                 │"
echo "│  What you got:                                  │"
echo "│  • Behavioral rules (AGENTS.md)                 │"
echo "│  • Persona (SOUL.md)                            │"
echo "│  • Project Management System (pms/)             │"
echo "│  • Governance patterns (governance/)            │"
echo "│  • Alignment map (ONTOLOGY.md template)         │"
echo "│  • jarvOS skill for Hermes                      │"
echo "│                                                 │"
echo "│  Next steps:                                    │"
echo "│  1. Edit USER.md with your info                 │"
echo "│  2. Edit ONTOLOGY.md with your mission + goals  │"
echo "│  3. Run: hermes setup (if not done)             │"
echo "│  4. Run: hermes                                 │"
echo "│  5. Tell your agent: 'Read AGENTS.md and the    │"
echo "│     pms/ and governance/ directories'            │"
echo "└─────────────────────────────────────────────────┘"
