'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHostProjectsContextProvider } = require('../src/projects-context-bootstrap');

function fixture(t, supportsRoster = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roster-bootstrap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const stateRoot = path.join(root, 'state');
  for (const dir of [repositoryRoot, stateRoot, path.join(stateRoot, 'registry'), path.join(stateRoot, 'release')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const providerModule = path.join(repositoryRoot, 'provider.js');
  fs.writeFileSync(providerModule, `module.exports.read = async () => ({ status: 'ordinary' });\n${supportsRoster ? "module.exports.readRoster = async (request) => ({ status: 'ok', query: request.query, expectedGeneration: request.expectedGeneration, renewal: request.releaseRefreshPolicy });" : ''}`, { mode: 0o600 });
  const query = { scope: { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: true }, include: ['hierarchy'], limits: { maxItems: 24, maxBytes: 16000, maxProviderAgeSeconds: 3600 } };
  const config = path.join(root, 'projects.json');
  fs.writeFileSync(config, JSON.stringify({ workspaceRoot: root, repositoryRoot, providerModule, stateRoot, registryStateDir: path.join(stateRoot, 'registry'), releaseProviderStateDir: path.join(stateRoot, 'release'), query }), { mode: 0o600 });
  return { provider: createHostProjectsContextProvider({ JARVOS_PROJECTS_CONTEXT_CONFIG: config }), query, providerModule, config };
}

test('host roster uses trusted query, disables renewal and preserves ordinary read', async (t) => {
  const { provider, query } = fixture(t);
  assert.ok(provider);
  assert.equal(typeof provider.readRoster, 'function');
  provider.defaultQuery.scope.projectIds = [];
  const out = await provider.readRoster({ expectedGeneration: 7 });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.query, query);
  assert.equal(out.expectedGeneration, 7);
  assert.equal(out.renewal.enabled, false);
  assert.deepEqual(await provider.read({ query }), { status: 'ordinary' });
});

test('host roster rejects caller authority and unsupported continuation', async (t) => {
  const { provider } = fixture(t);
  for (const request of [{ query: {} }, { scope: {} }, { continuation: 'token' }, { releaseRefreshPolicy: { enabled: true } }, { expectedGeneration: -1 }, { expectedGeneration: '7' }]) {
    assert.notEqual((await provider.readRoster(request)).status, 'ok');
  }
});

test('host roster never falls back to ordinary provider read', async (t) => {
  const { provider } = fixture(t, false);
  assert.equal((await provider.readRoster()).status, 'unavailable');
});

test('host roster sanitizes private provider exceptions', async (t) => {
  const { provider, providerModule } = fixture(t);
  require(providerModule).readRoster = async () => { throw new Error('private-path-and-secret'); };
  const out = await provider.readRoster();
  assert.equal(out.status, 'unavailable');
  assert.ok(!JSON.stringify(out).includes('private-path-and-secret'));
});

test('source CLI rejects scope and continuation flags before reading host configuration', async () => {
  const { run } = require('../scripts/jarvos-projects-roster');
  for (const argv of [['--scope', 'all'], ['--continuation', 'token'], ['--expected-generation', '-1'], ['--expected-generation', '9007199254740992']]) {
    assert.equal((await run(argv, {})).code, 'ROSTER_ARGUMENTS_INVALID');
  }
});
