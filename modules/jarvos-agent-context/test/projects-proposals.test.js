'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { canonicalJson, normalizeProposal } = require('../src/projects-proposals.js');
const agentContext = require('../src/index.js');
const { callTool, setMcpProjectsContextProvider } = require('../scripts/jarvos-mcp.js');

function proposal(overrides = {}) {
  return {
    kind: 'create',
    expectedGeneration: 12,
    record: {
      kind: 'outcome',
      title: 'Ship the bounded proposal transport',
      parentId: 'prj_000001',
      goal: 'Safely submit a reviewable proposal.',
      definitionOfDone: 'The host returns a pending receipt without applying a registry change.',
      links: { plan: 'docs/plans/SUP-3816.md' },
    },
    rationale: 'The relationship is currently missing from the canonical registry.',
    evidenceRefs: ['issue:SUP-3816'],
    expiresAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

test('normalizes a bounded proposal deterministically', () => {
  const first = normalizeProposal(proposal());
  const second = normalizeProposal(proposal({ record: { ...proposal().record, links: { plan: 'docs/plans/SUP-3816.md' } } }));
  assert.deepEqual(first.proposal, second.proposal);
  assert.equal(first.digest, second.digest);
  assert.equal(first.proposal.record.links.plan, 'docs/plans/SUP-3816.md');
});

test('rejects unknown fields, non-JSON prototypes, invalid parents, and oversized envelopes', () => {
  assert.throws(() => normalizeProposal(proposal({ owner: 'spoofed' })), /unknown field/);
  const inherited = Object.create({ hidden: true });
  Object.assign(inherited, proposal());
  assert.throws(() => normalizeProposal(inherited), /JSON/);
  assert.throws(() => normalizeProposal(proposal({ record: { ...proposal().record, parentId: 'project-1' } })), /canonical Projects id/);
  assert.throws(() => normalizeProposal(proposal({ record: { ...proposal().record, parentId: null } })), /outcomes require/);
  const large = proposal({
    record: {
      ...proposal().record,
      definitionOfDone: 'd'.repeat(8000),
      goal: 'g'.repeat(4000),
      links: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`link-${index}`, 'l'.repeat(2000)])),
    },
    evidenceRefs: Array.from({ length: 16 }, (_, index) => `${index}:${'e'.repeat(1997)}`),
  });
  assert.throws(() => normalizeProposal(large), /encoded size/);
  assert.throws(() => normalizeProposal(proposal({ rationale: ' '.repeat(40000) })), /encoded size/);
  const accessor = proposal();
  let getterRead = false;
  Object.defineProperty(accessor, 'rationale', { enumerable: true, get() { getterRead = true; return 'do not run'; } });
  assert.throws(() => normalizeProposal(accessor), /JSON/);
  assert.equal(getterRead, false);
  const cyclic = proposal();
  cyclic.record.links = { self: cyclic };
  assert.throws(() => normalizeProposal(cyclic), /JSON/);
  const unsafeLinks = Object.create(Object.prototype);
  Object.defineProperty(unsafeLinks, '__proto__', { enumerable: true, value: 'https://example.test' });
  assert.throws(() => normalizeProposal(proposal({ record: { ...proposal().record, links: unsafeLinks } })), /unsafe/);
  assert.throws(() => normalizeProposal(proposal({ record: { ...proposal().record, links: { plan: 'a', ' plan ': 'b' } } })), /duplicate/);
});

test('invalid proposals are never forwarded and provider errors stay typed and private', async () => {
  let forwarded = 0;
  const invalid = await agentContext.proposePendingProjectsContext({
    provider: { propose: async () => { forwarded += 1; } },
    proposal: proposal({ rationale: '' }),
  });
  assert.equal(invalid.code, 'PROJECTS_PROPOSAL_INVALID');
  assert.equal(forwarded, 0);

  const failed = await agentContext.proposePendingProjectsContext({
    provider: { propose: async () => { throw new Error('capability-secret=/private/ledger'); } },
    proposal: proposal(),
  });
  assert.equal(failed.code, 'PROJECTS_PROPOSAL_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(failed), /capability-secret|private\/ledger/);
  const rateLimited = await agentContext.proposePendingProjectsContext({
    provider: { propose: async () => ({ status: 'unavailable', code: 'PROJECTS_PROPOSAL_RATE_LIMITED', diagnostic: 'secret=leak' }) }, proposal: proposal(),
  });
  assert.equal(rateLimited.code, 'PROJECTS_PROPOSAL_RATE_LIMITED');
  assert.doesNotMatch(JSON.stringify(rateLimited), /secret=leak/);
  assert.equal(typeof agentContext.applyProjectsProposal, 'undefined');
  assert.equal(typeof agentContext.createProject, 'undefined');
});

function withHostProposalProvider(callback, { proposals = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-proposals-host-'));
  const workspaceRoot = path.join(root, 'workspace');
  const repositoryRoot = path.join(workspaceRoot, 'repository');
  const stateRoot = path.join(workspaceRoot, 'state');
  const registryStateDir = path.join(stateRoot, 'registry');
  const releaseStateDir = path.join(stateRoot, 'release');
  const proposalStateDir = path.join(stateRoot, 'proposals');
  for (const directory of [repositoryRoot, registryStateDir, releaseStateDir, proposalStateDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(proposalStateDir, 0o700);
  const providerModule = path.join(repositoryRoot, 'provider.js');
  fs.writeFileSync(providerModule, `
    const crypto = require('node:crypto');
    function stable(value) { if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'; return JSON.stringify(value); }
    module.exports.calls = [];
    module.exports.readCalls = 0;
    module.exports.read = async () => { module.exports.readCalls += 1; return { status: 'unavailable' }; };
    module.exports.propose = async (request) => {
      module.exports.calls.push(request);
      return { status: 'proposed', proposal: { id: 'prop_000001', status: 'pending', digest: crypto.createHash('sha256').update(stable(request.proposal)).digest('hex'), registryGeneration: request.proposal.expectedGeneration, createdAt: '2026-09-15T12:00:00.000Z', expiresAt: request.proposal.expiresAt } };
    };
  `);
  fs.chmodSync(providerModule, 0o600);
  const capability = path.join(stateRoot, 'capability');
  fs.writeFileSync(capability, 'host-capability-secret');
  fs.chmodSync(capability, 0o600);
  const config = path.join(root, 'projects-context.json');
  const query = { scope: { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: false }, include: ['hierarchy'], limits: { maxItems: 12 } };
  fs.writeFileSync(config, JSON.stringify({
    workspaceRoot, repositoryRoot, stateRoot, registryStateDir, releaseProviderStateDir: releaseStateDir,
    providerModule, capabilitySecret: capability, hostId: 'trusted-host', subject: 'agent:trusted', query,
    ...(proposals ? { proposals: { enabled: true, stateDir: proposalStateDir, authorizedSubjects: ['agent:trusted'], maxEntries: 20, maxPerHour: 5, ttlSeconds: 3600 } } : {}),
  }));
  fs.chmodSync(config, 0o600);
  const prior = process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = config;
  setMcpProjectsContextProvider(null);
  return Promise.resolve().then(() => callback({ providerModule, query, proposalStateDir })).finally(() => {
    setMcpProjectsContextProvider(null);
    if (prior === undefined) delete process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
    else process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('ordinary configured hosts expose only an opt-in pending proposal transport', async () => {
  await withHostProposalProvider(async ({ providerModule, query, proposalStateDir }) => {
    const result = JSON.parse((await callTool('jarvos_projects_propose_v1', {
      proposal: proposal(), subject: 'agent:spoofed', hostId: 'spoofed-host', query: { scope: { projectIds: ['prj_999999'] } },
    })).content[0].text);
    assert.deepEqual(Object.keys(result).sort(), ['contract', 'ok', 'proposal', 'status']);
    assert.equal(result.ok, true);
    assert.equal(result.contract, 'jarvos.projects-proposal/v1');
    assert.equal(result.status, 'proposed');
    assert.equal(result.proposal.status, 'pending');
    const provider = require(providerModule);
    assert.equal(provider.calls.length, 1);
    const forwarded = provider.calls[0];
    assert.equal(forwarded.subject, 'agent:trusted');
    assert.equal(forwarded.hostId, 'trusted-host');
    assert.deepEqual(forwarded.query, query);
    assert.equal(forwarded.proposalStateDir, fs.realpathSync(proposalStateDir));
    assert.equal(forwarded.proposalPolicy.stateDir, undefined);
    assert.ok(Object.isFrozen(forwarded.proposalPolicy));
    assert.equal(forwarded.profileDigest, crypto.createHash('sha256').update(canonicalJson(query)).digest('hex'));

    const explicitNull = await agentContext.proposePendingProjectsContext({ provider: null, proposal: proposal() });
    assert.equal(explicitNull.code, 'PROJECTS_PROPOSAL_UNAVAILABLE');
  });
});

test('disabled or malformed host proposal opt-in keeps reads available and proposal unavailable', async () => {
  await withHostProposalProvider(async ({ providerModule }) => {
    const config = process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
    const value = JSON.parse(fs.readFileSync(config, 'utf8'));
    value.proposals = { enabled: true, stateDir: value.registryStateDir, authorizedSubjects: ['agent:trusted'], maxEntries: 20, maxPerHour: 5, ttlSeconds: 3600 };
    fs.writeFileSync(config, JSON.stringify(value));
    fs.chmodSync(config, 0o600);
    setMcpProjectsContextProvider(null);
    const result = JSON.parse((await callTool('jarvos_projects_propose_v1', { proposal: proposal() })).content[0].text);
    assert.equal(result.code, 'PROJECTS_PROPOSAL_UNAVAILABLE');
    assert.equal(require(providerModule).calls.length, 0);
    const read = JSON.parse((await callTool('jarvos_projects_context', { profile: 'orientation' })).content[0].text);
    assert.equal(read.code, 'PROJECTS_PROVIDER_UNAVAILABLE');
    assert.equal(require(providerModule).readCalls, 1);
  }, { proposals: false });
});
