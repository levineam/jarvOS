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
const { loadConfig, saveConfig } = require('../src/config');

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

test('operator aliases a known higher-precedence Codex skill before apply', () => {
  const env = seedEnv();
  const projectSkills = path.join(env.home, 'project-skills');
  try {
    copyFixture(path.join(projectSkills, 'public-fixture'));
    const loaded = loadConfig(env.configPath);
    const config = {
      ...loaded.config,
      harnesses: {
        ...loaded.config.harnesses,
        codex: {
          ...loaded.config.harnesses.codex,
          scopeRoots: { ...loaded.config.harnesses.codex.scopeRoots, project: projectSkills },
          scopeRootsComplete: true,
        },
      },
    };
    saveConfig(config, env.configPath);

    const planned = planOperator({ configPath: env.configPath });
    assert.equal(planned.aliases['public-fixture'], 'jarvos-public-fixture');
    applyOperator({ configPath: env.configPath });
    assert.equal(fs.existsSync(path.join(env.harnessRoots.codex, 'public-fixture')), false);
    assert.equal(fs.existsSync(path.join(env.harnessRoots.codex, 'jarvos-public-fixture', 'SKILL.md')), true);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('operator reserves home-relative higher-precedence scope roots before apply', () => {
  const env = seedEnv();
  const projectSkills = fs.mkdtempSync(path.join(os.homedir(), 'jarvos-op-home-scope-'));
  fs.chmodSync(projectSkills, 0o700);
  try {
    copyFixture(path.join(projectSkills, 'public-fixture'));
    const loaded = loadConfig(env.configPath);
    const config = {
      ...loaded.config,
      harnesses: {
        ...loaded.config.harnesses,
        codex: {
          ...loaded.config.harnesses.codex,
          scopeRoots: { ...loaded.config.harnesses.codex.scopeRoots, project: `~/${path.basename(projectSkills)}` },
          scopeRootsComplete: true,
        },
      },
    };
    saveConfig(config, env.configPath);
    assert.equal(planOperator({ configPath: env.configPath }).aliases['public-fixture'], 'jarvos-public-fixture');
  } finally {
    fs.rmSync(projectSkills, { recursive: true, force: true });
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

    applyOperator({ configPath: env.configPath });
    assert.equal(fs.existsSync(path.join(env.harnessRoots.codex, 'public-fixture', 'SKILL.md')), true);

    // Force an alias via rename and retire the receipt-owned old name.
    const renamed = renameAlias({ configPath: env.configPath, id: 'public-fixture', name: 'jarvos-public-fixture' });
    assert.equal(renamed.effectiveName, 'jarvos-public-fixture');
    assert.throws(() => repairOperator({ configPath: env.configPath }), /accepted catalog generation/);
    applyOperator({ configPath: env.configPath });
    assert.equal(fs.existsSync(path.join(env.harnessRoots.codex, 'jarvos-public-fixture', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(env.harnessRoots.codex, 'public-fixture')), false);

    const configText = fs.readFileSync(env.configPath, 'utf8');
    assert.equal(configText.includes('Local overlay only'), false);
    assert.equal(configText.includes('console.log'), false);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('repair refuses a catalog generation that was not accepted by apply', () => {
  const env = seedEnv();
  try {
    assert.throws(() => repairOperator({ configPath: env.configPath }), /accepted catalog generation/);
    const applied = applyOperator({ configPath: env.configPath });
    assert.ok(applied.acceptedCatalogDigest);
    const repaired = repairOperator({ configPath: env.configPath });
    assert.equal(repaired.repaired, false);

    fs.appendFileSync(path.join(env.bundle, 'SKILL.md'), '\nchanged\n');
    const refreshed = refreshOperator({ configPath: env.configPath });
    assert.equal(refreshed.publicUpdated, 1);
    assert.throws(() => repairOperator({ configPath: env.configPath }), /accepted catalog generation/);
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
    const launchdText = fs.readFileSync(path.join(env.home, 'Library', 'LaunchAgents', 'dev.jarvos.jarvos-shared-skills.plist'), 'utf8');
    assert.doesNotMatch(launchdText, /install-skills\.js['\"]?\s+refresh/);
    assert.match(launchdText, /install-skills\.js['\"]?\s+autonomous-repair/);
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

test('direct CLI mutation refuses a concurrent owner lease', () => {
  const env = seedEnv();
  try {
    const lease = path.join(env.control, '.shared-skill-cli.lock'); fs.writeFileSync(lease, 'held', { mode: 0o600 });
    const result = spawnSync(process.execPath, [CLI, 'repair', '--config', env.configPath, '--json'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stdout, /already running/);
  } finally { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.sourceRoot, { recursive: true, force: true }); }
});

test('direct CLI mutation recovers a stale owner lease', () => {
  const env = seedEnv();
  try {
    fs.writeFileSync(path.join(env.control, '.shared-skill-cli.lock'), JSON.stringify({ pid: 999999, operation: 'apply', startedAt: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [CLI, 'apply', '--config', env.configPath, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
    assert.equal(fs.existsSync(path.join(env.control, '.shared-skill-cli.lock')), false);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('direct CLI mutation recovers an old incomplete owner lease', () => {
  const env = seedEnv();
  try {
    const lease = path.join(env.control, '.shared-skill-cli.lock');
    fs.writeFileSync(lease, '', { mode: 0o600 });
    const old = new Date('2000-01-01T00:00:00.000Z'); fs.utimesSync(lease, old, old);
    const result = spawnSync(process.execPath, [CLI, 'apply', '--config', env.configPath, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
    fs.rmSync(env.sourceRoot, { recursive: true, force: true });
  }
});

test('scheduler planning refuses a concurrent owner lease even without --write', () => {
  const env = seedEnv();
  try {
    const lease = path.join(env.control, '.shared-skill-cli.lock'); fs.writeFileSync(lease, 'held', { mode: 0o600 });
    const result = spawnSync(process.execPath, [CLI, 'scheduler', '--config', env.configPath, '--json'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stdout, /already running/);
  } finally { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.sourceRoot, { recursive: true, force: true }); }
});

test('status marks a managed target unverifiable when a declared higher-precedence shadow exists', () => {
  const env = seedEnv();
  try {
    applyOperator({ configPath: env.configPath });
    const config = JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
    const shadowRoot = path.join(env.home, 'codex-project');
    config.harnesses.codex.scopeRoots = { project: shadowRoot, user: config.harnesses.codex.root };
    config.harnesses.codex.scopeRootsComplete = true;
    fs.writeFileSync(env.configPath, JSON.stringify(config));
    const shadow = path.join(shadowRoot, 'public-fixture'); fs.mkdirSync(shadow, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(shadow, 'SKILL.md'), 'shadow\n', { mode: 0o600 });
    const status = statusOperator({ configPath: env.configPath });
    const codex = status.pairs.find((pair) => pair.harness === 'codex');
    assert.equal(codex.verification.reason, 'higher_precedence_shadow');
  } finally { fs.rmSync(env.home, { recursive: true, force: true }); fs.rmSync(env.sourceRoot, { recursive: true, force: true }); }
});
