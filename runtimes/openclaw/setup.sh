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

# This mode is intentionally limited to the stable stewardship plugin. It is
# used by the managed launcher and must never copy workspace templates.
if [ "${JARVOS_STEWARDSHIP_ONLY:-0}" = "1" ] || [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
  : "${JARVOS_MANAGED_HARNESS_STATE_ROOT:?the managed launcher state root is required}"
  if [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" != "1" ]; then
    : "${JARVOS_STEWARDSHIP_STABLE_ROOT:?the stable stewardship bundle root is required}"
  fi
  OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}}"
  node - "$OPENCLAW_CONFIG" "${JARVOS_STEWARDSHIP_STABLE_ROOT:-}" "$JARVOS_MANAGED_HARNESS_STATE_ROOT/stewardship-bridge/openclaw-sessions" "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" "${JARVOS_STAGED_PUBLIC_RUNTIME_ROOT:-}" "$REPO_ROOT/modules/jarvos-runtime-kit/src/openclaw-plugin-persistence.js" <<'NODE'
const fs = require('fs'); const os = require('os'); const path = require('path');
const [configPath, stableRoot, mappingRoot, rollback, stagedRoot, runtimeKitPath] = process.argv.slice(2);
const pluginPath = stableRoot ? path.join(stableRoot, 'jarvos-openclaw-stewardship-plugin') : null;
function trustedDirectory(value) {
  const stat = fs.lstatSync(value); const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return path.isAbsolute(value) && !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);
}
function trustedFile(value) {
  const stat = fs.lstatSync(value); const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);
}
function snapshot(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null, mode: null };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('refusing symlinked OpenClaw configuration');
  if (!stat.isFile()) throw new Error('OpenClaw configuration is not a regular file');
  return { exists: true, bytes: fs.readFileSync(filePath), mode: stat.mode & 0o7777 };
}
function rejectSymlink(filePath, label) {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error(`refusing symlinked ${label}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function sameSnapshot(filePath, expected) {
  const current = snapshot(filePath);
  return current.exists === expected.exists
    && (!current.exists || (current.mode === expected.mode && current.bytes.equals(expected.bytes)));
}
function assertUnchanged(filePath, expected) {
  try {
    if (!sameSnapshot(filePath, expected)) throw new Error('configuration changed');
  } catch (error) {
    throw new Error('OpenClaw configuration changed; manual reconciliation may be required');
  }
}
function temporaryPath(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}
function atomicReplace(filePath, bytes, mode, expected) {
  if (expected) assertUnchanged(filePath, expected);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = temporaryPath(filePath);
  try {
    fs.writeFileSync(tempPath, bytes, { flag: 'wx', mode });
    fs.chmodSync(tempPath, mode);
    if (expected) assertUnchanged(filePath, expected);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup of our temp file */ }
    throw error;
  }
}
function restorePrior(filePath, prior, written) {
  assertUnchanged(filePath, written);
  if (!prior.exists) {
    fs.unlinkSync(filePath);
    return;
  }
  atomicReplace(filePath, prior.bytes, prior.mode, written);
}
// Keep the installed bundle aligned with the public OpenClaw adapter contract:
// the package manifest, OpenClaw plugin manifest, and hook implementation are
// all required before touching user configuration.
const requiredPluginFiles = ['package.json', 'openclaw.plugin.json', 'jarvos-next-turn-plugin.js'];
if (rollback !== '1' && (!trustedDirectory(stableRoot) || !trustedDirectory(pluginPath) || !requiredPluginFiles.every((file) => trustedFile(path.join(pluginPath, file))))) {
  throw new Error('stable OpenClaw plugin is missing or unsafe');
}
const prior = snapshot(configPath);
const original = prior.exists ? prior.bytes.toString('utf8') : '{}\n';
const config = JSON.parse(original || '{}');
const plugins = config.plugins && typeof config.plugins === 'object' ? config.plugins : {};
const tools = config.tools && typeof config.tools === 'object' ? config.tools : null;
const stewardshipEntry = plugins.entries && typeof plugins.entries === 'object' ? plugins.entries['jarvos-stewardship'] : null;
const ownsStewardshipEntry = stewardshipEntry?.config?.mappingRoot === mappingRoot;
if (rollback !== '1' && stewardshipEntry && !ownsStewardshipEntry) throw new Error('refusing to replace an unrelated OpenClaw stewardship plugin entry');
const existingToolOwnership = stewardshipEntry?.config?.toolAllowAddedByJarvos;
const toolAllowAddedByJarvos = typeof existingToolOwnership === 'boolean'
  ? existingToolOwnership
  : Array.isArray(tools?.allow) && !tools.allow.includes('jarvos_stewardship_answer');
const existingAgentGrant = stewardshipEntry?.config?.agentToolGrantByJarvos;
let agentToolGrantByJarvos = existingAgentGrant && typeof existingAgentGrant === 'object' ? existingAgentGrant : null;
const ownedPluginPaths = pluginPath ? [pluginPath] : [];
if (path.isAbsolute(stagedRoot || '')) ownedPluginPaths.push(path.join(stagedRoot, 'runtimes', 'openclaw'));
const requestedAgentId = process.env.JARVOS_OPENCLAW_AGENT_ID || 'main';
const targetAgentId = rollback === '1' && typeof agentToolGrantByJarvos?.agentId === 'string' ? agentToolGrantByJarvos.agentId : requestedAgentId;
if (!/^[A-Za-z0-9._-]{1,64}$/.test(targetAgentId)) throw new Error('invalid stewardship OpenClaw agent id');
function targetAgent(create) {
  if (!config.agents || typeof config.agents !== 'object') { if (!create) return null; config.agents = {}; }
  if (!Array.isArray(config.agents.list)) { if (!create) return null; config.agents.list = []; }
  let agent = config.agents.list.find((value) => value && typeof value === 'object' && value.id === targetAgentId);
  if (!agent && create) { agent = { id: targetAgentId }; config.agents.list.push(agent); }
  return agent;
}
if (rollback === '1') {
  if (plugins.load && Array.isArray(plugins.load.paths)) plugins.load.paths = plugins.load.paths.filter((value) => !ownedPluginPaths.includes(value));
  if (ownsStewardshipEntry && Array.isArray(plugins.allow)) plugins.allow = plugins.allow.filter((value) => value !== 'jarvos-stewardship');
  if (ownsStewardshipEntry && plugins.entries && typeof plugins.entries === 'object') delete plugins.entries['jarvos-stewardship'];
  if (toolAllowAddedByJarvos && Array.isArray(tools?.allow)) tools.allow = tools.allow.filter((value) => value !== 'jarvos_stewardship_answer');
  if (agentToolGrantByJarvos?.added === true) {
    const agent = targetAgent(false);
    if (agent?.tools && Array.isArray(agent.tools.alsoAllow)) agent.tools.alsoAllow = agent.tools.alsoAllow.filter((value) => value !== 'jarvos_stewardship_answer');
    if (agentToolGrantByJarvos.createdAlsoAllow === true && agent?.tools?.alsoAllow?.length === 0) delete agent.tools.alsoAllow;
    if (agentToolGrantByJarvos.createdTools === true && agent?.tools && Object.keys(agent.tools).length === 0) delete agent.tools;
    if (agentToolGrantByJarvos.createdAgent === true && agent && Object.keys(agent).length === 1 && agent.id === targetAgentId) config.agents.list = config.agents.list.filter((value) => value !== agent);
  }
  config.plugins = plugins;
} else {
  config.plugins = plugins;
  plugins.load = plugins.load && typeof plugins.load === 'object' ? plugins.load : {};
  plugins.load.paths = Array.isArray(plugins.load.paths) ? plugins.load.paths : [];
  if (!pluginPath || !path.isAbsolute(pluginPath)) throw new Error('stable OpenClaw plugin path is required');
  plugins.load.paths = plugins.load.paths.filter((value) => !ownedPluginPaths.includes(value));
  if (!plugins.load.paths.includes(pluginPath)) plugins.load.paths.push(pluginPath);
  if (Array.isArray(plugins.allow) && !plugins.allow.includes('jarvos-stewardship')) plugins.allow.push('jarvos-stewardship');
  if (Array.isArray(tools?.allow) && !tools.allow.includes('jarvos_stewardship_answer')) tools.allow.push('jarvos_stewardship_answer');
  const existingAgent = targetAgent(false);
  const effectiveProfile = existingAgent?.tools?.profile || tools?.profile;
  if (effectiveProfile && effectiveProfile !== 'full') {
    if (!existingAgent) throw new Error(`stewardship OpenClaw agent is not configured: ${targetAgentId}`);
    const agent = existingAgent; const createdAgent = false;
    const createdTools = !agent.tools; agent.tools = agent.tools && typeof agent.tools === 'object' ? agent.tools : {};
    if (Array.isArray(agent.tools.allow)) throw new Error('stewardship requires an additive OpenClaw agent tool policy');
    const createdAlsoAllow = !Array.isArray(agent.tools.alsoAllow);
    agent.tools.alsoAllow = Array.isArray(agent.tools.alsoAllow) ? agent.tools.alsoAllow : [];
    if (!agentToolGrantByJarvos) agentToolGrantByJarvos = { agentId: targetAgentId, added: !agent.tools.alsoAllow.includes('jarvos_stewardship_answer'), createdAgent, createdTools, createdAlsoAllow };
    if (!agent.tools.alsoAllow.includes('jarvos_stewardship_answer')) agent.tools.alsoAllow.push('jarvos_stewardship_answer');
  }
  plugins.entries = plugins.entries && typeof plugins.entries === 'object' ? plugins.entries : {};
  const entry = plugins.entries['jarvos-stewardship'] || {};
  plugins.entries['jarvos-stewardship'] = { ...entry, enabled: true, config: { ...(entry.config || {}), mappingRoot, toolAllowAddedByJarvos, ...(agentToolGrantByJarvos ? { agentToolGrantByJarvos } : {}) }, hooks: { ...(entry.hooks || {}), allowPromptInjection: true } };
}
const next = `${JSON.stringify(config, null, 2)}\n`;
const nextBytes = Buffer.from(next, 'utf8');
const changed = !prior.exists || !prior.bytes.equals(nextBytes);
if (changed) {
  const mode = prior.exists ? prior.mode : 0o600;
  if (prior.exists) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '');
    const backupPath = `${configPath}.bak-jarvos-stewardship-${stamp}-${process.pid}`;
    rejectSymlink(backupPath, 'OpenClaw configuration backup');
    fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, prior.mode);
  }
  atomicReplace(configPath, nextBytes, mode, prior);
}

async function verifyRegistration() {
  const { verifyOpenClawPluginRegistration } = require(runtimeKitPath);
  const validationEnv = { ...process.env };
  const defaultConfigPath = path.join(process.env.HOME || os.homedir(), '.openclaw', 'openclaw.json');
  if (path.resolve(configPath) === path.resolve(defaultConfigPath) && !process.env.OPENCLAW_CONFIG_PATH) {
    delete validationEnv.OPENCLAW_CONFIG_PATH;
  } else {
    validationEnv.OPENCLAW_CONFIG_PATH = configPath;
  }
  return verifyOpenClawPluginRegistration({
    executable: 'openclaw',
    pluginId: 'jarvos-stewardship',
    pluginPath,
    timeoutMs: 30000,
    env: validationEnv,
  });
}

(async () => {
  if (rollback === '1' || !pluginPath) return;
  let verification;
  try {
    verification = await verifyRegistration();
  } catch {
    verification = { status: 'compatibility', reason: 'verification-failed' };
  }
  if (verification.status === 'ok') return;
  if (!changed) throw new Error(`staged OpenClaw plugin registration verification failed: ${verification.reason}`);
  const written = { exists: true, bytes: nextBytes, mode: prior.exists ? prior.mode : 0o600 };
  try {
    restorePrior(configPath, prior, written);
  } catch (error) {
    if (/manual reconciliation/i.test(error.message)) throw error;
    throw new Error('staged OpenClaw plugin registration verification failed and rollback could not be completed');
  }
  throw new Error(`staged OpenClaw plugin registration verification failed; prior configuration restored: ${verification.reason}`);
})().catch((error) => {
  process.stderr.write(`${error.message || 'OpenClaw setup failed'}\n`);
  process.exitCode = 1;
});
NODE
  if [ "${JARVOS_MANAGED_HARNESS_ROLLBACK:-0}" = "1" ]; then
    echo "Removed only the stable jarvOS OpenClaw stewardship plugin configuration."
  else
    echo "Installed the stable jarvOS OpenClaw stewardship plugin configuration."
  fi
  exit 0
fi

echo "┌──────────────────────────────────────────────────┐"
echo "│          jarvOS — OpenClaw Setup                 │"
echo "│    Personal AI Operating System                  │"
echo "└──────────────────────────────────────────────────┘"
echo ""
echo "  Source:     $REPO_ROOT"
echo "  Workspace:  $WORKSPACE"
echo ""
echo "  i Managed-launcher activation requires explicit managed repository roots and a staged private runtime tuple."
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
  set +e
  node "$DETECT_VAULT" --runtime=openclaw
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
