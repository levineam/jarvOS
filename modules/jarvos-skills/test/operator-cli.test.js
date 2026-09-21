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

test('read-only plan does not create absent inventory state', () => {
  const root = temp('jarvos-plan-read-only-');
  const control = path.join(root, 'control');
  const configPath = path.join(control, 'config.json');
  try {
    initOperator({ configPath, controlRoot: control });
    const inventoryRoot = path.join(control, 'inventory');
    assert.equal(fs.existsSync(inventoryRoot), false);
    const planned = planOperator({ configPath });
    assert.equal(planned.ok, true);
    assert.equal(planned.inventoryGenerationId, null);
    assert.equal(fs.existsSync(inventoryRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('article-generator local admission captures the literal routing eval and projects it across enabled harnesses', () => {
  const home = temp('jarvos-article-home-');
  const sourceRoot = temp('jarvos-article-source-');
  const control = path.join(home, '.jarvos', 'shared-skills');
  const configPath = path.join(control, 'config.json');
  const bundle = path.join(sourceRoot, 'article-generator');
  const harnessRoots = Object.fromEntries(['codex', 'claude', 'openclaw', 'hermes'].map((harness) => [
    harness,
    path.join(home, `.${harness}`, 'skills'),
  ]));
  try {
    fs.mkdirSync(path.join(bundle, 'evals'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), '---\nname: article-generator\n---\n\nprivate fixture\n', { mode: 0o600 });
    fs.writeFileSync(path.join(bundle, 'evals', 'routing.jsonl'), '{"case":"routing"}\n', { mode: 0o600 });
    initOperator({ configPath, controlRoot: control });
    for (const [harness, root] of Object.entries(harnessRoots)) {
      enableHarness({ configPath, harness, root });
    }

    const admitted = shareOperator({
      configPath,
      id: 'article-generator',
      bundlePath: bundle,
      scope: 'local',
      allowExtra: 'evals/routing.jsonl',
      harnesses: Object.keys(harnessRoots),
    });
    assert.match(admitted.entry.bundle.root, /^snapshots\/article-generator\/[a-f0-9]{64}$/);
    const overlayV1 = JSON.parse(fs.readFileSync(path.join(control, 'local-overlay.json'), 'utf8'));
    const entryV1 = overlayV1.entries.find((entry) => entry.id === 'article-generator');
    assert.equal(entryV1.sourceRootKind, 'inventory-snapshot');
    assert.deepEqual(entryV1.bundle.allowlist, [
      'SKILL.md',
      'assets/**',
      'evals/routing.jsonl',
      'references/**',
      'scripts/**',
      'templates/**',
    ]);
    assert.equal(fs.existsSync(path.join(control, 'inventory', 'source-store', entryV1.bundle.root)), true);
    assert.equal(loadConfig(configPath).config.localSourceRoot, null);
    const applied = applyOperator({ configPath });
    assert.equal(applied.ok, true);
    for (const root of Object.values(harnessRoots)) {
      assert.equal(fs.readFileSync(path.join(root, 'article-generator', 'evals', 'routing.jsonl'), 'utf8'), '{"case":"routing"}\n');
    }
    assert.equal(shareOperator({
      configPath,
      id: 'article-generator',
      bundlePath: bundle,
      scope: 'local',
      allowExtra: 'evals/routing.jsonl',
      harnesses: Object.keys(harnessRoots),
    }).reused, true);

    const original = fs.readFileSync(path.join(bundle, 'SKILL.md'), 'utf8');
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), `${original}v2\n`, { mode: 0o600 });
    const updated = shareOperator({
      configPath,
      id: 'article-generator',
      bundlePath: bundle,
      scope: 'local',
      allowExtra: 'evals/routing.jsonl',
      harnesses: Object.keys(harnessRoots),
    });
    assert.equal(updated.supersededTreeDigest, entryV1.bundle.treeDigest);
    const overlayV2 = JSON.parse(fs.readFileSync(path.join(control, 'local-overlay.json'), 'utf8'));
    const entryV2 = overlayV2.entries.find((entry) => entry.id === 'article-generator');
    assert.notEqual(entryV2.bundle.treeDigest, entryV1.bundle.treeDigest);
    assert.equal(fs.existsSync(path.join(control, 'inventory', 'source-store', entryV1.bundle.root)), true);
    assert.equal(
      fs.readFileSync(path.join(control, 'inventory', 'source-store', entryV1.bundle.root, 'SKILL.md'), 'utf8'),
      original,
    );
    applyOperator({ configPath });
    for (const root of Object.values(harnessRoots)) {
      assert.match(fs.readFileSync(path.join(root, 'article-generator', 'SKILL.md'), 'utf8'), /v2/);
    }
    const ordinarySource = temp('jarvos-ordinary-local-');
    try {
      const ordinaryBundle = path.join(ordinarySource, 'ordinary-local');
      fs.mkdirSync(ordinaryBundle, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(ordinaryBundle, 'SKILL.md'), '---\nname: ordinary-local\n---\n\nordinary fixture\n', { mode: 0o600 });
      shareOperator({
        configPath,
        id: 'ordinary-local',
        bundlePath: ordinaryBundle,
        scope: 'local',
        harnesses: Object.keys(harnessRoots),
      });
      assert.equal(loadConfig(configPath).resolved.localSourceRoot, ordinarySource);
      assert.equal(applyOperator({ configPath }).ok, true);
      for (const root of Object.values(harnessRoots)) {
        assert.equal(fs.existsSync(path.join(root, 'ordinary-local', 'SKILL.md')), true);
        assert.match(fs.readFileSync(path.join(root, 'article-generator', 'SKILL.md'), 'utf8'), /v2/);
      }
    } finally {
      fs.rmSync(ordinarySource, { recursive: true, force: true });
    }
    assert.throws(() => shareOperator({
      configPath,
      id: 'article-generator',
      bundlePath: bundle,
      scope: 'public',
      allowExtra: 'evals/routing.jsonl',
    }), /only supported/);
    assert.throws(() => shareOperator({
      configPath,
      id: 'article-generator',
      bundlePath: bundle,
      scope: 'local',
      allowExtra: 'evals/other.jsonl',
    }), /only supported/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('article-generator inventory snapshot coexists with an existing ordinary local source root', () => {
  const home = temp('jarvos-article-existing-local-home-');
  const sourceRoot = temp('jarvos-article-existing-local-source-');
  const control = path.join(home, '.jarvos', 'shared-skills');
  const configPath = path.join(control, 'config.json');
  const articleBundle = path.join(sourceRoot, 'article-generator');
  const ordinaryBundle = path.join(sourceRoot, 'ordinary-local');
  const harnessRoot = path.join(home, '.codex', 'skills');
  try {
    fs.mkdirSync(path.join(articleBundle, 'evals'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(ordinaryBundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(articleBundle, 'SKILL.md'), '---\nname: article-generator\n---\n\narticle fixture\n', { mode: 0o600 });
    fs.writeFileSync(path.join(articleBundle, 'evals', 'routing.jsonl'), '{"case":"routing"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(ordinaryBundle, 'SKILL.md'), '---\nname: ordinary-local\n---\n\nordinary fixture\n', { mode: 0o600 });
    initOperator({ configPath, controlRoot: control });
    enableHarness({ configPath, harness: 'codex', root: harnessRoot });
    shareOperator({ configPath, id: 'ordinary-local', bundlePath: ordinaryBundle, scope: 'local', harnesses: ['codex'] });
    assert.equal(loadConfig(configPath).resolved.localSourceRoot, sourceRoot);
    shareOperator({
      configPath,
      id: 'article-generator',
      bundlePath: articleBundle,
      scope: 'local',
      allowExtra: 'evals/routing.jsonl',
      harnesses: ['codex'],
    });
    assert.equal(loadConfig(configPath).resolved.localSourceRoot, sourceRoot);
    assert.equal(applyOperator({ configPath }).ok, true);
    assert.equal(fs.existsSync(path.join(harnessRoot, 'ordinary-local', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(harnessRoot, 'article-generator', 'evals', 'routing.jsonl')), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
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
