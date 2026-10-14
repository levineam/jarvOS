'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const { createInventoryWatcher, buildRefreshCommand } = require('../src/scheduler');
const { defaultConfig, normalizeConfig, saveConfig, loadConfig, ensureDir } = require('../src/config');
const {
  autonomousRepairOperator,
  sharedStatusOperator,
  explainOperator,
  excludeSkillOperator,
  includeSkillOperator,
  claudeProofOperator,
} = require('../src/operator');
const { reconcileAttention, redactedAttention } = require('../src/attention');
const { opaqueSkillId } = require('../src/inventory-contract');

const CLI = path.join(__dirname, '..', 'scripts', 'install-skills.js');

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function writeSkill(root, name, body = 'body') {
  const bundle = path.join(root, name);
  fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(bundle, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`,
    { mode: 0o600 },
  );
  return bundle;
}

function seedEnabledInventory({ maxEntriesPerRoot = 8, skills = ['alpha-skill'], limits = {} } = {}) {
  const home = temp('jarvos-auto-home-');
  const control = path.join(home, 'control');
  const codexRoot = path.join(home, 'codex');
  ensureDir(control, 'control');
  ensureDir(codexRoot, 'codex root');
  for (const name of skills) writeSkill(codexRoot, name);
  const harnesses = Object.fromEntries(['codex', 'claude', 'openclaw', 'hermes'].map((id) => {
    const root = path.join(home, 'harnesses', id);
    ensureDir(root, `${id} harness root`);
    return [id, { enabled: true, root, scopeRoots: {}, scopeRootsComplete: true }];
  }));
  const config = normalizeConfig({
    ...defaultConfig(),
    controlRoot: control,
    publicCatalogPath: path.join(control, 'public-catalog.json'),
    localOverlayPath: path.join(control, 'local-overlay.json'),
    harnesses,
    inventory: {
      ...defaultConfig().inventory,
      enabled: true,
      limits: { ...defaultConfig().inventory.limits, maxEntriesPerRoot, ...limits },
      registeredRoots: [
        {
          rootId: 'codex-managed',
          harness: 'codex',
          root: codexRoot,
          trustClass: 'markdown-only',
          lifecycle: 'available',
        },
      ],
    },
  });
  const configPath = saveConfig(config, path.join(control, 'config.json')).path;
  return { home, control, codexRoot, configPath };
}

test('scheduler refresh command targets autonomous-repair only', () => {
  const command = buildRefreshCommand({
    nodeExecutable: '/usr/bin/node',
    cliScript: '/tmp/install-skills.js',
    configPath: '/tmp/config.json',
  });
  assert.match(command, /autonomous-repair/);
  assert.doesNotMatch(command, /\srepair(\s|$)/);
  assert.doesNotMatch(command, /\srefresh(\s|$)/);
});

test('event watcher coalesces requests, suppresses projections, and bounds backlog', () => {
  const root = temp('jarvos-watch-root-');
  const projection = path.join(root, '.jarvos-managed');
  fs.mkdirSync(projection, { mode: 0o700 });
  let timer = null;
  const cycles = [];
  const watcher = createInventoryWatcher({
    roots: [],
    suppressedPaths: [projection],
    debounceMs: 1,
    digestStabilityMs: 1,
    maxEvents: 2,
    setTimer(fn) { timer = fn; return 1; },
    clearTimer() {},
    onCycle(cycle) { cycles.push(cycle); },
  });
  watcher.request(path.join(root, 'alpha'));
  watcher.request(path.join(root, 'beta'));
  watcher.request(path.join(root, 'gamma'));
  assert.equal(watcher.request(path.join(projection, 'receipt.json')), false);
  timer();
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].overflowed, true);
  assert.deepEqual(cycles[0].events, [path.join(root, 'alpha'), path.join(root, 'beta')]);
  // Concurrent second wake coalesces again.
  watcher.request(path.join(root, 'delta'));
  timer();
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[1].events, [path.join(root, 'delta')]);
  watcher.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('event watcher requests fallback after watch startup failure and closes active watchers', () => {
  const root = temp('jarvos-watch-recovery-');
  let timer = null;
  const cycles = [];
  let closeCount = 0;
  const failed = createInventoryWatcher({
    roots: [root],
    watch() { throw new Error('fixture watch unavailable'); },
    setTimer(fn) { timer = fn; return 1; },
    clearTimer() {},
    onCycle(cycle) { cycles.push(cycle); },
  });
  timer();
  assert.equal(cycles[0].reason, 'watcher_overflow');
  assert.deepEqual(cycles[0].events, [root]);
  failed.close();

  const active = createInventoryWatcher({
    roots: [root],
    watch() { return { close() { closeCount += 1; } }; },
    setTimer(fn) { timer = fn; return 2; },
    clearTimer() {},
    onCycle(cycle) { cycles.push(cycle); },
  });
  active.close();
  assert.equal(closeCount, 1);
  assert.equal(active.request(path.join(root, 'after-close')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('event watcher degrades an async FSWatcher error into one bounded fallback cycle', () => {
  const root = temp('jarvos-watch-async-error-');
  let timer = null;
  let closeCount = 0;
  const cycles = [];
  const nativeWatcher = new EventEmitter();
  nativeWatcher.close = () => { closeCount += 1; };
  const watcher = createInventoryWatcher({
    roots: [root],
    watch() { return nativeWatcher; },
    setTimer(fn) { timer = fn; return 1; },
    clearTimer() {},
    onCycle(cycle) { cycles.push(cycle); },
  });

  nativeWatcher.emit('error', new Error('fixture async watch failure'));
  nativeWatcher.emit('error', new Error('duplicate failure is coalesced'));
  assert.equal(closeCount, 1);
  assert.equal(typeof timer, 'function');
  timer();
  assert.deepEqual(cycles, [{ reason: 'watcher_overflow', events: [root], overflowed: true }]);
  watcher.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('attention raises once per stable problem and once on recovery', () => {
  const home = temp('jarvos-attn-');
  const attentionPath = path.join(home, 'attention.json');
  const statusA = {
    skills: [
      {
        logicalId: 'needs-help',
        attention: 'actionable',
        disposition: { kind: 'needs_input', reasonCode: 'needs_owner_input' },
      },
    ],
  };
  const first = reconcileAttention({
    attentionPath,
    status: statusA,
    observedAt: '2026-08-15T16:00:00.000Z',
  });
  assert.equal(first.wrote, true);
  assert.equal(first.raised.length, 1);
  assert.equal(first.resolved.length, 0);

  const second = reconcileAttention({
    attentionPath,
    status: statusA,
    observedAt: '2026-08-15T16:01:00.000Z',
  });
  assert.equal(second.wrote, false);
  assert.equal(second.raised.length, 0);

  const cleared = reconcileAttention({
    attentionPath,
    status: { skills: [] },
    observedAt: '2026-08-15T16:02:00.000Z',
  });
  assert.equal(cleared.wrote, true);
  assert.equal(cleared.resolved.length, 1);
  assert.equal(cleared.resolved[0].attention, 'resolved');

  // Malicious/private fields never enter redacted attention.
  const leaked = redactedAttention({
    skills: [{
      logicalId: 'x',
      attention: 'actionable',
      disposition: { kind: 'blocked', reasonCode: 'unsafe_source' },
      absolutePath: '/Users/secret/path',
      body: 'PRIVATE BODY',
    }],
  });
  assert.equal(JSON.stringify(leaked).includes('/Users/secret'), false);
  assert.equal(JSON.stringify(leaked).includes('PRIVATE BODY'), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('autonomous repair denies incomplete inventory and is zero-write when healthy', () => {
  const env = seedEnabledInventory({
    maxEntriesPerRoot: 1,
    skills: ['alpha-skill', 'beta-skill'],
  });
  try {
    const incomplete = autonomousRepairOperator({ configPath: env.configPath });
    assert.equal(incomplete.mutationDenied, true);
    assert.equal(incomplete.reason, 'incomplete_generation');

    const loaded = loadConfig(env.configPath);
    saveConfig({
      ...loaded.config,
      inventory: {
        ...loaded.config.inventory,
        limits: { ...loaded.config.inventory.limits, maxEntriesPerRoot: 2 },
      },
    }, env.configPath);
    const first = autonomousRepairOperator({ configPath: env.configPath });
    assert.equal(first.ok, true);
    assert.equal(first.mutationDenied, false);
    const statePath = path.join(env.control, 'inventory', 'observations.json');
    assert.ok(fs.existsSync(statePath));
    const before = fs.statSync(statePath).mtimeMs;
    const second = autonomousRepairOperator({ configPath: env.configPath });
    assert.equal(second.ok, true);
    assert.equal(second.reconciliation.repaired, false);
    assert.equal(second.attention.wrote, false);
    assert.equal(fs.statSync(statePath).mtimeMs, before);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('autonomous repair continues for safe skills when one sibling bundle is unsafe', () => {
  const env = seedEnabledInventory({ skills: ['safe-skill', 'unsafe-skill'] });
  try {
    fs.writeFileSync(path.join(env.codexRoot, 'unsafe-skill', 'README.md'), 'ordinary unmanaged extra\n', { mode: 0o600 });
    const result = autonomousRepairOperator({ configPath: env.configPath, observedAt: '2026-08-15T16:30:00.000Z' });
    assert.equal(result.mutationDenied, false);
    assert.equal(result.status.skills.find((skill) => skill.logicalId === opaqueSkillId('unsafe-skill')).disposition.reasonCode, 'unsafe_source');
    assert.equal(result.status.skills.find((skill) => skill.logicalId === opaqueSkillId('safe-skill')).disposition.kind, 'shared');
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('autonomous repair admits a safe sibling while an oversized bundle stays blocked', () => {
  const env = seedEnabledInventory({
    skills: ['safe-skill', 'oversized-skill'],
    limits: { maxBundleBytes: 128 },
  });
  try {
    fs.appendFileSync(
      path.join(env.codexRoot, 'oversized-skill', 'SKILL.md'),
      `\n${'x'.repeat(256)}\n`,
    );
    const result = autonomousRepairOperator({
      configPath: env.configPath,
      observedAt: '2026-08-15T16:31:00.000Z',
    });
    assert.equal(result.mutationDenied, false);
    assert.equal(
      result.status.skills.find((skill) => skill.logicalId === opaqueSkillId('safe-skill')).disposition.kind,
      'shared',
    );
    assert.equal(
      result.status.skills.find((skill) => skill.logicalId === opaqueSkillId('oversized-skill')).disposition.reasonCode,
      'unsafe_source',
    );
    assert.equal(result.reconciliation.applied.some((pair) => pair.id === 'safe-skill' && pair.applied), true);
    assert.equal(result.reconciliation.applied.some((pair) => pair.id === 'oversized-skill'), false);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('autonomous repair retires generated overlay after complete absence floor', () => {
  const env = seedEnabledInventory({ skills: ['departed-skill'] });
  try {
    const admitted = autonomousRepairOperator({ configPath: env.configPath, observedAt: '2026-08-15T16:00:00.000Z' });
    assert.equal(admitted.mutationDenied, false);
    fs.rmSync(path.join(env.codexRoot, 'departed-skill'), { recursive: true, force: true });
    autonomousRepairOperator({ configPath: env.configPath, observedAt: '2026-08-15T17:00:00.000Z' });
    const acceptedPath = loadConfig(env.configPath).resolved.inventory.acceptedGenerationPath;
    assert.equal(JSON.parse(fs.readFileSync(acceptedPath, 'utf8')).absences['departed-skill'].count, 1);
    autonomousRepairOperator({ configPath: env.configPath, observedAt: '2026-08-16T17:00:00.000Z' });
    const accepted = JSON.parse(fs.readFileSync(acceptedPath, 'utf8'));
    assert.equal(accepted.absences?.['departed-skill']?.count || 0, 0);
    assert.equal(accepted.generatedOverlay.entries.some((entry) => entry.id === 'departed-skill'), false);
    const overlay = JSON.parse(fs.readFileSync(path.join(env.control, 'local-overlay.json'), 'utf8'));
    assert.equal(overlay.entries.some((entry) => entry.id === 'departed-skill'), false);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('shared-status/explain/exclude/include/claude-proof stay path-redacted', () => {
  const env = seedEnabledInventory({ skills: ['portable-skill'] });
  try {
    // First observation so explain has data.
    autonomousRepairOperator({ configPath: env.configPath });

    const shared = sharedStatusOperator({ configPath: env.configPath });
    assert.equal(shared.ok, true);
    assert.equal(shared.mode, 'shared-status');
    assert.equal(JSON.stringify(shared).includes(env.home), false);
    assert.equal(JSON.stringify(shared).includes('absolutePath'), false);

    const explained = explainOperator({ configPath: env.configPath, id: 'portable-skill' });
    assert.equal(explained.ok, true);
    assert.equal(explained.found, true);
    assert.equal(explained.skill.logicalId, opaqueSkillId('portable-skill'));
    assert.equal(JSON.stringify(explained).includes('portable-skill'), false);
    assert.equal(JSON.stringify(explained).includes(env.home), false);

    const excluded = excludeSkillOperator({
      configPath: env.configPath,
      id: 'portable-skill',
      reasonCode: 'owner_excluded',
    });
    assert.equal(excluded.ok, true);
    assert.equal(excluded.mode, 'exclude');

    const afterExclude = explainOperator({ configPath: env.configPath, id: 'portable-skill' });
    assert.equal(afterExclude.exclusion?.reasonCode, 'owner_excluded');

    const included = includeSkillOperator({ configPath: env.configPath, id: 'portable-skill' });
    assert.equal(included.ok, true);
    assert.equal(included.removed, true);
    autonomousRepairOperator({ configPath: env.configPath });

    const proof = claudeProofOperator({
      configPath: env.configPath,
      id: 'portable-skill',
    });
    assert.equal(proof.ok, true);
    assert.equal(proof.evidence.privateBodyIncluded, false);
    assert.equal(JSON.stringify(proof).includes('body'), false);

    const mismatch = claudeProofOperator({
      configPath: env.configPath,
      id: 'portable-skill',
      expectedGenerationId: 'not-the-generation',
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'generation_mismatch');

    // CLI parity
    const cliStatus = spawnSync(
      process.execPath,
      [CLI, 'shared-status', '--config', env.configPath, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(cliStatus.status, 0, cliStatus.stderr || cliStatus.stdout);
    const cliPayload = JSON.parse(cliStatus.stdout);
    assert.equal(cliPayload.mode, 'shared-status');
    assert.equal(cliStatus.stdout.includes(env.home), false);

    const cliExplain = spawnSync(
      process.execPath,
      [CLI, 'explain', '--id', 'portable-skill', '--config', env.configPath, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(cliExplain.status, 0, cliExplain.stderr || cliExplain.stdout);
    assert.equal(JSON.parse(cliExplain.stdout).logicalId, opaqueSkillId('portable-skill'));
    assert.equal(cliExplain.stdout.includes('portable-skill'), false);

    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /autonomous-repair/);
    assert.match(help.stdout, /shared-status/);
    assert.match(help.stdout, /explain/);
    assert.match(help.stdout, /exclude/);
    assert.match(help.stdout, /include/);
    assert.match(help.stdout, /claude-proof/);
  } finally {
    fs.rmSync(env.home, { recursive: true, force: true });
  }
});

test('disabled inventory keeps autonomous repair inert', () => {
  const home = temp('jarvos-auto-off-');
  const control = path.join(home, 'control');
  ensureDir(control, 'control');
  const config = normalizeConfig({
    ...defaultConfig(),
    controlRoot: control,
    publicCatalogPath: path.join(control, 'public-catalog.json'),
    localOverlayPath: path.join(control, 'local-overlay.json'),
    inventory: {
      ...defaultConfig().inventory,
      enabled: false,
      registeredRoots: [],
    },
  });
  const configPath = saveConfig(config, path.join(control, 'config.json')).path;
  try {
    const result = autonomousRepairOperator({ configPath });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'inventory_disabled');
    assert.equal(result.mutationDenied, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
