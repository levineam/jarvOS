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

# Default workspace is this clone root, override with first argument
WORKSPACE_INPUT="${1:-$REPO_ROOT}"
mkdir -p "$WORKSPACE_INPUT"
WORKSPACE="$(cd "$WORKSPACE_INPUT" && pwd)"

# The launcher calls this narrow mode to install one stable hook shell and its
# exact consent. Do not run normal workspace onboarding from this path.
if [ "${JARVOS_STEWARDSHIP_ONLY:-0}" = "1" ] && [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" != "1" ]; then
  : "${JARVOS_STEWARDSHIP_STABLE_ROOT:?the stable stewardship bundle root is required}"
  HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
  python3 - "$HERMES_CONFIG" "$HOME/.hermes/shell-hooks-allowlist.json" "$JARVOS_STEWARDSHIP_STABLE_ROOT" "$JARVOS_STEWARDSHIP_STABLE_ROOT/jarvos-hermes-pre-llm-hook.js" "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:-}" <<'PY'
import datetime, json, os, shutil, stat, sys, tempfile, yaml
config_path, allowlist_path, stable_root, command, staged_root = sys.argv[1:]
def atomic(path, data, mode):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        with open(path, encoding='utf-8') as source:
            if source.read() == data: return
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S%f')
        shutil.copy2(path, path + '.bak-jarvos-stewardship-' + stamp)
    fd, temp = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '.', dir=os.path.dirname(path))
    with os.fdopen(fd, 'w', encoding='utf-8') as target: target.write(data); target.flush(); os.fsync(target.fileno())
    os.chmod(temp, mode); os.replace(temp, path)
def trusted_directory(value):
    try: info = os.lstat(value)
    except OSError: return False
    return os.path.isabs(value) and not stat.S_ISLNK(info.st_mode) and stat.S_ISDIR(info.st_mode) and (stat.S_IMODE(info.st_mode) & 0o077) == 0 and info.st_uid == os.getuid()
def trusted_executable(value):
    try: info = os.lstat(value)
    except OSError: return False
    return not stat.S_ISLNK(info.st_mode) and stat.S_ISREG(info.st_mode) and (stat.S_IMODE(info.st_mode) & 0o077) == 0 and (stat.S_IMODE(info.st_mode) & 0o111) != 0 and info.st_uid == os.getuid()
def trusted_ancestry(value):
    if not os.path.isabs(value) or os.path.normpath(value) != value or os.path.realpath(value) != value: return False
    current = value
    while True:
        try: info = os.lstat(current)
        except OSError: return False
        trusted_owner = info.st_uid in (0, os.getuid())
        safely_writable = (stat.S_IMODE(info.st_mode) & 0o022) == 0 or bool(info.st_mode & stat.S_ISVTX)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or not trusted_owner or not safely_writable: return False
        parent = os.path.dirname(current)
        if parent == current: return True
        current = parent
if not trusted_directory(stable_root) or not trusted_ancestry(stable_root) or not trusted_executable(command): raise SystemExit('stable Hermes hook is missing or unsafe')
owned_commands = {command}
if os.path.isabs(staged_root): owned_commands.add(os.path.join(staged_root, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js'))
config = {}
if os.path.exists(config_path):
    with open(config_path, encoding='utf-8') as source: config = yaml.safe_load(source) or {}
hooks = config.setdefault('hooks', {}); entries = hooks.setdefault('pre_llm_call', [])
entries[:] = [item for item in entries if not (isinstance(item, dict) and item.get('command') in owned_commands)]
entries.append({'command': command, 'timeout': 5})
atomic(config_path, yaml.safe_dump(config, sort_keys=False), stat.S_IMODE(os.stat(config_path).st_mode) if os.path.exists(config_path) else 0o600)
allowlist = {'approvals': []}
if os.path.exists(allowlist_path):
    with open(allowlist_path, encoding='utf-8') as source: allowlist = json.load(source)
if not isinstance(allowlist, dict): raise SystemExit('invalid Hermes shell-hook allowlist')
allowlist.setdefault('approvals', [])
existing_approval = next((item for item in allowlist['approvals'] if isinstance(item, dict) and item.get('event') == 'pre_llm_call' and item.get('command') == command), None)
allowlist['approvals'] = [item for item in allowlist['approvals'] if not (isinstance(item, dict) and item.get('event') == 'pre_llm_call' and item.get('command') in owned_commands)]
allowlist['approvals'].append(existing_approval or {'event': 'pre_llm_call', 'command': command, 'approved_at': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'), 'script_mtime_at_approval': datetime.datetime.fromtimestamp(os.path.getmtime(command), datetime.timezone.utc).isoformat().replace('+00:00', 'Z')})
atomic(allowlist_path, json.dumps(allowlist, indent=2) + '\n', stat.S_IMODE(os.stat(allowlist_path).st_mode) if os.path.exists(allowlist_path) else 0o600)
PY
  echo "Installed the stable jarvOS Hermes stewardship hook and exact consent record."
  exit 0
fi

if [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
  HERMES_CONFIG="${HERMES_CONFIG:-$HOME/.hermes/config.yaml}"
  python3 - "$HERMES_CONFIG" "$HOME/.hermes/shell-hooks-allowlist.json" "${JARVOS_STEWARDSHIP_STABLE_ROOT:-}" "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:-}" <<'PY'
import datetime, json, os, shutil, stat, sys, tempfile, yaml
config_path, allowlist_path, stable_root, staged_root = sys.argv[1:]
def atomic(path, data, mode):
    if os.path.exists(path):
        with open(path, encoding='utf-8') as source:
            if source.read() == data: return
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S%f')
        shutil.copy2(path, path + '.bak-jarvos-stewardship-' + stamp)
    fd, temp = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '.', dir=os.path.dirname(path))
    with os.fdopen(fd, 'w', encoding='utf-8') as target: target.write(data); target.flush(); os.fsync(target.fileno())
    os.chmod(temp, mode); os.replace(temp, path)
owned_commands = set()
if os.path.isabs(stable_root): owned_commands.add(os.path.join(stable_root, 'jarvos-hermes-pre-llm-hook.js'))
if os.path.isabs(staged_root): owned_commands.add(os.path.join(staged_root, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js'))
if os.path.exists(config_path):
    with open(config_path, encoding='utf-8') as source: config = yaml.safe_load(source) or {}
    hooks = config.get('hooks') or {}; entries = hooks.get('pre_llm_call') or []
    kept = [item for item in entries if not (isinstance(item, dict) and item.get('command') in owned_commands)]
    if len(kept) != len(entries):
        hooks['pre_llm_call'] = kept; config['hooks'] = hooks
        atomic(config_path, yaml.safe_dump(config, sort_keys=False), stat.S_IMODE(os.stat(config_path).st_mode))
if os.path.exists(allowlist_path):
    with open(allowlist_path, encoding='utf-8') as source: allowlist = json.load(source)
    approvals = allowlist.get('approvals') if isinstance(allowlist, dict) else None
    if isinstance(approvals, list):
        kept = [item for item in approvals if not (isinstance(item, dict) and item.get('event') == 'pre_llm_call' and item.get('command') in owned_commands)]
        if len(kept) != len(approvals):
            allowlist['approvals'] = kept
            atomic(allowlist_path, json.dumps(allowlist, indent=2) + '\n', stat.S_IMODE(os.stat(allowlist_path).st_mode))
PY
  echo "Removed only the stable jarvOS Hermes stewardship hook and consent record."
  exit 0
fi

echo "┌─────────────────────────────────────────────────┐"
echo "│            jarvOS — Hermes Setup                 │"
echo "│     Personal AI Operating System                 │"
echo "└─────────────────────────────────────────────────┘"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Workspace:  $WORKSPACE"
echo ""
echo "  i Managed-launcher activation requires explicit managed repository roots and a staged private runtime tuple."
echo ""

# ── Dependency checks ──
echo "→ Checking dependencies..."
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js not found — install Node.js v18+ from https://nodejs.org"
  echo ""
  echo "Install Node.js, then re-run this script."
  exit 1
fi
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ "${NODE_VER:-0}" -lt 18 ]; then
  echo "  ✗ Node.js v18+ required (found v$NODE_VER)"
  echo ""
  echo "Install Node.js v18+, then re-run this script."
  exit 1
fi
echo "  ✓ Node.js $(node --version)"
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
  copy_if_missing "$CORE_DIR/$core_file" "$WORKSPACE/$core_file"
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
template_names=(
  "USER"
  "MEMORY"
  "ONTOLOGY"
  "TOOLS"
  "okr-task-board"
  "project-kickoff-pack"
)
for name in "${template_names[@]}"; do
  tmpl="$TEMPLATES_DIR/$name.template.md"
  if [ ! -f "$tmpl" ]; then
    alt_tmpl="$TEMPLATES_DIR/$name-template.md"
    if [ -f "$alt_tmpl" ]; then
      tmpl="$alt_tmpl"
    else
      echo "  • $name template not found — skipping (fallback file creation will run if needed)"
      continue
    fi
  fi

  base="${name%-template}"
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

## Priorities
- [Top priority 1]
- [Top priority 2]

## Preferences
- [Communication style]
- [Working hours]
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
- [Goal 2]

## Constraints
- [Hard constraints to respect]
EOF
  echo "  + ONTOLOGY.md created"
fi

if [ ! -f "$WORKSPACE/MEMORY.md" ]; then
  if [ -f "$TEMPLATES_DIR/MEMORY.template.md" ]; then
    cp "$TEMPLATES_DIR/MEMORY.template.md" "$WORKSPACE/MEMORY.md"
    echo "  + MEMORY.md created from template"
  else
    cat > "$WORKSPACE/MEMORY.md" <<'EOF'
# MEMORY.md

## Key Context
- [Important personal or project context]

## Preferences
- [Working preferences]

## Ongoing Work
- [Active projects or focus areas]

## Durable Decisions
- [Long-term decisions to preserve across sessions]
EOF
    echo "  + MEMORY.md created"
  fi
fi

if [ ! -f "$WORKSPACE/TOOLS.md" ]; then
  if [ -f "$TEMPLATES_DIR/TOOLS.template.md" ]; then
    cp "$TEMPLATES_DIR/TOOLS.template.md" "$WORKSPACE/TOOLS.md"
    echo "  + TOOLS.md created from template"
  else
    cat > "$WORKSPACE/TOOLS.md" <<'EOF'
# TOOLS.md

## Tool Notes
- Add local CLI patterns and shortcuts here.

## Runtime-Specific Commands
- Add command examples for your runtime/toolchain.

## Operational Guardrails
- Add local do/don't reminders for tool usage.
EOF
    echo "  + TOOLS.md created"
  fi
fi

# ── Shared secondbrain vault onboarding ──
echo "→ Detecting shared secondbrain vault..."
DETECT_VAULT="$REPO_ROOT/modules/jarvos-secondbrain/scripts/detect-vault.js"
if [ -f "$DETECT_VAULT" ]; then
  set +e
  node "$DETECT_VAULT" --runtime=hermes
  DETECT_STATUS=$?
  set -e
  if [ "$DETECT_STATUS" -eq 2 ]; then
    echo "  i Vault directory is not on disk yet — continuing setup."
  elif [ "$DETECT_STATUS" -ne 0 ]; then
    exit "$DETECT_STATUS"
  fi
else
  echo "  ⚠ detect-vault.js not found — skipping vault detection"
fi
echo ""

# ── Install portable jarvOS skills for Hermes ──
echo "→ Reconciling portable jarvOS skills..."
HERMES_SKILLS="$HOME/.hermes/skills"
SKILL_INSTALLER="$REPO_ROOT/modules/jarvos-skills/scripts/install-skills.js"
if [ -f "$SKILL_INSTALLER" ]; then
  # The projection contract creates missing/clean targets and preserves unknown,
  # locally modified, or conflicting targets. It never replaces a user edit.
  node "$SKILL_INSTALLER" project --harness hermes --dest "$HERMES_SKILLS" --apply
  echo "  ✓ portable skills reconciled at ~/.hermes/skills/"
  echo "  i Existing ~/.hermes/skills/jarvos/SKILL.md is not managed or overwritten by this setup."
else
  echo "  ⚠ @jarvos/skills installer not found — portable skills were not changed"
fi

# ── Configure Hermes workspace ──
echo ""
echo "→ Configuring Hermes..."
HERMES_MCP_STATUS=0
if command -v hermes >/dev/null 2>&1; then
  HERMES_CONFIG="$HOME/.hermes/config.yaml"
  MCP_SERVER="$REPO_ROOT/modules/jarvos-agent-context/scripts/jarvos-mcp.js"
  if [ -f "$MCP_SERVER" ]; then
    mcp_added=0
    mcp_backup=""
    if hermes mcp list 2>/dev/null | awk 'tolower($1) == "jarvos" { found=1 } END { exit(found ? 0 : 1) }'; then
      echo "  ✓ Hermes MCP entry 'jarvos' already exists — keeping it"
    else
      if [ -f "$HERMES_CONFIG" ]; then
        mcp_backup="$HERMES_CONFIG.bak.$(date +%Y%m%d%H%M%S).$$"
        cp "$HERMES_CONFIG" "$mcp_backup"
        echo "  • Backup saved to $mcp_backup"
      fi
      if printf 'y\n' | hermes mcp add jarvos --command node --args "$MCP_SERVER" >/dev/null 2>&1; then
        mcp_added=1
        echo "  ✓ Hermes MCP entry 'jarvos' registered"
      else
        HERMES_MCP_STATUS=1
        echo "  ✗ Hermes MCP registration failed"
      fi
    fi
    if [ "$HERMES_MCP_STATUS" -eq 0 ]; then
      if hermes mcp test jarvos >/dev/null 2>&1; then
        echo "  ✓ Hermes MCP entry 'jarvos' is healthy"
      else
        HERMES_MCP_STATUS=1
        if [ "$mcp_added" -eq 1 ] && [ -n "$mcp_backup" ]; then
          cp "$mcp_backup" "$HERMES_CONFIG"
          echo "  ✗ Hermes MCP health check failed; restored the prior config"
        elif [ "$mcp_added" -eq 1 ]; then
          hermes mcp remove jarvos >/dev/null 2>&1 || true
          echo "  ✗ Hermes MCP health check failed; removed the new entry"
        else
          echo "  ✗ Existing Hermes MCP entry 'jarvos' failed its health check"
        fi
      fi
    fi
  else
    HERMES_MCP_STATUS=1
    echo "  ✗ shared jarvOS MCP server not found"
  fi
  if [ -f "$HERMES_CONFIG" ]; then
    if grep -qE '^terminal:[[:space:]]*(#.*)?$' "$HERMES_CONFIG"; then
      yaml_workspace=$(printf "%s" "$WORKSPACE" | sed "s/'/''/g")

      backup="$HERMES_CONFIG.bak.$(date +%Y%m%d%H%M%S).$$"
      cp "$HERMES_CONFIG" "$backup"
      echo "  • Backup saved to $backup"

      config_mode=$(stat -c '%a' "$HERMES_CONFIG" 2>/dev/null || stat -f '%Lp' "$HERMES_CONFIG")
      config_owner=$(stat -c '%u:%g' "$HERMES_CONFIG" 2>/dev/null || stat -f '%u:%g' "$HERMES_CONFIG")
      tmp_config="$HERMES_CONFIG.tmp.$$"

      awk -v workspace="$yaml_workspace" '
        function leading_ws(str, tmp) {
          tmp = str
          sub(/[^[:space:]].*$/, "", tmp)
          return tmp
        }
        BEGIN {
          in_terminal = 0
          updated = 0
          terminal_targeted = 0
          term_indent = ""
          child_indent = "  "
          term_indent_len = 0
          child_indent_len = 2
          child_indent_set = 0
        }
        {
          line = $0

          if (!terminal_targeted && line ~ /^terminal:[[:space:]]*(#.*)?$/) {
            print line
            in_terminal = 1
            updated = 0
            terminal_targeted = 1
            term_indent = leading_ws(line)
            term_indent_len = length(term_indent)
            child_indent = term_indent "  "
            child_indent_len = term_indent_len + 2
            child_indent_set = 0
            next
          }

          if (in_terminal) {
            trimmed = line
            sub(/^[[:space:]]+/, "", trimmed)

            if (trimmed != "" && trimmed !~ /^#/) {
              line_indent_len = length(leading_ws(line))

              if (line_indent_len > term_indent_len && !child_indent_set) {
                child_indent = leading_ws(line)
                child_indent_len = line_indent_len
                child_indent_set = 1
              }

              if (line_indent_len <= term_indent_len) {
                if (!updated) {
                  printf "%scwd: '\''%s'\''\n", child_indent, workspace
                  updated = 1
                }
                in_terminal = 0
              } else if (line_indent_len == child_indent_len && trimmed ~ /^cwd:[[:space:]]*/) {
                printf "%scwd: '\''%s'\''\n", child_indent, workspace
                updated = 1
                next
              }
            }
          }

          print line
        }
        END {
          if (in_terminal && !updated) {
            printf "%scwd: '\''%s'\''\n", child_indent, workspace
          }
        }
      ' "$HERMES_CONFIG" > "$tmp_config"

      chmod "$config_mode" "$tmp_config" 2>/dev/null || true
      chown "$config_owner" "$tmp_config" 2>/dev/null || true
      mv "$tmp_config" "$HERMES_CONFIG"

      echo "  ✓ Hermes terminal.cwd set to $WORKSPACE"
    else
      echo "  ⚠ Could not find terminal: block in $HERMES_CONFIG"
      echo "    Add this under terminal:"
      echo "    cwd: '$WORKSPACE'"
    fi
  else
    HERMES_MCP_STATUS=1
    echo "  ✗ Config was not created at $HERMES_CONFIG"
  fi
else
  HERMES_MCP_STATUS=1
  echo "  ✗ hermes not found — install it first, then set terminal.cwd to $WORKSPACE"
fi

echo ""
if [ "$HERMES_MCP_STATUS" -ne 0 ]; then
  echo "✗ jarvOS setup did not establish a healthy Hermes MCP connection."
  exit "$HERMES_MCP_STATUS"
fi

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
