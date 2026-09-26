'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHostProjectsContextProvider } = require('../src/projects-context-bootstrap');

function fixture(t, {
  supportsProof = true,
  proofReceiptPath = undefined,
  aliasProofToCapability = false,
  groupReadableProof = false,
  omitProofKey = false,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-bootstrap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const stateRoot = path.join(root, 'state');
  for (const dir of [repositoryRoot, stateRoot, path.join(stateRoot, 'registry'), path.join(stateRoot, 'release')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const providerModule = path.join(repositoryRoot, 'provider.js');
  fs.writeFileSync(
    providerModule,
    `module.exports.read = async () => ({ status: 'ordinary' });\n`
    + `module.exports.readRoster = async (request) => ({ status: 'ok', expectedGeneration: request.expectedGeneration });\n`
    + (supportsProof
      ? `module.exports.readPortfolioProof = async (request) => ({ status: 'ok', request });\n`
      : ''),
    { mode: 0o600 },
  );
  const query = { scope: { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: true }, include: ['hierarchy'], limits: { maxItems: 24, maxBytes: 16000, maxProviderAgeSeconds: 3600 } };
  const capabilityReceipt = path.join(stateRoot, 'capability.json');
  fs.writeFileSync(capabilityReceipt, JSON.stringify({ receiptId: 'cap_ordinary' }), { mode: 0o600 });
  const capabilitySecret = path.join(stateRoot, 'capability.secret');
  fs.writeFileSync(capabilitySecret, 'shared-capability-secret', { mode: 0o600 });

  let resolvedProofPath = proofReceiptPath;
  if (resolvedProofPath === undefined && !omitProofKey) {
    resolvedProofPath = aliasProofToCapability ? capabilityReceipt : path.join(stateRoot, 'portfolio-proof.json');
    if (resolvedProofPath !== capabilityReceipt) {
      fs.writeFileSync(resolvedProofPath, JSON.stringify({ receiptId: 'cap_proof' }), { mode: groupReadableProof ? 0o640 : 0o600 });
    }
  }

  const config = path.join(root, 'projects.json');
  const configBody = {
    workspaceRoot: root,
    repositoryRoot,
    providerModule,
    stateRoot,
    registryStateDir: path.join(stateRoot, 'registry'),
    releaseProviderStateDir: path.join(stateRoot, 'release'),
    query,
    hostId: 'proof-host',
    subject: 'proof-observer',
    capabilityReceiptPath: capabilityReceipt,
    capabilitySecret,
  };
  if (!omitProofKey) configBody.portfolioProofCapabilityReceiptPath = resolvedProofPath;
  fs.writeFileSync(config, JSON.stringify(configBody), { mode: 0o600 });
  return { provider: createHostProjectsContextProvider({ JARVOS_PROJECTS_CONTEXT_CONFIG: config }), query, providerModule, config };
}

test('ordinary read and readRoster survive a missing or invalid portfolio proof key', async (t) => {
  const { provider: missing } = fixture(t, { omitProofKey: true });
  assert.ok(missing);
  assert.deepEqual(await missing.read({}), { status: 'ordinary' });
  assert.equal((await missing.readRoster({ expectedGeneration: 1 })).status, 'ok');
  assert.equal((await missing.readPortfolioProof({ expectedGeneration: 1 })).status, 'unavailable');

  const { provider: nonexistent } = fixture(t, { proofReceiptPath: '/nonexistent/portfolio-proof.json' });
  assert.ok(nonexistent);
  assert.deepEqual(await nonexistent.read({}), { status: 'ordinary' });
  assert.equal((await nonexistent.readRoster({ expectedGeneration: 1 })).status, 'ok');
  assert.equal((await nonexistent.readPortfolioProof({ expectedGeneration: 1 })).status, 'unavailable');
});

test('portfolio proof receipt aliased to the ordinary capability receipt is rejected', async (t) => {
  const { provider } = fixture(t, { aliasProofToCapability: true });
  assert.ok(provider);
  const out = await provider.readPortfolioProof({ expectedGeneration: 1 });
  assert.equal(out.status, 'unavailable');
});

test('a group-readable portfolio proof receipt is rejected', async (t) => {
  const { provider } = fixture(t, { groupReadableProof: true });
  assert.ok(provider);
  const out = await provider.readPortfolioProof({ expectedGeneration: 1 });
  assert.equal(out.status, 'unavailable');
});

test('readPortfolioProof enforces an exact single-key request allowlist', async (t) => {
  const { provider } = fixture(t);
  for (const request of [
    undefined,
    {},
    { expectedGeneration: 0 },
    { expectedGeneration: -1 },
    { expectedGeneration: '1' },
    { expectedGeneration: 1.5 },
    { expectedGeneration: 1, query: {} },
    { expectedGeneration: 1, capability: {} },
    { expectedGeneration: 1, path: '/etc/passwd' },
    { expectedGeneration: 1, secret: 'x' },
    { expectedGeneration: 1, profile: 'default' },
  ]) {
    assert.notEqual((await provider.readPortfolioProof(request)).status, 'ok');
  }
  assert.equal((await provider.readPortfolioProof({ expectedGeneration: 1 })).status, 'ok');
});

test('readPortfolioProof passes trusted host binding and disables renewal', async (t) => {
  const { provider } = fixture(t);
  const out = await provider.readPortfolioProof({ expectedGeneration: 3 });
  assert.equal(out.status, 'ok');
  const { request } = out;
  assert.deepEqual(Object.keys(request).sort(), [
    'capability', 'capabilitySecret', 'expectedGeneration', 'hostBindingDigests',
    'hostId', 'registryStateDir', 'releaseRefreshPolicy', 'repositoryRoot',
    'stateRoot', 'subject',
  ].sort());
  assert.equal(request.hostId, 'proof-host');
  assert.equal(request.subject, 'proof-observer');
  assert.equal(request.expectedGeneration, 3);
  assert.equal(request.releaseRefreshPolicy.enabled, false);
  assert.equal(typeof request.hostBindingDigests.configDigest, 'string');
  assert.equal(typeof request.hostBindingDigests.providerDigest, 'string');
  assert.deepEqual(request.capability, { receiptId: 'cap_proof' });
  assert.equal(request.capabilitySecret, 'shared-capability-secret');
});

test('readPortfolioProof never falls back to readRoster or ordinary read', async (t) => {
  const { provider } = fixture(t, { supportsProof: false });
  assert.equal((await provider.readPortfolioProof({ expectedGeneration: 1 })).status, 'unavailable');
});

test('normal query profile is unaffected by the portfolio proof binding', async (t) => {
  const { provider, query } = fixture(t);
  assert.deepEqual(provider.defaultQuery, query);
});

test('source CLI requires exactly one expected-generation argument before reading host configuration', async () => {
  const { run } = require('../scripts/jarvos-projects-portfolio-proof');
  for (const argv of [
    [],
    ['--expected-generation'],
    ['--expected-generation', '0'],
    ['--expected-generation', '-1'],
    ['--expected-generation', '1.5'],
    ['--scope', 'all'],
    ['--expected-generation', '1', '--extra', 'x'],
  ]) {
    assert.equal((await run(argv, {})).code, 'PORTFOLIO_PROOF_ARGUMENTS_INVALID');
  }
});

test('source CLI invokes only host readPortfolioProof and exits according to status', async (t) => {
  const { run } = require('../scripts/jarvos-projects-portfolio-proof');
  const { config } = fixture(t);
  const out = await run(['--expected-generation', '1'], { JARVOS_PROJECTS_CONTEXT_CONFIG: config });
  assert.equal(out.status, 'ok');
});
