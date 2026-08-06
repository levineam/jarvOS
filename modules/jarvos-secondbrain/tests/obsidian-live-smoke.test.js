'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ATTESTATION_PATH_ENV,
  CANDIDATE_MANIFEST_ENV,
  LIVE_GATE,
  RUNTIME_MANIFEST_ENV,
  SMOKE_DIRECTORY_ENV,
  assertMatchingManifests,
  parseObsidianVersion,
  runLiveSmoke,
  verifyObsidianCli,
} = require('../scripts/obsidian-live-smoke');

const DIGEST = 'a'.repeat(64);
const NONCE = '12345678-1234-1234-1234-123456789abc';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-live-smoke-'));
  const vaultRoot = path.join(root, 'Vault');
  const smokeDirectory = 'JarVOS Smoke';
  fs.mkdirSync(path.join(vaultRoot, smokeDirectory), { recursive: true });
  const candidatePath = path.join(root, 'candidate.json');
  const runtimePath = path.join(root, 'runtime.json');
  const attestationPath = path.join(root, 'state', 'attestation.json');
  fs.writeFileSync(candidatePath, JSON.stringify({ clean: true, revision: 'abc123', artifactManifestHash: DIGEST, gateOutputDigests: { test: DIGEST } }));
  fs.writeFileSync(runtimePath, JSON.stringify({ revision: 'abc123', artifactManifestHash: DIGEST }));
  const env = {
    [LIVE_GATE]: '1',
    [CANDIDATE_MANIFEST_ENV]: candidatePath,
    [RUNTIME_MANIFEST_ENV]: runtimePath,
    [ATTESTATION_PATH_ENV]: attestationPath,
    [SMOKE_DIRECTORY_ENV]: smokeDirectory,
    JARVOS_VAULT_ROOT: vaultRoot,
  };
  return { root, vaultRoot, smokeDirectory, candidatePath, runtimePath, attestationPath, env };
}

function fakeService() {
  const content = new Map();
  let sequence = 0;
  let retainedTerminal = 0;
  const health = () => ({ pending: 0, ambiguous: 0, conflict: 0, quarantined: 0, malformed: 0, retainedTerminal });
  const inspectInvariant = (operation) => {
    if (operation.operationKind === 'delete') return content.has(operation.vaultRelativePath) ? { status: 'unsatisfied', invariant: false } : { status: 'satisfied', invariant: true };
    return content.has(operation.vaultRelativePath) ? { status: 'unsatisfied', invariant: false } : { status: 'missing', invariant: false };
  };
  return {
    vaultId: 'vault:test',
    reconciler: { health },
    adapter: { inspectInvariant },
    createWriteContext({ vaultRelativePath, operationId }) {
      return { mutationExecutor: (operation) => this.execute(operation), operationId, vaultId: 'vault:test', vaultRelativePath, sequence: ++sequence, source: 'operator.obsidian-live-smoke' };
    },
    execute(operation) {
      if (operation.operationKind === 'create') content.set(operation.vaultRelativePath, operation.content);
      else if (operation.operationKind === 'transform') content.set(operation.vaultRelativePath, `${content.get(operation.vaultRelativePath)}${operation.replayPayload.line}\n`);
      retainedTerminal += 1;
      return { status: 'committed', obsidian: 'acknowledged' };
    },
    deleteMarkdownFile({ vaultRelativePath, expectedContent }) {
      if (content.get(vaultRelativePath) !== expectedContent) return { status: 'conflict', obsidian: 'unacknowledged' };
      content.delete(vaultRelativePath);
      retainedTerminal += 1;
      return { status: 'committed', obsidian: 'acknowledged' };
    },
  };
}

test('live smoke is a no-op unless explicitly enabled', () => {
  assert.deepEqual(runLiveSmoke({ env: {} }), { skipped: true, reason: `${LIVE_GATE} is not 1` });
});

test('registered CLI verification uses the version subcommand and requires Obsidian 1.12.7+', () => {
  const calls = [];
  const result = verifyObsidianCli({ command: '/usr/local/bin/obsidian', execute(command, args) { calls.push([command, args]); return '1.13.2 (installer 1.7.7)\n'; } });
  assert.deepEqual(calls, [['/usr/local/bin/obsidian', ['version']]]);
  assert.deepEqual(parseObsidianVersion('1.12.7'), [1, 12, 7]);
  assert.equal(result.version, '1.13.2');
  assert.throws(() => verifyObsidianCli({ execute: () => '1.12.6\n' }), /1\.12\.7 or newer/);
});

test('source-to-runtime attestation fails closed on dirty or mismatched manifests', () => {
  const fixture = setup();
  try {
    assert.equal(assertMatchingManifests({ candidatePath: fixture.candidatePath, runtimePath: fixture.runtimePath }).equality, true);
    fs.writeFileSync(fixture.runtimePath, JSON.stringify({ revision: 'different', artifactManifestHash: DIGEST }));
    assert.throws(() => assertMatchingManifests({ candidatePath: fixture.candidatePath, runtimePath: fixture.runtimePath }), /revisions do not match/);
    fs.writeFileSync(fixture.candidatePath, JSON.stringify({ clean: false, revision: 'abc123', artifactManifestHash: DIGEST, gateOutputDigests: { test: DIGEST } }));
    assert.throws(() => assertMatchingManifests({ candidatePath: fixture.candidatePath, runtimePath: fixture.runtimePath }), /clean source revision/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('live smoke creates, transforms, and guarded-deletes only a disposable fixture', () => {
  const fixture = setup();
  const service = fakeService();
  try {
    const result = runLiveSmoke({
      env: fixture.env,
      nonce: NONCE,
      serviceFactory({ vaultRoot, source, allowDeleteOperation }) {
        assert.equal(vaultRoot, fixture.vaultRoot);
        assert.equal(source, 'operator.obsidian-live-smoke');
        assert.equal(allowDeleteOperation({ source, vaultRelativePath: `${fixture.smokeDirectory}/jarvos-live-smoke-${NONCE}.md` }), true);
        assert.equal(allowDeleteOperation({ source, vaultRelativePath: 'Notes/Authored.md' }), false);
        return service;
      },
      execute: () => '1.12.7\n',
      inspectSync: ({ expectedHash }) => ({ status: 'converged', expectedHash }),
      now: () => '2030-02-03T04:05:06.000Z',
    });
    assert.equal(result.fixture, `${fixture.smokeDirectory}/jarvos-live-smoke-${NONCE}.md`);
    assert.equal(result.create, 'acknowledged');
    assert.equal(result.transform, 'acknowledged');
    assert.equal(result.deletion, 'acknowledged');
    assert.equal(result.sync.status, 'converged');
    assert.equal(result.after.retainedTerminal - result.baseline.retainedTerminal, 3);
    const attestation = JSON.parse(fs.readFileSync(fixture.attestationPath, 'utf8'));
    assert.equal(attestation.status, 'passed');
    assert.equal(fs.statSync(fixture.attestationPath).mode & 0o777, 0o600);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('manifest mismatch stops before service composition or any fixture mutation', () => {
  const fixture = setup();
  fs.writeFileSync(fixture.runtimePath, JSON.stringify({ revision: 'abc123', artifactManifestHash: crypto.randomBytes(32).toString('hex') }));
  let composed = false;
  try {
    assert.throws(() => runLiveSmoke({ env: fixture.env, nonce: NONCE, serviceFactory() { composed = true; return fakeService(); }, execute: () => '1.12.7\n' }), /artifact manifests do not match/);
    assert.equal(composed, false);
    assert.equal(fs.existsSync(fixture.attestationPath), false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const status of ['pending', 'diverged', 'unknown']) {
  test(`live smoke records failure when per-file Sync is ${status}`, () => {
    const fixture = setup();
    try {
      assert.throws(() => runLiveSmoke({
        env: fixture.env,
        nonce: NONCE,
        serviceFactory: () => fakeService(),
        execute: () => '1.12.7\n',
        inspectSync: () => ({ status }),
      }), /Sync did not converge/);
      assert.equal(JSON.parse(fs.readFileSync(fixture.attestationPath, 'utf8')).status, 'failed');
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

test('live smoke records failure when no per-file Sync inspector is configured', () => {
  const fixture = setup();
  try {
    assert.throws(() => runLiveSmoke({ env: fixture.env, nonce: NONCE, serviceFactory: () => fakeService(), execute: () => '1.12.7\n' }), /requires the configured per-file Sync inspector/);
    assert.equal(JSON.parse(fs.readFileSync(fixture.attestationPath, 'utf8')).status, 'failed');
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test('live smoke refuses to use a missing dedicated fixture directory', () => {
  const fixture = setup();
  fs.rmSync(path.join(fixture.vaultRoot, fixture.smokeDirectory), { recursive: true });
  try {
    assert.throws(() => runLiveSmoke({ env: fixture.env, nonce: NONCE, serviceFactory: () => fakeService(), execute: () => '1.12.7\n' }), /Dedicated smoke directory does not exist/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
