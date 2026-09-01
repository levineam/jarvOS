#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'jarvos.js');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const NONE_RUNTIME_MODE = {
  version: 'jarvos-runtime-mode/v1',
  mode: 'none',
  installedAdapters: [],
  workloadRoutes: [],
  capabilityTruth: [],
};

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

const templateNames = ['AGENTS-template.md', 'BOOTSTRAP-template.md', 'HEARTBEAT-template.md'];
for (const name of templateNames) {
  const content = readTemplate(name);
  assert.match(content, /authority|approval/i, `${name} must require an explicit authority decision`);
  assert.doesNotMatch(content, /\bopenclaw\b/i, `${name} must not prescribe an OpenClaw-only action`);
  assert.doesNotMatch(content, /mkdir\s+-p|cron\s+name|npm\s+view\s+openclaw|openclaw\s+--version/i,
    `${name} must not contain an unconditional harness, scheduler, or Vault mutation command`);
}

const bootstrap = readTemplate('BOOTSTRAP-template.md');
const heartbeat = readTemplate('HEARTBEAT-template.md');
assert.match(bootstrap, /do not create or\s+normalize journals, notes, task boards, schedules, provider checks, or\s+resident-harness configuration until the user grants authority/i);
assert.match(heartbeat, /do not run a background\s+check or create a schedule/i);
assert.match(heartbeat, /never create, repair, normalize, or update journal, notes, memory, or task\s+artifacts unless the user has granted authority/i);

// The installer only receives disposable paths. This proves fresh core-only
// workspaces render the dormant contract without touching a developer's local
// workspace or notes store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-neutral-'));
try {
  const home = path.join(tmp, 'home');
  const workspace = path.join(tmp, 'workspace');
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    JARVOS_YES: '1',
    JARVOS_ASSISTANT_NAME: 'TestJarvis',
    JARVOS_USER_NAME: 'TestUser',
    JARVOS_COACH_NAME: 'TestCoach',
    JARVOS_RUNTIME: 'minimal',
  };
  const init = run(['init', '--profile', 'minimal', '--yes', '--workspace', workspace, '--vault', vault], env);
  assert.equal(init.status, 0, init.stderr || init.stdout);
  const config = JSON.parse(fs.readFileSync(path.join(workspace, 'jarvos.config.json'), 'utf8'));
  assert.deepEqual(config.runtimeMode, NONE_RUNTIME_MODE);
  for (const name of ['AGENTS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md']) {
    const content = fs.readFileSync(path.join(workspace, name), 'utf8');
    assert.doesNotMatch(content, /\bopenclaw\b/i, `${name} must stay runtime-neutral in a fresh workspace`);
  }

  const authoredAgents = '# Customized workspace instructions\n';
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), authoredAgents, 'utf8');
  const rerun = run(['init', '--profile', 'minimal', '--yes', '--workspace', workspace, '--vault', vault], env);
  assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
  assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), authoredAgents,
    'a compatible workspace must preserve customized instructions');

  const syncWorkspace = path.join(tmp, 'sync-workspace');
  const syncVault = path.join(tmp, 'sync-vault');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(syncVault, directory), { recursive: true });
  const sync = run(['sync', '--workspace', syncWorkspace, '--vault', syncVault, '--name', 'TestUser', '--timezone', 'UTC', '--json'], env);
  assert.equal(sync.status, 0, sync.stderr || sync.stdout);
  const synced = JSON.parse(sync.stdout);
  assert.deepEqual(synced.config.runtimeMode, NONE_RUNTIME_MODE);
  assert.equal(synced.vaultWrites, false);
  assert.equal(synced.vaultContentsWritten, false);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
