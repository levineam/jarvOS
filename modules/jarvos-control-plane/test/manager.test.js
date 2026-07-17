'use strict';

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createApplicationService, createMemoryApplicationStore } = require('../src');
const {
  createControlPlaneService,
  normalizeOperation,
  parseCli,
  probeReadiness,
  resolveCliCredential,
  verifyHostService,
} = require('../scripts/jarvos-manager.js');

const MANAGER_CLI = path.join(__dirname, '..', 'scripts', 'jarvos-manager.js');

// A host module that authenticates the "writer" credential and persists state
// to a JSON file, so two separate spawned CLI processes (request, then approve)
// share the same control-plane state and can exercise the full flow end to end.
function writerHostSource(stateFile) {
  const src = path.join(__dirname, '..', 'src', 'index.js');
  return [
    "const fs = require('fs');",
    `const { createApplicationService } = require(${JSON.stringify(src)});`,
    `const STATE_FILE = ${JSON.stringify(stateFile)};`,
    'function load() {',
    '  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }',
    '  catch { return { revision: 0, paused: false, keyedFences: {}, idempotency: {}, requests: [], evidence: [] }; }',
    '}',
    'const store = {',
    '  load,',
    '  save(next, expectedRevision) {',
    '    const current = load();',
    '    if (current.revision !== expectedRevision) throw new Error("concurrent state mutation");',
    '    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...next, revision: current.revision + 1 }));',
    '  },',
    '};',
    'module.exports = () => createApplicationService({',
    '  store,',
    "  resolveCredential: (credential) => credential === 'writer'",
    "    ? { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'] }",
    '    : null,',
    '  canRead: () => true,',
    "  policy: () => ({ outcome: 'require_approval', allowCreatorApproval: true }),",
    '});',
  ].join('\n');
}

function runManager(args, env) {
  return spawnSync(process.execPath, [MANAGER_CLI, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

function fixture() {
  const applicationService = createApplicationService({
    store: createMemoryApplicationStore(),
    resolveCredential: (credential) => credential === 'writer'
      ? { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'] }
      : null,
    canRead: () => true,
    policy: () => ({ outcome: 'require_approval', allowCreatorApproval: true }),
  });
  return createControlPlaneService({ applicationService });
}

test('manager delegates human aliases to the trusted application service', () => {
  const manager = fixture();
  const created = manager.execute('request', {
    credential: 'writer', actor: { kind: 'human' }, resource: { machineId: 'machine-a', type: 'workspace', id: 'one' },
    mutationClass: 'workspace.test', desiredGeneration: '1', commandSpec: { operation: 'test' },
  });
  assert.equal(created.request.principal.id, 'principal:writer');
  assert.equal(created.request.status, 'approval_required');
  const approved = manager.execute('approve', { credential: 'writer', requestId: created.request.id, fence: created.request.approval.fence });
  assert.equal(approved.request.status, 'approved');
});

test('manager has no adapter-owned lifecycle or configuration escape hatch', () => {
  const manager = fixture();
  assert.throws(() => manager.execute('pause', { credential: 'writer' }), /unsupported public control-plane operation/);
  assert.throws(() => normalizeOperation('cancel'), /unsupported public control-plane operation/);
  assert.throws(() => createControlPlaneService(), /host service is not configured/);
});

test('host-service readiness verification is boolean and does not disclose configuration', () => {
  assert.deepEqual(verifyHostService(), { ok: false });
  // A plain JS file without execute() is not a ready host, and the result must
  // stay a boolean ok flag with no path disclosure.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-verify-'));
  try {
    const decoy = path.join(tmp, 'not-a-host.js');
    fs.writeFileSync(decoy, 'module.exports = { hello: true };\n', 'utf8');
    assert.deepEqual(verifyHostService(decoy), { ok: false });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('verify-host-service CLI fails when readiness returns ok:false', () => {
  // A loadable module that is not an auth-enforcing host must exit non-zero.
  // This also guards the object-truthiness footgun: `{ ok: false }` is truthy,
  // so `if (!verifyHostService(...))` would incorrectly report success.
  // Use a disposable dummy module — never require this test file as a host.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-verify-cli-'));
  try {
    const decoy = path.join(tmp, 'decoy-host.js');
    fs.writeFileSync(decoy, 'module.exports = { execute() { return { ok: true, requests: [] }; } };\n', 'utf8');
    const result = runManager(['verify-host-service', '--service-module', decoy], {});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not ready/);
    assert.equal(result.stdout.trim(), '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readiness requires enforced authentication, not just an execute() method', () => {
  // Decorative host: has execute() but serves data without authenticating.
  assert.equal(probeReadiness({ execute: () => ({ ok: true, requests: [] }) }), false);
  // No execute() at all.
  assert.equal(probeReadiness({}), false);
  // A decorative host that merely throws an error whose text mentions "auth" is
  // NOT ready: readiness requires the structured AUTH_REQUIRED code, so a generic
  // failure cannot masquerade as an enforced authentication boundary.
  assert.equal(probeReadiness({ execute: () => { throw new Error('auth service unavailable'); } }), false);
  // A host that rejects an unresolvable credential at the auth boundary is ready.
  const authEnforcing = createApplicationService({
    store: createMemoryApplicationStore(),
    resolveCredential: () => null,
    canRead: () => false,
    policy: () => ({ outcome: 'deny' }),
  });
  assert.equal(probeReadiness(authEnforcing), true);
});

test('CLI numeric flags are coerced so --fence approval is not compared as a string', () => {
  const { input } = parseCli(['approve', '--request-id', 'req_1', '--fence', '3']);
  assert.strictEqual(input.fence, 3);
  assert.throws(() => parseCli(['approve', '--fence', 'not-a-number']), /--fence must be an integer/);
});

test('spawned CLI completes a real --fence approval end to end', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cli-approve-'));
  try {
    const stateFile = path.join(tmp, 'state.json');
    const hostModule = path.join(tmp, 'host.js');
    fs.writeFileSync(hostModule, writerHostSource(stateFile), 'utf8');
    // Secret must never appear on argv; use env binding for the CLI process.
    const secret = 'writer-secret-never-on-argv';
    const hostWithSecret = writerHostSource(stateFile).replaceAll("'writer'", JSON.stringify(secret));
    fs.writeFileSync(hostModule, hostWithSecret, 'utf8');
    const env = {
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL: secret,
    };

    const created = runManager([
      'request',
      '--input',
      JSON.stringify({
        actor: { kind: 'human' },
        resource: { machineId: 'machine-a', type: 'workspace', id: 'one' },
        mutationClass: 'workspace.test',
        desiredGeneration: '1',
        commandSpec: { operation: 'test' },
      }),
    ], env);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.ok(!created.stdout.includes(secret), 'CLI stdout must not project the credential');
    assert.ok(!created.stderr.includes(secret), 'CLI stderr must not log the credential');
    const requestResult = JSON.parse(created.stdout);
    assert.equal(requestResult.request.status, 'approval_required');
    const fence = requestResult.request.approval.fence;
    assert.equal(typeof fence, 'number');

    const approved = runManager([
      'approve',
      '--request-id',
      requestResult.request.id,
      '--fence',
      String(fence),
    ], env);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    assert.ok(!approved.stdout.includes(secret), 'approve stdout must not project the credential');
    const approveResult = JSON.parse(approved.stdout);
    assert.equal(approveResult.request.status, 'approved');
    // Inspected projection must also omit the raw credential.
    const inspected = runManager(['inspect', '--request-id', requestResult.request.id], env);
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    assert.ok(!inspected.stdout.includes(secret), 'inspect projection must not include the credential');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI resolves credential from env or file, never requiring it on argv', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cred-'));
  try {
    const previous = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;

    // No source at all is an explicit error, not a silent empty credential.
    assert.throws(() => resolveCliCredential({}), /credential required/);

    // Credential file is accepted without ever touching argv.
    const credFile = path.join(tmp, 'cred');
    fs.writeFileSync(credFile, 'writer\n', 'utf8');
    assert.equal(resolveCliCredential({ credentialFile: credFile }), 'writer');

    // A raw --credential on argv is rejected by default: a warning does not undo
    // its exposure in process listings and shell history.
    assert.throws(() => resolveCliCredential({ credential: 'from-argv' }), /rejected by default/);

    // The insecure dev override honors it explicitly (opt-in only).
    assert.equal(resolveCliCredential({ credential: 'from-argv', allowInsecureCredential: true }), 'from-argv');

    // Environment takes precedence even over an explicitly overridden argv value.
    process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = 'from-env';
    assert.equal(resolveCliCredential({ credential: 'from-argv', allowInsecureCredential: true }), 'from-env');

    if (previous === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = previous;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('host-service module must be an absolute path in a non-writable location', () => {
  const { resolveTrustedServiceModule } = require('../scripts/jarvos-manager.js');
  assert.throws(() => resolveTrustedServiceModule('relative/host.js'), /absolute path/);
  assert.throws(() => resolveTrustedServiceModule(path.join(os.tmpdir(), 'jarvos-missing-host-xyz.js')), /does not exist/);
  // A normally-permissioned module file resolves to its realpath.
  assert.equal(resolveTrustedServiceModule(__filename), fs.realpathSync(__filename));
});

test('host-service module owned by an untrusted user is rejected regardless of mode', () => {
  const { resolveTrustedServiceModule } = require('../scripts/jarvos-manager.js');
  if (typeof process.getuid !== 'function') return; // POSIX-only ownership semantics.
  // A 0644 file an attacker owns in a shared temp root passes the writability
  // check yet is fully rewritable by its owner. Simulate a foreign owner by making
  // our own uid appear different from the file's, and assert it is rejected.
  const realGetuid = process.getuid;
  const foreignUid = fs.statSync(__filename).uid + 1;
  process.getuid = () => foreignUid;
  try {
    assert.throws(() => resolveTrustedServiceModule(__filename), /untrusted user/);
  } finally {
    process.getuid = realGetuid;
  }
});
