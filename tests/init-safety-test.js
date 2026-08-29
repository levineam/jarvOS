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

function runBootstrap(args, env, options = {}) {
  return spawnSync(process.execPath, [BOOTSTRAP, '--yes', ...args], {
    cwd: options.cwd || ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function initEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    JARVOS_YES: '1',
    JARVOS_ASSISTANT_NAME: 'SafetyJarvis',
    JARVOS_USER_NAME: 'SafetyUser',
    JARVOS_COACH_NAME: 'SafetyCoach',
    JARVOS_RUNTIME: 'minimal',
  };
  delete env.JARVOS_WORKSPACE_PATH;
  delete env.JARVOS_VAULT_PATH;
  return env;
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

  const invalidEnvironmentCases = [
    { name: 'JARVOS_WORKSPACE_PATH', value: '', other: 'JARVOS_VAULT_PATH' },
    { name: 'JARVOS_WORKSPACE_PATH', value: '   ', other: 'JARVOS_VAULT_PATH' },
    { name: 'JARVOS_WORKSPACE_PATH', value: '  -workspace', other: 'JARVOS_VAULT_PATH' },
    { name: 'JARVOS_VAULT_PATH', value: '', other: 'JARVOS_WORKSPACE_PATH' },
    { name: 'JARVOS_VAULT_PATH', value: '\t', other: 'JARVOS_WORKSPACE_PATH' },
    { name: 'JARVOS_VAULT_PATH', value: '-vault', other: 'JARVOS_WORKSPACE_PATH' },
  ];
  for (const [index, invalid] of invalidEnvironmentCases.entries()) {
    for (const [surface, invoke] of [['router', runInit], ['bootstrap', runBootstrap]]) {
      const invalidHome = path.join(tmp, `invalid-env-${index}-${surface}`);
      const selectedOtherTarget = path.join(tmp, `invalid-env-selected-${index}-${surface}`);
      fs.mkdirSync(invalidHome);
      const invalidEnv = {
        ...initEnv(invalidHome),
        [invalid.name]: invalid.value,
        [invalid.other]: selectedOtherTarget,
      };
      const result = invoke([], invalidEnv);
      assert.notEqual(result.status, 0, `${surface} accepted ${invalid.name}=${JSON.stringify(invalid.value)}`);
      assert.match(`${result.stdout}${result.stderr}`, new RegExp(`${invalid.name} requires a non-empty path value`));
      assert.equal(fs.existsSync(selectedOtherTarget), false, `${surface} wrote another selected environment target`);
      assert.equal(fs.existsSync(path.join(invalidHome, 'clawd')), false, `${surface} wrote the default workspace`);
      assert.equal(fs.existsSync(path.join(invalidHome, 'jarvos-vault')), false, `${surface} wrote the default vault`);
    }
  }

  const relativeRouterHome = path.join(tmp, 'relative-router-home');
  const relativeRouterWorkspace = path.join(tmp, 'relative-router-workspace');
  const relativeRouterVault = path.join(tmp, 'relative-router-vault');
  fs.mkdirSync(relativeRouterHome);
  const relativeRouter = runInit([], {
    ...initEnv(relativeRouterHome),
    JARVOS_WORKSPACE_PATH: path.relative(ROOT, relativeRouterWorkspace),
    JARVOS_VAULT_PATH: path.relative(ROOT, relativeRouterVault),
  });
  assert.equal(relativeRouter.status, 0, relativeRouter.stderr || relativeRouter.stdout);
  assert.ok(fs.existsSync(path.join(relativeRouterWorkspace, 'jarvos.config.json')));
  assert.ok(fs.existsSync(path.join(relativeRouterVault, 'Journal')));

  const relativeBootstrapRoot = path.join(tmp, 'relative-bootstrap-root');
  const relativeBootstrapHome = path.join(tmp, 'relative-bootstrap-home');
  fs.mkdirSync(relativeBootstrapRoot);
  fs.mkdirSync(relativeBootstrapHome);
  const relativeBootstrap = runBootstrap([], {
    ...initEnv(relativeBootstrapHome),
    JARVOS_WORKSPACE_PATH: 'workspace',
    JARVOS_VAULT_PATH: 'vault',
  }, { cwd: relativeBootstrapRoot });
  assert.equal(relativeBootstrap.status, 0, relativeBootstrap.stderr || relativeBootstrap.stdout);
  assert.ok(fs.existsSync(path.join(relativeBootstrapRoot, 'workspace', 'jarvos.config.json')));
  assert.ok(fs.existsSync(path.join(relativeBootstrapRoot, 'vault', 'Journal')));

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

  const attachWorkspace = path.join(tmp, 'attach-workspace');
  const attachVault = path.join(tmp, 'attach-vault');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(attachVault, directory), { recursive: true });
  fs.writeFileSync(path.join(attachVault, 'Notes', 'existing.md'), 'do not modify\n');
  const attach = runInit(['--workspace', attachWorkspace, '--vault', attachVault, '--use-existing-vault'], env);
  assert.equal(attach.status, 0, attach.stderr || attach.stdout);
  assert.match(attach.stdout, /Intended action:\s+attach-existing-vault/);
  assert.ok(fs.existsSync(path.join(attachWorkspace, 'jarvos.config.json')));
  assert.equal(fs.readFileSync(path.join(attachVault, 'Notes', 'existing.md'), 'utf8'), 'do not modify\n');

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

  // A symlink is still refused for new writes, but a complete existing install
  // behind aliases can be recognized and read-only re-run safely.
  const compatibleWorkspaceLink = path.join(tmp, 'compatible-workspace-link');
  const compatibleVaultLink = path.join(tmp, 'compatible-vault-link');
  fs.symlinkSync(workspace, compatibleWorkspaceLink, 'dir');
  fs.symlinkSync(vault, compatibleVaultLink, 'dir');
  const symlinkCompatible = runInit(['--workspace', compatibleWorkspaceLink, '--vault', compatibleVaultLink], env);
  assert.equal(symlinkCompatible.status, 0, symlinkCompatible.stderr || symlinkCompatible.stdout);
  assert.match(symlinkCompatible.stdout, /Intended action:\s+already-initialized/);
  assert.match(symlinkCompatible.stdout, /preserving all existing files/i);

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
