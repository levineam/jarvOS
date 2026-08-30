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
  checkVaultPath,
  checkVaultPathStale,
  checkJournalConflict,
  healthModuleBlocksDoctor,
  REQUIRED_WORKSPACE_FILES,
  resolveDoctorContext,
  runCli,
  runDoctor,
  runSync,
  validateConfigShape,
} = require('../lib/jarvos-cli');
const { PATH_ENV_KEYS, buildSharedVaultConfig, resolveConfig } = require('../modules/jarvos-secondbrain/bridge/config');
const {
  defaultKnowledgeDirectory,
  runMinimalDoctor,
  runProfileDoctor,
  resolveOpenClawStateDir,
  resolveStagedOpenClawRuntimeRoot,
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

test('CLI schema validation rejects an invalid portable-config timezone', () => {
  const errors = validateConfigShape({
    paths: { workspace: '/srv/jarvos', vault: '/srv/vault' },
    user: { name: 'Tester', timezone: 'Not/AZone' },
  });
  assert.deepEqual(errors, ['jarvos.config.json.user.timezone must be a valid IANA timezone']);
});

test('public and profile Doctor reject invalid runtime timezone aliases while preserving valid aliases', () => {
  const tmp = fs.realpathSync(scratch());
  const workspace = path.join(tmp, 'workspace');
  const vault = path.join(tmp, 'vault');
  try {
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    for (const directory of ['memory', 'scripts', 'workflows', 'customers']) fs.mkdirSync(path.join(workspace, directory), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');

    const portablePaths = {
      workspace,
      vault,
      notes: path.join(vault, 'Notes'),
      journal: path.join(vault, 'Journal'),
      tags: path.join(vault, 'Tags'),
      memory: path.join(workspace, 'memory'),
      scripts: path.join(workspace, 'scripts'),
      workflows: path.join(workspace, 'workflows'),
      customers: path.join(workspace, 'customers'),
    };
    const aliases = [
      ['timezone', (config) => { config.timezone = 'Not/AZone'; }],
      ['timeZone', (config) => { config.timeZone = 'Not/AZone'; }],
      ['user.timeZone', (config) => { config.user = { name: 'Tester', timeZone: 'Not/AZone' }; }],
    ];

    for (const [field, applyInvalid] of aliases) {
      const config = { paths: portablePaths, user: { name: 'Tester', timezone: 'UTC' } };
      // For user.timeZone, remove the canonical field so it is the one the
      // runtime selects. The top-level aliases are also selected when no
      // canonical user.timezone is present.
      if (field !== 'user.timeZone') config.user = { name: 'Tester' };
      applyInvalid(config);
      writeConfig(workspace, config);

      const publicReport = runDoctor({ profile: 'minimal', workspace, env: {}, homeDir: tmp });
      const publicSchema = publicReport.results.find((entry) => entry.id === 'config-schema');
      assert.equal(publicSchema.ok, false, field);
      assert.match(publicSchema.detail, new RegExp(field.replace('.', '\\.')));
      assert.match(publicSchema.detail, /valid IANA timezone/);

      const profileReport = runMinimalDoctor({ workspace, env: {}, homeDir: tmp });
      const profileSchema = profileReport.checks.find((entry) => entry.component === 'config.schema');
      assert.equal(profileSchema.ok, false, field);
      assert.match(profileSchema.message, new RegExp(field.replace('.', '[./]')));
      assert.match(profileSchema.message, /valid IANA timezone/);
    }

    // Legacy aliases remain supported when valid: neither Doctor reports a
    // schema error, and resolveConfig() resolves the same timezone.
    for (const [field, applyValid] of [
      ['timezone', (config) => { config.timezone = 'America/New_York'; }],
      ['timeZone', (config) => { config.timeZone = 'America/New_York'; }],
      ['user.timeZone', (config) => { config.user.timeZone = 'America/New_York'; }],
    ]) {
      const validAliasConfig = { paths: portablePaths, user: { name: 'Tester' } };
      applyValid(validAliasConfig);
      const configPath = writeConfig(workspace, validAliasConfig);
      assert.equal(validateConfigShape(validAliasConfig).length, 0, field);
      assert.equal(resolveConfig({ configPath, env: {}, homeDir: tmp }).user.timezone, 'America/New_York', field);
      assert.equal(runDoctor({ profile: 'minimal', workspace, env: {}, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema').ok, true, field);
      assert.equal(runMinimalDoctor({ workspace, env: {}, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema').ok, true, field);
    }

    // Match resolveConfig's first-non-empty precedence: lower-priority stale
    // aliases are not selected and therefore must not make either Doctor
    // report an otherwise valid configuration as unhealthy.
    for (const config of [
      {
        paths: portablePaths,
        user: { name: 'Tester', timezone: 'UTC', timeZone: 'Not/AZone' },
        timezone: 'Not/AZone',
        timeZone: 'Not/AZone',
      },
      {
        paths: portablePaths,
        user: { name: 'Tester', timeZone: 'UTC' },
        timezone: 'Not/AZone',
        timeZone: 'Not/AZone',
      },
    ]) {
      const configPath = writeConfig(workspace, config);
      assert.equal(resolveConfig({ configPath, env: {}, homeDir: tmp }).user.timezone, 'UTC');
      assert.equal(runDoctor({ profile: 'minimal', workspace, env: {}, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema').ok, true);
      assert.equal(runMinimalDoctor({ workspace, env: {}, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema').ok, true);
    }

    // A non-empty JARVOS_TIMEZONE wins before every config field. A valid
    // explicit value therefore leaves stale lower-priority config aliases
    // non-blocking, while an invalid explicit value fails both Doctor paths
    // just as resolveUserTimezone() refuses it at runtime.
    const staleConfig = {
      paths: portablePaths,
      user: { name: 'Tester', timezone: 'Not/AZone', timeZone: 'Not/AZone' },
      timezone: 'Not/AZone',
      timeZone: 'Not/AZone',
    };
    const configPath = writeConfig(workspace, staleConfig);
    const validEnv = { JARVOS_TIMEZONE: 'UTC' };
    assert.equal(resolveConfig({ configPath, env: validEnv, homeDir: tmp }).user.timezone, 'UTC');
    assert.equal(runDoctor({ profile: 'minimal', workspace, env: validEnv, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema').ok, true);
    assert.equal(runMinimalDoctor({ workspace, env: validEnv, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema').ok, true);

    const invalidEnv = { JARVOS_TIMEZONE: 'Not/AZone' };
    assert.throws(() => resolveConfig({ configPath, env: invalidEnv, homeDir: tmp }), /invalid IANA timezone/);
    const publicInvalidEnv = runDoctor({ profile: 'minimal', workspace, env: invalidEnv, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema');
    const profileInvalidEnv = runMinimalDoctor({ workspace, env: invalidEnv, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema');
    assert.equal(publicInvalidEnv.ok, false);
    assert.match(publicInvalidEnv.detail, /JARVOS_TIMEZONE.*valid IANA timezone/);
    assert.equal(profileInvalidEnv.ok, false);
    assert.match(profileInvalidEnv.message, /JARVOS_TIMEZONE.*valid IANA timezone/);

    // Omitting options.env follows the runtime process environment; an
    // explicit empty object remains isolated. Restore the process value
    // exactly so this regression cannot affect unrelated tests.
    const hadProcessTimezone = Object.prototype.hasOwnProperty.call(process.env, 'JARVOS_TIMEZONE');
    const previousProcessTimezone = process.env.JARVOS_TIMEZONE;
    try {
      process.env.JARVOS_TIMEZONE = 'UTC';
      assert.equal(runDoctor({ profile: 'minimal', workspace, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema').ok, true);
      assert.equal(runMinimalDoctor({ workspace, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema').ok, true);
      assert.equal(runDoctor({ profile: 'minimal', workspace, env: {}, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema').ok, false);
      assert.equal(runMinimalDoctor({ workspace, env: {}, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema').ok, false);

      process.env.JARVOS_TIMEZONE = 'Not/AZone';
      const omittedPublicInvalid = runDoctor({ profile: 'minimal', workspace, homeDir: tmp }).results.find((entry) => entry.id === 'config-schema');
      const omittedProfileInvalid = runMinimalDoctor({ workspace, homeDir: tmp }).checks.find((entry) => entry.component === 'config.schema');
      assert.equal(omittedPublicInvalid.ok, false);
      assert.match(omittedPublicInvalid.detail, /JARVOS_TIMEZONE.*valid IANA timezone/);
      assert.equal(omittedProfileInvalid.ok, false);
      assert.match(omittedProfileInvalid.message, /JARVOS_TIMEZONE.*valid IANA timezone/);
    } finally {
      if (hadProcessTimezone) process.env.JARVOS_TIMEZONE = previousProcessTimezone;
      else delete process.env.JARVOS_TIMEZONE;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schema validation rejects incomplete portable and empty legacy configs', () => {
  assert.notEqual(validateConfigShape({
    paths: { vault: '/srv/vault' },
    user: { name: 'Tester', timezone: 'UTC' },
  }).length, 0);
  assert.notEqual(validateConfigShape({
    assistantName: '', userName: 'Tester', coachName: 'Coach',
    vaultPath: '/srv/vault', workspacePath: '/srv/workspace', runtime: 'codex',
  }).length, 0);
});

test('vault-path-stale passes for an existing vault root', () => {
  const tmp = scratch();
  try {
    const vault = makeVault(path.join(tmp, 'vault'));
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkVaultPathStale(configPath, { env: {} });
    assert.equal(res.ok, true, res.detail);
    assert.equal(res.id, 'vault-path-stale');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('vault-path-stale fails when the configured vault root is gone', () => {
  const tmp = scratch();
  try {
    const configPath = writeConfig(tmp, { paths: { vault: path.join(tmp, 'moved-away') } });
    const res = checkVaultPathStale(configPath, { env: {} });
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
    const res = checkVaultPathStale(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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
    const configPath = writeConfig(tmp, { paths: { vault } });
    const res = checkJournalConflict(configPath, { env: {} });
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

test('v0-5-0 and local-openclaw profile Doctor honor env-selected workspace and config under the supplied home', async () => {
  const tmp = fs.realpathSync(scratch());
  const homeDir = path.join(tmp, 'custom-home');
  const workspace = path.join(homeDir, 'env-workspace');
  const configPath = path.join(homeDir, 'env-profile-config.json');
  const vault = path.join(homeDir, 'vault');
  try {
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      paths: {
        workspace,
        vault,
        notes: path.join(vault, 'Notes'),
        journal: path.join(vault, 'Journal'),
        tags: path.join(vault, 'Tags'),
        memory: path.join(workspace, 'memory'),
      },
      user: { name: 'Tester', timezone: 'UTC' },
      skillPacks: { installed: ['v0-5-0', 'local-openclaw'] },
      runtimeAdapters: { openclaw: { kind: 'openclaw' } },
    }, null, 2));
    const env = {
      JARVOS_WORKSPACE_PATH: '~/env-workspace',
      JARVOS_CONFIG_PATH: '~/env-profile-config.json',
    };

    const v050 = await runProfileDoctor({
      profile: 'v0-5-0', env, homeDir, commandsPresent: { gbrain: false },
    });
    assert.equal(v050.workspace, workspace);
    assert.equal(v050.checks.find((check) => check.component === 'config.schema').ok, true);
    assert.equal(v050.checks.find((check) => check.component === 'jarvos.skillPack').status, 'ok');

    const local = await runProfileDoctor({
      profile: 'local-openclaw', env, homeDir, commandsPresent: { openclaw: false },
      openclawPluginEvidence: persistenceEvidence(),
    });
    assert.equal(local.workspace, workspace);
    assert.equal(local.checks.find((check) => check.component === 'config.schema').ok, true);
    assert.equal(local.checks.find((check) => check.component === 'jarvos.openclawAdapter').status, 'ok');

    // validateOpenClawProfile has a separate entrypoint but must resolve the
    // same options.env context rather than falling back to cwd/default config.
    const directLocal = await validateOpenClawProfile({
      env, homeDir, commandsPresent: { openclaw: false }, openclawPluginEvidence: persistenceEvidence(),
    });
    assert.equal(directLocal.workspace, workspace);
    assert.equal(directLocal.checks.find((check) => check.component === 'jarvos.openclawAdapter').status, 'ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('minimal Doctor and profile=minimal share explicit/env/cwd context precedence with custom-home expansion', async () => {
  const tmp = fs.realpathSync(scratch());
  const homeDir = path.join(tmp, 'custom-home');
  const workspace = path.join(homeDir, 'minimal-workspace');
  const configPath = path.join(homeDir, 'minimal-config.json');
  const vault = path.join(homeDir, 'vault');
  try {
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    fs.writeFileSync(configPath, JSON.stringify({
      paths: {
        workspace,
        vault,
        notes: path.join(vault, 'Notes'),
        journal: path.join(vault, 'Journal'),
        tags: path.join(vault, 'Tags'),
        memory: path.join(workspace, 'memory'),
      },
      user: { name: 'Tester', timezone: 'UTC' },
    }, null, 2));
    const env = {
      JARVOS_WORKSPACE_PATH: '~/minimal-workspace',
      JARVOS_CONFIG_PATH: '~/minimal-config.json',
    };

    const direct = runMinimalDoctor({ env, homeDir });
    assert.equal(direct.workspace, workspace);
    assert.equal(direct.configPath, configPath);
    assert.equal(direct.checks.find((check) => check.component === 'config.schema').ok, true);

    const profiled = await runProfileDoctor({ profile: 'minimal', env, homeDir });
    assert.equal(profiled.workspace, workspace);
    assert.equal(profiled.configPath, configPath);
    assert.equal(profiled.checks.find((check) => check.component === 'config.schema').ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('public and minimal Doctor visibly require read-only reconciliation for a compatible hybrid config', async () => {
  const tmp = fs.realpathSync(scratch());
  const homeDir = path.join(tmp, 'custom-home');
  const workspace = path.join(homeDir, 'workspace');
  const configPath = path.join(homeDir, 'hybrid-config.json');
  const vault = path.join(homeDir, 'vault');
  try {
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    for (const directory of ['memory', 'scripts', 'workflows', 'customers']) fs.mkdirSync(path.join(workspace, directory), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');

    // This is a hybrid legacy target: its runtime paths are complete and
    // usable, but its identity remains in legacy fields instead of a canonical
    // user object. assessSharedVaultConfigTarget() classifies that exact shape
    // as compatible-but-not-portable, which sync surfaces as manual-reconcile.
    const hybrid = {
      assistantName: 'jarvOS',
      userName: 'Legacy User',
      coachName: 'Coach',
      vaultPath: vault,
      workspacePath: workspace,
      runtime: 'codex',
      timezone: 'UTC',
      paths: {
        workspace,
        vault,
        notes: path.join(vault, 'Notes'),
        journal: path.join(vault, 'Journal'),
        tags: path.join(vault, 'Tags'),
        memory: path.join(workspace, 'memory'),
        scripts: path.join(workspace, 'scripts'),
        workflows: path.join(workspace, 'workflows'),
        customers: path.join(workspace, 'customers'),
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(hybrid, null, 2));
    const originalBytes = fs.readFileSync(configPath);
    const env = {
      JARVOS_WORKSPACE_PATH: '~/workspace',
      JARVOS_CONFIG_PATH: '~/hybrid-config.json',
    };

    const publicReport = runDoctor({ profile: 'minimal', env, homeDir });
    const publicCheck = publicReport.results.find((entry) => entry.id === 'config-reconciliation');
    assert.equal(publicReport.configPath, configPath);
    assert.equal(publicCheck.ok, false, publicCheck.detail);
    assert.match(publicCheck.detail, /manual reconciliation/);
    assert.match(publicCheck.detail, /--config <new-path>/);

    const direct = runMinimalDoctor({ env, homeDir });
    const directCheck = direct.checks.find((entry) => entry.component === 'config.reconciliation');
    assert.equal(direct.configPath, configPath);
    assert.equal(directCheck.ok, false, directCheck.message);
    assert.equal(directCheck.action, 'manual-reconcile');
    assert.equal(directCheck.message, publicCheck.detail, 'both Doctor surfaces must share the same outcome');

    const profiled = await runProfileDoctor({ profile: 'minimal', env, homeDir });
    const profileCheck = profiled.checks.find((entry) => entry.component === 'config.reconciliation');
    assert.equal(profiled.configPath, configPath);
    assert.equal(profileCheck.ok, false, profileCheck.message);
    assert.equal(profileCheck.message, publicCheck.detail);
    assert.deepEqual(fs.readFileSync(configPath), originalBytes, 'Doctor reconciliation check is read-only');

    // A fully portable target is already-synced and remains healthy on every
    // Doctor surface. This uses the same config construction as sync rather
    // than hand-copying the portable path predicate into the test.
    const portable = buildSharedVaultConfig({
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir,
      user: { name: 'Legacy User', timezone: 'UTC' },
    });
    fs.writeFileSync(configPath, JSON.stringify(portable, null, 2));
    const portablePublic = runDoctor({ profile: 'minimal', env, homeDir });
    const portableMinimal = runMinimalDoctor({ env, homeDir });
    assert.equal(portablePublic.results.find((entry) => entry.id === 'config-reconciliation').ok, true);
    assert.equal(portableMinimal.checks.find((entry) => entry.component === 'config.reconciliation').ok, true);

    // A divergent path is a sync conflict, not manual reconciliation. Doctor
    // leaves that shape to its existing config/path diagnostics rather than
    // promising a reconciliation outcome that sync would not offer.
    const conflict = { ...hybrid, paths: { ...hybrid.paths, notes: path.join(tmp, 'other-notes') } };
    fs.mkdirSync(conflict.paths.notes, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(conflict, null, 2));
    const conflictCheck = runMinimalDoctor({ env, homeDir }).checks.find((entry) => entry.component === 'config.reconciliation');
    assert.equal(conflictCheck.ok, true, conflictCheck.message);
    assert.match(conflictCheck.message, /^No compatible legacy configuration requires a Doctor reconciliation recommendation$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('knowledge and memory-wiki checks use the frozen runtime vault, not the configured vault, after env override', () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const configuredVault = path.join(tmp, 'configured-vault');
    const runtimeVault = path.join(tmp, 'runtime-vault');
    for (const vault of [configuredVault, runtimeVault]) {
      for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      paths: { workspace, vault: configuredVault, memory: path.join(workspace, 'memory') },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const knowledgeDir = path.join(runtimeVault, '.jarvos', 'knowledge');
    fs.mkdirSync(path.join(knowledgeDir, 'artifacts'), { recursive: true });
    for (const file of ['gbrain-import-queue.json', 'memory-wiki-queue.json', 'qmd-refresh-pending.json', 'lossless-continuity.json']) {
      fs.writeFileSync(path.join(knowledgeDir, file), '{}\n');
    }

    const report = runMinimalDoctor({
      workspace,
      env: { JARVOS_VAULT_DIR: runtimeVault },
      homeDir: tmp,
    });
    const knowledge = report.checks.find((check) => check.component === 'knowledge.outputs');
    assert.equal(knowledge.status, 'ok', knowledge.message);
    assert.equal(knowledge.path, knowledgeDir);
    const memoryWiki = report.checks.find((check) => check.component === 'memory-wiki.surface');
    assert.equal(memoryWiki.status, 'ok', memoryWiki.message);
    assert.equal(memoryWiki.knowledgeDir, knowledgeDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('profile Obsidian checks inspect the runtime override vault and its derived journal paths', async () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const configuredVault = makeVault(path.join(tmp, 'configured-vault'), { obsidian: true });
    const overrideVault = makeVault(path.join(tmp, 'override-vault'), { obsidian: true });
    for (const vault of [configuredVault, overrideVault]) {
      fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });
    }
    // Only the runtime override has an automated writer. The configured vault
    // remains clean, so a config-only inspection would miss this warning.
    fs.writeFileSync(path.join(overrideVault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      // Deliberately only vault: runtime derives notes/journal from the
      // winning JARVOS_VAULT_DIR and Doctor must do the same.
      paths: { workspace, vault: configuredVault, memory: path.join(workspace, 'memory') },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const report = await validateJarvosProfile({
      profile: 'v0-5-0',
      workspace,
      env: { JARVOS_VAULT_DIR: overrideVault },
      homeDir: tmp,
      commandsPresent: { gbrain: false },
    });
    const singleWriter = report.checks.find((check) => check.component === 'obsidian.singleWriter');
    assert.equal(singleWriter.status, 'warn', singleWriter.message);
    assert.equal(singleWriter.path, overrideVault);
    assert.match(singleWriter.message, /Core Daily Notes/);
    const alignment = report.checks.find((check) => check.component === 'obsidian.paths');
    assert.equal(alignment.path, overrideVault, alignment.message);
    assert.equal(alignment.status, 'ok', alignment.message);
    assert.equal(alignment.skipped, undefined, alignment.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('OpenClaw state and staged runtime resolution honor custom env/home values and explicit precedence', () => {
  const tmp = fs.realpathSync(scratch());
  const homeDir = path.join(tmp, 'custom-home');
  try {
    assert.notEqual(homeDir, os.homedir());
    const env = {
      OPENCLAW_CONFIG_PATH: '~/env-state/openclaw.json',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: '~/env-staged-runtime',
    };
    assert.equal(resolveOpenClawStateDir({ env, homeDir }), path.join(homeDir, 'env-state'));
    assert.equal(resolveStagedOpenClawRuntimeRoot({ env, homeDir }), path.join(homeDir, 'env-staged-runtime'));

    const config = {
      runtimeAdapters: {
        openclaw: {
          stateDir: '~/configured-state',
          stagedRuntimeRoot: '~/configured-staged-runtime',
        },
      },
    };
    assert.equal(resolveOpenClawStateDir({ env, homeDir }, config), path.join(homeDir, 'configured-state'));
    assert.equal(resolveStagedOpenClawRuntimeRoot({ env, homeDir }, config), path.join(homeDir, 'configured-staged-runtime'));
    assert.equal(resolveOpenClawStateDir({ env, homeDir, openclawStateDir: '~/explicit-state' }, config), path.join(homeDir, 'explicit-state'));
    assert.equal(resolveStagedOpenClawRuntimeRoot({ env, homeDir, stagedRuntimeRoot: '~/explicit-staged-runtime' }, config), path.join(homeDir, 'explicit-staged-runtime'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

test('module doctor requires a portable config before reporting legacy runtime paths healthy', () => {
  const workspace = scratch();
  const vault = path.join(workspace, 'vault');
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      assistantName: 'Jarvis',
      userName: 'Legacy User',
      coachName: 'Coach',
      vaultPath: vault,
      workspacePath: workspace,
      runtime: 'codex',
    });

    const result = runMinimalDoctor({ workspace });
    assert.equal(result.checks.find((check) => check.component === 'config.schema').ok, true);
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      assert.equal(result.checks.find((check) => check.component === `path.${key}`).ok, false, key);
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('module doctor rejects a portable config missing required nested paths', () => {
  const workspace = scratch();
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    writeConfig(workspace, {
      paths: { vault: path.join(workspace, 'vault') },
      user: { name: 'Tester', timezone: 'UTC' },
    });
    const result = runMinimalDoctor({ workspace });
    const schema = result.checks.find((check) => check.component === 'config.schema');
    assert.equal(schema.ok, false);
    assert.match(schema.message, /failed .* validation/i);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('schema validation rejects relative and whitespace-only portable config values', () => {
  const relative = validateConfigShape({
    paths: { workspace: 'workspace', vault: 'workspace/vault' },
    user: { name: 'Tester', timezone: 'UTC' },
  });
  assert.deepEqual(relative, [
    'jarvos.config.json.paths.workspace must be an absolute or ~-rooted path the runtime can use',
    'jarvos.config.json.paths.vault must be an absolute or ~-rooted path the runtime can use',
  ]);

  assert.deepEqual(validateConfigShape({
    paths: { workspace: '/srv/jarvos', vault: '/srv/vault' },
    user: { name: ' ', timezone: 'UTC' },
  }), ['jarvos.config.json.user.name must contain at least 1 non-whitespace character']);

  assert.deepEqual(validateConfigShape({
    paths: { workspace: '~/clawd', vault: '~/Vaults/Vault v3' },
    user: { name: 'Tester', timezone: 'UTC' },
  }), []);
});

test('module doctor refuses to call a workspace-relative configured path healthy', () => {
  // resolveConfig() drops relative paths.* and writes to the home-directory
  // defaults instead, so a doctor that resolved them against the workspace
  // would report healthy paths the runtime never touches.
  const workspace = scratch();
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(workspace, 'vault', directory), { recursive: true });
    }
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      paths: {
        workspace: '.',
        vault: 'vault',
        notes: 'vault/Notes',
        journal: 'vault/Journal',
        tags: 'vault/Tags',
        memory: 'memory',
      },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const result = runMinimalDoctor({ workspace });
    assert.equal(result.checks.find((check) => check.component === 'config.schema').ok, false);
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      assert.equal(result.checks.find((entry) => entry.component === `path.${key}`).ok, false, key);
    }

    // A workspace carrying an older schema copy still must not report those
    // paths healthy: the path check itself, not just the schema, is the gate.
    const schemaPath = path.join(workspace, 'jarvos.config.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    for (const definition of Object.values(schema.properties.paths.properties)) delete definition.format;
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

    const relaxed = runMinimalDoctor({ workspace });
    assert.equal(relaxed.checks.find((check) => check.component === 'config.schema').ok, true);
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      const check = relaxed.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(check.ok, false, key);
      assert.match(check.message, /not runtime-effective/);
    }

    // The diagnostic must state what the runtime actually does, which differs
    // between the two roots and the keys derived from them.
    const messageFor = (key) => relaxed.checks.find((entry) => entry.component === `path.${key}`).message;
    assert.match(messageFor('workspace'), /falls back to the home default workspace/);
    assert.match(messageFor('vault'), /falls back to the home default vault/);
    for (const key of ['notes', 'journal', 'tags']) {
      assert.match(messageFor(key), /recomputes it from the resolved vault/, key);
      assert.doesNotMatch(messageFor(key), /home default/, `${key} is not a home-default fallback`);
    }
    assert.match(messageFor('memory'), /recomputes it from the resolved workspace/);
    assert.doesNotMatch(messageFor('memory'), /home default/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('jarvos sync refuses to plan a write on a platform that cannot publish it', () => {
  // Platform is injected rather than mutated on `process`, so this covers the
  // Windows verdict from non-Windows CI.
  // realpath: sync refuses symlinked config path components, and /var is a
  // symlink to /private/var on macOS.
  const tmp = fs.realpathSync(scratch());
  const workspace = path.join(tmp, 'workspace');
  const vault = makeVault(path.join(tmp, 'vault'));
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });
  const syncArgs = ['--workspace', workspace, '--vault', vault, '--name', 'Tester', '--timezone', 'UTC'];

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const capture = () => {
    const out = [];
    const err = [];
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
    return { out, err };
  };

  try {
    // A create that apply could never carry out must not be reported as a plan.
    let { out, err } = capture();
    let code = runSync([...syncArgs, '--dry-run'], process.env, { platform: 'win32' });
    assert.equal(code, 1);
    assert.match(err.join(''), /cannot publish a config on win32/);
    assert.doesNotMatch(out.join(''), /targetAction|DRY RUN/);
    assert.equal(fs.existsSync(workspace), false, 'a refused plan must create nothing');

    // The same refusal, with the same message, when applying.
    ({ out, err } = capture());
    code = runSync(syncArgs, process.env, { platform: 'win32' });
    assert.equal(code, 1);
    assert.match(err.join(''), /cannot publish a config on win32/);
    assert.equal(fs.existsSync(workspace), false);

    // On a supporting platform the same plan is reported normally.
    ({ out, err } = capture());
    code = runSync([...syncArgs, '--dry-run', '--json'], process.env, { platform: 'linux' });
    assert.equal(code, 0, err.join(''));
    assert.equal(JSON.parse(out.join('')).targetAction, 'create');

    // Read-only already-synced inspection needs no write, so it stays available.
    ({ out, err } = capture());
    assert.equal(runSync(syncArgs, process.env, { platform: process.platform }), 0, err.join(''));
    ({ out, err } = capture());
    code = runSync([...syncArgs, '--dry-run', '--json'], process.env, { platform: 'win32' });
    assert.equal(code, 0, err.join(''));
    assert.equal(JSON.parse(out.join('')).targetAction, 'already-synced');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('whitespace-padded configured paths resolve exactly as the runtime resolver', () => {
  // normalizePathMap() trims paths.* before the runtime uses them, so doctor
  // must resolve the same trimmed string rather than treating a padded
  // absolute path as workspace-relative and reporting a phantom failure.
  const tmp = fs.realpathSync(scratch());
  const workspace = path.join(tmp, 'workspace');
  const vault = path.join(tmp, 'vault');
  try {
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(vault, directory), { recursive: true });
    }
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    const pad = (value) => `  ${value}  `;
    const configPath = writeConfig(workspace, {
      paths: {
        workspace: pad(workspace),
        vault: pad(vault),
        notes: pad(path.join(vault, 'Notes')),
        journal: pad(path.join(vault, 'Journal')),
        tags: pad(path.join(vault, 'Tags')),
        memory: pad(path.join(workspace, 'memory')),
      },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const runtime = resolveConfig({ configPath, homeDir: tmp, env: {} });
    assert.equal(runtime.paths.vault, vault, 'runtime resolves the trimmed path');

    // env: {} keeps this cross-check against resolveConfig() deterministic —
    // an ambient JARVOS_* var on the machine running the test must not be
    // able to redirect the runtime-effective path away from the fixture.
    const report = runMinimalDoctor({ workspace, env: {}, homeDir: tmp });
    assert.equal(report.checks.find((check) => check.component === 'config.schema').ok, true);
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      const check = report.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(check.ok, true, `${key}: ${check.message}`);
      assert.equal(check.path, runtime.paths[key], `${key} must resolve exactly as the runtime`);
    }

    const stale = checkVaultPathStale(configPath, { env: {} });
    assert.equal(stale.ok, true, stale.detail);
    const journal = checkJournalConflict(configPath, { env: {} });
    assert.equal(journal.ok, true, journal.detail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('~-rooted configured paths expand against options.homeDir, not the real os.homedir()', () => {
  // GH-248 regression: resolveConfiguredPath()/runtimeConfiguredPath() must
  // expand `~` using the homeDir threaded in from options, matching the home
  // resolveConfig() itself is given. A fixed real-machine os.homedir() fallback
  // would silently expand these paths.* values under the machine running the
  // test instead of the isolated fixture home below, so this must fail if that
  // fallback is ever reintroduced.
  const tmp = fs.realpathSync(scratch());
  const customHome = path.join(tmp, 'custom-home');
  const workspace = path.join(tmp, 'workspace');
  try {
    assert.notEqual(customHome, os.homedir(), 'the fixture home must differ from the real machine home');
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(customHome, 'vault', directory), { recursive: true });
    }
    fs.mkdirSync(path.join(customHome, 'memory'), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      paths: {
        workspace: '~',
        vault: '~/vault',
        notes: '~/vault/Notes',
        journal: '~/vault/Journal',
        tags: '~/vault/Tags',
        memory: '~/memory',
      },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    // env: {} keeps this deterministic against ambient JARVOS_* vars.
    const report = runMinimalDoctor({ workspace, env: {}, homeDir: customHome });
    assert.equal(report.checks.find((check) => check.component === 'config.schema').ok, true);
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      const check = report.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(check.ok, true, `${key}: ${check.message}`);
      const isUnderCustomHome = check.path === customHome || check.path.startsWith(customHome + path.sep);
      assert.ok(isUnderCustomHome, `${key} must resolve under the fixture home, got ${check.path}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('minimal Doctor expands an explicit ~/ config path and ~/ obsidianVault against options.homeDir', () => {
  // These are Doctor command options, not paths read from jarvos.config.json.
  // They therefore need their own custom-home coverage in addition to the
  // configured-path regression above.
  const tmp = fs.realpathSync(scratch());
  const customHome = path.join(tmp, 'custom-home');
  const workspace = path.join(tmp, 'workspace');
  try {
    assert.notEqual(customHome, os.homedir(), 'the fixture home must differ from the real machine home');
    fs.mkdirSync(workspace, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');

    const configDir = path.join(customHome, 'config');
    const vault = path.join(customHome, 'configured-vault');
    const activeObsidianVault = path.join(customHome, 'active-obsidian-vault');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(vault, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(activeObsidianVault, '.obsidian'), { recursive: true });
    const configPath = writeConfig(configDir, {
      paths: {
        workspace,
        vault,
        notes: path.join(vault, 'Notes'),
        journal: path.join(vault, 'Journal'),
        tags: path.join(vault, 'Tags'),
        memory: path.join(workspace, 'memory'),
      },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const report = runMinimalDoctor({
      workspace,
      configPath: '~/config/jarvos.config.json',
      obsidianVault: '~/active-obsidian-vault',
      env: {},
      homeDir: customHome,
    });
    assert.equal(report.configPath, configPath);
    assert.equal(report.checks.find((check) => check.component === 'config.schema').ok, true);
    const obsidian = report.checks.find((check) => check.component === 'obsidian.paths');
    assert.equal(obsidian.path, activeObsidianVault, obsidian.message);
    assert.equal(obsidian.status, 'warn', obsidian.message);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('minimal Doctor captures one immutable runtime-config snapshot for all required path checks', () => {
  // The resolver seam makes this deterministic: a faulty implementation that
  // resolves once per key would obtain different paths on each invocation.
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const vault = path.join(tmp, 'vault');
    const alternate = path.join(tmp, 'alternate');
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    for (const root of [vault, alternate]) {
      for (const directory of ['Notes', 'Journal', 'Tags']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
      }
    }
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    const configPath = writeConfig(workspace, {
      paths: {
        workspace,
        vault,
        notes: path.join(vault, 'Notes'),
        journal: path.join(vault, 'Journal'),
        tags: path.join(vault, 'Tags'),
        memory: path.join(workspace, 'memory'),
      },
      user: { name: 'Tester', timezone: 'UTC' },
    });
    let calls = 0;
    const runtimeConfigResolver = (received) => {
      calls += 1;
      assert.equal(received.configPath, configPath);
      assert.equal(received.homeDir, tmp);
      assert.deepEqual(received.env, {});
      const runtimeVault = calls === 1 ? vault : alternate;
      return {
        paths: {
          workspace,
          vault: runtimeVault,
          notes: path.join(runtimeVault, 'Notes'),
          journal: path.join(runtimeVault, 'Journal'),
          tags: path.join(runtimeVault, 'Tags'),
          memory: path.join(workspace, 'memory'),
        },
      };
    };

    const report = runMinimalDoctor({
      workspace,
      env: {},
      homeDir: tmp,
      runtimeConfigResolver,
    });
    assert.equal(calls, 1, 'all required-path checks must share one resolver call');
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      const check = report.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(check.ok, true, `${key}: ${check.message}`);
      assert.equal(check.status, 'ok', `${key}: ${check.message}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI vault checks refuse to inspect a relative paths.vault the runtime ignores', () => {
  // resolveConfig() drops a relative paths.* value and falls back to the home
  // default.  A CLI check that resolved it against cwd could report a healthy
  // vault the runtime never writes to, so stage one that WOULD look healthy
  // from cwd and prove none of the three checks inspects it.
  const tmp = fs.realpathSync(scratch());
  const originalCwd = process.cwd();
  try {
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(tmp, 'vault', directory), { recursive: true });
    }
    const configPath = writeConfig(tmp, { paths: { vault: 'vault' } });
    process.chdir(tmp);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'vault', 'Notes')), true, 'the cwd-relative vault must be reachable');

    const vaultPath = checkVaultPath(configPath, { env: {} });
    assert.equal(vaultPath.ok, false, vaultPath.detail);
    assert.match(vaultPath.detail, /runtime-effective/);

    const stale = checkVaultPathStale(configPath, { env: {} });
    assert.equal(stale.ok, false, stale.detail);
    assert.match(stale.detail, /runtime-effective/);

    // journal-conflict delegates the failure to vault-path-stale and skips
    // rather than claiming a clean vault it never looked at.
    const journal = checkJournalConflict(configPath, { env: {} });
    assert.equal(journal.ok, true, journal.detail);
    assert.match(journal.detail, /no vault to inspect/);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI vault checks accept whitespace-padded absolute and ~-rooted vault paths', () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const vault = path.join(tmp, 'vault');
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(vault, directory), { recursive: true });
    }
    const padded = writeConfig(tmp, { paths: { vault: `  ${vault}  ` } });
    assert.equal(checkVaultPath(padded, { env: {} }).ok, true, checkVaultPath(padded, { env: {} }).detail);
    assert.equal(checkVaultPathStale(padded, { env: {} }).ok, true, checkVaultPathStale(padded, { env: {} }).detail);
    assert.equal(checkJournalConflict(padded, { env: {} }).ok, true, checkJournalConflict(padded, { env: {} }).detail);

    // A padded ~-rooted path must pass the gate and be judged on existence,
    // not rejected as non-runtime-effective.  This one deliberately does not
    // exist, so no real vault is read.
    fs.mkdirSync(path.join(tmp, 'tilde'), { recursive: true });
    const tilde = writeConfig(path.join(tmp, 'tilde'), { paths: { vault: '  ~/jarvos-nonexistent-fixture-vault  ' } });
    const stale = checkVaultPathStale(tilde, { env: {} });
    assert.equal(stale.ok, false);
    assert.doesNotMatch(stale.detail, /runtime-effective/);
    assert.match(stale.detail, /does not exist \(stale or moved vault\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync never inherits a configured vault the runtime would ignore', () => {
  // A relative paths.vault would be anchored to process.cwd(), so the directory
  // sync happens to run from could repoint the config.  Stage exactly that cwd
  // and prove it cannot.
  const tmp = fs.realpathSync(scratch());
  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const out = [];
  const err = [];
  try {
    const workspace = path.join(tmp, 'workspace');
    const realVault = path.join(tmp, 'real-vault');
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(realVault, directory), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'vault', directory), { recursive: true });
    }
    fs.mkdirSync(workspace, { recursive: true });
    // A relative paths.vault plus a relative legacy vaultPath: neither is
    // runtime-effective, so neither may be inherited.  A *usable* legacy
    // vaultPath is a separate, supported case covered below.
    fs.writeFileSync(path.join(workspace, 'jarvos.config.json'), JSON.stringify({
      paths: { vault: 'vault', workspace: 'workspace' },
      vaultPath: 'vault',
      user: { name: 'Tester', timezone: 'UTC' },
    }));
    process.chdir(tmp);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'vault', 'Notes')), true, 'the cwd-relative vault must be reachable');

    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };

    // No --vault, and HOME points at a home with no discoverable vault: the
    // command must demand an explicit vault rather than adopt cwd/vault or the
    // legacy vaultPath.
    const code = runSync(['--workspace', workspace, '--dry-run', '--json'], { ...process.env, HOME: tmp });
    assert.equal(code, 1, out.join(''));
    assert.match(err.join(''), /No existing jarvOS vault was found; pass --vault explicitly/);
    assert.equal(out.join(''), '');

    // With an explicit vault, the relative config is never treated as already
    // matching it: it is refused rather than silently left pointing at the
    // cwd-relative vault or the legacy field.
    out.length = 0;
    err.length = 0;
    assert.equal(runSync(
      ['--workspace', workspace, '--vault', realVault, '--dry-run', '--json'],
      { ...process.env, HOME: tmp },
    ), 1, out.join(''));
    assert.match(err.join(''), /Refusing to overwrite an existing jarvos\.config\.json/);

    // A workspace without a conflicting config plans against the explicit
    // vault, confirming the refusal above is about the config, not the vault.
    const freshWorkspace = path.join(tmp, 'fresh-workspace');
    out.length = 0;
    err.length = 0;
    assert.equal(runSync(
      ['--workspace', freshWorkspace, '--vault', realVault, '--name', 'Tester', '--timezone', 'UTC', '--dry-run', '--json'],
      { ...process.env, HOME: tmp },
    ), 0, err.join(''));
    const plan = JSON.parse(out.join(''));
    assert.equal(plan.vault, realVault);
    assert.equal(plan.targetAction, 'create');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.chdir(originalCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('configured ~-rooted vault paths expand exactly as the runtime resolver', () => {
  // The runtime's expandTilde accepts both ~/ and ~\ forms, and isUsablePath
  // gates on it, so the CLI and module doctors must expand with the same helper
  // or a gate-accepted value resolves to something the runtime never uses.
  // These fixtures deliberately do not exist, so no real vault is read.
  const tmp = fs.realpathSync(scratch());
  try {
    for (const configured of ['~/jarvos-nonexistent-fixture-vault', '~\\jarvos-nonexistent-fixture-vault']) {
      const workspace = path.join(tmp, Buffer.from(configured).toString('hex'));
      fs.mkdirSync(workspace, { recursive: true });
      const configPath = writeConfig(workspace, {
        paths: { workspace, vault: configured },
        user: { name: 'Tester', timezone: 'UTC' },
      });
      const runtime = resolveConfig({ configPath, homeDir: os.homedir(), env: {} });

      const stale = checkVaultPathStale(configPath, { env: {} });
      assert.equal(stale.ok, false);
      assert.doesNotMatch(stale.detail, /runtime-effective/, `${configured} must pass the gate`);
      assert.match(stale.detail, /does not exist \(stale or moved vault\)/);
      assert.ok(
        stale.detail.endsWith(runtime.paths.vault),
        `${configured}: CLI resolved ${JSON.stringify(stale.detail)} but runtime resolved ${JSON.stringify(runtime.paths.vault)}`,
      );

      fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
      // env: {} matches the resolveConfig() call above — this test deliberately
      // expands ~ against the real os.homedir() for tilde/runtime parity, but
      // an ambient JARVOS_* var on the machine running the test must still not
      // be able to redirect the runtime-effective path away from the fixture.
      const report = runMinimalDoctor({ workspace, env: {}, homeDir: os.homedir() });
      const vaultCheck = report.checks.find((check) => check.component === 'path.vault');
      assert.equal(vaultCheck.ok, false);
      assert.doesNotMatch(vaultCheck.message, /not runtime-effective/, `${configured} must pass the gate`);
      assert.equal(vaultCheck.path, runtime.paths.vault, `${configured}: module doctor must match the runtime`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the unusable-vault-path remediation directs unusable paths to a separate portable config', () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const configPath = writeConfig(tmp, { paths: { vault: 'vault' } });
    for (const check of [checkVaultPath(configPath, { env: {} }), checkVaultPathStale(configPath, { env: {} })]) {
      assert.equal(check.ok, false);
      // sync refuses a conflicting existing config rather than rewriting it.
      assert.doesNotMatch(check.detail, /sync to migrate/);
      assert.match(check.detail, /absolute or ~-rooted/);
      assert.match(check.detail, /Edit jarvos\.config\.json/);
      assert.match(check.detail, /--config/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sync reports manual reconciliation for a legacy config, preserves its bytes, and can create a separate portable config', () => {
  // A legacy bootstrap config still selects its recorded vault rather than a
  // discoverable canonical alternative, but the existing config is read-only.
  const tmp = fs.realpathSync(scratch());
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const out = [];
  const err = [];
  try {
    const workspace = path.join(tmp, 'legacy-workspace');
    const legacyVault = path.join(tmp, 'legacy-vault');
    // A discoverable canonical vault under HOME that must NOT win.
    const canonicalVault = path.join(tmp, 'Vaults', 'Vault v3');
    for (const vault of [legacyVault, canonicalVault]) {
      for (const directory of ['Notes', 'Journal', 'Tags']) {
        fs.mkdirSync(path.join(vault, directory), { recursive: true });
      }
    }
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'jarvos.config.json'), JSON.stringify({
      assistantName: 'jarvOS',
      userName: 'Legacy User',
      coachName: 'Coach',
      vaultPath: legacyVault,
      workspacePath: workspace,
      runtime: 'codex',
    }));

    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };

    // No --vault: the legacy vaultPath selects the vault, not discovery.
    const code = runSync(
      ['--workspace', workspace, '--timezone', 'UTC', '--dry-run', '--json'],
      { ...process.env, HOME: tmp },
    );
    assert.equal(code, 0, err.join(''));
    const plan = JSON.parse(out.join(''));
    assert.equal(plan.vault, legacyVault);
    assert.notEqual(plan.vault, canonicalVault);
    assert.equal(plan.targetAction, 'manual-reconcile');
    assert.equal(plan.manualReconciliation, true);
    assert.equal(plan.config.userName, 'Legacy User', 'the read-only diagnostic returns the existing legacy identity');
    const legacyBytes = fs.readFileSync(path.join(workspace, 'jarvos.config.json'));

    // Applying against the existing legacy target refuses before mutation.
    out.length = 0;
    err.length = 0;
    assert.equal(runSync(
      ['--workspace', workspace, '--timezone', 'UTC'],
      { ...process.env, HOME: tmp },
    ), 1);
    assert.match(err.join(''), /Cannot automatically migrate the existing config/);
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'jarvos.config.json')), legacyBytes);

    // The documented remedy writes only a separate new target.
    const portableConfig = path.join(tmp, 'portable', 'jarvos.config.json');
    out.length = 0;
    err.length = 0;
    assert.equal(runSync(
      ['--workspace', workspace, '--config', portableConfig, '--vault', legacyVault, '--name', 'Legacy User', '--timezone', 'UTC', '--json'],
      { ...process.env, HOME: tmp },
    ), 0, err.join(''));
    const created = JSON.parse(out.join(''));
    assert.equal(created.targetAction, 'create');
    assert.equal(created.changed, true);
    const portable = JSON.parse(fs.readFileSync(portableConfig, 'utf8'));
    assert.equal(portable.paths.vault, legacyVault);
    assert.equal(portable.paths.journal, path.join(legacyVault, 'Journal'));
    assert.equal(portable.user.name, 'Legacy User');
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'jarvos.config.json')), legacyBytes);
    // The vault itself is never written to.
    assert.deepEqual(fs.readdirSync(legacyVault).sort(), ['Journal', 'Notes', 'Tags']);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manual-reconcile payload preserves legacy extension fields and apply preserves legacy bytes', () => {
  // A diagnostic plan must expose the actual untouched legacy object, including
  // extension fields, without implying those bytes will be rewritten.
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'legacy-workspace');
    const legacyVault = path.join(tmp, 'legacy-vault');
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(legacyVault, directory), { recursive: true });
    }
    fs.mkdirSync(workspace, { recursive: true });
    const legacyConfig = {
      assistantName: 'jarvOS',
      runtime: 'codex',
      userName: 'Legacy User',
      vaultPath: legacyVault,
      workspacePath: workspace,
      paths: { extraPathField: 'keep-me' },
    };
    fs.writeFileSync(path.join(workspace, 'jarvos.config.json'), JSON.stringify(legacyConfig, null, 2));

    const syncArgs = ['--workspace', workspace, '--timezone', 'UTC', '--json'];

    const dryRunOut = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { dryRunOut.push(String(chunk)); return true; };
    let code;
    try {
      code = runSync([...syncArgs, '--dry-run'], { ...process.env, HOME: tmp });
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
    assert.equal(code, 0, dryRunOut.join(''));
    const plan = JSON.parse(dryRunOut.join(''));
    assert.equal(plan.targetAction, 'manual-reconcile');
    assert.equal(plan.manualReconciliation, true);
    assert.equal(plan.config.assistantName, 'jarvOS', 'plan must preserve the unrecognised top-level field');
    assert.equal(plan.config.runtime, 'codex', 'plan must preserve the unrecognised top-level field');
    assert.equal(plan.config.paths.extraPathField, 'keep-me', 'plan must preserve the unrecognised paths field');
    assert.equal(plan.config.vaultPath, legacyVault);
    assert.equal(plan.config.userName, 'Legacy User');
    const legacyBytes = fs.readFileSync(path.join(workspace, 'jarvos.config.json'));
    assert.deepEqual(JSON.parse(legacyBytes.toString('utf8')), legacyConfig);

    const applyOut = [];
    const applyErr = [];
    process.stdout.write = (chunk) => { applyOut.push(String(chunk)); return true; };
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { applyErr.push(String(chunk)); return true; };
    try {
      code = runSync(syncArgs, { ...process.env, HOME: tmp });
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
    assert.equal(code, 1);
    assert.equal(applyOut.join(''), '');
    assert.match(applyErr.join(''), /Cannot automatically migrate the existing config/);
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'jarvos.config.json')), legacyBytes);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('doctor consumers never inspect workspace-relative paths the runtime drops', () => {
  // Stage a complete workspace-relative tree — an .obsidian vault, a knowledge
  // directory and a memory-wiki surface — that a workspace-resolving consumer
  // would happily find and report on.  normalizePathMap() drops every one of
  // these configured values, so none of them may be inspected.
  const tmp = fs.realpathSync(scratch());
  const workspace = path.join(tmp, 'workspace');
  const homeDir = path.join(tmp, 'home');
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    for (const directory of ['Notes', 'Journal', 'Tags', '.obsidian']) {
      fs.mkdirSync(path.join(workspace, 'vault', directory), { recursive: true });
    }
    fs.mkdirSync(path.join(workspace, 'vault', '.jarvos', 'knowledge', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'wiki'), { recursive: true });
    writeConfig(workspace, {
      paths: {
        workspace: '.',
        vault: 'vault',
        notes: 'vault/Notes',
        journal: 'vault/Journal',
        tags: 'vault/Tags',
        memory: 'memory',
        memoryWiki: 'wiki',
      },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    // Relax the workspace schema copy so the per-check diagnostics run rather
    // than being short-circuited by the schema failure.
    const schemaPath = path.join(workspace, 'jarvos.config.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    for (const definition of Object.values(schema.properties.paths.properties)) delete definition.format;
    fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));

    // env: {} and an isolated homeDir keep this deterministic — an ambient
    // JARVOS_* var or the real machine home must not be able to make a
    // workspace-relative path look runtime-effective.
    const report = runMinimalDoctor({ workspace, env: {}, homeDir });
    const check = (component) => report.checks.find((entry) => entry.component === component);

    // resolveObsidianVault must not adopt the workspace-relative vault: with no
    // other .obsidian tree there is simply no active vault to align against.
    const obsidian = check('obsidian.paths');
    assert.equal(obsidian.status, 'skipped', obsidian.message);
    assert.match(obsidian.message, /No active Obsidian vault config found/);
    assert.notEqual(obsidian.path, path.join(workspace, 'vault'));

    // memory-wiki.surface: fails truthfully instead of finding workspace/wiki.
    const memoryWiki = check('memory-wiki.surface');
    assert.equal(memoryWiki.ok, false, memoryWiki.message);
    assert.match(memoryWiki.message, /paths\.memoryWiki must be absolute or ~-rooted/);
    assert.doesNotMatch(memoryWiki.message, /Found configured memory-wiki surface/);

    // knowledge.outputs: anchored to the workspace default, never to the
    // workspace-relative vault tree staged above.
    const knowledge = check('knowledge.outputs');
    assert.equal(knowledge.path, path.join(workspace, '.jarvos', 'knowledge'));
    assert.notEqual(knowledge.path, path.join(workspace, 'vault', '.jarvos', 'knowledge'));

    // The per-path checks still own the failure.
    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      assert.equal(check(`path.${key}`).ok, false, key);
    }

    // With an active Obsidian vault found another way, alignment is skipped
    // with a per-key reason rather than compared against ignored values.
    fs.mkdirSync(path.join(workspace, '.obsidian'), { recursive: true });
    const aligned = runMinimalDoctor({ workspace, env: {}, homeDir }).checks.find((entry) => entry.component === 'obsidian.paths');
    assert.equal(aligned.status, 'skipped', aligned.message);
    assert.equal(aligned.path, workspace);
    for (const key of ['vault', 'journal', 'notes']) {
      assert.match(aligned.message, new RegExp(`paths\\.${key} is not runtime-effective`), key);
    }
    assert.doesNotMatch(aligned.message, /points at|points outside/, 'no comparison against ignored values');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('unusable vault remediation matches what sync will actually do', () => {
  const tmp = fs.realpathSync(scratch());
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  try {
    const legacyVault = makeVault(path.join(tmp, 'legacy-vault'));
    fs.mkdirSync(path.join(legacyVault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(legacyVault, 'Tags'), { recursive: true });

    // Every fixture states the shape, the flags its separate-config remedy
    // must name, and whether it can truthfully be classified as a compatible
    // legacy target requiring manual reconciliation.
    const fixtures = [
      {
        id: 'legacy-complete',
        config: { vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC' },
        migratable: true,
        flags: [],
      },
      {
        id: 'legacy-no-timezone',
        config: { vaultPath: legacyVault, userName: 'Legacy User' },
        migratable: true,
        flags: ['--timezone Area/City'],
      },
      {
        id: 'legacy-bare',
        config: { vaultPath: legacyVault },
        migratable: true,
        flags: ['--name "Your Name"', '--timezone Area/City'],
      },
      // Present-but-unusable identity: sync inherits and compares those fields,
      // so they can never match a supplied placeholder — this is a conflict,
      // not a compatible manual-reconcile target.
      {
        id: 'blank-name-bad-zone',
        config: { vaultPath: legacyVault, userName: '   ', user: { timeZone: 'Not/AZone' } },
        migratable: false,
      },
      {
        id: 'empty-name-is-absent',
        config: { vaultPath: legacyVault, userName: '' },
        migratable: true,
        flags: ['--name "Your Name"', '--timezone Area/City'],
      },
      {
        id: 'legacy-config-elsewhere',
        config: { vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC' },
        configElsewhere: true,
        migratable: true,
        flags: ['--config <config>'],
      },
      // These are not compatible legacy targets: Doctor must not promise a
      // manual-reconcile outcome when sync would instead refuse a conflict.
      { id: 'no-workspace-path', config: { vaultPath: legacyVault }, omitWorkspacePath: true, migratable: false },
      { id: 'relative-workspace-path', config: { vaultPath: legacyVault, workspacePath: 'legacy-ws' }, keepWorkspacePath: true, migratable: false },
      { id: 'relative-vault-path', config: { vaultPath: 'legacy-vault' }, migratable: false },
      { id: 'relative-portable-vault', config: { paths: { vault: 'vault' }, vaultPath: legacyVault }, migratable: false },
      // A partial portable paths.* that has nothing to do with paths.vault:
      // hasConfiguredVault is still false here, so this reaches the
      // compatibility comparison, but a recorded value that disagrees with
      // what buildSharedVaultConfig() would compute from the legacy
      // vaultPath/workspacePath makes isCompatibleSharedVaultConfig() report
      // a conflict, not a compatible manual-reconcile target. Two representative keys — one derived
      // from the workspace (memory), one from the vault (notes) — cover both
      // halves of resolvedConfigPaths().
      {
        id: 'divergent-portable-memory',
        config: {
          vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC', paths: { memory: path.join(tmp, 'elsewhere-memory') },
        },
        migratable: false,
      },
      {
        id: 'divergent-portable-notes',
        config: {
          vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC', paths: { notes: path.join(tmp, 'elsewhere-notes') },
        },
        migratable: false,
      },
      // A recorded workspace spelling that differs from runSync()'s normalized
      // --workspace value is a conflict, not a manual-reconcile target.
      {
        id: 'workspace-trailing-slash',
        config: { vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC' },
        workspacePathVariant: (workspace) => `${workspace}${path.sep}`,
        migratable: false,
      },
      {
        id: 'workspace-dot-segment',
        config: { vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC' },
        workspacePathVariant: (workspace) => `${path.dirname(workspace)}${path.sep}.${path.sep}${path.basename(workspace)}`,
        migratable: false,
      },
      {
        id: 'workspace-doubled-separator',
        config: { vaultPath: legacyVault, userName: 'Legacy User', timezone: 'UTC' },
        workspacePathVariant: (workspace) => `${path.dirname(workspace)}${path.sep}${path.sep}${path.basename(workspace)}`,
        migratable: false,
      },
    ];

    for (const fixture of fixtures) {
      const workspace = path.join(tmp, fixture.id);
      fs.mkdirSync(workspace, { recursive: true });
      const raw = { ...fixture.config };
      if (!fixture.omitWorkspacePath && !fixture.keepWorkspacePath) {
        raw.workspacePath = fixture.workspacePathVariant ? fixture.workspacePathVariant(workspace) : workspace;
      }
      const configDir = fixture.configElsewhere ? path.join(tmp, `${fixture.id}-config`) : workspace;
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = writeConfig(configDir, raw);

      const detail = checkVaultPath(configPath, { env: {} }).detail;
      assert.equal(checkVaultPathStale(configPath, { env: {} }).detail, detail, `${fixture.id}: both checks share one verdict`);

      if (!fixture.migratable) {
        assert.doesNotMatch(detail, /manual reconciliation/, `${fixture.id}: must not promise manual reconciliation`);
        assert.match(detail, /absolute or ~-rooted/, fixture.id);
        if (fixture.workspacePathVariant) {
          // Not just the message: prove a real sync run against the exact
          // recorded (un-normalized) workspacePath also refuses as a
          // conflict, never reports manual reconciliation — the un-normalized existing
          // value can never compare equal to the path.resolve()-normalized
          // expected value runSync() builds from --workspace, however that
          // flag is spelled. A 'conflict' verdict throws before --dry-run is
          // even consulted, so this is a plain exit-1 refusal, not JSON.
          const out = [];
          const err = [];
          process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
          process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
          let code;
          try {
            code = runSync(
              ['--workspace', workspace, '--name', 'Legacy User', '--timezone', 'UTC', '--dry-run', '--json'],
              { ...process.env, HOME: tmp },
            );
          } finally {
            process.stdout.write = originalStdoutWrite;
            process.stderr.write = originalStderrWrite;
          }
          assert.equal(code, 1, `${fixture.id}: a real sync run must refuse this exactly like the detail message says`);
          assert.match(err.join(''), /Refusing to overwrite an existing jarvos\.config\.json/, fixture.id);
          assert.equal(out.join(''), '', fixture.id);
        }
        continue;
      }

      assert.match(detail, /legacy config records a usable vaultPath/i, fixture.id);
      assert.match(detail, /manual reconciliation/, fixture.id);
      assert.match(detail, /--config <new-path>/, fixture.id);
      assert.doesNotMatch(detail, /migrate it in place/, fixture.id);
      for (const flag of ['--name "Your Name"', '--timezone Area/City']) {
        const expected = (fixture.flags || []).includes(flag);
        assert.equal(detail.includes(flag), expected, `${fixture.id}: ${flag} should be ${expected ? 'present' : 'absent'}`);
      }

      // The claim must be true: the existing target reports the same read-only
      // manual-reconcile action without modifying its bytes.
      const argv = ['--workspace', workspace];
      if (fixture.configElsewhere) argv.push('--config', configPath);
      if ((fixture.flags || []).includes('--name "Your Name"')) argv.push('--name', 'Your Name');
      if ((fixture.flags || []).includes('--timezone Area/City')) argv.push('--timezone', 'UTC');
      const out = [];
      const err = [];
      process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
      process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
      let code;
      try {
        code = runSync([...argv, '--dry-run', '--json'], { ...process.env, HOME: tmp });
      } finally {
        process.stdout.write = originalStdoutWrite;
        process.stderr.write = originalStderrWrite;
      }
      assert.equal(code, 0, `${fixture.id}: ${err.join('')}`);
      const plan = JSON.parse(out.join(''));
      assert.equal(plan.targetAction, 'manual-reconcile', `${fixture.id}: remediation must actually report manual reconciliation`);
      assert.equal(plan.manualReconciliation, true, fixture.id);
      assert.equal(plan.vault, legacyVault, fixture.id);
    }
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('obsidian.paths reports vault drift even when notes and journal are absent', () => {
  // paths.notes/journal are optional under the schema, so their absence must
  // not suppress drift reporting for a runtime-effective paths.vault.
  const workspace = fs.realpathSync(scratch());
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    // The active Obsidian vault is the workspace; the configured vault is a
    // different, absolute, existing directory — genuine drift.
    fs.mkdirSync(path.join(workspace, '.obsidian'), { recursive: true });
    const staleVault = makeVault(path.join(workspace, 'stale-vault'));
    writeConfig(workspace, {
      paths: { workspace, vault: staleVault },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    // env: {} keeps the paths.vault cross-check against resolveConfig()
    // deterministic; an ambient JARVOS_VAULT_DIR would otherwise redirect the
    // runtime-effective vault away from this fixture's staleVault.
    const report = runMinimalDoctor({ workspace, env: {} });
    const obsidian = report.checks.find((entry) => entry.component === 'obsidian.paths');
    assert.equal(obsidian.status, 'warn', obsidian.message);
    assert.deepEqual(obsidian.stale, [`paths.vault points at ${staleVault}`]);
    // With an active runtime-effective vault, resolveConfig() derives the
    // absent optional siblings from that vault. Doctor must inspect those same
    // derived paths rather than treating them as absent config values.
    assert.equal(obsidian.skipped, undefined);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

for (const { key, envVar } of [
  { key: 'vault', envVar: 'JARVOS_VAULT_DIR' },
  { key: 'workspace', envVar: 'JARVOS_WORKSPACE_DIR' },
  { key: 'journal', envVar: 'JARVOS_JOURNAL_DIR' },
  { key: 'notes', envVar: 'JARVOS_NOTES_DIR' },
  // Legacy aliases (PATH_ENV_KEYS carries these alongside the JARVOS_* names)
  // must be named exactly, too — not folded into a generic "JARVOS_*" claim,
  // and never the removed "a runtime environment override" fallback: with
  // the configured value already usable and unset in env, winningPathEnvKey()
  // always has a concrete key to report for a direct override (see
  // doctor.js's validateConfiguredDirectory — no other divergence is possible
  // here, so there is no cascading case to construct a test for).
  { key: 'notes', envVar: 'VAULT_NOTES_DIR' },
  { key: 'workspace', envVar: 'CLAWD_DIR' },
  { key: 'journal', envVar: 'JOURNAL_DIR' },
]) {
  test(`path.${key} reports a visible warn — not plain ok — when a ${envVar} override redirects the runtime, and still fails when the override is missing`, () => {
    // resolveConfig() lets a JARVOS_* env var override paths.* entirely; a
    // check that only ever inspects the configured value can report a healthy
    // path the runtime does not actually use, or miss that the runtime's real
    // (overridden) path is broken. An override that exists is not a runtime
    // failure, but it IS drift between jarvos.config.json and what actually
    // runs, so it must stay visibly a warning rather than collapsing to plain
    // ok. Both homeDir and env are isolated fixtures here, never the real
    // machine's.
    const tmp = fs.realpathSync(scratch());
    try {
      const workspace = path.join(tmp, 'workspace');
      const configuredVault = path.join(tmp, 'configured-vault');
      const overrideDir = path.join(tmp, `override-${key}`);
      fs.mkdirSync(overrideDir, { recursive: true });
      for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(configuredVault, directory), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
      fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
      fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
      const configuredPaths = {
        workspace,
        vault: configuredVault,
        notes: path.join(configuredVault, 'Notes'),
        journal: path.join(configuredVault, 'Journal'),
        tags: path.join(configuredVault, 'Tags'),
        memory: path.join(workspace, 'memory'),
      };
      writeConfig(workspace, {
        paths: configuredPaths,
        user: { name: 'Tester', timezone: 'UTC' },
      });

      const healthy = runMinimalDoctor({ workspace, env: { [envVar]: overrideDir }, homeDir: tmp });
      const check = healthy.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(check.ok, true, check.message);
      assert.equal(check.status, 'warn', `path.${key} must report an existing override as warn, not plain ok`);
      assert.equal(check.path, overrideDir, `the check must inspect the override, not the configured value`);
      assert.match(check.message, /environment override/);
      // The message must name the exact env var that actually won, not a
      // generic "JARVOS_*" claim -- true for both JARVOS_* names and legacy
      // aliases like VAULT_NOTES_DIR/JOURNAL_DIR/CLAWD_DIR.
      assert.match(check.message, new RegExp(`\\b${envVar}\\b`), `message must name ${envVar} exactly: ${check.message}`);
      assert.match(check.message, new RegExp(configuredPaths[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      // Point the override at a directory that does not exist: the check
      // must fail, even though the configured directory is itself perfectly
      // healthy.
      const missingOverride = path.join(tmp, `missing-override-${key}`);
      const broken = runMinimalDoctor({ workspace, env: { [envVar]: missingOverride }, homeDir: tmp });
      const brokenCheck = broken.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(brokenCheck.ok, false, brokenCheck.message);
      assert.equal(brokenCheck.status, 'fail');
      assert.match(brokenCheck.message, /does not exist/);
      assert.equal(broken.ok, false, `an overridden ${key} that does not exist must not report an overall-healthy doctor`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('path.vault, path.notes, and path.journal fail closed for a stale ~/Documents/Vault v3 configuration, matching resolveConfig()', () => {
  // A stale vault under an isolated homeDir with a canonical vault present is
  // exactly what resolveConfig()'s SUP-1307/SUP-1884 guard refuses. The
  // configured directory itself exists with the right shape, so a
  // config-file-only check would otherwise report it healthy.
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const staleVault = path.join(tmp, 'Documents', 'Vault v3');
    const canonicalVault = path.join(tmp, 'Vaults', 'Vault v3');
    for (const vault of [staleVault, canonicalVault]) {
      for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      paths: { workspace, vault: staleVault, memory: path.join(workspace, 'memory') },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const report = runMinimalDoctor({ workspace, env: {}, homeDir: tmp });
    const vaultCheck = report.checks.find((check) => check.component === 'path.vault');
    assert.equal(vaultCheck.ok, false, vaultCheck.message);
    assert.match(vaultCheck.message, /runtime's own resolver refuses/);
    assert.match(vaultCheck.message, /stale vault path/);
    assert.equal(report.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an invalid timezone that makes resolveConfig() throw does not get blamed on path.vault/notes/journal', () => {
  // resolveConfig() is one function: resolveUserTimezone() throwing on an
  // invalid IANA timezone aborts the same call that assertNotStaleVaultPath()
  // guards. Every configured path is otherwise perfectly healthy here, so the
  // failure belongs to config/schema/timezone, not to the vault/notes/journal
  // path guard — a doctor that attributed any resolveConfig() throw to those
  // paths would misreport a timezone problem as a stale-vault one.
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const vault = path.join(tmp, 'vault');
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      paths: {
        workspace,
        vault,
        notes: path.join(vault, 'Notes'),
        journal: path.join(vault, 'Journal'),
        tags: path.join(vault, 'Tags'),
        memory: path.join(workspace, 'memory'),
      },
      // jarvos.config.json's own user.timezone is valid, but a
      // JARVOS_TIMEZONE env override is what resolveConfig() actually
      // resolves against, and that is what is invalid here.
      user: { name: 'Tester', timezone: 'UTC' },
    });

    assert.throws(
      () => resolveConfig({ configPath: path.join(workspace, 'jarvos.config.json'), homeDir: tmp, env: { JARVOS_TIMEZONE: 'Not/AZone' } }),
      /invalid IANA timezone/,
      'the fixture must actually reproduce a resolveConfig() throw',
    );

    const report = runMinimalDoctor({ workspace, env: { JARVOS_TIMEZONE: 'Not/AZone' }, homeDir: tmp });
    const schema = report.checks.find((check) => check.component === 'config.schema');
    assert.equal(schema.ok, false, schema.message);
    assert.match(schema.message, /JARVOS_TIMEZONE.*valid IANA timezone/);

    for (const key of ['workspace', 'vault', 'notes', 'journal', 'tags', 'memory']) {
      const check = report.checks.find((entry) => entry.component === `path.${key}`);
      assert.equal(check.ok, false, `${key}: ${check.message}`);
      assert.match(check.message, /Cannot inspect paths\./, key);
      assert.doesNotMatch(check.message, /stale vault path/, key);
      assert.doesNotMatch(check.message, /runtime's own resolver refuses/, key);
      assert.doesNotMatch(check.message, /outside the required canonical vault/, key);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('defaultKnowledgeDirectory gives JARVOS_KNOWLEDGE_DIR absolute priority, matching the runtime writers', () => {
  // knowledge-optimizer.js and journal-spine-synthesis.js both compute their
  // knowledge directory as `process.env.JARVOS_KNOWLEDGE_DIR || <vault-derived
  // default>`, consulting no config field at all. Doctor's derivation must
  // agree, or a knowledge output that IS present (just wherever the env var
  // points) reads here as "not present yet".
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const vault = makeVault(path.join(tmp, 'vault'));
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    const config = { paths: { vault }, user: { name: 'Tester', timezone: 'UTC' } };

    const withoutOverride = defaultKnowledgeDirectory(workspace, config, { env: {} });
    assert.equal(withoutOverride, path.join(vault, '.jarvos', 'knowledge'));

    const overrideKnowledgeDir = path.join(tmp, 'override-knowledge');
    const withOverride = defaultKnowledgeDirectory(workspace, config, { env: { JARVOS_KNOWLEDGE_DIR: overrideKnowledgeDir } });
    assert.equal(withOverride, overrideKnowledgeDir, 'the override wins even though the vault-derived default is fully configured');

    // A relative override resolves against cwd, exactly as the fs calls that
    // follow it in the real writers would resolve it.
    const relativeOverride = defaultKnowledgeDirectory(workspace, config, { env: { JARVOS_KNOWLEDGE_DIR: 'relative-knowledge-dir' } });
    assert.equal(relativeOverride, path.resolve('relative-knowledge-dir'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// GH-248: the CLI ("public") doctor's vault-path/vault-path-stale/journal-conflict
// checks historically only ever inspected jarvos.config.json's paths.vault. But
// resolveConfig() lets JARVOS_VAULT_DIR (PATH_ENV_KEYS.vault) override paths.vault
// unconditionally, so a config-only check could report a healthy vault the runtime
// never touches, or silently scan the wrong vault for a journal-writer conflict.
// These regressions are deliberately isolated: every check below is given an
// explicit env/homeDir so no ambient JARVOS_VAULT_DIR or real vault on the machine
// running the tests can change the outcome.
for (const envVar of PATH_ENV_KEYS.vault) {
  test(`checkVaultPath/checkVaultPathStale inspect the ${envVar} override vault and truthfully report the drift from paths.vault`, () => {
    const tmp = fs.realpathSync(scratch());
    try {
      const configuredVault = makeVault(path.join(tmp, 'configured-vault'));
      fs.mkdirSync(path.join(configuredVault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(configuredVault, 'Tags'), { recursive: true });
      const overrideVault = makeVault(path.join(tmp, 'override-vault'));
      fs.mkdirSync(path.join(overrideVault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(overrideVault, 'Tags'), { recursive: true });
      const configPath = writeConfig(tmp, { paths: { vault: configuredVault } });
      const options = { env: { [envVar]: overrideVault }, homeDir: tmp };

      const vaultPath = checkVaultPath(configPath, options);
      assert.equal(vaultPath.ok, true, vaultPath.detail);
      assert.match(vaultPath.detail, new RegExp(`\\b${envVar}\\b`));
      assert.match(vaultPath.detail, new RegExp(overrideVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(vaultPath.detail, new RegExp(configuredVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      const stale = checkVaultPathStale(configPath, options);
      assert.equal(stale.ok, true, stale.detail);
      assert.match(stale.detail, new RegExp(`\\b${envVar}\\b`));
      assert.match(stale.detail, new RegExp(overrideVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      // Without the override, both checks stay on the configured vault — proving
      // the override note above is genuinely conditional, not always present.
      const configOnly = { env: {}, homeDir: tmp };
      const configOnlyVaultPath = checkVaultPath(configPath, configOnly);
      assert.equal(configOnlyVaultPath.ok, true, configOnlyVaultPath.detail);
      assert.doesNotMatch(configOnlyVaultPath.detail, /environment override/);
      assert.equal(configOnlyVaultPath.detail, configuredVault);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`journal-conflict inspects the ${envVar} override vault's .obsidian state, not the configured vault's`, () => {
    const tmp = fs.realpathSync(scratch());
    try {
      // The configured vault is a clean, conflict-free Obsidian vault: if
      // journal-conflict fell back to inspecting it instead of the override, this
      // test would see a false "no conflict" pass.
      const configuredVault = makeVault(path.join(tmp, 'configured-vault'), { obsidian: true });
      fs.mkdirSync(path.join(configuredVault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(configuredVault, 'Tags'), { recursive: true });

      // The override vault is where the actual conflict lives: core daily-notes
      // enabled and writing straight into Journal/.
      const overrideVault = makeVault(path.join(tmp, 'override-vault'), { obsidian: true });
      fs.mkdirSync(path.join(overrideVault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(overrideVault, 'Tags'), { recursive: true });
      fs.writeFileSync(path.join(overrideVault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
      fs.writeFileSync(path.join(overrideVault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Journal' }));

      const configPath = writeConfig(tmp, { paths: { vault: configuredVault } });

      // Baseline: with no override, journal-conflict correctly reports the
      // configured vault clean.
      const configOnly = checkJournalConflict(configPath, { env: {}, homeDir: tmp });
      assert.equal(configOnly.ok, true, configOnly.detail);

      // With the override active, the same config must now report the
      // override vault's conflict — proof the override, not the configured
      // vault, was actually inspected.
      const overridden = checkJournalConflict(configPath, { env: { [envVar]: overrideVault }, homeDir: tmp });
      assert.equal(overridden.ok, false, overridden.detail);
      assert.match(overridden.detail, /daily-notes.*overlapping jarvOS Journal/);
      assert.match(overridden.detail, new RegExp(`\\b${envVar}\\b`));
      assert.match(overridden.detail, new RegExp(configuredVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`vault checks fail closed, still naming ${envVar}, when the override vault is missing rather than silently falling back to the healthy configured vault`, () => {
    const tmp = fs.realpathSync(scratch());
    try {
      // The configured vault is perfectly healthy on its own — proof that a
      // failure below comes from the override, not the configured fallback.
      const configuredVault = makeVault(path.join(tmp, 'configured-vault'));
      fs.mkdirSync(path.join(configuredVault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(configuredVault, 'Tags'), { recursive: true });
      const configPath = writeConfig(tmp, { paths: { vault: configuredVault } });

      const missingOverride = path.join(tmp, 'missing-override-vault');
      const options = { env: { [envVar]: missingOverride }, homeDir: tmp };

      const vaultPath = checkVaultPath(configPath, options);
      assert.equal(vaultPath.ok, false, vaultPath.detail);
      assert.match(vaultPath.detail, new RegExp(`\\b${envVar}\\b`));
      assert.match(vaultPath.detail, /Notes, Journal, Tags/);

      const stale = checkVaultPathStale(configPath, options);
      assert.equal(stale.ok, false, stale.detail);
      assert.match(stale.detail, /does not exist \(stale or moved vault\)/);
      assert.match(stale.detail, new RegExp(`\\b${envVar}\\b`));

      // journal-conflict has nothing to inspect either — it must defer to
      // vault-path-stale's failure rather than silently reporting the
      // healthy configured vault clean.
      const journal = checkJournalConflict(configPath, options);
      assert.equal(journal.ok, true, journal.detail);
      assert.match(journal.detail, /no vault to inspect/);
      assert.match(journal.detail, new RegExp(`\\b${envVar}\\b`));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('runDoctor threads its own env/homeDir into vault-path/vault-path-stale/journal-conflict end to end', () => {
  // The check functions can be individually correct while runDoctor's own
  // `checks` map still forgets to pass options through — this exercises the
  // whole wiring: runCli-style options in, override-aware results out.
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    for (const file of REQUIRED_WORKSPACE_FILES) {
      if (file === 'jarvos.config.json') continue;
      fs.writeFileSync(path.join(workspace, file), `# ${file}\n`);
    }

    const configuredVault = makeVault(path.join(tmp, 'configured-vault'), { obsidian: true });
    fs.mkdirSync(path.join(configuredVault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(configuredVault, 'Tags'), { recursive: true });

    const overrideVault = makeVault(path.join(tmp, 'override-vault'), { obsidian: true });
    fs.mkdirSync(path.join(overrideVault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(overrideVault, 'Tags'), { recursive: true });
    fs.writeFileSync(path.join(overrideVault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
    fs.writeFileSync(path.join(overrideVault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Journal' }));

    writeConfig(workspace, {
      paths: { workspace, vault: configuredVault },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const report = runDoctor({
      profile: 'minimal',
      workspace,
      env: { JARVOS_VAULT_DIR: overrideVault },
      homeDir: tmp,
    });

    const findCheck = (id) => report.results.find((entry) => entry.id === id);

    const vaultPath = findCheck('vault-path');
    assert.equal(vaultPath.ok, true, vaultPath.detail);
    assert.match(vaultPath.detail, /JARVOS_VAULT_DIR/);
    assert.match(vaultPath.detail, new RegExp(overrideVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const vaultStale = findCheck('vault-path-stale');
    assert.equal(vaultStale.ok, true, vaultStale.detail);
    assert.match(vaultStale.detail, new RegExp(overrideVault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const journal = findCheck('journal-conflict');
    assert.equal(journal.ok, false, journal.detail);
    assert.match(journal.detail, /daily-notes.*overlapping jarvOS Journal/);

    // A doctor run with no override at all must still behave exactly as the
    // pre-GH-248 config-only checks did: the configured vault itself has no
    // conflicting plugin (only the override vault does), so it must report
    // clean rather than inheriting the override vault's conflict.
    const configOnlyReport = runDoctor({
      profile: 'minimal',
      workspace,
      env: {},
      homeDir: tmp,
    });
    const configOnlyJournal = configOnlyReport.results.find((entry) => entry.id === 'journal-conflict');
    assert.equal(configOnlyJournal.ok, true, configOnlyJournal.detail);
    assert.doesNotMatch(configOnlyJournal.detail, /environment override/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// GH-248 parity fix (1): journal-conflict must compare Obsidian's daily-notes
// folder against the runtime-effective journal directory — paths.journal, or
// a JARVOS_JOURNAL_DIR/JOURNAL_DIR override (PATH_ENV_KEYS.journal) — not a
// hard-coded <vault>/Journal. These fixtures isolate the journal override from
// any vault override, so the divergence can only come from the journal path
// itself.
for (const envVar of PATH_ENV_KEYS.journal) {
  test(`journal-conflict is redirected clean by a journal-only ${envVar} override, even though the hardcoded <vault>/Journal folder would conflict`, () => {
    const tmp = fs.realpathSync(scratch());
    try {
      const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
      fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });
      // Obsidian's daily-notes writes into the vault's own Journal/ folder —
      // exactly what the old hard-coded <vault>/Journal comparison would flag.
      fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
      fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Journal' }));
      const configPath = writeConfig(tmp, { paths: { vault } });

      const baseline = checkJournalConflict(configPath, { env: {}, homeDir: tmp });
      assert.equal(baseline.ok, false, baseline.detail);

      const overrideJournal = path.join(tmp, 'external-journal');
      fs.mkdirSync(overrideJournal, { recursive: true });
      const overridden = checkJournalConflict(configPath, { env: { [envVar]: overrideJournal }, homeDir: tmp });
      assert.equal(overridden.ok, true, overridden.detail);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(`journal-conflict flags a folder overlap against a journal-only ${envVar} override that the hardcoded <vault>/Journal comparison would miss`, () => {
    const tmp = fs.realpathSync(scratch());
    try {
      const vault = makeVault(path.join(tmp, 'vault'), { obsidian: true });
      fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
      fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });
      // Daily-notes writes to a custom folder that does not overlap the
      // default <vault>/Journal, so an unfixed check would report this clean.
      fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(['daily-notes']));
      fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'CustomJournal' }));
      const configPath = writeConfig(tmp, { paths: { vault } });

      const baseline = checkJournalConflict(configPath, { env: {}, homeDir: tmp });
      assert.equal(baseline.ok, true, baseline.detail);

      // Redirecting the runtime-effective journal to that exact custom folder
      // must surface the real conflict the baseline missed.
      const overrideJournal = path.join(vault, 'CustomJournal');
      const overridden = checkJournalConflict(configPath, { env: { [envVar]: overrideJournal }, homeDir: tmp });
      assert.equal(overridden.ok, false, overridden.detail);
      assert.match(overridden.detail, /daily-notes.*overlapping jarvOS Journal/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

// GH-248 parity fix (2): effectiveVaultTarget() must honor resolveConfig()'s
// stale-vault (SUP-1307/SUP-1884) and JARVOS_REQUIRE_CANONICAL_VAULT guards
// even when no vault env override is present — a config-only paths.vault (or
// even the default vault) that the runtime itself would refuse must never be
// silently reported healthy.
test('checkVaultPath/checkVaultPathStale/checkJournalConflict fail closed for a stale ~/Documents/Vault v3 configuration, matching resolveConfig() — no env override present', () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const staleVault = makeVault(path.join(tmp, 'Documents', 'Vault v3'), { obsidian: true });
    fs.mkdirSync(path.join(staleVault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(staleVault, 'Tags'), { recursive: true });
    const canonicalVault = makeVault(path.join(tmp, 'Vaults', 'Vault v3'));
    fs.mkdirSync(path.join(canonicalVault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(canonicalVault, 'Tags'), { recursive: true });

    // The configured directory itself exists with the right shape — a
    // config-file-only check would otherwise report this healthy.
    const configPath = writeConfig(tmp, { paths: { vault: staleVault } });
    const options = { env: {}, homeDir: tmp };

    for (const check of [checkVaultPath(configPath, options), checkVaultPathStale(configPath, options)]) {
      assert.equal(check.ok, false, check.detail);
      assert.match(check.detail, /runtime's own resolver refuses/);
      assert.match(check.detail, /stale vault path/);
    }

    const journal = checkJournalConflict(configPath, options);
    assert.equal(journal.ok, false, journal.detail);
    assert.match(journal.detail, /runtime's own resolver refuses/);
    assert.match(journal.detail, /stale vault path/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkVaultPath/checkVaultPathStale/checkJournalConflict fail closed when JARVOS_REQUIRE_CANONICAL_VAULT rejects the resolved vault — no vault env override present', () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const vault = makeVault(path.join(tmp, 'some-vault'), { obsidian: true });
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });
    const requiredRoot = path.join(tmp, 'Required', 'Vault');
    const configPath = writeConfig(tmp, { paths: { vault } });

    const options = { env: { JARVOS_REQUIRE_CANONICAL_VAULT: requiredRoot }, homeDir: tmp };
    for (const check of [checkVaultPath(configPath, options), checkVaultPathStale(configPath, options)]) {
      assert.equal(check.ok, false, check.detail);
      assert.match(check.detail, /runtime's own resolver refuses/);
      assert.match(check.detail, /outside the required canonical vault/);
    }
    const journal = checkJournalConflict(configPath, options);
    assert.equal(journal.ok, false, journal.detail);
    assert.match(journal.detail, /outside the required canonical vault/);

    // Sanity: the same config is healthy with no canonical-vault constraint —
    // proof the failure above is genuinely driven by the guard, not the fixture.
    const unrestricted = checkVaultPath(configPath, { env: {}, homeDir: tmp });
    assert.equal(unrestricted.ok, true, unrestricted.detail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// GH-248 parity fix (4): unusableVaultPathDetail()/legacyMigrationAssessment()
// must resolve a ~-rooted legacy vaultPath against options.homeDir, not the
// real os.homedir() — mirroring the same regression already covered for
// configured paths.* above.
test('unusable-vault-path legacy remediation resolves a ~-rooted legacy vaultPath against options.homeDir, not the real os.homedir()', () => {
  const tmp = fs.realpathSync(scratch());
  const customHome = path.join(tmp, 'custom-home');
  try {
    assert.notEqual(customHome, os.homedir(), 'the fixture home must differ from the real machine home');
    const legacyVault = path.join(customHome, 'legacy-vault');
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(legacyVault, directory), { recursive: true });
    }
    const workspace = path.join(tmp, 'legacy-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const configPath = writeConfig(workspace, {
      vaultPath: '~/legacy-vault',
      workspacePath: workspace,
      userName: 'Legacy User',
      timezone: 'UTC',
    });

    const detail = checkVaultPath(configPath, { env: {}, homeDir: customHome }).detail;
    assert.equal(checkVaultPathStale(configPath, { env: {}, homeDir: customHome }).detail, detail);
    assert.match(detail, /legacy config records a usable vaultPath/i, detail);
    assert.match(detail, /manual reconciliation/, detail);
    assert.match(detail, /--config <new-path>/, detail);
    assert.doesNotMatch(detail, /migrate it in place/, detail);

    // Proof this is genuinely homeDir-driven: the real machine home (which
    // has no matching legacy-vault directory) must fall back to the generic
    // remediation instead of describing a legacy target it cannot find there.
    const realHomeDetail = checkVaultPath(configPath, { env: {} }).detail;
    assert.doesNotMatch(realHomeDetail, /legacy config records a usable vaultPath/, realHomeDetail);
    assert.match(realHomeDetail, /absolute or ~-rooted/, realHomeDetail);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// GH-248 parity fix (5): resolveDoctorContext() must select JARVOS_WORKSPACE_PATH/
// JARVOS_CONFIG_PATH from options.env and expand ~ against options.homeDir,
// never ambient process.env/os.homedir() — proven end to end through runDoctor().
test('resolveDoctorContext/runDoctor select workspace/config from options.env and expand ~ against options.homeDir', () => {
  const tmp = fs.realpathSync(scratch());
  const customHome = path.join(tmp, 'custom-home');
  try {
    assert.notEqual(customHome, os.homedir(), 'the fixture home must differ from the real machine home');
    assert.equal(process.env.JARVOS_WORKSPACE_PATH, undefined, 'ambient JARVOS_WORKSPACE_PATH would defeat this fixture');
    assert.equal(process.env.JARVOS_CONFIG_PATH, undefined, 'ambient JARVOS_CONFIG_PATH would defeat this fixture');

    const workspace = path.join(customHome, 'ws-from-env');
    const configPath = path.join(customHome, 'custom-config.json');
    fs.mkdirSync(workspace, { recursive: true });
    for (const file of REQUIRED_WORKSPACE_FILES) {
      fs.writeFileSync(path.join(workspace, file), file === 'jarvos.config.json' ? '{}\n' : `# ${file}\n`);
    }
    fs.writeFileSync(configPath, JSON.stringify({
      paths: { vault: path.join(customHome, 'vault'), workspace },
      user: { name: 'Tester', timezone: 'UTC' },
    }, null, 2));

    const env = { JARVOS_WORKSPACE_PATH: '~/ws-from-env', JARVOS_CONFIG_PATH: '~/custom-config.json' };
    const context = resolveDoctorContext({ env, homeDir: customHome });
    assert.equal(context.workspace, workspace);
    assert.equal(context.configPath, configPath);

    // End-to-end: runDoctor must actually select this workspace/config, not
    // just the standalone helper — each check echoes its resolved input back
    // on success, so this proves the wiring all the way through.
    const report = runDoctor({ profile: 'minimal', env, homeDir: customHome });
    assert.equal(report.workspace, workspace);
    assert.equal(report.configPath, configPath);
    const workspaceFiles = report.results.find((entry) => entry.id === 'workspace-files');
    assert.equal(workspaceFiles.ok, true, workspaceFiles.detail);
    assert.equal(workspaceFiles.detail, workspace);
    const configSchema = report.results.find((entry) => entry.id === 'config-schema');
    assert.equal(configSchema.ok, true, configSchema.detail);
    assert.equal(configSchema.detail, configPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// GH-248 parity fix (3): runCli's local-openclaw/v0-5-0 doctor branch must
// pass its own `env` into profileDoctor.runProfileDoctor() alongside homeDir,
// matching the minimal branch — otherwise an explicit env override never
// reaches the profile doctor's own checks (e.g. JARVOS_VAULT_DIR).
test("runCli threads its env into the local-openclaw/v0-5-0 profile doctor branch, matching the minimal branch", async () => {
  const tmp = fs.realpathSync(scratch());
  try {
    const workspace = path.join(tmp, 'workspace');
    const configuredVault = path.join(tmp, 'configured-vault');
    const overrideVault = path.join(tmp, 'override-vault');
    for (const directory of ['Notes', 'Journal', 'Tags']) {
      fs.mkdirSync(path.join(configuredVault, directory), { recursive: true });
      fs.mkdirSync(path.join(overrideVault, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Agent context\n');
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n');
    writeConfig(workspace, {
      paths: { workspace, vault: configuredVault, memory: path.join(workspace, 'memory') },
      user: { name: 'Tester', timezone: 'UTC' },
    });

    const out = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
    try {
      await runCli(
        ['doctor', '--profile', 'v0-5-0', '--workspace', workspace, '--json'],
        { JARVOS_VAULT_DIR: overrideVault, HOME: tmp },
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
    assert.ok(out.join('').length > 0, 'doctor must print a JSON report');
    const report = JSON.parse(out.join(''));
    const vaultCheck = report.checks.find((check) => check.component === 'path.vault');
    assert.equal(vaultCheck.ok, true, vaultCheck.message);
    assert.equal(vaultCheck.status, 'warn', vaultCheck.message);
    assert.match(vaultCheck.message, /JARVOS_VAULT_DIR/);
    assert.equal(vaultCheck.path, overrideVault);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
