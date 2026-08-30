#!/usr/bin/env node
/**
 * jarvOS Bootstrap CLI
 * Usage: npx jarvos-bootstrap  OR  node bootstrap.js
 *
 * Guides a new user through setting up a portable jarvOS workspace.
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// ─── Helpers ────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET}  ${msg}`); }
function err(msg)  { console.log(`${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}→${RESET} ${msg}`); }
function hdr(msg)  { console.log(`\n${BOLD}${msg}${RESET}`); }

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// jarvos.config.json paths.* must be runtime-effective: the config resolver
// ignores relative values and silently falls back to the home-directory
// defaults, so anchor them here instead of writing a path nothing will use.
function absolutePath(p) {
  return path.resolve(expandHome(p));
}

function isValidIanaTimezone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: value }); return true; } catch { return false; }
}

function resolvePathInput(value, fallback) {
  const selected = value || fallback;
  return path.resolve(expandHome(selected));
}

function requirePathOptionValue(flag, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.startsWith('-')) {
    throw new Error(`${flag} requires a non-empty path value`);
  }
  return value;
}

function explicitEnvironmentPath(env, name) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return undefined;
  return requirePathOptionValue(name, env[name]);
}

function parseBootstrapPathOptions(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace') {
      options.workspace = requirePathOptionValue(arg, argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = requirePathOptionValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--vault') {
      options.vault = requirePathOptionValue(arg, argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--vault=')) {
      options.vault = requirePathOptionValue('--vault', arg.slice('--vault='.length));
    } else if (arg === '--use-existing-vault') {
      options.useExistingVault = true;
    }
  }
  return options;
}

function resolvedPathInputs(argv = process.argv.slice(2), env = process.env) {
  const options = parseBootstrapPathOptions(argv);
  const homeDir = os.homedir();
  const environmentWorkspace = explicitEnvironmentPath(env, 'JARVOS_WORKSPACE_PATH');
  const environmentVault = explicitEnvironmentPath(env, 'JARVOS_VAULT_PATH');
  const workspaceSource = options.workspace
    ? '--workspace'
    : environmentWorkspace !== undefined
      ? 'JARVOS_WORKSPACE_PATH'
      : 'default';
  const vaultSource = options.vault
    ? '--vault'
    : environmentVault !== undefined
      ? 'JARVOS_VAULT_PATH'
      : 'default';
  return {
    workspace: resolvePathInput(
      options.workspace || environmentWorkspace,
      path.join(homeDir, 'clawd'),
    ),
    vault: resolvePathInput(
      options.vault || environmentVault,
      path.join(homeDir, 'jarvos-vault'),
    ),
    workspaceSource,
    vaultSource,
    useExistingVault: Boolean(options.useExistingVault),
  };
}

function inspectTarget(target) {
  const pathInspection = inspectPathComponents(target);
  if (!pathInspection.ok) {
    return { state: 'symlinked-path', path: pathInspection.path };
  }
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return { state: 'not-directory' };
    return { state: fs.readdirSync(target).length === 0 ? 'empty-directory' : 'non-empty-directory' };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: error && error.message };
  }
}

const MACOS_SYSTEM_PARENT_ALIASES = new Map([
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
]);

function isAllowedMacOSSystemParentAlias(component, target) {
  if (process.platform !== 'darwin' || component === target) return false;
  const expectedRealPath = MACOS_SYSTEM_PARENT_ALIASES.get(component);
  if (!expectedRealPath) return false;
  try {
    return fs.realpathSync(component) === expectedRealPath;
  } catch {
    return false;
  }
}

function inspectPathComponents(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  let missingAncestor = false;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (missingAncestor) continue;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() && !isAllowedMacOSSystemParentAlias(current, absolute)) {
        return { ok: false, path: current };
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        missingAncestor = true;
        continue;
      }
      return { ok: false, path: current };
    }
  }
  return { ok: true };
}

function assertPathComponentsSafe(target, label) {
  const inspection = inspectPathComponents(target);
  if (!inspection.ok) throw new Error(`${label} is symlinked or unreadable at ${inspection.path}`);
}

function ensureDirectoryPathSafe(directory, label) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) {
      if (!isAllowedMacOSSystemParentAlias(current, absolute)) throw new Error(`${label} is symlinked at ${current}`);
      stat = fs.statSync(current);
    }
    if (!stat.isDirectory()) throw new Error(`${label} has a non-directory component at ${current}`);
    assertPathComponentsSafe(absolute, label);
  }
}

function writeFileExclusiveSafe(destination, content) {
  const parent = path.dirname(destination);
  assertPathComponentsSafe(parent, 'Bootstrap file parent');
  const temporary = path.join(parent, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    temporaryCreated = true;
    assertPathComponentsSafe(parent, 'Bootstrap file parent');
    // An exclusive hard link neither follows nor replaces the final directory
    // entry. If a parent is swapped after the temporary file is created, the
    // unpredictable source name is absent in the replacement tree and linking
    // fails without writing the destination.
    fs.linkSync(temporary, destination);
    fs.unlinkSync(temporary);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

function resolveConfigPath(value, workspace) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const expanded = expandHome(value);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(workspace, expanded));
}

function sameExistingPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return left === right;
  }
}

function isCompatibleExistingInstall(workspace, vault) {
  const configPath = path.join(workspace, 'jarvos.config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { compatible: false, reason: 'jarvos.config.json is missing or invalid' };
  }

  const requiredConfigFields = ['assistantName', 'userName', 'coachName', 'runtime'];
  if (requiredConfigFields.some((field) => typeof config[field] !== 'string' || !config[field].trim())) {
    return { compatible: false, reason: 'jarvos.config.json is not a complete bootstrap configuration' };
  }
  if (!sameExistingPath(resolveConfigPath(config.workspacePath, process.cwd()), workspace)
    || !sameExistingPath(resolveConfigPath(config.vaultPath, process.cwd()), vault)) {
    return { compatible: false, reason: 'jarvos.config.json targets different workspace or vault paths' };
  }

  const requiredWorkspaceFiles = [
    'AGENTS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'MEMORY.md',
    'USER.md', 'ONTOLOGY.md', 'SOUL.md', 'TOOLS.md', 'jarvos.config.json',
  ];
  if (requiredWorkspaceFiles.some((file) => !fs.statSync(path.join(workspace, file), { throwIfNoEntry: false })?.isFile())) {
    return { compatible: false, reason: 'required bootstrap workspace files are missing' };
  }
  if (!fs.statSync(path.join(workspace, 'memory'), { throwIfNoEntry: false })?.isDirectory()) {
    return { compatible: false, reason: 'required bootstrap memory directory is missing' };
  }
  const requiredVaultDirectories = ['Notes', 'Journal', 'Tags'];
  if (requiredVaultDirectories.some((dir) => !fs.statSync(path.join(vault, dir), { throwIfNoEntry: false })?.isDirectory())) {
    return { compatible: false, reason: 'required bootstrap vault directories are missing' };
  }
  return { compatible: true };
}

function isExistingVaultAttachable(vault) {
  const requiredVaultDirectories = ['Notes', 'Journal', 'Tags'];
  return requiredVaultDirectories.every((dir) => fs.lstatSync(path.join(vault, dir), { throwIfNoEntry: false })?.isDirectory());
}

function classifyInitTargets({ workspace, vault, useExistingVault = false }) {
  const workspaceTarget = inspectTarget(workspace);
  const vaultTarget = inspectTarget(vault);

  // A compatible installed tree is read-only on this code path. Recognize it
  // before rejecting an alias in its path; otherwise a normal synced/iCloud
  // location cannot be safely inspected or re-run at all. Any non-compatible
  // symlinked target still refuses before a write.
  if (['non-empty-directory', 'symlinked-path'].includes(workspaceTarget.state)
    && isCompatibleExistingInstall(workspace, vault).compatible) {
    return { action: 'already-initialized' };
  }
  const badTarget = [
    ['workspace', workspaceTarget],
    ['vault', vaultTarget],
  ].find(([, target]) => ['not-directory', 'unreadable', 'symlinked-path'].includes(target.state));
  if (badTarget) {
    return {
      action: 'refuse',
      reason: `${badTarget[0]} target is ${badTarget[1].state.replaceAll('-', ' ')}`,
    };
  }

  if (workspaceTarget.state === 'non-empty-directory') {
    const compatibility = isCompatibleExistingInstall(workspace, vault);
    if (compatibility.compatible) return { action: 'already-initialized' };
    return {
      action: 'refuse',
      reason: `workspace already exists and is not a compatible jarvOS install (${compatibility.reason})`,
    };
  }

  if (vaultTarget.state === 'non-empty-directory') {
    if (useExistingVault && ['absent', 'empty-directory'].includes(workspaceTarget.state) && isExistingVaultAttachable(vault)) {
      return { action: 'attach-existing-vault' };
    }
    return {
      action: 'refuse',
      reason: useExistingVault
        ? 'existing vault is missing required Notes/, Journal/, or Tags/ directories'
        : 'vault already exists; pass --use-existing-vault only to attach a vault with Notes/, Journal/, and Tags/',
    };
  }
  return { action: 'new-install' };
}

function preflightInit(config, inputs) {
  if (!isValidIanaTimezone(config.TIMEZONE)) {
    throw new Error(`Refusing to initialize: TIMEZONE must be a valid IANA timezone (received ${JSON.stringify(config.TIMEZONE)})`);
  }
  const classification = classifyInitTargets({
    workspace: config.WORKSPACE_PATH,
    vault: config.VAULT_PATH,
    useExistingVault: inputs.useExistingVault,
  });
  console.log(`Resolved workspace: ${config.WORKSPACE_PATH} (${inputs.workspaceSource})`);
  console.log(`Resolved vault:     ${config.VAULT_PATH} (${inputs.vaultSource})`);
  console.log(`Intended action:    ${classification.action}`);
  if (classification.action === 'refuse') {
    throw new Error(`Refusing to initialize: ${classification.reason}. Use \`jarvos init --use-existing-vault\` for a new/empty workspace with a verified existing vault, or use \`jarvos sync\` only for a harness workspace that is already installed. Otherwise choose empty/new --workspace and --vault targets.`);
  }
  return classification;
}

// ─── Dependency checks ──────────────────────────────────────────────────────

function checkDeps() {
  hdr('1/5  Checking dependencies');

  const checks = [
    {
      name: 'Node.js ≥ 18',
      test: () => {
        const [major] = process.versions.node.split('.').map(Number);
        return major >= 18;
      },
      hint: 'Install Node.js 18+ from https://nodejs.org'
    }
  ];

  // Optional but noted
  const optionals = [
    {
      name: 'OpenClaw CLI (openclaw)',
      test: () => {
        const r = spawnSync('openclaw', ['--version'], { encoding: 'utf8' });
        return r.status === 0;
      },
      hint: 'Install with: npm install -g openclaw  (see https://openclaw.ai)'
    },
    {
      name: 'git',
      test: () => spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
    },
    {
      name: 'npx',
      test: () => spawnSync('npx', ['--version'], { encoding: 'utf8' }).status === 0
    }
  ];

  let allOk = true;
  for (const c of checks) {
    try {
      if (c.test()) {
        ok(c.name);
      } else {
        err(`${c.name} — not found or wrong version`);
        info(c.hint);
        allOk = false;
      }
    } catch {
      err(`${c.name} — check failed`);
      if (c.hint) info(c.hint);
      allOk = false;
    }
  }

  for (const c of optionals) {
    try {
      if (c.test()) {
        ok(`${c.name} (optional)`);
      } else {
        warn(`${c.name} not found (optional)`);
        if (c.hint) info(c.hint);
      }
    } catch {
      warn(`${c.name} not found (optional)`);
      if (c.hint) info(c.hint);
    }
  }

  return allOk;
}

// ─── Prompt for config ──────────────────────────────────────────────────────

/**
 * Build config from env vars / flags without prompting.
 * Useful for CI and smoke tests.
 * Set JARVOS_YES=1 (or pass --yes) to skip prompts entirely.
 * Override individual fields with JARVOS_ASSISTANT_NAME, JARVOS_USER_NAME, etc.
 */
function nonInteractiveConfig(argv = process.argv.slice(2), env = process.env) {
  // Detect local timezone (e.g. "America/New_York")
  let tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}

  const paths = resolvedPathInputs(argv, env);
  const defaults = {
    ASSISTANT_NAME: env.JARVOS_ASSISTANT_NAME || 'Jarvis',
    USER_NAME:      env.JARVOS_USER_NAME      || os.userInfo().username,
    COACH_NAME:     env.JARVOS_COACH_NAME     || 'jarvOS',
    TIMEZONE:       env.JARVOS_TIMEZONE       || tz,
    VAULT_PATH:     paths.vault,
    WORKSPACE_PATH: paths.workspace,
    RUNTIME:        env.JARVOS_RUNTIME        || 'openclaw'
  };
  return defaults;
}

async function gatherConfig(rl, argv = process.argv.slice(2), env = process.env) {
  hdr('2/5  Configure your jarvOS instance');

  // Non-interactive mode: --yes / -y / --non-interactive flag or JARVOS_YES env var
  const isYes =
    argv.includes('--yes') ||
    argv.includes('-y') ||
    argv.includes('--non-interactive') ||
    env.JARVOS_YES === '1';
  if (isYes) {
    const cfg = nonInteractiveConfig(argv, env);
    info('Non-interactive mode — using defaults / env vars');
    info(`  ASSISTANT_NAME:  ${cfg.ASSISTANT_NAME}`);
    info(`  USER_NAME:       ${cfg.USER_NAME}`);
    info(`  COACH_NAME:      ${cfg.COACH_NAME}`);
    info(`  TIMEZONE:        ${cfg.TIMEZONE}`);
    info(`  VAULT_PATH:      ${cfg.VAULT_PATH}`);
    info(`  WORKSPACE_PATH:  ${cfg.WORKSPACE_PATH}`);
    info(`  RUNTIME:         ${cfg.RUNTIME}`);
    return cfg;
  }

  const defaults = nonInteractiveConfig(argv, env);

  console.log('\nPress Enter to accept the default shown in brackets.\n');

  const answers = {};
  const fields = [
    ['ASSISTANT_NAME', `Assistant name [${defaults.ASSISTANT_NAME}]: `],
    ['USER_NAME',      `Your name [${defaults.USER_NAME}]: `],
    ['COACH_NAME',     `Coach/operator name [${defaults.COACH_NAME}]: `],
    ['TIMEZONE',       `Your timezone [${defaults.TIMEZONE}]: `],
    ['VAULT_PATH',     `Vault path (Obsidian or notes folder) [${defaults.VAULT_PATH}]: `],
    ['WORKSPACE_PATH', `OpenClaw workspace path [${defaults.WORKSPACE_PATH}]: `],
    ['RUNTIME',        `Runtime (e.g. openclaw) [${defaults.RUNTIME}]: `]
  ];

  for (const [key, prompt] of fields) {
    const raw = await ask(rl, prompt);
    answers[key] = (raw || '').trim() || defaults[key];
  }

  return {
    ASSISTANT_NAME:  answers.ASSISTANT_NAME,
    USER_NAME:       answers.USER_NAME,
    COACH_NAME:      answers.COACH_NAME,
    TIMEZONE:        answers.TIMEZONE,
    VAULT_PATH:      absolutePath(answers.VAULT_PATH),
    WORKSPACE_PATH:  absolutePath(answers.WORKSPACE_PATH),
    RUNTIME:         answers.RUNTIME
  };
}

// ─── Create directory structure ─────────────────────────────────────────────

function createDirectories(config) {
  hdr('3/5  Creating directory structure');

  const dirs = [
    path.join(config.VAULT_PATH, 'Notes'),
    path.join(config.VAULT_PATH, 'Journal'),
    path.join(config.VAULT_PATH, 'Tags'),
    path.join(config.WORKSPACE_PATH, 'memory')
  ];

  for (const d of dirs) {
    ensureDirectoryPathSafe(d, 'Bootstrap directory target');
    ok(d);
  }
}

// ─── Generate overlay files from templates ──────────────────────────────────

function renderTemplate(src, config) {
  let content = fs.readFileSync(src, 'utf8');
  // Strip HTML comment headers (template version lines)
  content = content.replace(/^<!--.*?-->\n/s, '');
  for (const [key, val] of Object.entries(config)) {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    content = content.replace(re, val);
  }
  return content;
}

const TEMPLATE_DIR = path.join(__dirname, 'templates');

function generateOverlays(config) {
  hdr('4/5  Generating starter overlay files');

  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-');

  // Destination paths
  const ws = config.WORKSPACE_PATH;

  const overlays = [
    {
      template: path.join(TEMPLATE_DIR, 'AGENTS-template.md'),
      dest: path.join(ws, 'AGENTS.md'),
      label: 'AGENTS.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'BOOTSTRAP-template.md'),
      dest: path.join(ws, 'BOOTSTRAP.md'),
      label: 'BOOTSTRAP.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'HEARTBEAT-template.md'),
      dest: path.join(ws, 'HEARTBEAT.md'),
      label: 'HEARTBEAT.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'USER.template.md'),
      dest: path.join(ws, 'USER.md'),
      label: 'USER.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'ONTOLOGY.template.md'),
      dest: path.join(ws, 'ONTOLOGY.md'),
      label: 'ONTOLOGY.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'SOUL.template.md'),
      dest: path.join(ws, 'SOUL.md'),
      label: 'SOUL.md'
    },
    {
      template: path.join(TEMPLATE_DIR, 'TOOLS.template.md'),
      dest: path.join(ws, 'TOOLS.md'),
      label: 'TOOLS.md'
    }
  ];

  for (const o of overlays) {
    if (!fs.existsSync(o.template)) {
      warn(`Template not found: ${o.template} — skipping`);
      continue;
    }
    const dest = o.dest;
    if (fs.existsSync(dest)) {
      warn(`${o.label} already exists at ${dest} — skipping (delete to regenerate)`);
      continue;
    }
    try {
      const rendered = renderTemplate(o.template, config);
      writeFileExclusiveSafe(dest, rendered);
      ok(`${o.label} → ${dest}`);
    } catch (e) {
      err(`Failed to write ${o.label}: ${e.message}`);
    }
  }

  // MEMORY.md
  const memoryPath = path.join(ws, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) {
    const memContent = `# Long-Term Memory

## Identity
- I am ${config.ASSISTANT_NAME}, personal AI assistant for ${config.USER_NAME}
- Configured by ${config.COACH_NAME} via jarvOS

## Key Learnings
*(Will grow over time)*

## Important Context
*(Will grow over time)*
`;
    writeFileExclusiveSafe(memoryPath, memContent);
    ok(`MEMORY.md → ${memoryPath}`);
  } else {
    warn(`MEMORY.md already exists — skipping`);
  }

  // Daily memory file
  const memDir = path.join(ws, 'memory');
  const dailyPath = path.join(memDir, `${today}.md`);
  if (!fs.existsSync(dailyPath)) {
    const dailyContent = `# Memory - ${today}

## First Run
- Bootstrap completed
- Identity: ${config.ASSISTANT_NAME} for ${config.USER_NAME}
- Coach: ${config.COACH_NAME}
`;
    writeFileExclusiveSafe(dailyPath, dailyContent);
    ok(`memory/${today}.md → ${dailyPath}`);
  }

  // jarvos.config.json (only if not already present)
  const configPath = path.join(ws, 'jarvos.config.json');
  if (!fs.existsSync(configPath)) {
    const jarvosConfig = {
      assistantName: config.ASSISTANT_NAME,
      userName: config.USER_NAME,
      coachName: config.COACH_NAME,
      vaultPath: config.VAULT_PATH,
      workspacePath: config.WORKSPACE_PATH,
      runtime: config.RUNTIME,
      paths: {
        workspace: config.WORKSPACE_PATH,
        vault: config.VAULT_PATH,
        notes: path.join(config.VAULT_PATH, 'Notes'),
        journal: path.join(config.VAULT_PATH, 'Journal'),
        tags: path.join(config.VAULT_PATH, 'Tags'),
        memory: path.join(config.WORKSPACE_PATH, 'memory'),
        scripts: path.join(config.WORKSPACE_PATH, 'scripts'),
        workflows: path.join(config.WORKSPACE_PATH, 'workflows'),
        customers: path.join(config.WORKSPACE_PATH, 'customers')
      },
      user: {
        name: config.USER_NAME,
        timezone: config.TIMEZONE
      }
    };
    writeFileExclusiveSafe(configPath, JSON.stringify(jarvosConfig, null, 2) + '\n');
    ok(`jarvos.config.json → ${configPath}`);
  } else {
    warn(`jarvos.config.json already exists — skipping`);
  }
}

// ─── Smoke test ─────────────────────────────────────────────────────────────

function smokeTest(config) {
  hdr('5/5  Smoke test');

  const ws = config.WORKSPACE_PATH;
  const requiredFiles = ['AGENTS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'MEMORY.md', 'USER.md', 'ONTOLOGY.md', 'SOUL.md', 'TOOLS.md', 'jarvos.config.json'];
  const requiredDirs  = [
    path.join(config.VAULT_PATH, 'Notes'),
    path.join(config.VAULT_PATH, 'Journal'),
    path.join(config.VAULT_PATH, 'Tags'),
    path.join(ws, 'memory')
  ];

  let passed = 0;
  let failed = 0;

  for (const f of requiredFiles) {
    const p = path.join(ws, f);
    if (fs.lstatSync(p, { throwIfNoEntry: false })?.isFile()) { ok(`${f} present`); passed++; }
    else { err(`${f} missing at ${p}`); failed++; }
  }

  for (const d of requiredDirs) {
    if (fs.lstatSync(d, { throwIfNoEntry: false })?.isDirectory()) {
      ok(`dir: ${d}`);
      passed++;
    } else {
      err(`dir missing: ${d}`);
      failed++;
    }
  }

  // Template substitution check — no raw {{placeholders}} left
  const templateFiles = ['AGENTS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'USER.md', 'ONTOLOGY.md', 'SOUL.md', 'TOOLS.md'];
  for (const f of templateFiles) {
    const p = path.join(ws, f);
    if (!fs.lstatSync(p, { throwIfNoEntry: false })?.isFile()) continue;
    const content = fs.readFileSync(p, 'utf8');
    const remaining = content.match(/\{\{[A-Z_]+\}\}/g);
    if (remaining) {
      err(`${f} still has unreplaced placeholders: ${[...new Set(remaining)].join(', ')}`);
      failed++;
    } else {
      ok(`${f} — no unreplaced placeholders`);
      passed++;
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All checks passed (${passed}/${passed + failed}).${RESET}`);
  } else {
    console.log(`${YELLOW}${BOLD}${passed} passed, ${failed} failed.${RESET}`);
    console.log('Review errors above and inspect or use fresh targets; do not re-run over a partial install.');
  }

  return failed === 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════╗`);
  console.log(`║      jarvOS Bootstrap Installer      ║`);
  console.log(`╚══════════════════════════════════════╝${RESET}\n`);
  console.log('This script sets up a portable jarvOS workspace for your selected runtime.');
  console.log('It will create the workspace file structure and generate starter overlay files.\n');

  const depsOk = checkDeps();
  if (!depsOk) {
    console.log(`\n${RED}Required dependencies are missing. Please install them and re-run.${RESET}\n`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let config;
  let pathInputs;
  try {
    pathInputs = resolvedPathInputs();
  } catch (error) {
    err(error.message);
    process.exit(1);
  }
  try {
    config = await gatherConfig(rl);
  } finally {
    rl.close();
  }

  let preflight;
  try {
    preflight = preflightInit(config, {
      workspaceSource: config.WORKSPACE_PATH === pathInputs.workspace
        ? pathInputs.workspaceSource
        : 'interactive prompt',
      vaultSource: config.VAULT_PATH === pathInputs.vault
        ? pathInputs.vaultSource
        : 'interactive prompt',
      useExistingVault: pathInputs.useExistingVault,
    });
  } catch (error) {
    err(error.message);
    process.exit(1);
  }

  if (preflight.action === 'new-install' || preflight.action === 'attach-existing-vault') {
    assertPathComponentsSafe(config.WORKSPACE_PATH, 'Workspace write target');
    assertPathComponentsSafe(config.VAULT_PATH, 'Vault write target');
    createDirectories(config);
    assertPathComponentsSafe(config.WORKSPACE_PATH, 'Workspace write target');
    assertPathComponentsSafe(config.VAULT_PATH, 'Vault write target');
    generateOverlays(config);
  } else {
    info('Compatible jarvOS installation detected — preserving all existing files.');
}
  const allPassed = smokeTest(config);

  console.log(`\n${BOLD}Next steps:${RESET}`);
  if (config.RUNTIME === 'openclaw') {
    console.log(`  1. Start OpenClaw:          openclaw gateway start`);
  } else {
    console.log(`  1. Start your runtime (${config.RUNTIME}) and point it at: ${config.WORKSPACE_PATH}`);
  }
  console.log(`  2. Tell your assistant:     "Read BOOTSTRAP.md and follow its instructions"`);
  console.log(`  3. Set up your ontology:    Edit ONTOLOGY.md with your mission and goals`);
  console.log(`  4. Create your first project: Board.md + Brief.md under a Portfolio folder`);
  console.log(`\nDocs: https://github.com/levineam/jarvOS\n`);

  process.exit(allPassed ? 0 : 1);
}

main().catch(e => {
  err(`Unexpected error: ${e.message}`);
  process.exit(1);
});
