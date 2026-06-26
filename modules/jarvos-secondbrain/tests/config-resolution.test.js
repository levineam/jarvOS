const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildSharedVaultConfig,
  discoverConfigPath,
  discoverExistingVault,
  parseEnvFile,
  resolveConfig,
  resolvePaperclipConfig,
  writeSharedVaultConfig,
} = require('../bridge/config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-config-'));
}

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

test('discoverExistingVault finds one reusable vault with Notes and Journal', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });

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
  assert.equal(config.user.name, 'Hermes');
  assert.equal(config.user.timezone, 'UTC');
});

test('shared-vault onboarding refuses paths without Notes and Journal', () => {
  const home = tempDir();
  const vault = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });

  assert.throws(
    () => buildSharedVaultConfig({ vaultDir: vault, homeDir: home }),
    /must contain Notes\/ and Journal\//,
  );
});
