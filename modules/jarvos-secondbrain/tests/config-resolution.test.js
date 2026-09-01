const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MANUAL_RECONCILIATION_ACTION,
  assertConfigPublicationSupported,
  assessSharedVaultConfigTarget,
  atomicReplaceConfig,
  createConfigExclusively,
  requiresConfigPublication,
  buildSharedVaultConfig,
  discoverConfigPath,
  discoverExistingVault,
  hasPosixDirectoryPinCapability,
  parseEnvFile,
  readSharedVaultConfigTarget,
  resolveConfig,
  resolveJournalConfig,
  resolvePaperclipConfig,
  isAllowedMacOSSystemParentAlias,
  writeSharedVaultConfig,
} = require('../bridge/config');

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-config-')));
}

test('in-place replacement is disabled and leaves an existing target untouched', { skip: process.platform === 'win32' }, () => {
  const root = tempDir();
  const target = path.join(root, 'jarvos.config.json');
  const original = '{"original":true}\n';
  fs.writeFileSync(target, original);

  assert.throws(
    () => atomicReplaceConfig(target, '{"migrated":true}\n'),
    /Cannot automatically migrate.*never rewrites.*in place/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('config publication support is decided per platform, and only for actions that write', () => {
  // Parameterized rather than read from process.platform so non-Windows CI
  // still covers the Windows verdict.
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.doesNotThrow(() => assertConfigPublicationSupported(platform), platform);
  }
  assert.throws(
    () => assertConfigPublicationSupported('win32'),
    /jarvos sync cannot publish a config on win32.*O_DIRECTORY\/O_NOFOLLOW.*macOS or Linux/s,
  );

  assert.equal(requiresConfigPublication('create'), true);
  assert.equal(requiresConfigPublication('migrate'), false);
  assert.equal(MANUAL_RECONCILIATION_ACTION, 'manual-reconcile');
  // Read-only inspection needs no write, so it stays available everywhere.
  assert.equal(requiresConfigPublication('already-synced'), false);
  assert.equal(requiresConfigPublication('conflict'), false);
});

test('config publication support fails closed on a non-win32 platform missing O_DIRECTORY/O_NOFOLLOW, via injected constants rather than mutating fs.constants', () => {
  // fs.constants' own properties are non-writable/non-configurable (a real
  // Node process cannot be made to lack these flags: this file runs in sloppy
  // mode, where the assignment below silently no-ops rather than throwing, and
  // strict-mode code would throw instead), so the capability gap is exercised
  // by injecting a substitute constants object instead of trying to patch the
  // real one.
  const before = fs.constants.O_DIRECTORY;
  fs.constants.O_DIRECTORY = 'poked';
  assert.equal(fs.constants.O_DIRECTORY, before, 'fs.constants must stay unwritable, or this test is no longer proving anything');

  const real = fs.constants;
  assert.equal(hasPosixDirectoryPinCapability(real), true, 'the real runtime must have the capability for every other test in this suite to mean anything');

  for (const missing of ['O_DIRECTORY', 'O_NOFOLLOW']) {
    const degraded = { ...real, [missing]: undefined };
    assert.equal(hasPosixDirectoryPinCapability(degraded), false, missing);
    assert.throws(
      () => assertConfigPublicationSupported('linux', degraded),
      /jarvos sync cannot publish a config on linux.*O_DIRECTORY\/O_NOFOLLOW.*macOS or Linux/s,
      missing,
    );
    // A non-integer stand-in (e.g. NaN from a broken shim) must be rejected
    // exactly like a missing one: OR-ing it into an open() mode would not
    // raise, it would just silently degrade the flags being requested.
    const nonInteger = { ...real, [missing]: NaN };
    assert.equal(hasPosixDirectoryPinCapability(nonInteger), false, `${missing} as NaN`);
    const zero = { ...real, [missing]: 0 };
    assert.equal(hasPosixDirectoryPinCapability(zero), false, `${missing} as zero`);
  }

  // Planning and applying still share the exact same verdict and message when
  // the capability is present: the new gate must not fire spuriously for a
  // real, fully capable environment.
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.doesNotThrow(() => assertConfigPublicationSupported(platform, real), platform);
  }
});

test('unsupported create capability has the same plan/apply verdict', { skip: process.platform === 'win32' }, () => {
  const root = tempDir();
  const target = path.join(root, 'jarvos.config.json');
  const vault = path.join(root, 'selected-vault');
  fs.mkdirSync(vault);
  let shared = '';
  try {
    assertConfigPublicationSupported('win32');
  } catch (error) {
    shared = error.message;
  }

  assert.throws(
    () => createConfigExclusively(target, '{"created":true}\n', { platform: 'win32', vaultDir: vault, homeDir: root }),
    (error) => error.message === shared,
  );
  assert.deepEqual(fs.readdirSync(root), ['selected-vault'], 'an unsupported platform must publish nothing');
});

test('direct exclusive creation requires an explicit valid selected vault', () => {
  const root = tempDir();
  const target = path.join(root, 'jarvos.config.json');

  assert.throws(
    () => createConfigExclusively(target, '{"created":true}\n', { homeDir: root }),
    /explicit selected vaultDir/,
  );
  assert.equal(fs.existsSync(target), false);

  const notADirectory = path.join(root, 'not-a-vault');
  fs.writeFileSync(notADirectory, 'not a directory\n');
  assert.throws(
    () => createConfigExclusively(target, '{"created":true}\n', { vaultDir: notADirectory, homeDir: root }),
    /selected vault that is not a directory/,
  );
  assert.equal(fs.existsSync(target), false);
});

test('direct shared-vault apply rejects unsupported platform/capabilities before creating config ancestors', { skip: process.platform === 'win32' }, () => {
  // Exercise both ways the publication capability can be absent without
  // touching the process-wide fs.constants object.  The target parent is
  // intentionally missing: a direct apply must reject before provisioning it.
  const scenarios = [
    { platform: 'win32', constants: fs.constants },
    { platform: 'linux', constants: { ...fs.constants, O_DIRECTORY: undefined } },
  ];

  for (const { platform, constants } of scenarios) {
    const home = tempDir();
    const workspace = path.join(home, 'new-runtime', 'workspace');
    const configPath = path.join(workspace, 'jarvos.config.json');
    const vault = path.join(home, 'Vaults', 'Vault v3');
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });

    assert.throws(
      () => writeSharedVaultConfig({
        configPath,
        vaultDir: vault,
        workspaceRoot: workspace,
        homeDir: home,
        platform,
        constants,
        user: { name: 'Tester', timezone: 'UTC' },
      }),
      /jarvos sync cannot publish a config/,
      platform,
    );
    assert.equal(fs.existsSync(workspace), false, `${platform}: workspace ancestors must not be created`);
    assert.equal(fs.existsSync(configPath), false, `${platform}: config must not be created`);
    assert.deepEqual(fs.readdirSync(home), ['Vaults'], `${platform}: no unrelated home entries may be created`);
  }
});

test('direct create writes the exact config through one exclusive final target and uses no pathname cleanup or staging publication', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'jarvos.config.json');
  const contents = '{"created":true}\n';
  const opened = [];
  const writes = [];
  const forbiddenCalls = [];
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  const originals = Object.fromEntries(['linkSync', 'renameSync', 'unlinkSync'].map((method) => [method, fs[method]]));

  fs.openSync = (file, ...rest) => {
    opened.push(file);
    return originalOpenSync(file, ...rest);
  };
  fs.writeFileSync = (file, ...rest) => {
    writes.push(file);
    return originalWriteFileSync(file, ...rest);
  };
  for (const method of Object.keys(originals)) {
    fs[method] = (...args) => {
      forbiddenCalls.push({ method, args });
      throw new Error(`${method} must not be used by config publication`);
    };
  }

  try {
    createConfigExclusively(target, contents, { vaultDir: vault, homeDir: home });
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeFileSync = originalWriteFileSync;
    for (const [method, original] of Object.entries(originals)) fs[method] = original;
  }

  assert.deepEqual(forbiddenCalls, []);
  assert.equal(opened.includes(target), true, 'the final target must be opened directly');
  assert.equal(opened.some((file) => typeof file === 'string' && path.basename(file).startsWith('.jarvos.config.json.')), false, 'no staging pathname may be opened');
  // The only write is through the retained numeric descriptor, never a path.
  assert.equal(writes.length, 1);
  assert.equal(typeof writes[0], 'number');
  assert.equal(fs.readFileSync(target, 'utf8'), contents);
  const stat = fs.statSync(target);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
});

test('an additional name for the new inode fails closed before writing and preserves existing files', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'jarvos.config.json');
  const secondName = path.join(workspace, 'second-name-for-new-inode');
  const existing = path.join(workspace, 'existing-data.json');
  const existingContents = 'preserve this existing file\n';
  fs.writeFileSync(existing, existingContents);
  const originalOpenSync = fs.openSync;
  const originalUnlinkSync = fs.unlinkSync;
  const unlinkCalls = [];
  let additionalNameCreated = false;
  fs.openSync = (file, ...rest) => {
    const fd = originalOpenSync(file, ...rest);
    if (!additionalNameCreated && file === target) {
      additionalNameCreated = true;
      // Give the newly created inode an additional name before the creator's
      // pre-write link-count check. The creator must preserve both path names
      // but clear the held inode rather than publish config bytes.
      fs.linkSync(target, secondName);
    }
    return fd;
  };
  fs.unlinkSync = (...args) => {
    unlinkCalls.push(args);
    throw new Error('pathname removal is not part of config publication');
  };

  try {
    assert.throws(
      () => createConfigExclusively(target, '{"created":true}\n', { vaultDir: vault, homeDir: home }),
      /config target with additional names/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(additionalNameCreated, true);
  assert.deepEqual(unlinkCalls, []);
  assert.equal(fs.readFileSync(existing, 'utf8'), existingContents);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(secondName), true);
  assert.equal(fs.statSync(target).size, 0, 'the held descriptor residue is empty');
  assert.equal(fs.statSync(secondName).size, 0, 'the additional name sees the empty residue');
});

test('create failure after a simultaneous target change preserves existing data and leaves only an empty file residue', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'jarvos.config.json');
  const moved = path.join(workspace, 'moved-created-inode');
  const replacementContents = 'replacement-owned\n';
  const originalOpenSync = fs.openSync;
  const originalUnlinkSync = fs.unlinkSync;
  const unlinkCalls = [];
  let substituted = false;
  fs.openSync = (file, ...rest) => {
    const fd = originalOpenSync(file, ...rest);
    if (!substituted && file === target) {
      substituted = true;
      // A simultaneous edit moves our newly created inode away, then installs
      // a separate file at the original pathname before the identity proof.
      fs.renameSync(target, moved);
      fs.writeFileSync(target, replacementContents);
    }
    return fd;
  };
  fs.unlinkSync = (...args) => {
    unlinkCalls.push(args);
    return originalUnlinkSync(...args);
  };

  try {
    assert.throws(
      () => createConfigExclusively(target, '{"created":true}\n', { vaultDir: vault, homeDir: home }),
      /config target that changed during sync/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(substituted, true);
  assert.deepEqual(unlinkCalls, [], 'failed create must never remove a pathname');
  assert.equal(fs.readFileSync(target, 'utf8'), replacementContents, 'the replacement file must survive');
  assert.equal(fs.statSync(moved).size, 0, 'the held fd is truncated before close');
});

test('an existing target appearing after assessment fails with EEXIST without modifying it', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'jarvos.config.json');
  const replacementContents = 'appeared-after-assessment\n';
  const originalOpenSync = fs.openSync;
  let appeared = false;
  fs.openSync = (file, ...rest) => {
    if (!appeared && file === target) {
      appeared = true;
      fs.writeFileSync(target, replacementContents);
    }
    return originalOpenSync(file, ...rest);
  };

  try {
    assert.throws(
      () => writeSharedVaultConfig({
        configPath: target,
        vaultDir: vault,
        workspaceRoot: workspace,
        homeDir: home,
        user: { name: 'Tester', timezone: 'UTC' },
      }),
      /EEXIST|already exists/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(appeared, true);
  assert.equal(fs.readFileSync(target, 'utf8'), replacementContents);
});

test('legacy migration is manual-only and preserves bytes changed during assessment', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'jarvos.config.json');
  const legacy = JSON.stringify({ workspacePath: workspace, vaultPath: vault, userName: 'Tester' });
  const replacementContents = '{"replacement":"changed during assessment"}\n';
  fs.writeFileSync(target, `${legacy}\n`);
  const originalReadFileSync = fs.readFileSync;
  let changedDuringAssessment = false;
  fs.readFileSync = (file, ...rest) => {
    const bytes = originalReadFileSync(file, ...rest);
    if (!changedDuringAssessment && file === target) {
      changedDuringAssessment = true;
      fs.writeFileSync(target, replacementContents);
    }
    return bytes;
  };

  try {
    assert.throws(
      () => writeSharedVaultConfig({
        configPath: target,
        vaultDir: vault,
        workspaceRoot: workspace,
        homeDir: home,
        user: { name: 'Tester', timezone: 'UTC' },
      }),
      /Cannot automatically migrate.*manual|never rewrites.*in place/,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(changedDuringAssessment, true);
  assert.equal(fs.readFileSync(target, 'utf8'), replacementContents);
});





test('a fully populated relative config is never classified already-synced', () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const expected = buildSharedVaultConfig({
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  });
  // Every key present and every value relative: normalizePathMap() drops all of
  // them, so the runtime would use the home defaults, not these.
  const relative = {
    ...expected,
    paths: Object.fromEntries(Object.entries(expected.paths).map(([key, value]) => [key, path.relative(home, value)])),
  };
  for (const value of Object.values(relative.paths)) {
    assert.equal(path.isAbsolute(value), false, `${value} must be relative for this fixture`);
  }

  const configPath = path.join(workspace, 'jarvos.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(relative, null, 2)}\n`);

  const previousCwd = process.cwd();
  try {
    // Run from the directory that makes the relative values resolve onto the
    // expected absolute paths — the cwd that would otherwise fake a match.
    process.chdir(home);
    const assessment = assessSharedVaultConfigTarget({ configPath, config: expected, vaultDir: vault, homeDir: home });
    assert.notEqual(assessment.action, 'already-synced');
    assert.equal(assessment.action, 'migrate');
  } finally {
    process.chdir(previousCwd);
  }
});

test('a portable config may omit derived child paths and remain already-synced', () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const expected = buildSharedVaultConfig({
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  });
  const existing = structuredClone(expected);
  delete existing.paths.tags;
  const configPath = path.join(workspace, 'jarvos.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`);

  const assessment = assessSharedVaultConfigTarget({
    configPath,
    config: expected,
    vaultDir: vault,
    homeDir: home,
  });
  assert.equal(assessment.action, 'already-synced');
});

test('a runtime path override prevents an existing portable config from being already-synced', () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  const overriddenTags = path.join(home, 'runtime-tags');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(overriddenTags, { recursive: true });

  const expected = buildSharedVaultConfig({
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  });
  const configPath = path.join(workspace, 'jarvos.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify(expected, null, 2)}\n`);

  const assessment = assessSharedVaultConfigTarget({
    configPath,
    config: expected,
    vaultDir: vault,
    homeDir: home,
    env: { JARVOS_TAGS_DIR: overriddenTags },
  });
  assert.equal(assessment.action, 'migrate');
});

test('successful exclusive creation leaves no residue beside the config', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const user = { name: 'Tester', timezone: 'UTC' };
  const configPath = path.join(workspace, 'jarvos.config.json');

  writeSharedVaultConfig({ configPath, vaultDir: vault, workspaceRoot: workspace, homeDir: home, user });
  assert.deepEqual(fs.readdirSync(workspace), ['jarvos.config.json']);
  assert.equal(fs.lstatSync(configPath).nlink, 1, 'a successful create leaves one target inode');
  assert.deepEqual(fs.readdirSync(vault).sort(), ['Journal', 'Notes', 'Tags'], 'ordinary create never chooses the vault for config publication');
  for (const directory of ['Notes', 'Journal', 'Tags']) {
    assert.deepEqual(fs.readdirSync(path.join(vault, directory)), [], `ordinary create leaves ${directory} untouched`);
  }

  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).user.name, 'Tester');
});

test('an ancestor redirected before the pin cannot publish a config inside the vault', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const parent = path.join(home, 'parent');
  const workspace = path.join(parent, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  // A real directory inside the vault, so the redirected path pins a genuine
  // directory: the descriptor and the lstat agree, and only re-deriving the
  // canonical location can tell that it sits in the vault.
  fs.mkdirSync(path.join(vault, 'workspace'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });

  const originalOpenSync = fs.openSync;
  let redirected = false;
  fs.openSync = (file, ...rest) => {
    if (!redirected && file === workspace) {
      redirected = true;
      fs.renameSync(parent, path.join(home, 'parent-real'));
      fs.symlinkSync(vault, parent, 'dir');
    }
    return originalOpenSync(file, ...rest);
  };
  try {
    assert.throws(
      () => writeSharedVaultConfig({
        configPath: path.join(workspace, 'jarvos.config.json'),
        vaultDir: vault,
        workspaceRoot: workspace,
        homeDir: home,
        user: { name: 'Tester', timezone: 'UTC' },
      }),
      /inside the shared vault/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(redirected, true, 'the test must actually redirect the ancestor before the pin');
  assert.deepEqual(fs.readdirSync(path.join(vault, 'workspace')), [], 'nothing may be created inside the vault');
  assert.deepEqual(fs.readdirSync(vault).sort(), ['Journal', 'Notes', 'Tags', 'workspace']);
});






test('shared-vault onboarding treats a JSON null config target as an existing file', () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const configPath = path.join(workspace, 'jarvos.config.json');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(configPath, 'null\n');

  const config = buildSharedVaultConfig({
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  });
  // The dry run must not plan a `create` the exclusive apply write would then
  // fail with EEXIST; both paths refuse the unusable target instead.
  assert.throws(
    () => assessSharedVaultConfigTarget({ configPath, config, vaultDir: vault, homeDir: home }),
    /not a JSON object/,
  );
  assert.throws(
    () => writeSharedVaultConfig({
      configPath,
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir: home,
      user: { name: 'Tester', timezone: 'UTC' },
    }),
    /not a JSON object/,
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'null\n');

  fs.rmSync(configPath);
  assert.equal(readSharedVaultConfigTarget({ configPath, homeDir: home }).exists, false);
  assert.equal(assessSharedVaultConfigTarget({ configPath, config, vaultDir: vault, homeDir: home }).action, 'create');
});

test('shared-vault onboarding refuses a whitespace-only user name', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });

  assert.throws(
    () => buildSharedVaultConfig({
      vaultDir: vault,
      workspaceRoot: path.join(home, 'workspace'),
      homeDir: home,
      user: { name: '  ', timezone: 'UTC' },
    }),
    /non-empty user name/,
  );
});

test('resolveConfig loads jarvos.config.json and recomputes child paths from workspace and vault', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: {
      workspace: '/srv/jarvos',
      vault: '/data/vault',
    },
    user: {
      name: 'Tester',
      timezone: 'UTC',
    },
  }));

  const config = resolveConfig({ configPath, homeDir: '/home/tester', env: {} });

  assert.equal(config.paths.workspace, '/srv/jarvos');
  assert.equal(config.paths.memory, '/srv/jarvos/memory');
  assert.equal(config.paths.scripts, '/srv/jarvos/scripts');
  assert.equal(config.paths.vault, '/data/vault');
  assert.equal(config.paths.notes, '/data/vault/Notes');
  assert.equal(config.paths.journal, '/data/vault/Journal');
  assert.equal(config.user.timezone, 'UTC');
});

test('resolveConfig lets env vars override config paths and supports legacy notes/journal env names', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: {
      notes: '/config/notes',
      journal: '/config/journal',
    },
  }));

  const config = resolveConfig({
    configPath,
    homeDir: '/home/tester',
    env: {
      VAULT_NOTES_DIR: '/env/notes',
      JOURNAL_DIR: '/env/journal',
    },
  });

  assert.equal(config.paths.notes, '/env/notes');
  assert.equal(config.paths.journal, '/env/journal');
});

test('resolveConfig lets JARVOS_TIMEZONE env override config timezone', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    user: {
      timezone: 'America/Los_Angeles',
    },
  }));

  const config = resolveConfig({
    configPath,
    homeDir: '/home/tester',
    env: {
      JARVOS_TIMEZONE: 'UTC',
    },
  });

  assert.equal(config.user.timezone, 'UTC');
});

test('resolveConfig uses JARVOS_TIMEZONE when no config timezone is set', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, '{}');

  const config = resolveConfig({
    configPath,
    homeDir: '/home/tester',
    env: {
      JARVOS_TIMEZONE: 'UTC',
    },
  });

  assert.equal(config.user.timezone, 'UTC');
});

test('resolveConfig prefers configured timezone over generic TZ env fallback', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    user: {
      timezone: 'America/Los_Angeles',
    },
  }));

  const config = resolveConfig({
    configPath,
    homeDir: '/home/tester',
    env: {
      TZ: 'UTC',
    },
  });

  assert.equal(config.user.timezone, 'America/Los_Angeles');
});

test('resolveConfig rejects an invalid configured timezone instead of silently changing it', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ user: { timezone: 'Not/AZone' } }));

  assert.throws(
    () => resolveConfig({ configPath, homeDir: '/home/tester', env: {} }),
    /invalid IANA timezone "Not\/AZone" from .*jarvos\.config\.json/,
  );
});

test('resolveJournalConfig does not derive a write target from legacy vaultPath', () => {
  const home = tempDir();
  const configPath = path.join(home, 'jarvos.config.json');
  const staleVault = path.join(home, 'Documents', 'Vault v3');
  fs.mkdirSync(path.join(home, 'Vaults', 'Vault v3'), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    vaultPath: staleVault,
    user: { timezone: 'UTC' },
  }));

  assert.throws(
    () => resolveJournalConfig({ configPath, homeDir: home, env: {} }),
    /explicit journal directory/i,
  );
});

test('resolveJournalConfig requires an explicit journal target and valid configured timezone', () => {
  const root = tempDir();
  const journalDir = path.join(root, 'Journal');
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: { journal: journalDir },
    user: { timezone: 'Europe/London' },
  }));

  const config = resolveJournalConfig({ configPath, homeDir: '/home/tester', env: { TZ: 'UTC' } });
  assert.equal(config.journalDir, journalDir);
  assert.equal(config.timeZone, 'Europe/London');

  assert.throws(
    () => resolveJournalConfig({ configPath: path.join(root, 'missing.json'), homeDir: '/home/tester', env: {} }),
    /explicit journal directory/i,
  );
  assert.throws(
    () => resolveJournalConfig({ configPath, homeDir: '/home/tester', env: { JARVOS_TIMEZONE: 'Not/AZone' } }),
    /invalid.*timezone/i,
  );
});

test('resolveJournalConfig fails closed on malformed higher-precedence path values', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: { journal: path.join(root, 'configured-journal'), vault: path.join(root, 'configured-vault') },
    user: { timezone: 'UTC' },
  }));

  assert.throws(
    () => resolveJournalConfig({ configPath, homeDir: '/home/tester', env: { JARVOS_JOURNAL_DIR: 'relative-journal' } }),
    /invalid configured JARVOS_JOURNAL_DIR path/i,
  );
  assert.throws(
    () => resolveJournalConfig({ configPath, homeDir: '/home/tester', env: { JOURNAL_DIR: 'relative-journal' } }),
    /invalid configured JOURNAL_DIR path/i,
  );
  assert.throws(
    () => resolveJournalConfig({ configPath: path.join(root, 'missing.json'), config: { paths: { journal: 'relative-journal' }, user: { timezone: 'UTC' } }, homeDir: '/home/tester', env: {} }),
    /invalid configured paths\.journal path/i,
  );
});

test('resolveJournalConfig ignores empty injected values and uses valid lower-precedence configuration', () => {
  const root = tempDir();
  const journal = path.join(root, 'configured-journal');
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: { journal },
    user: { timezone: 'UTC' },
  }));

  const config = resolveJournalConfig({
    configPath,
    homeDir: '/home/tester',
    env: { JARVOS_JOURNAL_DIR: '', JARVOS_TIMEZONE: '' },
  });
  assert.equal(config.journalDir, journal);
  assert.equal(config.timeZone, 'UTC');
});

test('resolveConfig rejects non-string, empty, and relative path overrides', () => {
  const root = tempDir();
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: {
      workspace: 'relative-workspace',
      vault: 123,
      notes: '',
    },
  }));

  const config = resolveConfig({ configPath, homeDir: '/home/tester', env: {} });

  assert.equal(config.paths.workspace, '/home/tester/clawd');
  assert.equal(config.paths.vault, '/home/tester/Vaults/Vault v3');
  assert.equal(config.paths.notes, '/home/tester/Vaults/Vault v3/Notes');
});

test('discoverConfigPath uses XDG config when no workspace config is provided', () => {
  const root = tempDir();
  const xdgHome = path.join(root, '.config');
  const xdgPath = path.join(xdgHome, 'jarvos', 'config.json');
  fs.mkdirSync(path.dirname(xdgPath), { recursive: true });
  fs.writeFileSync(xdgPath, '{}');

  assert.equal(
    discoverConfigPath({ homeDir: '/home/tester', env: { XDG_CONFIG_HOME: xdgHome } }),
    xdgPath,
  );
});

test('parseEnvFile reads shell-style Paperclip env files without executing them', () => {
  const parsed = parseEnvFile([
    '# comment',
    'export PAPERCLIP_API_URL="http://localhost:3000"',
    "PAPERCLIP_COMPANY_ID='company-1'",
    'IGNORED line',
  ].join('\n'));

  assert.equal(parsed.PAPERCLIP_API_URL, 'http://localhost:3000');
  assert.equal(parsed.PAPERCLIP_COMPANY_ID, 'company-1');
});

test('resolvePaperclipConfig reads env first and falls back to config/paperclip-env.sh', () => {
  const root = tempDir();
  const envFile = path.join(root, 'config', 'paperclip-env.sh');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, [
    'PAPERCLIP_API_URL=http://from-file.test',
    'PAPERCLIP_API_KEY=file-secret',
    'PAPERCLIP_COMPANY_ID=file-company',
  ].join('\n'));

  const config = resolvePaperclipConfig({
    envFile,
    homeDir: '/home/tester',
    configPath: path.join(root, 'missing.json'),
    env: {
      PAPERCLIP_API_KEY: 'env-secret',
    },
  });

  assert.equal(config.apiUrl, 'http://from-file.test');
  assert.equal(config.apiKey, 'env-secret');
  assert.equal(config.companyId, 'file-company');
  assert.equal(config.hasApiKey, true);
});

// --- Vault-drift guardrails (SUP-1307 / SUP-1884) ---------------------------

test('resolveConfig fails closed when an explicit vault points at stale ~/Documents/Vault v3 and a canonical vault exists', () => {
  const home = tempDir();
  fs.mkdirSync(path.join(home, 'Vaults', 'Vault v3'), { recursive: true });
  const configPath = path.join(home, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: { vault: path.join(home, 'Documents', 'Vault v3') },
  }));

  assert.throws(
    () => resolveConfig({ configPath, homeDir: home, env: {} }),
    /stale vault path under ~\/Documents\/Vault v3/,
  );
});

test('resolveConfig allows a stale ~/Documents/Vault v3 path when no canonical vault or marker exists (legacy installs)', () => {
  const home = tempDir();
  const docsVault = path.join(home, 'Documents', 'Vault v3');
  const configPath = path.join(home, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ paths: { vault: docsVault } }));

  const config = resolveConfig({ configPath, homeDir: home, env: {} });
  assert.equal(config.paths.vault, docsVault);
});

test('resolveConfig follows a DO_NOT_USE.txt hint to fail closed on a stale vault even without a canonical dir', () => {
  const home = tempDir();
  const docsVault = path.join(home, 'Documents', 'Vault v3');
  fs.mkdirSync(docsVault, { recursive: true });
  fs.writeFileSync(path.join(docsVault, 'DO_NOT_USE.txt'), 'Moved. Use ~/Vaults/Vault v3 instead.\n');
  const configPath = path.join(home, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({ paths: { vault: docsVault } }));

  assert.throws(
    () => resolveConfig({ configPath, homeDir: home, env: {} }),
    /DO_NOT_USE marker present/,
  );
});

test('JARVOS_REQUIRE_CANONICAL_VAULT fails closed when $HOME resolves the vault outside the pinned root (sandbox case)', () => {
  const realHome = tempDir();
  const sandboxHome = tempDir(); // simulates a Codex sandbox $HOME
  const requiredRoot = path.join(realHome, 'Vaults', 'Vault v3');

  assert.throws(
    () => resolveConfig({ homeDir: sandboxHome, env: { JARVOS_REQUIRE_CANONICAL_VAULT: requiredRoot } }),
    /outside the required canonical vault/,
  );
});

test('JARVOS_REQUIRE_CANONICAL_VAULT passes when JARVOS_VAULT_DIR is pinned to the canonical root despite a sandbox $HOME', () => {
  const realHome = tempDir();
  const sandboxHome = tempDir();
  const requiredRoot = path.join(realHome, 'Vaults', 'Vault v3');

  const config = resolveConfig({
    homeDir: sandboxHome,
    env: { JARVOS_REQUIRE_CANONICAL_VAULT: requiredRoot, JARVOS_VAULT_DIR: requiredRoot },
  });
  assert.equal(config.paths.vault, requiredRoot);
});

test('discoverExistingVault finds one reusable vault with Notes, Journal, and Tags', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });

  assert.equal(discoverExistingVault({ homeDir: home }), vault);
});

test('shared-vault onboarding writes a config a new runtime home can reuse', () => {
  const realHome = tempDir();
  const runtimeHome = tempDir();
  const workspace = path.join(runtimeHome, 'runtime-workspace');
  const configPath = path.join(workspace, 'jarvos.config.json');
  const vault = path.join(realHome, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });

  writeSharedVaultConfig({
    configPath,
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: runtimeHome,
    user: { name: 'Hermes', timezone: 'UTC' },
  });

  const config = resolveConfig({ configPath, homeDir: runtimeHome, env: {} });
  assert.equal(config.paths.workspace, workspace);
  assert.equal(config.paths.vault, vault);
  assert.equal(config.paths.notes, path.join(vault, 'Notes'));
  assert.equal(config.paths.journal, path.join(vault, 'Journal'));
  assert.equal(config.paths.tags, path.join(vault, 'Tags'));
  assert.equal(config.user.name, 'Hermes');
  assert.equal(config.user.timezone, 'UTC');
});

test('shared-vault onboarding refuses paths without Notes, Journal, and Tags', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });

  assert.throws(
    () => buildSharedVaultConfig({ vaultDir: vault, homeDir: home }),
    /missing required directories \(Journal, Tags\)/,
  );
});

test('shared-vault onboarding requires Notes, Journal, and Tags to be directories', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(vault, { recursive: true });
  for (const entry of ['Notes', 'Journal', 'Tags']) fs.writeFileSync(path.join(vault, entry), 'not a directory\n');

  assert.throws(
    () => buildSharedVaultConfig({ vaultDir: vault, homeDir: home }),
    /missing required directories \(Notes, Journal, Tags\)/,
  );
});

test('shared-vault onboarding is idempotent and refuses to replace a different config', () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const configPath = path.join(workspace, 'jarvos.config.json');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });

  const first = writeSharedVaultConfig({
    configPath,
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  });
  const second = writeSharedVaultConfig({
    configPath,
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);

  const compatibleSuperset = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  compatibleSuperset.gbrainContinuity = { required: true };
  fs.writeFileSync(configPath, `${JSON.stringify(compatibleSuperset, null, 2)}\n`);
  assert.equal(writeSharedVaultConfig({
    configPath,
    vaultDir: vault,
    workspaceRoot: workspace,
    homeDir: home,
    user: { name: 'Tester', timezone: 'UTC' },
  }).changed, false);

  assert.throws(
    () => writeSharedVaultConfig({
      configPath,
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir: home,
      user: { name: 'Different User', timezone: 'UTC' },
    }),
    /Refusing to overwrite an existing jarvos\.config\.json/,
  );
});

test('macOS system-parent alias exception is exact, platform-bound, and realpath-bound', () => {
  const realpath = (candidate) => ({
    '/tmp': '/private/tmp',
    '/var': '/private/var',
  }[candidate] || candidate);

  assert.equal(isAllowedMacOSSystemParentAlias('/tmp', '/tmp/runtime/jarvos.config.json', 'darwin', realpath), true);
  assert.equal(isAllowedMacOSSystemParentAlias('/var', '/var/runtime/jarvos.config.json', 'darwin', realpath), true);

  // The exception is for parent components only: a symlink cannot be the
  // final config target even when it is one of the two standard aliases.
  assert.equal(isAllowedMacOSSystemParentAlias('/tmp', '/tmp', 'darwin', realpath), false);
  assert.equal(isAllowedMacOSSystemParentAlias('/var', '/var', 'darwin', realpath), false);

  // A different platform, a different path, or a changed canonical mapping
  // must not widen the exception.
  assert.equal(isAllowedMacOSSystemParentAlias('/tmp', '/tmp/runtime/jarvos.config.json', 'linux', realpath), false);
  assert.equal(isAllowedMacOSSystemParentAlias('/var/tmp', '/var/tmp/runtime/jarvos.config.json', 'darwin', realpath), false);
  assert.equal(isAllowedMacOSSystemParentAlias('/tmp', '/tmp/runtime/jarvos.config.json', 'darwin', () => '/private/not-tmp'), false);
});

test('shared-vault onboarding accepts the standard macOS parent aliases but not an aliased final target', { skip: process.platform !== 'darwin' }, () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });

  for (const [base, canonical, alias] of [['/tmp', '/private/tmp', '/tmp'], ['/var/tmp', '/private/var/tmp', '/var']]) {
    const workspace = fs.mkdtempSync(path.join(base, 'jarvos-config-alias-'));
    const configPath = path.join(workspace, 'jarvos.config.json');
    assert.equal(fs.realpathSync(base), canonical);

    writeSharedVaultConfig({
      configPath,
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir: home,
      user: { name: 'Tester', timezone: 'UTC' },
    });
    assert.equal(fs.existsSync(configPath), true, `${base} parent alias should be usable for sync`);

    assert.throws(
      () => writeSharedVaultConfig({
        configPath: alias,
        vaultDir: vault,
        workspaceRoot: workspace,
        homeDir: home,
        user: { name: 'Tester', timezone: 'UTC' },
      }),
      /symlinked config path/,
      `${alias} must remain rejected when used as the final target`,
    );
  }
});

test('shared-vault onboarding refuses config targets inside the vault or behind symlinks', { skip: process.platform === 'win32' }, () => {
  const home = tempDir();
  const workspace = path.join(home, 'workspace');
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });

  assert.throws(
    () => writeSharedVaultConfig({
      configPath: path.join(vault, 'jarvos.config.json'),
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir: home,
      user: { name: 'Tester', timezone: 'UTC' },
    }),
    /inside the shared vault/,
  );
  assert.equal(fs.existsSync(path.join(vault, 'jarvos.config.json')), false);

  const targetDirectory = path.join(home, 'target-directory');
  const linkedDirectory = path.join(home, 'linked-directory');
  fs.mkdirSync(targetDirectory);
  fs.symlinkSync(targetDirectory, linkedDirectory, 'dir');
  assert.throws(
    () => writeSharedVaultConfig({
      configPath: path.join(linkedDirectory, 'jarvos.config.json'),
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir: home,
      user: { name: 'Tester', timezone: 'UTC' },
    }),
    /symlinked config path/,
  );
  assert.equal(fs.existsSync(path.join(targetDirectory, 'jarvos.config.json')), false);

  const danglingConfig = path.join(home, 'dangling.json');
  fs.symlinkSync(path.join(home, 'missing.json'), danglingConfig);
  assert.throws(
    () => writeSharedVaultConfig({
      configPath: danglingConfig,
      vaultDir: vault,
      workspaceRoot: workspace,
      homeDir: home,
      user: { name: 'Tester', timezone: 'UTC' },
    }),
    /symlinked config path/,
  );

  const racedWorkspace = path.join(home, 'raced-workspace');
  const originalMkdirSync = fs.mkdirSync;
  fs.mkdirSync = (directory, options) => {
    if (directory === racedWorkspace) {
      fs.symlinkSync(vault, racedWorkspace, 'dir');
      return undefined;
    }
    return originalMkdirSync(directory, options);
  };
  try {
    assert.throws(
      () => writeSharedVaultConfig({
        configPath: path.join(racedWorkspace, 'jarvos.config.json'),
        vaultDir: vault,
        workspaceRoot: racedWorkspace,
        homeDir: home,
        user: { name: 'Tester', timezone: 'UTC' },
      }),
      /symlinked config path/,
    );
    assert.equal(fs.existsSync(path.join(vault, 'jarvos.config.json')), false);
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
});

test('shared-vault onboarding rejects invalid timezones before generating a config', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Tags'), { recursive: true });

  assert.throws(
    () => buildSharedVaultConfig({
      vaultDir: vault,
      workspaceRoot: path.join(home, 'workspace'),
      homeDir: home,
      user: { name: 'Tester', timezone: 'Not/AZone' },
    }),
    /valid IANA timezone/,
  );
});

test('resolveConfig preserves historical default resolution for legacy bootstrap paths', () => {
  const home = tempDir();
  const configPath = path.join(home, 'legacy.json');
  fs.writeFileSync(configPath, JSON.stringify({
    userName: 'Legacy User',
    workspacePath: '/srv/legacy-workspace',
    vaultPath: '/srv/legacy-vault',
  }));

  const config = resolveConfig({ configPath, homeDir: home, env: {} });
  assert.equal(config.paths.workspace, path.join(home, 'clawd'));
  assert.equal(config.paths.vault, path.join(home, 'Vaults', 'Vault v3'));
  assert.equal(config.paths.journal, path.join(home, 'Vaults', 'Vault v3', 'Journal'));
  assert.equal(config.user.name, 'Legacy User');
});







test('shared-vault onboarding rejects a stale vault and discovery skips its DO_NOT_USE marker', () => {
  const home = tempDir();
  const staleVault = path.join(home, 'Documents', 'Vault v3');
  const canonicalVault = path.join(home, 'Vaults', 'Vault v3');
  for (const vault of [staleVault, canonicalVault]) {
    for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(staleVault, 'DO_NOT_USE.txt'), `Use ${canonicalVault} instead.\n`);

  assert.equal(discoverExistingVault({ homeDir: home }), canonicalVault);
  assert.throws(
    () => buildSharedVaultConfig({ vaultDir: staleVault, workspaceRoot: path.join(home, 'workspace'), homeDir: home }),
    /Refusing to use stale vault path/,
  );
});
