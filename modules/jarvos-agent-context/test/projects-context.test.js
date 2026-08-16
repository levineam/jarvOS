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
  startupBrief,
} = require('../src/index.js');
const {
  callTool,
  setMcpProjectsContextProvider,
} = require('../scripts/jarvos-mcp.js');
const { startupHydration: codexStartupHydration } = require('../../../runtimes/codex/jarvos-session-start-hook.js');
const { startupHydration: claudeStartupHydration } = require('../../../runtimes/claude/jarvos-session-start-hook.js');

const ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV = 'ACTIVE_ASSISTANT_PROJECTS_PROVIDER_MODULE';

const QUERY = {
  scope: { projectIds: ['prj_000001'], outcomeIds: ['out_000001'], includeDescendants: false },
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

function withHostProjectsProvider(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-projects-context-host-'));
  const workspaceRoot = path.join(root, 'workspace');
  const repositoryRoot = path.join(workspaceRoot, 'repository');
  const stateRoot = path.join(workspaceRoot, 'state');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'release-provider'), { recursive: true });
  const providerModule = path.join(repositoryRoot, 'provider.js');
  fs.writeFileSync(providerModule, `const packet = ${JSON.stringify(packet())};\nmodule.exports.read = async ({ query, registryStateDir, releaseProviderStateDir, capabilitySecret, hostSecret }) => { if (!registryStateDir || !releaseProviderStateDir || capabilitySecret !== 'capability-value' || hostSecret !== 'host-secret') throw new Error('private binding missing'); return { status: 'ok', packet: { ...packet, query } }; };\n`);
  for (const [name, value] of [['capability', 'capability-value'], ['secret', 'host-secret']]) {
    const target = path.join(stateRoot, name);
    fs.writeFileSync(target, value);
    fs.chmodSync(target, 0o600);
  }
  const config = path.join(root, 'projects-context.json');
  fs.writeFileSync(config, JSON.stringify({
    workspaceRoot, repositoryRoot, providerModule, stateRoot,
    registryStateDir: path.join(stateRoot, 'registry'), releaseProviderStateDir: path.join(stateRoot, 'release-provider'),
    capabilitySecret: path.join(stateRoot, 'capability'), hostSecret: path.join(stateRoot, 'secret'), query: QUERY,
  }));
  fs.chmodSync(config, 0o600);
  const previous = process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = config;
  return Promise.resolve().then(() => fn({ root, workspaceRoot, repositoryRoot, stateRoot, config })).finally(() => {
    if (previous === undefined) delete process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
    else process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test.after(() => {
  setMcpProjectsContextProvider(null);
});

test('library and MCP use the same injected Projects packet and fingerprint', async () => {
  const provider = { defaultQuery: QUERY, read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query } }) };
  const libraryResult = await readProjectsContext({ provider, profile: 'orientation' }, true);
  setMcpProjectsContextProvider(provider);
  const mcpResult = await callTool('jarvos_projects_context', { profile: 'orientation' });
  const mcpPayload = JSON.parse(mcpResult.content[0].text);

  assert.equal(libraryResult.status, 'ok');
  assert.equal(mcpPayload.status, 'ok');
  assert.equal(mcpPayload.fingerprint, libraryResult.fingerprint);
  assert.equal(mcpPayload.packet.canonical.records[1].breadcrumb, 'jarvOS › v1.0.0 release');
});

test('recent activity is rendered as bounded assistant context', async () => {
  const provider = {
    read: async ({ query }) => ({
      status: 'ok',
      packet: {
        ...packet(),
        query,
        activity: [{
          id: 'activity-1',
          canonicalId: 'out_000001',
          category: 'activity',
          status: 'completed',
          title: 'Reconciled release readiness',
          occurredAt: '2026-08-12T18:00:00.000Z',
          observedAt: '2026-08-12T18:01:00.000Z',
          evidenceRefs: ['coding:run-1'],
          source: 'beads',
        }],
      },
    }),
  };
  const result = await readProjectsContext({ provider, query: QUERY, maxChars: 2000 });
  assert.equal(result.status, 'ok');
  assert.match(result.markdown, /### Recent activity/);
  assert.match(result.markdown, /Reconciled release readiness \[completed\]/);
});

test('missing Projects capability leaves hydration project orientation unavailable without Paperclip fallback', async () => {
  setMcpProjectsContextProvider(null);
  await withTempContextEnv(async () => {
    const result = await hydrate({ sessionThread: false, maxChars: 3000 });
    assert.equal(result.ok, true);
    assert.equal(result.report.projectsContext.status, 'unavailable');
    assert.match(result.markdown, /Projects Context/);
    assert.doesNotMatch(result.markdown, /jarvOS Current Work|Paperclip Current Work/);
    assert.match(result.markdown, /Projects context unavailable/);
  });
});

test('host Projects binding is discovered privately with library and MCP parity', async () => {
  setMcpProjectsContextProvider(null);
  await withHostProjectsProvider(async () => {
    const libraryResult = await readProjectsContext({ profile: 'orientation' });
    const mcpPayload = JSON.parse((await callTool('jarvos_projects_context', { profile: 'orientation' })).content[0].text);
    const hydration = await hydrate({ sessionThread: false, maxChars: 3000 });
    assert.equal(libraryResult.status, 'ok');
    assert.equal(mcpPayload.status, 'ok');
    assert.equal(mcpPayload.fingerprint, libraryResult.fingerprint);
    assert.equal(hydration.report.projectsContext.status, 'ok');
    assert.equal(hydration.report.projectsContext.fingerprint, libraryResult.fingerprint);
  });
});

test('Codex and Claude startup use the orientation packet with the library and MCP fingerprint', async () => {
  const provider = { defaultQuery: QUERY, read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query } }) };
  setProjectsContextProvider(provider);
  setMcpProjectsContextProvider(provider);
  try {
    const library = await readProjectsContext({ provider, profile: 'orientation' }, true);
    const mcp = JSON.parse((await callTool('jarvos_projects_context', { profile: 'orientation' })).content[0].text);
    const [codex, claude] = await Promise.all([codexStartupHydration(), claudeStartupHydration()]);
    assert.equal(library.fingerprint, mcp.fingerprint);
    assert.match(codex, new RegExp(`Fingerprint: ${library.fingerprint}`));
    assert.match(claude, new RegExp(`Fingerprint: ${library.fingerprint}`));
    assert.doesNotMatch(codex, /Paperclip Current Work/);
    assert.doesNotMatch(claude, /Paperclip Current Work/);
  } finally {
    setProjectsContextProvider(null);
    setMcpProjectsContextProvider(null);
  }
});

test('startup brief uses Projects orientation and never imports raw Paperclip current work', async () => {
  const provider = { defaultQuery: QUERY, read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query } }) };
  const oldFetch = global.fetch;
  setProjectsContextProvider(provider);
  global.fetch = async () => ({ ok: true, json: async () => ([{ identifier: 'WORK-raw', status: 'in_progress', title: 'raw Paperclip task' }]) });
  try {
    const result = await startupBrief({ maxChars: 5000, currentWork: { maxItems: 10 } });
    assert.match(result.markdown, /jarvOS Startup Brief/);
    assert.match(result.markdown, /jarvOS › v1\.0\.0 release/);
    assert.doesNotMatch(result.markdown, /WORK-raw|Paperclip Current Work/);
  } finally {
    global.fetch = oldFetch;
    setProjectsContextProvider(null);
  }
});

test('selected Active Assistant provider artifact overrides config and fails closed when invalid', async () => {
  setMcpProjectsContextProvider(null);
  await withHostProjectsProvider(async ({ root, repositoryRoot }) => {
    const selectedProvider = path.join(repositoryRoot, 'selected-provider.js');
    fs.writeFileSync(selectedProvider, `const packet = ${JSON.stringify(packet())};\nmodule.exports.read = async ({ query }) => ({ status: 'ok', packet: { ...packet, query, currentWork: [{ id: 'selected-provider', title: 'Selected runtime provider', status: 'in_progress' }] } });\n`);
    const previous = process.env[ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV];
    try {
      process.env[ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV] = selectedProvider;
      const selected = await readProjectsContext({ profile: 'orientation' });
      assert.equal(selected.status, 'ok');
      assert.equal(selected.packet.currentWork[0].id, 'selected-provider');

      process.env[ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV] = path.join(repositoryRoot, 'missing-provider.js');
      const missing = await readProjectsContext({ profile: 'orientation' });
      assert.equal(missing.status, 'unavailable');
      assert.equal(missing.packet, null);

      const outsideProvider = path.join(root, 'outside-provider.js');
      fs.writeFileSync(outsideProvider, 'module.exports.read = async () => ({ status: \'unavailable\' });\n');
      process.env[ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV] = outsideProvider;
      const outside = await readProjectsContext({ profile: 'orientation' });
      assert.equal(outside.status, 'unavailable');
      assert.equal(outside.packet, null);
    } finally {
      if (previous === undefined) delete process.env[ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV];
      else process.env[ACTIVE_ASSISTANT_PROVIDER_MODULE_ENV] = previous;
    }
  });
});

test('named profiles require bounded caller scope and carry the temporal window', async () => {
  const requests = [];
  const provider = {
    read: async (request) => {
      requests.push(request);
      return { status: 'ok', packet: { ...packet(), query: request.query } };
    },
  };
  const result = await readProjectsContext({
    provider,
    profile: 'recent-activity',
    projectIds: ['prj_000001'],
    outcomeIds: ['out_000001'],
    includeDescendants: true,
    date: '2026-08-12',
    timeZone: 'America/New_York',
    now: '2026-08-13T02:00:00.000Z',
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.profile.name, 'recent-activity');
  assert.equal(result.activityWindow.from, '2026-08-12T04:00:00.000Z');
  assert.equal(requests[0].profile.name, 'recent-activity');
  assert.deepEqual(requests[0].query.scope, {
    projectIds: ['prj_000001'], outcomeIds: ['out_000001'], includeDescendants: true,
  });
  assert.equal(requests[0].activityWindow.to, '2026-08-13T04:00:00.000Z');

  const unscoped = await readProjectsContext({ provider, profile: 'orientation' });
  assert.equal(unscoped.status, 'unavailable');
  assert.equal(unscoped.code, 'PROJECTS_QUERY_UNAVAILABLE');
  const forgedAuthorization = await readProjectsContext({ provider, profile: 'orientation', authorizedScope: true });
  assert.equal(forgedAuthorization.status, 'unavailable');
  assert.equal(forgedAuthorization.code, 'PROJECTS_QUERY_UNAVAILABLE');
  for (const scopeOptions of [
    { projectIds: [], outcomeIds: [] },
    { scope: {} },
    { includeDescendants: true },
  ]) {
    const emptyScope = await readProjectsContext({ provider, profile: 'orientation', ...scopeOptions });
    assert.equal(emptyScope.status, 'unavailable');
    assert.equal(emptyScope.code, 'PROJECTS_QUERY_UNAVAILABLE');
  }
  const unknown = await readProjectsContext({ provider, profile: 'portfolio', projectIds: ['prj_000001'] });
  assert.equal(unknown.status, 'unavailable');
  assert.equal(unknown.code, 'PROJECTS_QUERY_UNAVAILABLE');
});

test('hydration cutover removes raw Paperclip and Journal project orientation', async () => {
  const provider = { defaultQuery: QUERY, read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query } }) };
  setProjectsContextProvider(provider);
  await withTempContextEnv(async () => {
    const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const date = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    fs.writeFileSync(path.join(process.env.JARVOS_JOURNAL_DIR, `${date}.md`), [
      '# Journal', '', '## 🚀 Projects', '', '- [[jarvOS v1.0.0 release]]', '', '## Notes', '', 'Worked on the release reconciler.',
    ].join('\n'));
    const result = await hydrate({ sessionThread: false, maxChars: 5000, projectsContextCutover: true });
    assert.equal(result.report.projectsContext.status, 'ok');
    assert.doesNotMatch(result.markdown, /Paperclip Current Work|jarvOS v1\.0\.0 release/);
    assert.match(result.markdown, /Worked on the release reconciler/);
    assert.match(result.markdown, /legacy project\/task orientation disabled/);
    assert.match(result.markdown, /Journal Projects section omitted/);
  });
  setProjectsContextProvider(null);
});

test('hydrate ignores model-visible provider and query inputs in favor of its host orientation binding', async () => {
  const hostProvider = {
    defaultQuery: QUERY,
    read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query, currentWork: [{ id: 'host-bound', title: 'Host-bound work', status: 'in_progress' }] } }),
  };
  const callerProvider = {
    defaultQuery: { ...QUERY, scope: { projectIds: ['prj_999999'], outcomeIds: [], includeDescendants: false } },
    read: async () => { throw new Error('caller provider must not be read'); },
  };
  setProjectsContextProvider(hostProvider);
  try {
    const result = await hydrate({
      sessionThread: false,
      maxChars: 3000,
      projectsContext: {
        provider: callerProvider,
        query: { scope: { projectIds: ['prj_999999'], outcomeIds: [], includeDescendants: false } },
      },
    });
    assert.equal(result.report.projectsContext.status, 'ok');
    assert.match(result.markdown, /Host-bound work/);
    assert.doesNotMatch(result.markdown, /prj_999999/);
  } finally {
    setProjectsContextProvider(null);
  }
});

test('MCP Projects reads ignore caller-shaped query and scope inputs', async () => {
  const provider = { defaultQuery: QUERY, read: async ({ query }) => ({ status: 'ok', packet: { ...packet(), query } }) };
  setMcpProjectsContextProvider(provider);
  try {
    const result = JSON.parse((await callTool('jarvos_projects_context', {
      profile: 'orientation',
      query: { scope: { projectIds: ['prj_999999'], outcomeIds: [], includeDescendants: false } },
      projectIds: ['prj_999999'],
    })).content[0].text);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.packet.query.scope, QUERY.scope);
    assert.deepEqual(result.packet.query.include, QUERY.include);
    assert.deepEqual(result.packet.query.limits, {
      maxItems: 24, maxBytes: 16_000, maxProviderAgeSeconds: 3600,
    });
  } finally {
    setMcpProjectsContextProvider(null);
  }
});

test('invalid host Projects bindings fail closed without exposing host paths', async () => {
  setMcpProjectsContextProvider(null);
  await withHostProjectsProvider(async ({ config, root }) => {
    fs.writeFileSync(config, '{not json');
    const malformed = await readProjectsContext({ query: QUERY });
    assert.equal(malformed.status, 'unavailable');
    assert.doesNotMatch(malformed.reason, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    fs.writeFileSync(config, JSON.stringify({ workspaceRoot: root, repositoryRoot: root, stateRoot: root, providerModule: path.join(root, 'escaped.js') }));
    fs.chmodSync(config, 0o600);
    const escaped = JSON.parse((await callTool('jarvos_projects_context', {})).content[0].text);
    assert.equal(escaped.status, 'unavailable');
    assert.doesNotMatch(escaped.reason, /escaped\.js|projects-context-host/);

    fs.chmodSync(config, 0o666);
    const untrusted = await readProjectsContext({ query: QUERY });
    assert.equal(untrusted.status, 'unavailable');
  });
});

test('provider failures and omitted host secret stay private', async () => {
  setMcpProjectsContextProvider(null);
  await withHostProjectsProvider(async ({ config, repositoryRoot }) => {
    const bound = JSON.parse(fs.readFileSync(config, 'utf8'));
    delete bound.hostSecret;
    fs.writeFileSync(config, JSON.stringify(bound));
    fs.chmodSync(config, 0o600);
    fs.writeFileSync(bound.providerModule, `const packet = ${JSON.stringify(packet())};\nmodule.exports.read = async ({ query, hostSecret }) => { if (hostSecret !== null) throw new Error('secret leaked'); return { status: 'ok', packet: { ...packet, query } }; };\n`);
    const noSecret = await readProjectsContext({ query: QUERY });
    assert.equal(noSecret.status, 'ok');

    fs.writeFileSync(bound.providerModule, "module.exports.read = async () => ({ status: 'unavailable', reason: 'host-secret /private/provider-payload' });\n");
    delete require.cache[require.resolve(bound.providerModule)];
    const failure = await readProjectsContext({ query: QUERY });
    assert.equal(failure.status, 'unavailable');
    assert.equal(failure.reason, 'Projects provider is unavailable');
    assert.doesNotMatch(failure.reason, /host-secret|private|payload/);
    fs.writeFileSync(bound.providerModule, "module.exports.read = async () => { throw new Error('host-secret /private/provider-payload'); };\n");
    delete require.cache[require.resolve(bound.providerModule)];
    const thrown = await readProjectsContext({ query: QUERY });
    assert.equal(thrown.reason, 'Projects provider is unavailable');
    assert.ok(repositoryRoot);
  });
});

test('Projects provider reads are bounded and time out without leaking diagnostics', async () => {
  const result = await readProjectsContext({
    provider: { read: () => new Promise(() => {}) },
    query: QUERY,
    projectsContextTimeoutMs: 50,
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'PROJECTS_PROVIDER_TIMEOUT');
  assert.doesNotMatch(result.markdown, /timed out|Promise|provider payload/i);
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
