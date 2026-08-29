#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'jarvos.js');
const BOOTSTRAP = path.join(ROOT, 'bootstrap.js');

function runInit(args, env) {
  return spawnSync(process.execPath, [CLI, 'init', '--profile', 'minimal', '--yes', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runBootstrap(args, env) {
  return spawnSync(process.execPath, [BOOTSTRAP, '--yes', ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function initEnv(home) {
  return {
    ...process.env,
    HOME: home,
    JARVOS_YES: '1',
    JARVOS_ASSISTANT_NAME: 'SafetyJarvis',
    JARVOS_USER_NAME: 'SafetyUser',
    JARVOS_COACH_NAME: 'SafetyCoach',
    JARVOS_RUNTIME: 'minimal',
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-init-safety-'));
try {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const env = initEnv(home);

  const malformedCases = [
    { args: ['--workspace'], message: /--workspace requires a non-empty path value/ },
    { args: ['--workspace='], message: /--workspace requires a non-empty path value/ },
    { args: ['--workspace', '--vault', path.join(tmp, 'malformed-vault')], message: /--workspace requires a non-empty path value/ },
    { args: ['--vault'], message: /--vault requires a non-empty path value/ },
    { args: ['--vault='], message: /--vault requires a non-empty path value/ },
    { args: ['--vault', '--json'], message: /--vault requires a non-empty path value/ },
    { args: ['--workspace', path.join(tmp, 'malformed-workspace'), '--vault='], message: /--vault requires a non-empty path value/ },
  ];
  for (const [index, malformed] of malformedCases.entries()) {
    for (const [surface, invoke] of [['router', runInit], ['bootstrap', runBootstrap]]) {
      const malformedHome = path.join(tmp, `malformed-${index}-${surface}`);
      fs.mkdirSync(malformedHome);
      const malformedWorkspace = path.join(malformedHome, 'clawd');
      const malformedVault = path.join(malformedHome, 'jarvos-vault');
      const result = invoke(malformed.args, initEnv(malformedHome));
      assert.notEqual(result.status, 0, `${surface} accepted ${malformed.args.join(' ')}`);
      assert.match(`${result.stdout}${result.stderr}`, malformed.message);
      assert.equal(fs.existsSync(malformedWorkspace), false, `${surface} wrote the default workspace`);
      assert.equal(fs.existsSync(malformedVault), false, `${surface} wrote the default vault`);
      assert.equal(fs.existsSync(path.join(tmp, 'malformed-workspace')), false, `${surface} wrote an explicit target before a malformed flag`);
      assert.equal(fs.existsSync(path.join(tmp, 'malformed-vault')), false, `${surface} wrote an explicit target after a malformed flag`);
    }
  }

  const workspace = path.join(tmp, 'new-workspace');
  const vault = path.join(tmp, 'new-vault');
  const cleanInstall = runInit(['--workspace', workspace, '--vault', vault], env);
  assert.equal(cleanInstall.status, 0, cleanInstall.stderr || cleanInstall.stdout);
  assert.match(cleanInstall.stdout, new RegExp(`Resolved workspace: ${escapeRegex(workspace)} \\(--workspace\\)`));
  assert.match(cleanInstall.stdout, /Resolved vault:.*\(--vault\)/);
  assert.match(cleanInstall.stdout, /Intended action:\s+new-install/);
  assert.ok(fs.existsSync(path.join(workspace, 'jarvos.config.json')));
  assert.ok(fs.existsSync(path.join(vault, 'Journal')));

  const userPath = path.join(workspace, 'USER.md');
  const authoredUser = '# Authored user context\n\nDo not overwrite.\n';
  fs.writeFileSync(userPath, authoredUser, 'utf8');
  const rerun = runInit(['--workspace', workspace, '--vault', vault], env);
  assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
  assert.match(rerun.stdout, /Intended action:\s+already-initialized/);
  assert.match(rerun.stdout, /preserving all existing files/i);
  assert.equal(fs.readFileSync(userPath, 'utf8'), authoredUser);

  // Reproduce the incident shape: `jarvos init --yes` must not touch an
  // already-used default ~/clawd workspace or create a shadow ~/jarvos-vault.
  const incidentHome = path.join(tmp, 'incident-home');
  const existingWorkspace = path.join(incidentHome, 'clawd');
  fs.mkdirSync(existingWorkspace, { recursive: true });
  const sentinel = path.join(existingWorkspace, 'private-work.md');
  fs.writeFileSync(sentinel, 'private state\n', 'utf8');
  const unrelatedWorkspace = path.join(tmp, 'unprefixed-workspace');
  const unrelatedVault = path.join(tmp, 'unprefixed-vault');
  const incident = runInit([], {
    ...initEnv(incidentHome),
    WORKSPACE_PATH: unrelatedWorkspace,
    VAULT_PATH: unrelatedVault,
  });
  assert.notEqual(incident.status, 0);
  assert.match(incident.stdout, new RegExp(`Resolved workspace: ${escapeRegex(existingWorkspace)} \\(default\\)`));
  assert.match(incident.stdout, /Intended action:\s+refuse/);
  assert.match(incident.stdout, /Refusing to initialize/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'private state\n');
  assert.equal(fs.existsSync(path.join(existingWorkspace, 'jarvos.config.json')), false);
  assert.equal(fs.existsSync(path.join(incidentHome, 'jarvos-vault')), false);
  assert.equal(fs.existsSync(unrelatedWorkspace), false);
  assert.equal(fs.existsSync(unrelatedVault), false);

  const existingVault = path.join(tmp, 'existing-vault');
  fs.mkdirSync(existingVault);
  fs.writeFileSync(path.join(existingVault, 'notes.md'), 'existing vault content\n', 'utf8');
  const blockedWorkspace = path.join(tmp, 'workspace-that-must-not-exist');
  const vaultRefusal = runInit(['--workspace', blockedWorkspace, '--vault', existingVault], env);
  assert.notEqual(vaultRefusal.status, 0);
  assert.match(vaultRefusal.stdout, /vault already exists/);
  assert.equal(fs.existsSync(blockedWorkspace), false, 'refusal must happen before workspace mkdir');
  assert.equal(fs.readFileSync(path.join(existingVault, 'notes.md'), 'utf8'), 'existing vault content\n');

  const emptyWorkspaceDestination = path.join(tmp, 'empty-workspace-destination');
  const workspaceLink = path.join(tmp, 'workspace-link');
  const symlinkVault = path.join(tmp, 'symlink-workspace-vault');
  fs.mkdirSync(emptyWorkspaceDestination);
  fs.symlinkSync(emptyWorkspaceDestination, workspaceLink, 'dir');
  const symlinkWorkspaceRefusal = runInit(['--workspace', workspaceLink, '--vault', symlinkVault], env);
  assert.notEqual(symlinkWorkspaceRefusal.status, 0);
  assert.match(symlinkWorkspaceRefusal.stdout, /workspace target is symlinked path/);
  assert.deepEqual(fs.readdirSync(emptyWorkspaceDestination), []);
  assert.equal(fs.existsSync(symlinkVault), false);

  const emptyVaultDestination = path.join(tmp, 'empty-vault-destination');
  const vaultLink = path.join(tmp, 'vault-link');
  const symlinkedVaultWorkspace = path.join(tmp, 'symlink-vault-workspace');
  fs.mkdirSync(emptyVaultDestination);
  fs.symlinkSync(emptyVaultDestination, vaultLink, 'dir');
  const symlinkVaultRefusal = runInit(['--workspace', symlinkedVaultWorkspace, '--vault', vaultLink], env);
  assert.notEqual(symlinkVaultRefusal.status, 0);
  assert.match(symlinkVaultRefusal.stdout, /vault target is symlinked path/);
  assert.deepEqual(fs.readdirSync(emptyVaultDestination), []);
  assert.equal(fs.existsSync(symlinkedVaultWorkspace), false);

  const realWorkspaceParent = path.join(tmp, 'real-workspace-parent');
  const workspaceParentLink = path.join(tmp, 'workspace-parent-link');
  const parentWorkspace = path.join(workspaceParentLink, 'new-workspace');
  const parentWorkspaceVault = path.join(tmp, 'parent-workspace-vault');
  fs.mkdirSync(realWorkspaceParent);
  fs.symlinkSync(realWorkspaceParent, workspaceParentLink, 'dir');
  const workspaceParentRefusal = runInit(['--workspace', parentWorkspace, '--vault', parentWorkspaceVault], env);
  assert.notEqual(workspaceParentRefusal.status, 0);
  assert.match(workspaceParentRefusal.stdout, /workspace target is symlinked path/);
  assert.equal(fs.existsSync(path.join(realWorkspaceParent, 'new-workspace')), false);
  assert.equal(fs.existsSync(parentWorkspaceVault), false);

  const realVaultParent = path.join(tmp, 'real-vault-parent');
  const vaultParentLink = path.join(tmp, 'vault-parent-link');
  const parentVault = path.join(vaultParentLink, 'new-vault');
  const parentVaultWorkspace = path.join(tmp, 'parent-vault-workspace');
  fs.mkdirSync(realVaultParent);
  fs.symlinkSync(realVaultParent, vaultParentLink, 'dir');
  const vaultParentRefusal = runInit(['--workspace', parentVaultWorkspace, '--vault', parentVault], env);
  assert.notEqual(vaultParentRefusal.status, 0);
  assert.match(vaultParentRefusal.stdout, /vault target is symlinked path/);
  assert.equal(fs.existsSync(path.join(realVaultParent, 'new-vault')), false);
  assert.equal(fs.existsSync(parentVaultWorkspace), false);

  console.log('Init safety tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
