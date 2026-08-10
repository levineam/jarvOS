'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PROJECTS_CONTEXT_CONTRACT,
  hydrate,
  proposeProjectsContext,
  readProjectsContext,
  setProjectsContextProvider,
} = require('../src/index.js');
const {
  callTool,
  setMcpProjectsContextProvider,
} = require('../scripts/jarvos-mcp.js');

const QUERY = {
  scope: { projectIds: [], outcomeIds: [], includeDescendants: false },
  include: ['hierarchy', 'activity', 'currentWork', 'attention'],
  limits: { maxItems: 12, maxBytes: 9000, maxProviderAgeSeconds: 3600 },
};

function packet() {
  return {
    contract: PROJECTS_CONTEXT_CONTRACT,
    packetId: 'ctx_0123456789abcdef0123456789abcdef',
    capturedAt: '2026-08-08T12:00:00.000Z',
    expiresAt: '2026-08-08T13:00:00.000Z',
    query: QUERY,
    canonical: {
      generation: 4,
      records: [{
        id: 'prj_000001',
        kind: 'project',
        title: 'jarvOS',
        breadcrumb: 'jarvOS',
        lifecycle: 'active',
        effectivePriority: 'high',
      }, {
        id: 'out_000001',
        kind: 'outcome',
        title: 'v1.0.0 release',
        breadcrumb: 'jarvOS › v1.0.0 release',
        lifecycle: 'active',
        effectivePriority: 'high',
      }],
      revisions: { prj_000001: 2, out_000001: 1 },
    },
    activity: [],
    currentWork: [{ id: 'beads-1', canonicalId: 'out_000001', title: 'Repair release readiness', status: 'in_progress' }],
    attention: [],
    evidence: [],
    providers: { beads: { state: 'fresh' } },
    omissions: [],
    truncation: { truncated: false, maxItems: 12, maxBytes: 9000, omittedItems: 0, sections: [] },
    redactionClass: 'private',
    capability: { receiptId: 'cap_0123456789abcdef0123456789abcdef', digest: 'a'.repeat(64) },
  };
}

function withTempContextEnv(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-projects-context-agent-'));
  const vault = path.join(root, 'vault');
  const notes = path.join(vault, 'Notes');
  const journal = path.join(vault, 'Journal');
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(journal, { recursive: true });
  const previous = Object.fromEntries(['JARVOS_VAULT_DIR', 'JARVOS_NOTES_DIR', 'JARVOS_JOURNAL_DIR', 'JARVOS_TIMEZONE', 'JARVOS_PAPERCLIP_ENV_FILE'].map((key) => [key, process.env[key]]));
  process.env.JARVOS_VAULT_DIR = vault;
  process.env.JARVOS_NOTES_DIR = notes;
  process.env.JARVOS_JOURNAL_DIR = journal;
  process.env.JARVOS_TIMEZONE = 'UTC';
  process.env.JARVOS_PAPERCLIP_ENV_FILE = path.join(root, 'missing-paperclip-env.sh');
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test.after(() => {
  setMcpProjectsContextProvider(null);
});

test('library and MCP use the same injected Projects packet and fingerprint', async () => {
  const provider = { read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query } }) };
  const libraryResult = await readProjectsContext({ provider, query: QUERY });
  setMcpProjectsContextProvider(provider);
  const mcpResult = await callTool('jarvos_projects_context', {});
  const mcpPayload = JSON.parse(mcpResult.content[0].text);

  assert.equal(libraryResult.status, 'ok');
  assert.equal(mcpPayload.status, 'ok');
  assert.equal(mcpPayload.fingerprint, libraryResult.fingerprint);
  assert.equal(mcpPayload.packet.canonical.records[1].breadcrumb, 'jarvOS › v1.0.0 release');
});

test('missing Projects capability leaves legacy hydration available and reports shadow unavailability', async () => {
  setMcpProjectsContextProvider(null);
  await withTempContextEnv(async () => {
    const result = await hydrate({ sessionThread: false, maxChars: 3000 });
    assert.equal(result.ok, true);
    assert.equal(result.report.projectsContext.status, 'unavailable');
    assert.match(result.markdown, /Projects Context/);
    assert.match(result.markdown, /jarvOS Current Work/);
    assert.match(result.markdown, /Projects context unavailable/);
  });
});

test('Projects proposals remain uncommitted and parity is shared through MCP', async () => {
  const provider = {
    read: async () => ({ status: 'ok', packet: packet() }),
    propose: async ({ proposal }) => ({ status: 'proposed', proposal: { ...proposal, status: 'proposed' } }),
  };
  const proposal = { kind: 'unknown-link', externalReference: 'release:v2.0.0' };
  const libraryResult = await proposeProjectsContext({ provider, proposal });
  setMcpProjectsContextProvider(provider);
  const mcpResult = await callTool('jarvos_projects_propose', { proposal });
  const mcpPayload = JSON.parse(mcpResult.content[0].text);

  assert.equal(libraryResult.status, 'proposed');
  assert.equal(mcpPayload.status, 'proposed');
  assert.deepEqual(mcpPayload.proposal, libraryResult.proposal);
  assert.equal(mcpPayload.proposal.status, 'proposed');
});
