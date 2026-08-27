#!/usr/bin/env node
'use strict';

// Unit coverage for the SUP-2262 doctor checks: vault-path-stale and journal-conflict.
// These guard the SUP-2269 failure mode (a stale/moved vault, or Obsidian's own journal
// automation writing into the same folder jarvOS journals into and clobbering it).

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  assessControlPlaneDoctor,
  checkCompoundEngineeringProvider,
  checkControlPlaneModule,
  checkVaultPathStale,
  checkJournalConflict,
  healthModuleBlocksDoctor,
} = require('../lib/jarvos-cli');
const {
  validateJarvosProfile,
  validateOpenClawProfile,
} = require('../modules/jarvos/src/doctor');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-'));
}

function writeConfig(dir, config) {
  const configPath = path.join(dir, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function makeVault(root, { obsidian = false, journalDir = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  if (journalDir) fs.mkdirSync(path.join(root, 'Journal'), { recursive: true });
  if (obsidian) fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  return root;
}

test('optional GBrain continuity remains visible without blocking portable doctor', () => {
  const staleContinuity = { id: 'gbrain-continuity', state: 'needs your attention' };
  assert.equal(healthModuleBlocksDoctor(staleContinuity, { continuityRequired: false }), false);
  assert.equal(healthModuleBlocksDoctor(staleContinuity, { continuityRequired: true }), true);
  assert.equal(healthModuleBlocksDoctor({ id: 'memory', state: 'needs your attention' }), true);
});

test('vault-path-stale passes for an existing vault root', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkVaultPathStale(configPath);
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.id, 'vault-path-stale');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vault-path-stale fails when the configured vault root is gone', () => {
  const tmp = scratch();
  try {
    const configPath = writeConfig(tmp, { vaultPath: path.join(tmp, 'moved-away') });
    const res = checkVaultPathStale(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /does not exist \(stale or moved vault\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vault-path-stale fails when vaultPath is unset', () => {
  const tmp = scratch();
  try {
    const configPath = writeConfig(tmp, {});
    const res = checkVaultPathStale(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /not configured/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict passes when there is no .obsidian config', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, true, res.detail);
    assert.match(res.detail, /sole journal writer/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict fails when the Obsidian "journals" community plugin is enabled', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['dataview', 'journals']));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /"journals" is enabled/);
    assert.match(res.detail, /SUP-2269/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict fails when core daily-notes writes into the jarvOS Journal folder', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
    fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Journal' }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /daily-notes.*overlapping jarvOS Journal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict ignores a daily-notes folder that does not overlap Journal', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
    fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Daily' }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, true, res.detail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict fails when Periodic Notes daily folder overlaps Journal', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['periodic-notes']));
    const pnDir = path.join(vault, '.obsidian', 'plugins', 'periodic-notes');
    fs.mkdirSync(pnDir, { recursive: true });
    fs.writeFileSync(path.join(pnDir, 'data.json'), JSON.stringify({ daily: { enabled: true, folder: 'Journal' } }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, false);
    assert.match(res.detail, /periodic-notes.*overlapping jarvOS Journal/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict ignores Periodic Notes when its daily folder does not overlap Journal', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['periodic-notes']));
    const pnDir = path.join(vault, '.obsidian', 'plugins', 'periodic-notes');
    fs.mkdirSync(pnDir, { recursive: true });
    fs.writeFileSync(path.join(pnDir, 'data.json'), JSON.stringify({ daily: { enabled: true, folder: 'Daily' } }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, true, res.detail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal-conflict ignores Periodic Notes when its daily section is disabled', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify(['periodic-notes']));
    const pnDir = path.join(vault, '.obsidian', 'plugins', 'periodic-notes');
    fs.mkdirSync(pnDir, { recursive: true });
    fs.writeFileSync(path.join(pnDir, 'data.json'), JSON.stringify({ daily: { enabled: false, folder: 'Journal' } }));
    const configPath = writeConfig(tmp, { vaultPath: vault });
    const res = checkJournalConflict(configPath);
    assert.equal(res.ok, true, res.detail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('assessControlPlaneDoctor distinguishes export, runtime, dependency, and host failures', () => {
  const base = {
    hasCreateService: true,
    hasContextControlPlane: true,
    hasVerifyHost: true,
    compatible: true,
    dependency: true,
    hostConfigured: false,
    hostReady: false,
  };

  assert.deepEqual(assessControlPlaneDoctor(base), {
    ok: true,
    detail: 'public module exports, package dependency, and shared CLI/MCP runtime declarations validated (host service not configured)',
  });

  assert.match(
    assessControlPlaneDoctor({ ...base, hasCreateService: false }).detail,
    /missing public exports \(createControlPlaneService\)/,
  );
  assert.match(
    assessControlPlaneDoctor({ ...base, compatible: false }).detail,
    /Codex runtime must declare the control-plane module/,
  );
  assert.match(
    assessControlPlaneDoctor({ ...base, dependency: false }).detail,
    /@jarvos\/agent-context must depend on @jarvos\/control-plane@0\.1\.0/,
  );
  assert.match(
    assessControlPlaneDoctor({ ...base, hostConfigured: true, hostReady: false }).detail,
    /configure a usable JARVOS_CONTROL_PLANE_SERVICE_MODULE/,
  );
  assert.doesNotMatch(
    assessControlPlaneDoctor({ ...base, compatible: false, hostConfigured: true, hostReady: false }).detail,
    /JARVOS_CONTROL_PLANE_SERVICE_MODULE \(doctor/,
  );
  assert.deepEqual(assessControlPlaneDoctor({ ...base, hostConfigured: true, hostReady: true }), {
    ok: true,
    detail: 'authenticated host service, package dependency, and shared CLI/MCP runtime declarations validated',
  });
});

test('checkControlPlaneModule passes a fresh minimal install without a private host service', () => {
  const previous = process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  try {
    delete process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
    const res = checkControlPlaneModule({ env: { ...process.env } });
    assert.equal(res.ok, true, res.detail);
    assert.match(res.detail, /host service not configured/);
  } finally {
    if (previous === undefined) delete process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
    else process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE = previous;
  }
});

test('Compound Engineering doctor reports a conformance-backed installed provider', () => {
  const res = checkCompoundEngineeringProvider({
    env: { ...process.env },
    codexProviderEvidence: {
      codexAvailable: true,
      codexVersion: '0.146.0',
      marketplaces: [{ name: 'compound-engineering-plugin', revision: 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711' }],
      installed: [{ name: 'compound-engineering', version: '3.21.4', enabled: true }],
    },
  });
  assert.equal(res.ok, true);
  assert.match(res.detail, /healthy/);
  assert.match(res.detail, /approved 3\.21\.4/);
  assert.doesNotMatch(res.detail, /Users\/|tmp\//);
});

test('checkControlPlaneModule fails when a configured host service is unusable', () => {
  const tmp = scratch();
  try {
    const decoy = path.join(tmp, 'not-a-host.js');
    fs.writeFileSync(decoy, 'module.exports = { hello: true };\n', 'utf8');
    const res = checkControlPlaneModule({
      env: { ...process.env, JARVOS_CONTROL_PLANE_SERVICE_MODULE: decoy },
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /configure a usable JARVOS_CONTROL_PLANE_SERVICE_MODULE/);
    assert.equal(res.detail.includes(decoy), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkControlPlaneModule passes when a configured host service is ready', () => {
  const tmp = scratch();
  try {
    const controlPlaneSource = path.join(__dirname, '..', 'modules', 'jarvos-control-plane', 'src', 'index.js');
    const host = path.join(tmp, 'ready-host.js');
    fs.writeFileSync(host, [
      `const { createApplicationService, createMemoryApplicationStore } = require(${JSON.stringify(controlPlaneSource)});`,
      "module.exports = () => createApplicationService({ store: createMemoryApplicationStore(), resolveCredential: () => null, canRead: () => false, policy: () => ({ outcome: 'deny' }) });",
    ].join('\n'), 'utf8');
    const res = checkControlPlaneModule({
      env: { ...process.env, JARVOS_CONTROL_PLANE_SERVICE_MODULE: host },
    });
    assert.equal(res.ok, true, res.detail);
    assert.match(res.detail, /authenticated host service/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function persistenceEvidence(overrides = {}) {
  return {
    status: 'ok',
    evidence: { version: '2026.7.1' },
    summary: { pluginCount: 2, protectedRootCount: 2, driftCount: 0 },
    jarvosAdapter: { status: 'healthy' },
    ...overrides,
  };
}

function persistenceCheck(result) {
  return result.checks.find((check) => check.component === 'openclaw.pluginPersistence');
}

test('local OpenClaw doctor maps healthy, drifted, compatibility, and missing adapter states', async () => {
  const workspaces = [scratch(), scratch(), scratch(), scratch()];
  try {
    const healthy = await validateOpenClawProfile({
      workspace: workspaces[0],
      openclawPluginEvidence: persistenceEvidence(),
    });
    assert.equal(persistenceCheck(healthy).status, 'ok');
    assert.equal(persistenceCheck(healthy).ok, true);

    const drifted = await validateOpenClawProfile({
      workspace: workspaces[1],
      openclawPluginEvidence: persistenceEvidence({
        status: 'warn',
        summary: { pluginCount: 2, protectedRootCount: 2, driftCount: 1 },
      }),
    });
    assert.equal(persistenceCheck(drifted).status, 'warn');
    assert.equal(persistenceCheck(drifted).ok, true);
    assert.match(persistenceCheck(drifted).message, /supported OpenClaw commands/);

    const compatibility = await validateOpenClawProfile({
      workspace: workspaces[2],
      openclawPluginEvidence: { status: 'compatibility', reason: 'unsupported-version' },
    });
    assert.equal(persistenceCheck(compatibility).status, 'skipped');
    assert.doesNotMatch(persistenceCheck(compatibility).message, /unsupported-version/);

    const missingAdapter = await validateOpenClawProfile({
      workspace: workspaces[3],
      openclawPluginEvidence: persistenceEvidence({
        status: 'warn',
        summary: { pluginCount: 2, protectedRootCount: 2, driftCount: 1 },
        jarvosAdapter: { status: 'missing-staged-adapter' },
      }),
    });
    assert.equal(persistenceCheck(missingAdapter).status, 'fail');
    assert.equal(persistenceCheck(missingAdapter).ok, false);

    const indeterminateMissingAdapter = await validateOpenClawProfile({
      workspace: workspaces[3],
      openclawPluginEvidence: persistenceEvidence({
        status: 'indeterminate',
        jarvosAdapter: { status: 'missing-staged-adapter' },
      }),
    });
    assert.equal(persistenceCheck(indeterminateMissingAdapter).status, 'fail');
    assert.equal(persistenceCheck(indeterminateMissingAdapter).ok, false);
  } finally {
    for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('non-local profiles do not invoke OpenClaw plugin persistence assessment', async () => {
  const workspace = scratch();
  try {
    const result = await validateJarvosProfile({
      profile: 'v0-5-0',
      workspace,
      openclawPluginEvidence: persistenceEvidence(),
    });
    assert.equal(result.checks.some((check) => check.component === 'openclaw.pluginPersistence'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('profile doctor honors an explicit config path', async () => {
  const workspace = scratch();
  const externalConfig = path.join(scratch(), 'custom-config.json');
  try {
    writeConfig(workspace, { runtimeAdapters: {} });
    fs.writeFileSync(externalConfig, JSON.stringify({
      runtimeAdapters: { openclaw: { kind: 'openclaw' } },
      skillPacks: { installed: ['local-openclaw'] },
    }, null, 2));

    const result = await validateJarvosProfile({
      profile: 'local-openclaw',
      workspace,
      configPath: externalConfig,
      openclawPluginEvidence: persistenceEvidence(),
    });
    const adapter = result.checks.find((check) => check.component === 'jarvos.openclawAdapter');
    assert.equal(adapter.status, 'ok');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(path.dirname(externalConfig), { recursive: true, force: true });
  }
});

test('profile doctor fails closed when private GBrain continuity is required but evidence is missing', async () => {
  const workspace = scratch();
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    writeConfig(workspace, {
      assistantName: 'Jarvis',
      userName: 'Andrew',
      coachName: 'Coach',
      vaultPath: path.join(workspace, 'vault'),
      workspacePath: workspace,
      runtime: 'codex',
      gbrainContinuity: { required: true },
    });

    const result = await validateJarvosProfile({
      profile: 'v0-5-0',
      workspace,
      commandsPresent: { gbrain: false },
    });
    const continuity = result.checks.find((check) => check.component === 'provider.gbrainContinuity');
    assert.equal(continuity.status, 'fail');
    assert.equal(continuity.required, true);
    assert.deepEqual(continuity.targets.map((target) => target.target), ['codex', 'hermes', 'openclaw']);
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(continuity), /Users\/|jarvos-doctor-/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('profile doctor keeps missing GBrain continuity optional for portable configs', async () => {
  const workspace = scratch();
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    writeConfig(workspace, {
      assistantName: 'Jarvis',
      userName: 'Portable User',
      coachName: 'Coach',
      vaultPath: path.join(workspace, 'vault'),
      workspacePath: workspace,
      runtime: 'codex',
    });

    const result = await validateJarvosProfile({
      profile: 'v0-5-0',
      workspace,
      commandsPresent: { gbrain: false },
    });
    assert.equal(result.checks.some((check) => check.component === 'provider.gbrainContinuity'), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
