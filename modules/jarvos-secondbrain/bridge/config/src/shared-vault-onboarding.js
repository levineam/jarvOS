#!/usr/bin/env node
/**
 * Shared-vault onboarding for new runtimes.
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
    && fs.existsSync(path.join(vaultDir, 'Journal')),
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
    throw new Error(`Shared vault must contain Notes/ and Journal/: ${resolvedVault}`);
  }

  const resolvedWorkspace = asAbsolutePath(workspaceRoot || path.join(homeDir, 'clawd'), homeDir);

  return {
    $schema: './jarvos.config.schema.json',
    paths: {
      workspace: resolvedWorkspace,
      vault: resolvedVault,
      notes: path.join(resolvedVault, 'Notes'),
      journal: path.join(resolvedVault, 'Journal'),
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

function writeSharedVaultConfig({
  configPath,
  vaultDir,
  workspaceRoot,
  homeDir = os.homedir(),
  user,
} = {}) {
  const target = asAbsolutePath(configPath || path.join(process.cwd(), 'jarvos.config.json'), homeDir);
  const config = buildSharedVaultConfig({ vaultDir, workspaceRoot, homeDir, user });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath: target, config };
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
    'Creates a jarvos.config.json that points this runtime at an existing shared vault.',
    'If --vault is omitted, the helper uses ~/Vaults/Vault v3 when it contains Notes/ and Journal/.',
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
  buildSharedVaultConfig,
  discoverExistingVault,
  hasSharedVaultShape,
  writeSharedVaultConfig,
};
