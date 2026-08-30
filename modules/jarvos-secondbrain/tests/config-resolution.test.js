const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  atomicReplaceConfig,
  buildSharedVaultConfig,
  discoverConfigPath,
  discoverExistingVault,
  parseEnvFile,
  resolveConfig,
  resolveJournalConfig,
  resolvePaperclipConfig,
  writeSharedVaultConfig,
} = require('../bridge/config');

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-config-')));
}

test('config migration replacement does not follow a target symlink swapped in after assessment', { skip: process.platform === 'win32' }, () => {
  const root = tempDir();
  const target = path.join(root, 'jarvos.config.json');
  const victim = path.join(root, 'victim.json');
  fs.writeFileSync(victim, 'preserve me\n');
  fs.symlinkSync(victim, target);
  atomicReplaceConfig(target, '{"migrated":true}\n');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"migrated":true}\n');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'preserve me\n');
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
