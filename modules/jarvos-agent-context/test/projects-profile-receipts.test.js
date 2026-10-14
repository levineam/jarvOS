'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHostProjectsContextProvider } = require('../src/projects-context-bootstrap');
const source = path.resolve(__dirname, '../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src');
const { ProjectRegistry } = require(path.join(source, 'registry'));
const { issueCapability } = require(path.join(source, 'projects-context-capability'));
const { resolveQueryProfile, PROFILE_REVISION } = require(path.join(source, 'projects-context-profiles'));
const { createHostAdmission } = require(path.join(source, 'provider-contracts'));
const NOW = '2026-10-01T12:00:00.000Z';
const SECRET = 'fixture-only-capability-secret';

function fixture(t, { receipt = 'valid', coverage = ['activity'], records = 1 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-profile-receipts-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repository');
  const stateRoot = path.join(root, 'state');
  const registryStateDir = path.join(stateRoot, 'registry');
  const releaseProviderStateDir = path.join(stateRoot, 'release');
  for (const dir of [repositoryRoot, registryStateDir, releaseProviderStateDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const registry = new ProjectRegistry({ stateDir: registryStateDir, now: () => NOW });
  for (let i = 0; i < records; i += 1) registry.create({ title: `Project ${i}` });
  const orientation = resolveQueryProfile('orientation', { authorizedScope: true });
  const recent = resolveQueryProfile('recent-activity', { authorizedScope: true, date: '2026-09-30', timeZone: 'America/New_York' });
  function issue(query, overrides = {}) {
    return issueCapability({ authorization: { allowed: true }, hostId: 'fixture-host', subject: 'fixture-assistant', hostSecret: SECRET,
      query, limits: query.limits, freshness: { maxAgeSeconds: query.limits.maxProviderAgeSeconds }, providerCoverage: coverage,
      capabilityRevision: 'fixture-1', issuedAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z', ...overrides });
  }
  const ordinaryPath = path.join(stateRoot, 'orientation.json');
  const recentPath = path.join(stateRoot, 'recent.json');
  fs.writeFileSync(ordinaryPath, JSON.stringify(issue(orientation.query)), { mode: 0o600 });
  fs.writeFileSync(recentPath, JSON.stringify(issue(receipt === 'mismatch' ? orientation.query : recent.query,
    receipt === 'expired' ? { expiresAt: '2026-10-01T00:00:00.000Z' } : {})), { mode: 0o600 });
  const secretPath = path.join(stateRoot, 'secret');
  fs.writeFileSync(secretPath, SECRET, { mode: 0o600 });
  const authority = createHostAdmission({ producerId: 'fixture-activity', secret: 'fixture-provider-secret', allowedProviders: ['activity'] });
  const activity = authority.admitProviderSnapshot({
    contract: 'jarvos.provider-snapshot/v1', provider: 'activity', state: 'fresh', trust: 'verified', capturedAt: NOW,
    watermark: 'fixture-events', scope: { projectIds: [], outcomeIds: [] }, omissions: [], errorCode: null, admission: null,
    summaries: ['2026-09-30T03:59:59.000Z', '2026-09-30T04:00:00.000Z', '2026-10-01T03:59:59.999Z', '2026-10-01T04:00:00.000Z'].map((occurredAt, i) => ({
      id: `event-${i}`, canonicalId: 'prj_000001', category: 'activity', status: 'completed', title: `Event ${i}`,
      occurredAt, observedAt: NOW, evidenceRefs: [],
    })),
  });
  const providerModule = path.join(repositoryRoot, 'provider.js');
  fs.writeFileSync(providerModule, [
    `const { ProjectRegistry } = require(${JSON.stringify(path.join(source, 'registry'))});`,
    `const { buildContextPacket } = require(${JSON.stringify(path.join(source, 'projects-context'))});`,
    `const { createHostAdmission } = require(${JSON.stringify(path.join(source, 'provider-contracts'))});`,
    'module.exports.read = async (request) => buildContextPacket({ ...request,',
    `registry: new ProjectRegistry({ stateDir: request.registryStateDir }), now: ${JSON.stringify(NOW)},`,
    `providers: { activity: ${JSON.stringify(activity)} },`,
    "providerAuthorities: { activity: createHostAdmission({ producerId: 'fixture-activity', secret: 'fixture-provider-secret', allowedProviders: ['activity'] }) } });",
  ].join('\n'), { mode: 0o600 });
  let recentReference = recentPath;
  if (receipt === 'missing') recentReference = path.join(stateRoot, 'missing.json');
  if (receipt === 'alias') recentReference = ordinaryPath;
  if (receipt === 'readable') fs.chmodSync(recentPath, 0o640);
  if (receipt === 'malformed') fs.writeFileSync(recentPath, '{');
  if (receipt === 'symlink') { recentReference = path.join(stateRoot, 'link.json'); fs.symlinkSync(recentPath, recentReference); }
  if (receipt === 'outside') { recentReference = path.join(root, 'outside.json'); fs.copyFileSync(recentPath, recentReference); }
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ workspaceRoot: root, repositoryRoot, stateRoot, registryStateDir, releaseProviderStateDir,
    providerModule, query: orientation.query, hostId: 'fixture-host', subject: 'fixture-assistant', capabilitySecret: secretPath,
    capabilityReceiptPath: ordinaryPath, ...(receipt === 'omitted' ? {} : { recentActivityCapabilityReceiptPath: recentReference }),
    ...(receipt === 'proof-alias' ? { portfolioProofCapabilityReceiptPath: recentPath } : {}),
    ...(receipt === 'roster-alias' ? { portfolioRosterCapabilityReceiptPath: recentPath } : {}),
  }), { mode: 0o600 });
  const provider = createHostProjectsContextProvider({ JARVOS_PROJECTS_CONTEXT_CONFIG: config });
  assert.ok(provider, 'optional receipt errors must not disable orientation');
  const read = (profile, extra = {}) => provider.read({ query: profile.query, profile, activityWindow: profile.activityWindow, ...extra });
  return { provider, read, orientation, recent, ordinaryPath, recentPath };
}

test('host selects distinct signed receipts while preserving default orientation and profile revision', async (t) => {
  const f = fixture(t);
  const ordinary = await f.provider.read({ query: f.orientation.query });
  assert.equal(ordinary.status, 'ok');
  const recent = await f.read(f.recent, { capability: JSON.parse(fs.readFileSync(f.ordinaryPath)), recentActivityCapabilityReceiptPath: f.ordinaryPath,
    hostId: 'caller-host', subject: 'caller-subject', capabilitySecret: 'caller-secret', stateRoot: '/caller-state' });
  assert.equal(recent.status, 'ok');
  assert.deepEqual(recent.packet.query, f.recent.query);
  assert.equal(f.recent.revision, PROFILE_REVISION);
  assert.equal(f.recent.query.limits.maxProviderAgeSeconds, 86400);
  assert.deepEqual(recent.packet.activity.map(row => row.id), ['event-2', 'event-1']);
  assert.equal((await f.read(f.orientation)).status, 'ok');
});

test('absent and untrusted recent references fail closed without an orientation fallback', async (t) => {
  for (const receipt of ['omitted', 'missing', 'alias', 'proof-alias', 'roster-alias', 'readable', 'symlink', 'outside', 'malformed']) {
    const f = fixture(t, { receipt });
    assert.equal((await f.read(f.recent)).status, 'unavailable', receipt);
    assert.equal((await f.read(f.orientation)).status, 'ok', receipt);
  }
});

test('the packet verifier still rejects mismatched, expired and forged profile/query capabilities', async (t) => {
  for (const receipt of ['mismatch', 'expired']) {
    const f = fixture(t, { receipt });
    assert.equal((await f.read(f.recent)).status, 'unavailable', receipt);
    assert.equal((await f.read(f.orientation)).status, 'ok', receipt);
  }
  const f = fixture(t);
  assert.equal((await f.read(f.recent, { query: f.orientation.query })).status, 'unavailable');
});

test('recent reads preserve receipt coverage and bounded packet truncation', async (t) => {
  const uncovered = fixture(t, { coverage: [] });
  const limited = await uncovered.read(uncovered.recent);
  assert.equal(limited.status, 'ok');
  assert.deepEqual(limited.packet.activity, []);
  assert.ok(limited.packet.omissions.includes('provider:activity:not-covered'));
  const crowded = fixture(t, { records: 105 });
  const truncated = await crowded.read(crowded.recent);
  assert.equal(truncated.status, 'ok');
  assert.equal(truncated.packet.truncation.truncated, true);
  assert.ok(truncated.packet.truncation.omittedItems > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(truncated.packet)) <= crowded.recent.query.limits.maxBytes);
});
