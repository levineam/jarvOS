'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
  initOperator,
  shareOperator,
  planOperator,
  applyOperator,
  statusOperator,
  enableHarness,
  disableHarness,
  renameAlias,
  refreshOperator,
  repairOperator,
  schedulerOperator,
} = require('../src/operator');
const { planSchedulerUnits } = require('../src/scheduler');

const FIXTURE = path.join(__dirname, 'fixtures', 'catalog', 'public-fixture');
const CLI = path.join(__dirname, '..', 'scripts', 'install-skills.js');

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function copyFixture(to) {
  fs.cpSync(FIXTURE, to, { recursive: true });
  const walk = (dir) => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.chmodSync(full, 0o600);
    }
  };
  walk(to);
}

function seedEnv() {
  const home = temp('jarvos-op-home-');
  const control = path.join(home, '.jarvos', 'shared-skills');
  const sourceRoot = temp('jarvos-op-source-');
  const bundle = path.join(sourceRoot, 'public-fixture');
  copyFixture(bundle);
  const harnessRoots = {
    codex: path.join(home, '.codex', 'skills'),
    claude: path.join(home, '.claude', 'skills'),
    openclaw: path.join(home, '.openclaw', 'skills'),
    hermes: path.join(home, '.hermes', 'skills'),
  };
  const configPath = path.join(control, 'config.json');
  initOperator({
    configPath,
    controlRoot: control,
    publicSourceRoot: sourceRoot,
  });
  for (const [harness, root] of Object.entries(harnessRoots)) {
    enableHarness({ configPath, harness, root });
  }
  shareOperator({
    configPath,
    id: 'public-fixture',
    bundlePath: bundle,
    scope: 'public',
    harnesses: ['codex', 'claude', 'openclaw', 'hermes'],
  });
  return { home, control, sourceRoot, bundle, configPath, harnessRoots };
}

test('operator share/plan/apply/status/refresh/repair path is idempotent and redacted', () => {
  const env = seedEnv();
  try {
    const planned = planOperator({ configPath: env.configPath });
    assert.equal(planned.pairs.filter((pair) => pair.status === 'missing').length, 4);
    const applied = applyOperator({ configPath: env.configPath });
    assert.equal(applied.applied.filter((item) => item.applied).length, 4);

    const status = statusOperator({ configPath: env.configPath });
    assert.equal(status.ok, true);
    assert.ok(status.catalogDigest);
    assert.equal(JSON.stringify(status).includes(env.bundle), false);
    assert.ok(status.pairs.every((pair) => pair.status === 'clean'));

    const refreshed = refreshOperator({ configPath: env.configPath });
    assert.equal(refreshed.ok, true);
    const repaired = repairOperator({ configPath: env.configPath });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.repaired, false);

    const second = applyOperator({ configPath: env.configPath });
    assert.ok(second.applied.every((item) => item.applied === false));
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('enable/disable and rename mutate config/alias state without writing skill bodies into config', () => {
  const env = seedEnv();
  try {
    disableHarness({ configPath: env.configPath, harness: 'claude' });
    const planned = planOperator({ configPath: env.configPath });
    assert.ok(planned.pairs.every((pair) => pair.harness !== 'claude'));
    enableHarness({ configPath: env.configPath, harness: 'claude', root: env.harnessRoots.claude });

    // Force an alias via rename.
    const renamed = renameAlias({ configPath: env.configPath, id: 'public-fixture', name: 'jarvos-public-fixture' });
    assert.equal(renamed.effectiveName, 'jarvos-public-fixture');
    applyOperator({ configPath: env.configPath });
    assert.equal(fs.existsSync(path.join(env.harnessRoots.codex, 'jarvos-public-fixture', 'SKILL.md')), true);

    const configText = fs.readFileSync(env.configPath, 'utf8');
    assert.equal(configText.includes('Local overlay only'), false);
    assert.equal(configText.includes('console.log'), false);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('scheduler plans launchd and systemd units without enabling them', () => {
  const env = seedEnv();
  try {
    const launchd = planSchedulerUnits({
      platform: 'darwin',
      home: env.home,
      moduleRoot: path.join(__dirname, '..'),
      configPath: env.configPath,
      unitName: 'jarvos-shared-skills',
      intervalMinutes: 30,
      write: true,
    });
    assert.equal(launchd.write, true);
    assert.equal(launchd.artifacts[0].kind, 'launchd-plist');
    assert.equal(fs.existsSync(path.join(env.home, 'Library', 'LaunchAgents', 'dev.jarvos.jarvos-shared-skills.plist')), true);

    const systemd = planSchedulerUnits({
      platform: 'linux',
      home: env.home,
      moduleRoot: path.join(__dirname, '..'),
      configPath: env.configPath,
      unitName: 'jarvos-shared-skills',
      intervalMinutes: 45,
      write: true,
    });
    assert.equal(systemd.artifacts.length, 2);
    assert.ok(systemd.artifacts.every((artifact) => artifact.enableCommand.includes('systemctl --user')));

    const viaOperator = schedulerOperator({
      configPath: env.configPath,
      write: false,
      intervalMinutes: 60,
      platform: 'darwin',
      home: env.home,
    });
    assert.equal(viaOperator.ok, true);
    assert.equal(viaOperator.plan.enabled, false);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('CLI status/plan commands return JSON and do not require live harnesses', () => {
  const env = seedEnv();
  try {
    const status = spawnSync(process.execPath, [CLI, 'status', '--config', env.configPath, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.pairs));

    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /share/);
    assert.match(help.stdout, /scheduler/);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});
