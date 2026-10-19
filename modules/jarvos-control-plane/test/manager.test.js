'use strict';

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createApplicationService, createMemoryApplicationStore } = require('../src');
const {
  PUBLIC_OPERATIONS,
  coerceNumericFlags,
  createControlPlaneService,
  normalizeOperation,
  parseCli,
  probeReadiness,
  readTrustedCredentialFile,
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

    // Credential file is accepted without ever touching argv (owner-only leaf).
    const secret = 'writer-file-secret';
    const credFile = path.join(tmp, 'cred');
    fs.writeFileSync(credFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credFile, 0o600);
    assert.equal(resolveCliCredential({ credentialFile: credFile }), secret);

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

test('CLI credential-file matches MCP/setup fail-closed bar without leaking path or secret', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cred-strict-'));
  try {
    const previous = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    const secret = 'super-secret-never-in-errors';

    // Relative paths fail closed.
    assert.throws(() => resolveCliCredential({ credentialFile: 'relative/secret' }), /absolute path/);
    assert.throws(() => readTrustedCredentialFile('relative/secret'), /absolute path/);

    // Owner-only absolute file succeeds.
    const okFile = path.join(tmp, 'ok.credential');
    fs.writeFileSync(okFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(okFile, 0o600);
    assert.equal(readTrustedCredentialFile(okFile), secret);
    assert.equal(resolveCliCredential({ credentialFile: okFile }), secret);

    // Group/other-readable leaf fails closed.
    const openFile = path.join(tmp, 'open.credential');
    fs.writeFileSync(openFile, `${secret}\n`, { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(openFile, 0o644);
    assert.throws(() => {
      try {
        resolveCliCredential({ credentialFile: openFile });
      } catch (error) {
        assert.ok(!String(error.message).includes(secret), 'error must not include secret');
        assert.ok(!String(error.message).includes(openFile), 'error must not include path');
        throw error;
      }
    }, /owner-only/);

    // Unsafe writable parent (non-sticky) fails closed for ancestry.
    const unsafeParent = path.join(tmp, 'unsafe-parent');
    fs.mkdirSync(unsafeParent, { recursive: true });
    fs.chmodSync(unsafeParent, 0o777);
    const nested = path.join(unsafeParent, 'nested.credential');
    fs.writeFileSync(nested, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(nested, 0o600);
    assert.throws(() => {
      try {
        readTrustedCredentialFile(nested);
      } catch (error) {
        assert.ok(!String(error.message).includes(secret), 'ancestry error must not include secret');
        assert.ok(!String(error.message).includes(nested), 'ancestry error must not include path');
        throw error;
      }
    }, /writable location|untrusted location/);

    // Restore parent mode before cleanup so rmSync can traverse.
    fs.chmodSync(unsafeParent, 0o755);

    if (previous === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = previous;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('coerceNumericFlags accepts integer strings and rejects non-integers safely', () => {
  const coerced = coerceNumericFlags({ fence: '7' }, { labelPrefix: '' });
  assert.strictEqual(coerced.fence, 7);
  // Bare true is the CLI "flag present without value" sentinel; leave it alone.
  assert.strictEqual(coerceNumericFlags({ fence: true }).fence, true);
  assert.throws(() => coerceNumericFlags({ fence: '3.5' }), /--fence must be an integer/);
  assert.throws(() => coerceNumericFlags({ fence: 3.5 }, { labelPrefix: '' }), /fence must be an integer/);
  assert.throws(() => coerceNumericFlags({ fence: 'nope' }, { labelPrefix: '' }), /fence must be an integer/);
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

// ---------------------------------------------------------------------------
// execute-approved transport.
//
// Contract: the public alias `execute-approved` normalizes to `executeApproved`
// and forwards EXACTLY { credential, requestId } to the installed host
// service's execute('executeApproved', ...). The host returns a Promise; the
// manager returns a Promise resolving to the closed projection
//   { ok, requestId, outcome, code, claimId, expiresAt }
// where ok is true only for a host result { ok: true, outcome: 'installed' },
// outcome is one of installed|failed|indeterminate|refused (anything else is
// indeterminate), code is an UPPER_SNAKE public code or null, claimId is an
// opaque id or null, expiresAt is an ISO instant or null, and requestId is the
// forwarded id. Internal claim/outcome operations are never transport callable.
// Legacy operations stay synchronous.
// ---------------------------------------------------------------------------

const EXECUTE_APPROVED_RESULT_KEYS = ['claimId', 'code', 'expiresAt', 'ok', 'outcome', 'requestId'];

function executeApprovedSpy({ result, reject, syncThrow } = {}) {
  const calls = [];
  const inner = createApplicationService({
    store: createMemoryApplicationStore(),
    resolveCredential: (credential) => credential === 'writer'
      ? { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'] }
      : null,
    canRead: () => true,
    policy: () => ({ outcome: 'require_approval', allowCreatorApproval: true }),
  });
  return {
    calls,
    execute(operation, input) {
      calls.push([operation, structuredClone(input)]);
      if (operation !== 'executeApproved') return inner.execute(operation, input);
      if (syncThrow) throw syncThrow;
      return reject ? Promise.reject(reject) : Promise.resolve(result);
    },
  };
}

const CALLER_AUTHORITY = Object.freeze({
  fence: 3,
  approval: { allowed: true, approvedBy: 'principal:forged' },
  actor: { kind: 'human', id: 'forged' },
  commandSpec: { operation: 'pms-read-grant', arguments: { rootProjectId: 'prj_999999' } },
  path: '/tmp/forged-receipt.json',
  provider: '/tmp/forged-provider.js',
  authorization: { allowed: true },
  pin: 'forged-pin',
  resolver: 'forged-resolver',
  expectedApprover: 'principal:forged',
  claimId: 'claim_forged',
  outcome: 'installed',
  binding: { status: 'approved', approvedBy: 'principal:forged' },
  service: { execute() { throw new Error('caller service must never be used'); } },
  applicationService: { execute() { throw new Error('caller service must never be used'); } },
  serviceModule: '/tmp/forged-host.js',
});

test('execute-approved aliases to executeApproved and forwards only the credential and opaque requestId', async () => {
  const spy = executeApprovedSpy({
    result: {
      ok: true, requestId: 'request_from_host', outcome: 'installed', code: null, claimId: 'claim_fixture_1',
      expiresAt: '2026-10-20T12:00:00.000Z', secret: 'SYNTHETIC-SECRET-MARKER', receiptPath: '/private/fixture/receipt.json',
      receipt: { signature: 'SYNTHETIC-SIGNATURE' },
    },
  });
  const manager = createControlPlaneService({ applicationService: spy });
  assert.equal(normalizeOperation('execute-approved'), 'executeApproved');
  assert.equal(PUBLIC_OPERATIONS.has('executeApproved'), true);

  const pending = manager.execute('execute-approved', { credential: 'writer', requestId: 'request_fixture_1', ...CALLER_AUTHORITY });
  assert.equal(typeof pending.then, 'function', 'execute-approved settles asynchronously');
  const result = await pending;
  assert.deepEqual(spy.calls, [['executeApproved', { credential: 'writer', requestId: 'request_fixture_1' }]]);
  assert.deepEqual(result, {
    ok: true, requestId: 'request_fixture_1', outcome: 'installed', code: null, claimId: 'claim_fixture_1', expiresAt: '2026-10-20T12:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|private\/fixture/);

  const canonical = await manager.execute('executeApproved', { credential: 'writer', requestId: 'request_fixture_2' });
  assert.equal(canonical.requestId, 'request_fixture_2');
  assert.deepEqual(spy.calls[1], ['executeApproved', { credential: 'writer', requestId: 'request_fixture_2' }]);
});

test('execute-approved fails before the host on a missing credential or a non-opaque requestId', async () => {
  const spy = executeApprovedSpy({ result: { ok: true, outcome: 'installed' } });
  const manager = createControlPlaneService({ applicationService: spy });
  for (const input of [
    { requestId: 'request_fixture_1' },
    { credential: '', requestId: 'request_fixture_1' },
    { credential: { secret: 'object' }, requestId: 'request_fixture_1' },
    { credential: 'writer' },
    { credential: 'writer', requestId: '' },
    { credential: 'writer', requestId: '../escape' },
    { credential: 'writer', requestId: 'request/fixture' },
    { credential: 'writer', requestId: ' request_fixture_1' },
    { credential: 'writer', requestId: 'r'.repeat(129) },
    { credential: 'writer', requestId: { id: 'request_fixture_1' } },
    { credential: 'writer', requestId: 7 },
  ]) {
    await assert.rejects(async () => manager.execute('execute-approved', input), () => true, JSON.stringify(input));
  }
  assert.equal(spy.calls.length, 0, 'invalid input never reaches the installed host');
});

test('internal claim and outcome operations are not transport callable', () => {
  const spy = executeApprovedSpy();
  const manager = createControlPlaneService({ applicationService: spy });
  for (const operation of ['claimExecution', 'recordExecutionOutcome', 'claim-execution', 'record-execution-outcome', 'execute']) {
    assert.equal(PUBLIC_OPERATIONS.has(operation), false, operation);
    assert.throws(() => normalizeOperation(operation), /unsupported public control-plane operation/, operation);
    assert.throws(() => manager.execute(operation, { credential: 'writer', requestId: 'request_fixture_1' }), /unsupported public control-plane operation/, operation);
  }
  assert.equal(spy.calls.length, 0);
});

test('execute-approved host failures settle once as rejections and never as {}', async () => {
  const rejected = createControlPlaneService({ applicationService: executeApprovedSpy({ reject: new Error('PMS_EXECUTION_REFUSED') }) });
  await assert.rejects(async () => rejected.execute('execute-approved', { credential: 'writer', requestId: 'request_fixture_1' }), /PMS_EXECUTION_REFUSED/);

  const thrown = createControlPlaneService({ applicationService: executeApprovedSpy({ syncThrow: new Error('PMS_HOST_UNAVAILABLE') }) });
  await assert.rejects(async () => thrown.execute('execute-approved', { credential: 'writer', requestId: 'request_fixture_1' }), /PMS_HOST_UNAVAILABLE/);

  // Malformed host successes are projected closed and never become ok:true.
  for (const hostResult of [undefined, null, 'installed', {}, { ok: true }, { ok: true, outcome: 'satisfied' }, { ok: 'true', outcome: 'installed' }]) {
    const manager = createControlPlaneService({ applicationService: executeApprovedSpy({ result: hostResult }) });
    const result = await manager.execute('execute-approved', { credential: 'writer', requestId: 'request_fixture_1' });
    assert.deepEqual(Object.keys(result).sort(), EXECUTE_APPROVED_RESULT_KEYS, JSON.stringify(hostResult));
    assert.equal(result.ok, false, JSON.stringify(hostResult));
    assert.equal(result.requestId, 'request_fixture_1');
    assert.equal(result.outcome, 'indeterminate', JSON.stringify(hostResult));
  }

  const unsafeFields = createControlPlaneService({
    applicationService: executeApprovedSpy({
      result: { ok: true, outcome: 'installed', code: 'bad code /private/path', claimId: '../claim', expiresAt: 'tomorrow' },
    }),
  });
  const projected = await unsafeFields.execute('execute-approved', { credential: 'writer', requestId: 'request_fixture_1' });
  assert.deepEqual(projected, { ok: true, requestId: 'request_fixture_1', outcome: 'installed', code: null, claimId: null, expiresAt: null });

  const refused = createControlPlaneService({
    applicationService: executeApprovedSpy({ result: { ok: false, outcome: 'refused', code: 'APPROVAL_UNAVAILABLE', claimId: null, expiresAt: null } }),
  });
  assert.deepEqual(
    await refused.execute('execute-approved', { credential: 'writer', requestId: 'request_fixture_1' }),
    { ok: false, requestId: 'request_fixture_1', outcome: 'refused', code: 'APPROVAL_UNAVAILABLE', claimId: null, expiresAt: null },
  );
});

test('legacy operations stay synchronous and readiness probing is unchanged', () => {
  const spy = executeApprovedSpy();
  const manager = createControlPlaneService({ applicationService: spy });
  const listed = manager.execute('list', { credential: 'writer' });
  assert.equal(typeof listed.then, 'undefined');
  assert.equal(listed.ok, true);
  assert.throws(() => manager.execute('list', { credential: 'not-a-credential' }), (error) => error.code === 'AUTH_REQUIRED');
  assert.equal(probeReadiness(spy), true);
  assert.equal(probeReadiness(manager), true);
});

function executeApprovedHostSource({ recordFile, loadMarker, mode, credential }) {
  const src = path.join(__dirname, '..', 'src', 'index.js');
  const settle = mode === 'reject'
    ? "    return new Promise((_, reject) => setTimeout(() => reject(new Error('PMS_EXECUTION_REFUSED')), 10));"
    : "    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, requestId: input.requestId, outcome: 'installed', code: null, claimId: 'claim_fixture_cli', expiresAt: '2026-10-20T12:00:00.000Z', secret: 'SYNTHETIC-SECRET-MARKER' }), 10));";
  return [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(loadMarker)}, 'loaded');`,
    `const { createApplicationService, createMemoryApplicationStore } = require(${JSON.stringify(src)});`,
    'const inner = createApplicationService({',
    '  store: createMemoryApplicationStore(),',
    `  resolveCredential: (value) => value === ${JSON.stringify(credential)} ? { id: 'principal:writer', capabilities: ['control-plane.read'] } : null,`,
    '  canRead: () => true,',
    '});',
    'module.exports = () => ({',
    '  execute(operation, input) {',
    "    if (operation !== 'executeApproved') return inner.execute(operation, input);",
    `    fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify(input));`,
    settle,
    '  },',
    '});',
  ].join('\n');
}

function withExecuteApprovedCliHost(mode, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cli-execute-approved-'));
  try {
    const credential = 'writer-secret-never-on-argv';
    const files = {
      hostModule: path.join(tmp, 'host.js'),
      recordFile: path.join(tmp, 'forwarded.json'),
      loadMarker: path.join(tmp, 'loaded.marker'),
    };
    fs.writeFileSync(files.hostModule, executeApprovedHostSource({ ...files, mode, credential }), { encoding: 'utf8', mode: 0o600 });
    return fn({ ...files, credential });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const CLI_AUTHORITY_ARGS = [
  '--request-id', 'request_fixture_cli', '--fence', '4',
  '--input', JSON.stringify({ approval: { allowed: true }, actor: { kind: 'human' }, expectedApprover: 'principal:forged', path: '/tmp/forged' }),
];

test('spawned CLI awaits execute-approved once and prints the closed projection', () => {
  withExecuteApprovedCliHost('resolve', ({ hostModule, recordFile, credential }) => {
    const result = runManager(['execute-approved', ...CLI_AUTHORITY_ARGS], {
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL: credential,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.notEqual(result.stdout.trim(), '{}');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true, requestId: 'request_fixture_cli', outcome: 'installed', code: null, claimId: 'claim_fixture_cli', expiresAt: '2026-10-20T12:00:00.000Z',
    });
    assert.ok(!result.stdout.includes(credential) && !result.stderr.includes(credential));
    assert.ok(!result.stdout.includes('SYNTHETIC-SECRET-MARKER'));
    assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')), { credential, requestId: 'request_fixture_cli' });
  });
});

test('spawned CLI reports an async execute-approved failure once with a non-zero exit', () => {
  withExecuteApprovedCliHost('reject', ({ hostModule, credential }) => {
    const result = runManager(['execute-approved', ...CLI_AUTHORITY_ARGS], {
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL: credential,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.trim(), '', 'a pending Promise must never print as {}');
    assert.match(result.stderr, /PMS_EXECUTION_REFUSED/);
    assert.equal(result.stderr.match(/PMS_EXECUTION_REFUSED/g).length, 1);
    assert.ok(!result.stderr.includes(credential));
  });
});

test('spawned CLI refuses execute-approved without a credential before loading the host', () => {
  withExecuteApprovedCliHost('resolve', ({ hostModule, recordFile, loadMarker }) => {
    const result = runManager(['execute-approved', '--request-id', 'request_fixture_cli'], {
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL: '',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /credential required/);
    assert.equal(fs.existsSync(loadMarker), false, 'host module must not load without a credential');
    assert.equal(fs.existsSync(recordFile), false);
  });
});

test('spawned CLI never exposes internal claim or outcome operations', () => {
  withExecuteApprovedCliHost('resolve', ({ hostModule, recordFile, credential }) => {
    for (const operation of ['claimExecution', 'recordExecutionOutcome']) {
      const result = runManager([operation, '--request-id', 'request_fixture_cli'], {
        JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
        JARVOS_CONTROL_PLANE_CREDENTIAL: credential,
      });
      assert.notEqual(result.status, 0, operation);
      assert.match(result.stderr, /unsupported public control-plane operation/, operation);
      assert.equal(fs.existsSync(recordFile), false, operation);
    }
  });
});
