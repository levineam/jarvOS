'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const script = path.resolve(__dirname, '../scripts/detect-vault.js');

function runDetector(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  for (const key of [
    'CLAWD_DIR',
    'JARVOS_CLAWD_DIR',
    'JARVOS_CONFIG_FILE',
    'JARVOS_CONFIG_PATH',
    'JARVOS_JOURNAL_DIR',
    'JARVOS_NOTES_DIR',
    'JARVOS_VAULT_DIR',
    'JOURNAL_DIR',
    'VAULT_NOTES_DIR',
    'XDG_CONFIG_HOME',
  ]) delete env[key];
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', env });
}

test('detect-vault uses the canonical shared resolver', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-vault-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const canonical = path.join(home, 'Vaults', 'Vault v3');
  fs.mkdirSync(canonical, { recursive: true });

  const result = runDetector(home);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    vault: canonical,
    journal: path.join(canonical, 'Journal'),
    notes: path.join(canonical, 'Notes'),
    configPath: path.join(home, 'clawd', 'jarvos.config.json'),
    configExists: false,
  });
});

test('detect-vault JSON mode does not emit a nonexistent vault as usable', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-vault-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = runDetector(home);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /does not exist on disk/);
});

test('detect-vault rejects an explicitly configured stale Documents vault', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-vault-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'Vaults', 'Vault v3'), { recursive: true });
  fs.mkdirSync(path.join(home, 'clawd'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'clawd', 'jarvos.config.json'),
    JSON.stringify({ paths: { vault: '~/Documents/Vault v3' } }),
  );

  const result = runDetector(home);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Refusing to use stale vault path/);
});
