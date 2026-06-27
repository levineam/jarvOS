#!/usr/bin/env node
/**
 * Shared jarvOS configuration resolver.
 *
 * Resolution order:
 *   1. explicit options / environment variables
 *   2. jarvos.config.json from CLAWD_DIR / workspace
 *   3. XDG config file if present
 *   4. homedir-relative defaults
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_USER_NAME = 'Andrew';

const PATH_ENV_KEYS = {
  workspace: ['JARVOS_WORKSPACE_DIR', 'JARVOS_CLAWD_DIR', 'CLAWD_DIR'],
  vault: ['JARVOS_VAULT_DIR'],
  notes: ['JARVOS_NOTES_DIR', 'VAULT_NOTES_DIR'],
  journal: ['JARVOS_JOURNAL_DIR', 'JOURNAL_DIR'],
  memory: ['JARVOS_MEMORY_DIR'],
  scripts: ['JARVOS_SCRIPTS_DIR'],
  workflows: ['JARVOS_WORKFLOWS_DIR'],
  customers: ['JARVOS_CUSTOMERS_DIR'],
  tags: ['JARVOS_TAGS_DIR'],
};

function homeDir(options = {}) {
  return options.homeDir || options.env?.HOME || os.homedir();
}

function expandTilde(value, home) {
  if (typeof value !== 'string') return value;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function defaultPaths(home) {
  const workspace = path.join(home, 'clawd');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  return {
    workspace,
    vault,
    notes: path.join(vault, 'Notes'),
    journal: path.join(vault, 'Journal'),
    memory: path.join(workspace, 'memory'),
    scripts: path.join(workspace, 'scripts'),
    workflows: path.join(workspace, 'workflows'),
    customers: path.join(workspace, 'customers'),
    tags: path.join(vault, 'Tags'),
  };
}

function isUsablePath(value, home) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return path.isAbsolute(expandTilde(value.trim(), home));
}

function normalizePathMap(rawPaths = {}, home) {
  const paths = {};
  for (const [key, value] of Object.entries(rawPaths || {})) {
    if (!isUsablePath(value, home)) continue;
    paths[key] = expandTilde(value.trim(), home);
  }
  return paths;
}

function firstEnvPath(keys = [], env = process.env, home = os.homedir()) {
  for (const key of keys) {
    if (isUsablePath(env[key], home)) return expandTilde(env[key].trim(), home);
  }
  return null;
}

function xdgConfigPath(env = process.env, home = os.homedir()) {
  const configHome = isUsablePath(env.XDG_CONFIG_HOME, home)
    ? expandTilde(env.XDG_CONFIG_HOME.trim(), home)
    : path.join(home, '.config');
  return path.join(configHome, 'jarvos', 'config.json');
}

function discoverConfigPath(options = {}) {
  const env = options.env || process.env;
  const home = homeDir(options);
  const explicit = options.configPath || env.JARVOS_CONFIG_PATH || env.JARVOS_CONFIG_FILE;
  if (isUsablePath(explicit, home)) return expandTilde(explicit.trim(), home);

  const workspace = options.workspaceRoot || firstEnvPath(PATH_ENV_KEYS.workspace, env, home);
  if (isUsablePath(workspace, home)) return path.join(expandTilde(workspace, home), 'jarvos.config.json');

  const xdgPath = xdgConfigPath(env, home);
  if (fs.existsSync(xdgPath)) return xdgPath;

  return path.join(defaultPaths(home).workspace, 'jarvos.config.json');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function validTimezone(value) {
  if (!value) return DEFAULT_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return value;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function resolveUserTimezone(rest = {}, env = process.env) {
  return validTimezone(
    env.JARVOS_TIMEZONE
    || rest.user?.timezone
    || rest.user?.timeZone
    || rest.timezone
    || rest.timeZone
    || env.TZ,
  );
}

// --- Vault-drift guardrails (SUP-1307 / SUP-1884) ---------------------------
// The active vault migrated from ~/Documents/Vault v3 to ~/Vaults/Vault v3.
// These guards restore the "target the active vault or fail closed" intent for
// the runtime resolver, and add an opt-in canonical assertion that catches the
// case where a sandboxed runtime resolves `~` against an unexpected $HOME.
const CANONICAL_VAULT_SEGMENTS = ['Vaults', 'Vault v3'];
const STALE_VAULT_SEGMENTS = ['Documents', 'Vault v3'];

function canonicalVaultDir(home) {
  return path.join(home, ...CANONICAL_VAULT_SEGMENTS);
}

function isSameOrSubPath(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function readCanonicalVaultHintFromDoNotUse(markerPath, home) {
  let body;
  try {
    body = fs.readFileSync(markerPath, 'utf8');
  } catch {
    return null;
  }
  const match = body.match(/((?:~\/|\/)[^\n]*Vault v\d[^\n]*)/);
  if (!match) return null;
  return expandTilde(match[1].trim(), home);
}

// Throw when a Documents-based vault is explicitly selected while a healthy
// canonical vault (or a DO_NOT_USE hint) exists. A bare home-default never
// throws, so fresh installs that have neither location are unaffected.
function assertNotStaleVaultPath(value, { home = os.homedir(), source = 'unknown' } = {}) {
  if (!value) return;
  const staleVault = path.join(home, ...STALE_VAULT_SEGMENTS);
  if (!isSameOrSubPath(staleVault, value)) return;

  const markerCandidates = [
    path.join(staleVault, 'DO_NOT_USE.txt'),
    path.join(home, 'Documents', 'REDACTED-Vault v3', 'DO_NOT_USE.txt'),
  ];
  let hinted = null;
  for (const marker of markerCandidates) {
    hinted = readCanonicalVaultHintFromDoNotUse(marker, home);
    if (hinted) break;
  }
  const canonical = canonicalVaultDir(home);
  const canonicalExists = fs.existsSync(canonical);

  if (source !== 'default' && (canonicalExists || hinted)) {
    const reason = hinted ? 'DO_NOT_USE marker present' : 'canonical vault exists';
    const recommendation = canonicalExists ? canonical : hinted;
    throw new Error(
      `Refusing to use stale vault path under ~/Documents/Vault v3 (${reason}; source: ${source}). `
      + `Repoint to ${recommendation} via JARVOS_VAULT_DIR or jarvos.config.json paths.vault.`,
    );
  }
}

// Resolve the host-pinned canonical vault root, if the host opted in.
// JARVOS_REQUIRE_CANONICAL_VAULT may be an absolute path (or ~/-path), or a
// truthy flag ("1"/"true") meaning "the canonical ~/Vaults/Vault v3 under $HOME".
function requiredCanonicalVaultRoot(env, home) {
  const raw = env.JARVOS_REQUIRE_CANONICAL_VAULT;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  if (value === '1' || value.toLowerCase() === 'true') return canonicalVaultDir(home);
  const expanded = expandTilde(value, home);
  return path.isAbsolute(expanded) ? expanded : canonicalVaultDir(home);
}

// Fail closed when the resolved vault is outside the host-pinned canonical root.
// This is what catches a sandboxed runtime that resolved `~` against the wrong
// $HOME (e.g. a Codex sandbox home) instead of silently writing to a dead vault.
function assertWithinRequiredVault(vaultPath, requiredRoot, source) {
  if (!requiredRoot || !vaultPath) return;
  if (isSameOrSubPath(requiredRoot, vaultPath)) return;
  throw new Error(
    `Resolved vault path "${vaultPath}" is outside the required canonical vault "${requiredRoot}" `
    + `(source: ${source}). This usually means the process is running with an unexpected $HOME `
    + `(e.g. a sandboxed runtime). Pin JARVOS_VAULT_DIR to an absolute path or correct $HOME.`,
  );
}
// ---------------------------------------------------------------------------

function resolveConfig(options = {}) {
  const env = options.env || process.env;
  const home = homeDir(options);
  const configPath = discoverConfigPath({ ...options, env, homeDir: home });
  const raw = readJsonFile(configPath);
  const { $schema: _schema, ...rest } = raw && typeof raw === 'object' ? raw : {};
  const basePaths = defaultPaths(home);
  const configPaths = normalizePathMap(rest.paths, home);
  const envPaths = {};

  for (const [key, keys] of Object.entries(PATH_ENV_KEYS)) {
    const value = firstEnvPath(keys, env, home);
    if (value) envPaths[key] = value;
  }

  if (isUsablePath(options.workspaceRoot, home)) {
    envPaths.workspace = expandTilde(options.workspaceRoot, home);
  }

  const paths = {
    ...basePaths,
    ...configPaths,
    ...envPaths,
  };

  const hasVaultOverride = Boolean(configPaths.vault || envPaths.vault);
  if (hasVaultOverride) {
    if (!configPaths.notes && !envPaths.notes) paths.notes = path.join(paths.vault, 'Notes');
    if (!configPaths.journal && !envPaths.journal) paths.journal = path.join(paths.vault, 'Journal');
    if (!configPaths.tags && !envPaths.tags) paths.tags = path.join(paths.vault, 'Tags');
  }

  const hasWorkspaceOverride = Boolean(configPaths.workspace || envPaths.workspace);
  if (hasWorkspaceOverride) {
    if (!configPaths.memory && !envPaths.memory) paths.memory = path.join(paths.workspace, 'memory');
    if (!configPaths.scripts && !envPaths.scripts) paths.scripts = path.join(paths.workspace, 'scripts');
    if (!configPaths.workflows && !envPaths.workflows) paths.workflows = path.join(paths.workspace, 'workflows');
    if (!configPaths.customers && !envPaths.customers) paths.customers = path.join(paths.workspace, 'customers');
  }

  // Fail closed on vault drift before returning the resolved config.
  const sourceOf = (key) => (envPaths[key] ? 'env' : (configPaths[key] ? 'config' : 'default'));
  const vaultSource = sourceOf('vault');
  assertNotStaleVaultPath(paths.vault, { home, source: vaultSource });
  assertNotStaleVaultPath(paths.notes, { home, source: sourceOf('notes') });
  assertNotStaleVaultPath(paths.journal, { home, source: sourceOf('journal') });
  assertWithinRequiredVault(paths.vault, requiredCanonicalVaultRoot(env, home), vaultSource);

  const user = {
    name: rest.user?.name || DEFAULT_USER_NAME,
    timezone: resolveUserTimezone(rest, env),
  };

  const config = { paths, user };
  for (const [key, value] of Object.entries(rest)) {
    if (key !== 'paths' && key !== 'user') config[key] = value;
  }

  return config;
}

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_USER_NAME,
  PATH_ENV_KEYS,
  CANONICAL_VAULT_SEGMENTS,
  STALE_VAULT_SEGMENTS,
  canonicalVaultDir,
  assertNotStaleVaultPath,
  assertWithinRequiredVault,
  requiredCanonicalVaultRoot,
  discoverConfigPath,
  expandTilde,
  resolveConfig,
  resolveUserTimezone,
  xdgConfigPath,
};
