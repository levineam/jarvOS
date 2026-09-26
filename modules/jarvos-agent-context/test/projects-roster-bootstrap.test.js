'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHostProjectsContextProvider } = require('../src/projects-context-bootstrap');
const { ProjectRegistry } = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/registry');
const { issueCapability } = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/projects-context-capability');
const REGISTRY_MODULE_PATH = require.resolve('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/registry');
const PROJECTS_CONTEXT_MODULE_PATH = require.resolve('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/projects-context');

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

const WHOLE_PORTFOLIO_QUERY = Object.freeze({
  scope: { projectIds: [], outcomeIds: [], includeDescendants: true },
  include: ['hierarchy'],
  limits: { maxItems: 1000, maxBytes: 262_144, maxProviderAgeSeconds: 86_400 },
});

function thirtyRosterRecords() {
  const records = [];
  for (let i = 1; i <= 30; i += 1) {
    records.push({ id: `prj_${String(i).padStart(6, '0')}`, kind: 'project', parentId: i === 1 ? null : 'prj_000001', revision: 1 });
  }
  return records;
}
const THIRTY_ROSTER_RECORDS = Object.freeze(thirtyRosterRecords());

function portfolioFixture(t, {
  supportsRoster = true,
  portfolioRosterResult = {
    status: 'ok',
    roster: {
      contract: 'jarvos.projects-roster/v1',
      generation: 42,
      capturedAt: '2026-01-01T00:00:00.000Z',
      scope: { projectIds: [], outcomeIds: [], includeDescendants: true },
      records: THIRTY_ROSTER_RECORDS,
      complete: true,
    },
  },
  includePortfolioRosterKeys = true,
  invalidPortfolioRosterScope = false,
  missingPortfolioRosterReceipt = false,
  aliasPortfolioReceiptToCapability = false,
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-roster-bootstrap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const stateRoot = path.join(root, 'state');
  for (const dir of [repositoryRoot, stateRoot, path.join(stateRoot, 'registry'), path.join(stateRoot, 'release')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const providerModule = path.join(repositoryRoot, 'provider.js');
  const providerSource = [
    "module.exports.read = async () => ({ status: 'ordinary' });",
    supportsRoster ? [
      'module.exports.readRoster = async (request) => {',
      "  const scope = request.query && request.query.scope;",
      '  const wholePortfolio = Boolean(scope) && Array.isArray(scope.projectIds) && scope.projectIds.length === 0'
        + ' && Array.isArray(scope.outcomeIds) && scope.outcomeIds.length === 0 && scope.includeDescendants === true;',
      '  if (!wholePortfolio) {',
      "    return { status: 'ok', query: request.query, expectedGeneration: request.expectedGeneration, renewal: request.releaseRefreshPolicy };",
      '  }',
      "  if (!request.capability || request.capability.receiptId !== 'cap_portfolio_roster') {",
      "    return { status: 'unavailable', code: 'PORTFOLIO_ROSTER_CAPABILITY_INVALID' };",
      '  }',
      `  return ${JSON.stringify(portfolioRosterResult)};`,
      '};',
    ].join('\n') : '',
  ].join('\n');
  fs.writeFileSync(providerModule, providerSource, { mode: 0o600 });

  const orientationQuery = { scope: { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: true }, include: ['hierarchy'], limits: { maxItems: 24, maxBytes: 16000, maxProviderAgeSeconds: 3600 } };

  const capabilityReceipt = path.join(stateRoot, 'capability.json');
  fs.writeFileSync(capabilityReceipt, JSON.stringify({ receiptId: 'cap_ordinary' }), { mode: 0o600 });

  const portfolioRosterCapabilityReceipt = path.join(stateRoot, 'portfolio-roster-capability.json');
  if (!missingPortfolioRosterReceipt) {
    fs.writeFileSync(portfolioRosterCapabilityReceipt, JSON.stringify({ receiptId: 'cap_portfolio_roster' }), { mode: 0o600 });
  }

  const badScopeQuery = { ...WHOLE_PORTFOLIO_QUERY, scope: { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: true } };

  const configBody = {
    workspaceRoot: root,
    repositoryRoot,
    providerModule,
    stateRoot,
    registryStateDir: path.join(stateRoot, 'registry'),
    releaseProviderStateDir: path.join(stateRoot, 'release'),
    query: orientationQuery,
    capabilityReceiptPath: capabilityReceipt,
  };
  if (includePortfolioRosterKeys) {
    configBody.portfolioRosterQuery = invalidPortfolioRosterScope ? badScopeQuery : WHOLE_PORTFOLIO_QUERY;
    configBody.portfolioRosterCapabilityReceiptPath = aliasPortfolioReceiptToCapability ? capabilityReceipt : portfolioRosterCapabilityReceipt;
  }
  const config = path.join(root, 'projects.json');
  fs.writeFileSync(config, JSON.stringify(configBody), { mode: 0o600 });
  return { provider: createHostProjectsContextProvider({ JARVOS_PROJECTS_CONTEXT_CONFIG: config }), providerModule, orientationQuery, config };
}

test('host portfolio roster uses a distinct whole-portfolio query and capability, returning all sorted identities', async (t) => {
  const { provider, orientationQuery } = portfolioFixture(t);
  assert.ok(provider);
  assert.equal(typeof provider.readPortfolioRoster, 'function');
  const out = await provider.readPortfolioRoster();
  assert.equal(out.status, 'ok');
  assert.equal(out.roster.records.length, 30);
  assert.deepEqual(out.roster.records, THIRTY_ROSTER_RECORDS);
  assert.ok(out.roster.records.some((record) => record.id === 'prj_000005'));
  const ids = out.roster.records.map((record) => record.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(out.roster.complete, true);
  assert.equal(out.roster.generation, 42);

  // Orientation readRoster is unaffected by the distinct portfolio binding.
  const orientation = await provider.readRoster({ expectedGeneration: 7 });
  assert.equal(orientation.status, 'ok');
  assert.deepEqual(orientation.query, orientationQuery);
});

test('host portfolio roster fails closed when the distinct query or capability binding is missing or invalid', async (t) => {
  for (const options of [
    { includePortfolioRosterKeys: false },
    { invalidPortfolioRosterScope: true },
    { missingPortfolioRosterReceipt: true },
  ]) {
    const { provider, orientationQuery } = portfolioFixture(t, options);
    const out = await provider.readPortfolioRoster();
    assert.notEqual(out.status, 'ok');
    assert.equal(out.status, 'unavailable');
    assert.equal(out.roster, undefined);
    // The invalid/missing portfolio binding never disables ordinary readRoster.
    const orientation = await provider.readRoster();
    assert.equal(orientation.status, 'ok');
    assert.deepEqual(orientation.query, orientationQuery);
  }
});

test('host portfolio roster rejects a capability receipt aliased to the ordinary orientation receipt', async (t) => {
  const { provider } = portfolioFixture(t, { aliasPortfolioReceiptToCapability: true });
  const out = await provider.readPortfolioRoster();
  assert.equal(out.status, 'unavailable');
  assert.equal(out.roster, undefined);
});

test('host portfolio roster never falls back to ordinary provider read when the private module lacks readRoster', async (t) => {
  const { provider } = portfolioFixture(t, { supportsRoster: false });
  const out = await provider.readPortfolioRoster();
  assert.equal(out.status, 'unavailable');
});

test('host portfolio roster propagates a budget-incomplete result with empty records, never as an empty-success roster', async (t) => {
  const { provider } = portfolioFixture(t, {
    portfolioRosterResult: {
      status: 'incomplete',
      roster: {
        contract: 'jarvos.projects-roster/v1',
        generation: 42,
        capturedAt: '2026-01-01T00:00:00.000Z',
        scope: { projectIds: [], outcomeIds: [], includeDescendants: true },
        records: [],
        complete: false,
      },
    },
  });
  const out = await provider.readPortfolioRoster();
  assert.equal(out.status, 'incomplete');
  assert.notEqual(out.status, 'ok');
  assert.deepEqual(out.roster.records, []);
  assert.equal(out.roster.complete, false);
});

test('host portfolio roster fails closed on a private generation mismatch', async (t) => {
  const { provider } = portfolioFixture(t, {
    portfolioRosterResult: { status: 'unavailable', code: 'ROSTER_GENERATION_MISMATCH' },
  });
  const out = await provider.readPortfolioRoster();
  assert.equal(out.status, 'unavailable');
  assert.equal(out.code, 'ROSTER_GENERATION_MISMATCH');
  assert.equal(out.roster, undefined);
});

test('host portfolio roster sanitizes private provider exceptions', async (t) => {
  const { provider, providerModule } = portfolioFixture(t);
  require(providerModule).readRoster = async () => { throw new Error('private-path-and-secret'); };
  const out = await provider.readPortfolioRoster();
  assert.equal(out.status, 'unavailable');
  assert.ok(!JSON.stringify(out).includes('private-path-and-secret'));
});

// Unlike portfolioFixture above (whose private provider.js fakes readRoster
// with a literal success packet), this fixture's provider.js requires the
// real public builder/registry and does no faking: it proves the host's
// separately bound whole-portfolio query/capability actually authorizes
// against real signature/scope verification and real registry state on disk.
const REAL_BUILDER_HOST_SECRET = 'roster-bootstrap-real-builder-secret';
const REAL_BUILDER_HOST_ID = 'real-builder-host';
const REAL_BUILDER_SUBJECT = 'real-builder-subject';
const REAL_BUILDER_ORIENTATION_QUERY = Object.freeze({
  scope: { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: true },
  include: ['hierarchy'],
  limits: { maxItems: 24, maxBytes: 16000, maxProviderAgeSeconds: 3600 },
});

function realBuilderProviderSource() {
  return [
    "module.exports.read = async () => ({ status: 'ordinary' });",
    `const { ProjectRegistry } = require(${JSON.stringify(REGISTRY_MODULE_PATH)});`,
    `const { buildCanonicalRosterPacket } = require(${JSON.stringify(PROJECTS_CONTEXT_MODULE_PATH)});`,
    'module.exports.readRoster = async (request) => buildCanonicalRosterPacket({',
    '  registry: new ProjectRegistry({ stateDir: request.registryStateDir }),',
    '  query: request.query,',
    '  capability: request.capability,',
    '  capabilitySecret: request.capabilitySecret,',
    '  subject: request.subject,',
    '  hostId: request.hostId,',
    '  expectedGeneration: request.expectedGeneration,',
    '});',
  ].join('\n');
}

function issueRealBuilderCapability(overrides = {}) {
  return issueCapability({
    authorization: { allowed: true },
    hostId: REAL_BUILDER_HOST_ID,
    hostSecret: REAL_BUILDER_HOST_SECRET,
    subject: REAL_BUILDER_SUBJECT,
    issuedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides,
  });
}

function realBuilderFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'real-builder-roster-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const stateRoot = path.join(root, 'state');
  const registryStateDir = path.join(stateRoot, 'registry');
  const releaseProviderStateDir = path.join(stateRoot, 'release');
  for (const dir of [repositoryRoot, stateRoot, registryStateDir, releaseProviderStateDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Disposable, file-backed registry state: the provider.js written below
  // reopens this same stateDir with its own ProjectRegistry instance, so the
  // roster it returns is read back from disk, not shared in-memory state.
  const registry = new ProjectRegistry({ stateDir: registryStateDir });
  for (let i = 1; i <= 30; i += 1) {
    registry.create({ title: i === 5 ? 'Desktop' : `Project ${String(i).padStart(3, '0')}` });
  }

  const providerModule = path.join(repositoryRoot, 'provider.js');
  fs.writeFileSync(providerModule, realBuilderProviderSource(), { mode: 0o600 });

  const secretPath = path.join(stateRoot, 'secret');
  fs.writeFileSync(secretPath, REAL_BUILDER_HOST_SECRET, { mode: 0o600 });

  const orientationCapability = issueRealBuilderCapability({
    query: REAL_BUILDER_ORIENTATION_QUERY,
    capabilityRevision: 'real-builder-orientation-1',
  });
  const portfolioCapability = issueRealBuilderCapability({
    query: WHOLE_PORTFOLIO_QUERY,
    limits: WHOLE_PORTFOLIO_QUERY.limits,
    freshness: { maxAgeSeconds: 86_400 },
    capabilityRevision: 'real-builder-portfolio-1',
  });

  const orientationCapabilityPath = path.join(stateRoot, 'orientation-capability.json');
  fs.writeFileSync(orientationCapabilityPath, JSON.stringify(orientationCapability), { mode: 0o600 });
  const portfolioCapabilityPath = path.join(stateRoot, 'portfolio-capability.json');
  fs.writeFileSync(portfolioCapabilityPath, JSON.stringify(portfolioCapability), { mode: 0o600 });

  const config = path.join(root, 'projects.json');
  fs.writeFileSync(config, JSON.stringify({
    workspaceRoot: root,
    repositoryRoot,
    providerModule,
    stateRoot,
    registryStateDir,
    releaseProviderStateDir,
    query: REAL_BUILDER_ORIENTATION_QUERY,
    capabilityReceiptPath: orientationCapabilityPath,
    portfolioRosterQuery: WHOLE_PORTFOLIO_QUERY,
    portfolioRosterCapabilityReceiptPath: portfolioCapabilityPath,
    capabilitySecret: secretPath,
    hostId: REAL_BUILDER_HOST_ID,
    subject: REAL_BUILDER_SUBJECT,
  }), { mode: 0o600 });

  return {
    provider: createHostProjectsContextProvider({ JARVOS_PROJECTS_CONTEXT_CONFIG: config }),
    providerModule,
    registryStateDir,
    portfolioCapability,
    portfolioCapabilityPath,
    orientationCapability,
  };
}

test('host portfolio roster proves the real signed whole-portfolio capability against the real public builder and on-disk registry, while a scoped orientation capability and a wrong or expired capability fail closed', async (t) => {
  const {
    provider, providerModule, registryStateDir, portfolioCapability, portfolioCapabilityPath, orientationCapability,
  } = realBuilderFixture(t);

  // The orientation capability's signed scope is bound to a single project:
  // presenting it against the whole-portfolio query fails real scope
  // verification and authorizes nothing.
  const scopedAgainstWhole = await require(providerModule).readRoster({
    registryStateDir,
    query: WHOLE_PORTFOLIO_QUERY,
    capability: orientationCapability,
    capabilitySecret: REAL_BUILDER_HOST_SECRET,
    subject: REAL_BUILDER_SUBJECT,
    hostId: REAL_BUILDER_HOST_ID,
  });
  assert.notEqual(scopedAgainstWhole.status, 'ok');
  assert.equal(scopedAgainstWhole.roster, undefined);

  // The distinct, separately bound whole-portfolio query and capability,
  // verified end to end through the real buildCanonicalRosterPacket and a
  // real on-disk ProjectRegistry, yields all 30 canonical identities,
  // including the quiet Desktop project.
  const whole = await provider.readPortfolioRoster();
  assert.equal(whole.status, 'ok');
  assert.equal(whole.roster.complete, true);
  const ids = whole.roster.records.map((record) => record.id);
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => `prj_${String(i + 1).padStart(6, '0')}`));
  assert.ok(ids.includes('prj_000005'));

  // A tampered (wrong) capability signature fails real signature
  // verification and returns no success or records.
  fs.writeFileSync(portfolioCapabilityPath, JSON.stringify({ ...portfolioCapability, signature: `${portfolioCapability.signature}-tampered` }), { mode: 0o600 });
  const wrong = await provider.readPortfolioRoster();
  assert.notEqual(wrong.status, 'ok');
  assert.equal(wrong.roster, undefined);

  // An expired capability fails real expiry verification and returns no
  // success or records.
  fs.writeFileSync(portfolioCapabilityPath, JSON.stringify(issueRealBuilderCapability({
    query: WHOLE_PORTFOLIO_QUERY,
    limits: WHOLE_PORTFOLIO_QUERY.limits,
    freshness: { maxAgeSeconds: 86_400 },
    capabilityRevision: 'real-builder-portfolio-expired',
    issuedAt: new Date(Date.now() - 7_200_000).toISOString(),
    expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
  })), { mode: 0o600 });
  const expired = await provider.readPortfolioRoster();
  assert.notEqual(expired.status, 'ok');
  assert.equal(expired.roster, undefined);
});
