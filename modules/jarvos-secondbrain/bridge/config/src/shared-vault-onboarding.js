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

const {
  DEFAULT_TIMEZONE,
  DEFAULT_USER_NAME,
  assertNotStaleVaultPath,
  expandTilde,
  isValidTimezone,
} = require('./resolve-config');

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

function missingSharedVaultDirectories(vaultDir) {
  return ['Notes', 'Journal', 'Tags'].filter((directory) => !fs.existsSync(path.join(vaultDir, directory)));
}

function hasDoNotUseMarker(vaultDir) {
  return fs.existsSync(path.join(vaultDir, 'DO_NOT_USE.txt'));
}

function discoverExistingVault({ homeDir = os.homedir(), candidates = DEFAULT_VAULT_CANDIDATES } = {}) {
  const matches = candidates
    .map((candidate) => asAbsolutePath(candidate, homeDir))
    .filter(Boolean)
    .filter((candidate) => hasSharedVaultShape(candidate) && !hasDoNotUseMarker(candidate));

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
    const missing = missingSharedVaultDirectories(resolvedVault);
    throw new Error(`Existing jarvOS vault is missing required directories (${missing.join(', ')}): ${resolvedVault}`);
  }
  assertNotStaleVaultPath(resolvedVault, { home: homeDir, source: 'config' });

  const resolvedWorkspace = asAbsolutePath(workspaceRoot || path.join(homeDir, 'clawd'), homeDir);
  const timezone = user.timezone || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) {
    throw new Error('A valid IANA timezone is required (for example, America/New_York or UTC)');
  }

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
      timezone,
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
  // Old bootstrap configs did not record identity metadata.  Their paths are
  // still authoritative; a supplied sync identity is an additive migration,
  // not a conflicting target.
  const nameCompatible = !existingName || existingName === expected.user.name;
  const timezoneCompatible = !existingTimezone || existingTimezone === expected.user.timezone;
  return pathsMatch && nameCompatible && timezoneCompatible;
}

function hasPortableRuntimeConfig(existing, expected, homeDir = os.homedir()) {
  if (!existing?.paths || typeof existing.paths !== 'object' || !existing?.user || typeof existing.user !== 'object') return false;
  const existingPaths = resolvedConfigPaths(existing, homeDir);
  const expectedPaths = resolvedConfigPaths(expected, homeDir);
  return Object.keys(expectedPaths).every((key) => existingPaths[key] === expectedPaths[key]
    && typeof existing.paths[key] === 'string')
    && existing.user.name === expected.user.name
    && existing.user.timezone === expected.user.timezone;
}

function migratedSharedVaultConfig(existing, expected) {
  return {
    ...existing,
    ...expected,
    paths: { ...(existing.paths || {}), ...expected.paths },
    user: { ...(existing.user || {}), ...expected.user },
  };
}

function isSameOrDescendant(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function assertNoSymlinkedConfigPathComponents(target) {
  const parsed = path.parse(target);
  const components = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let missingAncestor = false;

  for (const component of components) {
    current = path.join(current, component);
    if (missingAncestor) continue;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to write through a symlinked config path: ${current}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        missingAncestor = true;
        continue;
      }
      throw error;
    }
  }
}

function canonicalizePathWithMissingTail(target) {
  let existing = target;
  const missingTail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missingTail);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missingTail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function assertConfigTargetOutsideVault(target, vaultDir, homeDir) {
  const vault = asAbsolutePath(vaultDir, homeDir);
  if (!vault) return;

  let canonicalVault;
  try {
    canonicalVault = fs.realpathSync(vault);
  } catch (error) {
    throw new Error(`Refusing to use an unreadable existing vault: ${vault} (${error.message})`);
  }
  let canonicalTarget;
  try {
    canonicalTarget = canonicalizePathWithMissingTail(target);
  } catch (error) {
    throw new Error(`Refusing to inspect an unreadable config path: ${target} (${error.message})`);
  }
  if (isSameOrDescendant(canonicalVault, canonicalTarget)) {
    throw new Error(`Refusing to place jarvos.config.json inside the shared vault: ${target}`);
  }
}

function readSharedVaultConfigTarget({ configPath, homeDir = os.homedir() } = {}) {
  const target = asAbsolutePath(configPath || path.join(process.cwd(), 'jarvos.config.json'), homeDir);
  assertNoSymlinkedConfigPathComponents(target);

  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { configPath: target, config: null };
    throw new Error(`Refusing to inspect an unreadable config path: ${target} (${error.message})`);
  }
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`Refusing to overwrite an unreadable existing config: ${target} (${error.message})`);
  }
  return { configPath: target, config: existing, targetStat };
}

function assessSharedVaultConfigTarget({ configPath, config, vaultDir, homeDir = os.homedir() } = {}) {
  const targetState = readSharedVaultConfigTarget({ configPath, homeDir });
  const target = targetState.configPath;
  const configuredVault = vaultDir || config?.paths?.vault || config?.vaultPath;
  assertConfigTargetOutsideVault(target, configuredVault, homeDir);
  if (!targetState.config) return { action: 'create', configPath: target };

  const compatible = isCompatibleSharedVaultConfig(targetState.config, config, homeDir);
  return {
    action: compatible
      ? (hasPortableRuntimeConfig(targetState.config, config, homeDir) ? 'already-synced' : 'migrate')
      : 'conflict',
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
  const assessment = assessSharedVaultConfigTarget({ configPath: target, config, vaultDir, homeDir });
  if (assessment.action === 'already-synced') {
    return { configPath: target, config, changed: false };
  }
  if (assessment.action === 'conflict') {
    throw new Error(
      `Refusing to overwrite an existing jarvos.config.json: ${target}. `
      + 'Choose a new --config path or reconcile the existing config manually.',
    );
  }

  if (assessment.action === 'migrate') {
    const existing = readSharedVaultConfigTarget({ configPath: target, homeDir }).config;
    const migrated = migratedSharedVaultConfig(existing, config);
    fs.writeFileSync(target, `${JSON.stringify(migrated, null, 2)}\n`, { mode: 0o600 });
    return { configPath: target, config: migrated, changed: true, migrated: true };
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
    const assessment = assessSharedVaultConfigTarget({
      configPath: options.configPath,
      config,
      vaultDir,
      homeDir,
    });
    console.log(JSON.stringify({ ok: true, action: 'dry-run', targetAction: assessment.action, paths: config.paths }, null, 2));
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
  readSharedVaultConfigTarget,
  writeSharedVaultConfig,
};
