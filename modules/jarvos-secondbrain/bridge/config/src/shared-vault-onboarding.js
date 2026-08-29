#!/usr/bin/env node
/**
 * Sync a new runtime with an existing jarvOS installation.
 *
 * A runtime such as Hermes should not need runtime-specific path instructions.
 * Point this helper at an existing vault once; it writes a portable
 * jarvos.config.json that the normal resolveConfig() pipeline can reuse.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { DEFAULT_TIMEZONE, DEFAULT_USER_NAME, expandTilde } = require('./resolve-config');

const DEFAULT_VAULT_CANDIDATES = [
  path.join('~', 'Vaults', 'Vault v3'),
  path.join('~', 'Documents', 'Vault v3'),
];

function asAbsolutePath(value, home) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const expanded = expandTilde(value.trim(), home);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

function hasSharedVaultShape(vaultDir) {
  return Boolean(
    vaultDir
    && fs.existsSync(path.join(vaultDir, 'Notes'))
    && fs.existsSync(path.join(vaultDir, 'Journal'))
    && fs.existsSync(path.join(vaultDir, 'Tags')),
  );
}

function discoverExistingVault({ homeDir = os.homedir(), candidates = DEFAULT_VAULT_CANDIDATES } = {}) {
  const matches = candidates
    .map((candidate) => asAbsolutePath(candidate, homeDir))
    .filter(Boolean)
    .filter(hasSharedVaultShape);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Multiple existing vaults found: ${matches.join(', ')}. Pass --vault explicitly.`);
  }
  return null;
}

function buildSharedVaultConfig({
  vaultDir,
  workspaceRoot,
  homeDir = os.homedir(),
  user = {},
} = {}) {
  const resolvedVault = asAbsolutePath(vaultDir, homeDir);
  if (!resolvedVault) {
    throw new Error('A shared vault path is required. Pass --vault or create ~/Vaults/Vault v3.');
  }
  if (!hasSharedVaultShape(resolvedVault)) {
    throw new Error(`Existing jarvOS vault must contain Notes/, Journal/, and Tags/: ${resolvedVault}`);
  }

  const resolvedWorkspace = asAbsolutePath(workspaceRoot || path.join(homeDir, 'clawd'), homeDir);

  return {
    $schema: 'https://raw.githubusercontent.com/levineam/jarvOS/main/jarvos.config.schema.json',
    paths: {
      workspace: resolvedWorkspace,
      vault: resolvedVault,
      notes: path.join(resolvedVault, 'Notes'),
      journal: path.join(resolvedVault, 'Journal'),
      tags: path.join(resolvedVault, 'Tags'),
      memory: path.join(resolvedWorkspace, 'memory'),
      scripts: path.join(resolvedWorkspace, 'scripts'),
      workflows: path.join(resolvedWorkspace, 'workflows'),
      customers: path.join(resolvedWorkspace, 'customers'),
    },
    user: {
      name: user.name || DEFAULT_USER_NAME,
      timezone: user.timezone || DEFAULT_TIMEZONE,
    },
  };
}

function resolvedConfigPaths(config, homeDir) {
  const configured = config?.paths && typeof config.paths === 'object' ? config.paths : {};
  const workspace = asAbsolutePath(configured.workspace || config?.workspacePath, homeDir);
  const vault = asAbsolutePath(configured.vault || config?.vaultPath, homeDir);
  return {
    workspace,
    vault,
    notes: asAbsolutePath(configured.notes, homeDir) || (vault && path.join(vault, 'Notes')),
    journal: asAbsolutePath(configured.journal, homeDir) || (vault && path.join(vault, 'Journal')),
    tags: asAbsolutePath(configured.tags, homeDir) || (vault && path.join(vault, 'Tags')),
    memory: asAbsolutePath(configured.memory, homeDir) || (workspace && path.join(workspace, 'memory')),
    scripts: asAbsolutePath(configured.scripts, homeDir) || (workspace && path.join(workspace, 'scripts')),
    workflows: asAbsolutePath(configured.workflows, homeDir) || (workspace && path.join(workspace, 'workflows')),
    customers: asAbsolutePath(configured.customers, homeDir) || (workspace && path.join(workspace, 'customers')),
  };
}

function isCompatibleSharedVaultConfig(existing, expected, homeDir = os.homedir()) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  const existingPaths = resolvedConfigPaths(existing, homeDir);
  const expectedPaths = resolvedConfigPaths(expected, homeDir);
  const pathsMatch = Object.keys(expectedPaths).every((key) => existingPaths[key] === expectedPaths[key]);
  const existingName = existing.user?.name || existing.userName;
  const existingTimezone = existing.user?.timezone
    || existing.user?.timeZone
    || existing.timezone
    || existing.timeZone;
  return pathsMatch
    && existingName === expected.user.name
    && existingTimezone === expected.user.timezone;
}

function assessSharedVaultConfigTarget({ configPath, config, homeDir = os.homedir() } = {}) {
  const target = asAbsolutePath(configPath || path.join(process.cwd(), 'jarvos.config.json'), homeDir);
  if (!fs.existsSync(target)) return { action: 'create', configPath: target };

  const targetStat = fs.lstatSync(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlinked config path: ${target}`);
  }
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`Refusing to overwrite an unreadable existing config: ${target} (${error.message})`);
  }
  return {
    action: isCompatibleSharedVaultConfig(existing, config, homeDir) ? 'already-synced' : 'conflict',
    configPath: target,
  };
}

function writeSharedVaultConfig({
  configPath,
  vaultDir,
  workspaceRoot,
  homeDir = os.homedir(),
  user,
} = {}) {
  const target = asAbsolutePath(configPath || path.join(process.cwd(), 'jarvos.config.json'), homeDir);
  const config = buildSharedVaultConfig({ vaultDir, workspaceRoot, homeDir, user });
  const assessment = assessSharedVaultConfigTarget({ configPath: target, config, homeDir });
  if (assessment.action === 'already-synced') {
    return { configPath: target, config, changed: false };
  }
  if (assessment.action === 'conflict') {
    throw new Error(
      `Refusing to overwrite an existing jarvos.config.json: ${target}. `
      + 'Choose a new --config path or reconcile the existing config manually.',
    );
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { configPath: target, config, changed: true };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--vault') {
      options.vaultDir = next;
      index += 1;
    } else if (arg === '--workspace') {
      options.workspaceRoot = next;
      index += 1;
    } else if (arg === '--config') {
      options.configPath = next;
      index += 1;
    } else if (arg === '--name') {
      options.user = { ...(options.user || {}), name: next };
      index += 1;
    } else if (arg === '--timezone') {
      options.user = { ...(options.user || {}), timezone: next };
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: node bridge/config/src/shared-vault-onboarding.js [--vault PATH] [--workspace PATH] [--config PATH] [--dry-run]',
    '',
    'Sync with an existing jarvOS installation by pointing this runtime at its shared vault.',
    'If --vault is omitted, the helper uses ~/Vaults/Vault v3 when it contains Notes/, Journal/, and Tags/.',
    'The helper never writes inside the vault and refuses to replace a different existing config.',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return { ok: true, help: true };
  }

  const homeDir = os.homedir();
  const vaultDir = options.vaultDir || discoverExistingVault({ homeDir });
  if (options.dryRun) {
    const config = buildSharedVaultConfig({ ...options, vaultDir, homeDir });
    console.log(JSON.stringify({ ok: true, action: 'dry-run', paths: config.paths }, null, 2));
    return { ok: true, config };
  }

  const result = writeSharedVaultConfig({ ...options, vaultDir, homeDir });
  console.log(JSON.stringify({
    ok: true,
    configPath: result.configPath,
    vault: result.config.paths.vault,
    notes: result.config.paths.notes,
    journal: result.config.paths.journal,
  }, null, 2));
  return { ok: true, ...result };
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_VAULT_CANDIDATES,
  assessSharedVaultConfigTarget,
  buildSharedVaultConfig,
  discoverExistingVault,
  hasSharedVaultShape,
  isCompatibleSharedVaultConfig,
  writeSharedVaultConfig,
};
