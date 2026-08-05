'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  initializeSecurityVault,
  loadSigningKey,
  vaultPaths,
} = require('../src/features/security/vault');

function fakeTools({ failPassphraseOnce = false } = {}) {
  const calls = [];
  const privateByOutput = new Map();
  let shouldFailPassphrase = failPassphraseOnce;
  async function execute(command, args, options = {}) {
    calls.push([command, args, options]);
    const outputIndex = args.indexOf('-o');
    const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
    if (command === 'age-plugin-se' && args[0] === 'keygen') {
      await fs.writeFile(output, '# public key: age1se1touchid\nAGE-PLUGIN-SE-TEST\n', { mode: 0o600 });
      return { ok: true, stdout: 'Public key: age1se1touchid\n', stderr: '' };
    }
    if (command === 'age-keygen') {
      return {
        ok: true,
        stdout: '# created: now\n# public key: age1recovery\nAGE-SECRET-KEY-TEST\n',
        stderr: '',
      };
    }
    if (command === 'age' && args.includes('--passphrase')) {
      if (shouldFailPassphrase) {
        shouldFailPassphrase = false;
        return { ok: false, stdout: '', stderr: 'cancelled' };
      }
      assert.match(String(options.input), /AGE-SECRET-KEY-TEST/);
      await fs.writeFile(output, 'passphrase-encrypted-recovery-identity\n', { mode: 0o600 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command === 'age' && args.includes('--encrypt')) {
      privateByOutput.set(output, String(options.input || ''));
      await fs.writeFile(output, `encrypted:${path.basename(output)}\n`, { mode: 0o600 });
      return { ok: true, stdout: '', stderr: '' };
    }
    if (command === 'age' && args.includes('--decrypt')) {
      return { ok: true, stdout: privateByOutput.get(args.at(-1)) || '', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command' };
  }
  return { calls, execute };
}

test('one Touch ID identity and one recovery credential protect separate signer keys', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-vault-'));
  const tools = fakeTools();
  const result = await initializeSecurityVault({ root, execute: tools.execute });
  const files = vaultPaths(root);

  assert.deepEqual(
    { status: result.status, unlock: result.unlock, recoveryCredentials: result.recoveryCredentials },
    { status: 'initialized', unlock: 'touch-id', recoveryCredentials: 1 },
  );
  assert.equal(tools.calls.filter(([command, args]) => command === 'age-plugin-se' && args[0] === 'keygen').length, 1);
  assert.equal(tools.calls.filter(([command, args]) => command === 'age-keygen' && args.length === 0).length, 1);
  assert.equal(tools.calls.filter(([command, args]) => command === 'age' && args.includes('--encrypt')).length, 2);
  assert.equal((await fs.stat(files.secureEnclaveIdentity)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(files.activationPrivateKey, 'utf8'), /PRIVATE KEY/);
  assert.doesNotMatch(await fs.readFile(files.projectsPrivateKey, 'utf8'), /PRIVATE KEY/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY|passphrase/i);
  assert.equal((await fs.readdir(root)).some((entry) => /plain/i.test(entry)), false);
});

test('the same unlock surface loads either purpose but keys remain purpose-bound', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-load-'));
  const tools = fakeTools();
  await initializeSecurityVault({ root, execute: tools.execute });
  assert.match(await loadSigningKey({ root, purpose: 'activation', execute: tools.execute }), /PRIVATE KEY/);
  assert.match(await loadSigningKey({ root, purpose: 'projects', execute: tools.execute }), /PRIVATE KEY/);
  await assert.rejects(
    loadSigningKey({ root, purpose: 'publication', execute: tools.execute }),
    /unknown signing purpose/,
  );
});

test('recovery can prompt while decrypted signer output remains internal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-recovery-'));
  const tools = fakeTools();
  await initializeSecurityVault({ root, execute: tools.execute });
  await loadSigningKey({ root, purpose: 'activation', recovery: true, execute: tools.execute });
  const recoveryCall = tools.calls.find(([command, args]) => command === 'age' && args.includes('--decrypt'));
  assert.deepEqual(recoveryCall[2], { interactive: true, captureStdout: true });
  assert.ok(recoveryCall[1].includes(vaultPaths(root).recoveryIdentity));
});

test('cancelled setup removes only its partial vault files and can be retried', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-retry-'));
  const tools = fakeTools({ failPassphraseOnce: true });
  await assert.rejects(initializeSecurityVault({ root, execute: tools.execute }), /could not protect recovery identity/);
  const remaining = await fs.readdir(root);
  assert.deepEqual(remaining, []);
  await assert.doesNotReject(initializeSecurityVault({ root, execute: tools.execute }));
});

test('an initialized vault is never overwritten', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-existing-'));
  const tools = fakeTools();
  await initializeSecurityVault({ root, execute: tools.execute });
  await assert.rejects(initializeSecurityVault({ root, execute: tools.execute }), /already initialized/);
});

test('a concurrent setup cannot clean up or overwrite the active setup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-concurrent-'));
  const tools = fakeTools();
  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const released = new Promise((resolve) => { releaseFirst = resolve; });
  let blocked = false;
  const execute = async (command, args, options) => {
    if (!blocked && command === 'age-plugin-se' && args[0] === 'keygen') {
      blocked = true;
      signalStarted();
      await released;
    }
    return tools.execute(command, args, options);
  };

  const first = initializeSecurityVault({ root, execute });
  await started;
  await assert.rejects(
    initializeSecurityVault({ root, execute: tools.execute }),
    /setup is already in progress/,
  );
  releaseFirst();
  await assert.doesNotReject(first);

  const files = vaultPaths(root);
  await assert.doesNotReject(fs.access(files.manifest));
  await assert.doesNotReject(fs.access(files.activationPrivateKey));
  await assert.doesNotReject(fs.access(files.projectsPrivateKey));
});

test('a setup can safely replace a lock left by a dead process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvos-security-stale-lock-'));
  const files = vaultPaths(root);
  await fs.mkdir(files.setupLock, { mode: 0o700 });
  await fs.writeFile(path.join(files.setupLock, 'owner.json'), JSON.stringify({
    pid: 99_999_999,
    startedAt: '2026-08-01T00:00:00.000Z',
    token: 'stale',
  }));

  await assert.doesNotReject(initializeSecurityVault({ root, execute: fakeTools().execute }));
  await assert.doesNotReject(fs.access(files.manifest));
  await assert.rejects(fs.access(files.setupLock), { code: 'ENOENT' });
});
