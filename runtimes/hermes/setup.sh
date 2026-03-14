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

# Default workspace is this clone root, override with first argument
WORKSPACE="${1:-$REPO_ROOT}"

echo "┌─────────────────────────────────────────────────┐"
echo "│            jarvOS — Hermes Setup                 │"
echo "│     Personal AI Operating System                 │"
echo "└─────────────────────────────────────────────────┘"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Workspace:  $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/pms" "$WORKSPACE/governance"

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

# ── Core files ──
echo "→ Installing core behavioral layer..."
for core_file in AGENTS.md SOUL.md IDENTITY.md; do
  src="$CORE_DIR/$core_file"
  dst="$WORKSPACE/$core_file"
  if [ -f "$dst" ]; then
    echo "  ⚠ $core_file exists — keeping yours"
  else
    cp "$src" "$dst"
    echo "  + $core_file installed"
  fi
done

# ── PMS templates ──
echo "→ Installing Project Management System..."
copy_if_missing "$PMS_DIR/README.md" "$WORKSPACE/pms/README.md"
copy_if_missing "$PMS_DIR/project-board.template.md" "$WORKSPACE/pms/project-board.template.md"
copy_if_missing "$PMS_DIR/project-brief.template.md" "$WORKSPACE/pms/project-brief.template.md"
copy_if_missing "$PMS_DIR/plan.template.md" "$WORKSPACE/pms/plan.template.md"
copy_if_missing "$PMS_DIR/tasks.template.md" "$WORKSPACE/pms/tasks.template.md"
copy_if_missing "$PMS_DIR/okr-board.template.md" "$WORKSPACE/pms/okr-board.template.md"
if [ -f "$PMS_DIR/session-lifecycle.md" ]; then
  copy_if_missing "$PMS_DIR/session-lifecycle.md" "$WORKSPACE/pms/session-lifecycle.md"
fi
echo "  ✓ Project Board, Brief, Plan, Tasks, OKR templates, Session Lifecycle guide"

# ── Governance ──
echo "→ Installing governance patterns..."
copy_if_missing "$GOV_DIR/README.md" "$WORKSPACE/governance/README.md"
echo "  ✓ Escalation ladders, approval gates, autonomy levels"

# ── Personal templates (don't overwrite existing) ──
echo "→ Setting up personal files..."
# Hermes-safe templates only (exclude OpenClaw-only bootstrap/heartbeat files)
template_files=(
  "$TEMPLATES_DIR/USER.template.md"
  "$TEMPLATES_DIR/MEMORY.template.md"
  "$TEMPLATES_DIR/ONTOLOGY.template.md"
  "$TEMPLATES_DIR/TOOLS.template.md"
  "$TEMPLATES_DIR/okr-task-board-template.md"
  "$TEMPLATES_DIR/project-kickoff-pack-template.md"
)
for tmpl in "${template_files[@]}"; do
  [ -f "$tmpl" ] || continue
  base=$(basename "$tmpl")
  base="${base%.template.md}"
  base="${base%-template.md}"
  target="$WORKSPACE/$base.md"
  if [ -f "$target" ]; then
    echo "  ⚠ $base.md exists — keeping yours"
  else
    cp "$tmpl" "$target"
    echo "  + $base.md created from template"
  fi
done

# Ensure expected personal files exist even if template pack is minimal
if [ ! -f "$WORKSPACE/USER.md" ]; then
  cat > "$WORKSPACE/USER.md" <<'EOF'
# USER.md

## Name
[Your name]

## Timezone
[Your IANA timezone, e.g. America/New_York]
EOF
  echo "  + USER.md created"
fi

if [ ! -f "$WORKSPACE/ONTOLOGY.md" ]; then
  cat > "$WORKSPACE/ONTOLOGY.md" <<'EOF'
# ONTOLOGY.md

## Mission
[What you're building toward]

## Values
- [Value 1]
- [Value 2]

## Goals
- [Goal 1]
EOF
  echo "  + ONTOLOGY.md created"
fi

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
    if grep -qE '^terminal:[[:space:]]*(#.*)?$' "$HERMES_CONFIG"; then
      yaml_workspace=$(printf "%s" "$WORKSPACE" | sed "s/'/'\"'\"'/g")
      replacement=$(printf "  cwd: '%s'" "$yaml_workspace")

      cp "$HERMES_CONFIG" "$HERMES_CONFIG.bak"
      awk -v replacement="$replacement" '
        BEGIN { in_terminal = 0; updated = 0 }
        /^terminal:[[:space:]]*(#.*)?$/ {
          print
          in_terminal = 1
          next
        }
        in_terminal && /^[^[:space:]]/ {
          if (!updated) {
            print replacement
            updated = 1
          }
          in_terminal = 0
        }
        in_terminal && /^[[:space:]]+cwd:[[:space:]]*/ {
          print replacement
          updated = 1
          next
        }
        { print }
        END {
          if (in_terminal && !updated) {
            print replacement
          }
        }
      ' "$HERMES_CONFIG" > "$HERMES_CONFIG.tmp" && mv "$HERMES_CONFIG.tmp" "$HERMES_CONFIG"

      echo "  ✓ Hermes terminal.cwd set to $WORKSPACE"
    else
      echo "  ⚠ Could not find terminal: block in $HERMES_CONFIG"
      echo "    Add this under terminal:"
      echo "    cwd: '$WORKSPACE'"
    fi
  else
    echo "  ⚠ Config not found at $HERMES_CONFIG"
    echo "    Run 'hermes setup' first, then re-run this script"
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
echo "│  3. Run: hermes                                 │"
echo "│  4. Tell your agent: 'Read AGENTS.md and the    │"
echo "│     pms/ and governance/ directories'            │"
echo "└─────────────────────────────────────────────────┘"
