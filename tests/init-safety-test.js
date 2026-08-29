#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'jarvos.js');

function runInit(args, env) {
  return spawnSync(process.execPath, [CLI, 'init', '--profile', 'minimal', '--yes', ...args], {
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

  console.log('Init safety tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
