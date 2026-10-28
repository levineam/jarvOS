'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVaultMutationLedger } = require('../adapters/obsidian/src/vault-mutation-ledger');

const op = (id, sequence = 1) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Notes/A.md', sequence, operationKind: 'create' });

test('ledger durably creates intent before granting FIFO fenced claims', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-'));
  try {
    let now = 100;
    const filePath = path.join(root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 20 });
    const first = ledger.claim(op('op-00000001'), 'owner-a'); assert.equal(first.granted, true);
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(ledger.claim(op('op-00000002', 2), 'owner-b').reason, 'prior_operation_pending');
    ledger.transition('op-00000001', 'unknown_after_dispatch', { ownerId: 'owner-a', fence: first.fence });
    now = 1000;
    assert.equal(ledger.claim(op('op-00000002', 2), 'owner-b').reason, 'prior_operation_blocked');
    const restarted = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 20 });
    assert.equal(restarted.get('op-00000001').status, 'unknown_after_dispatch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('separate ledger instances fence stale claim owners and reject sequence collisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-fence-'));
  try {
    let now = 1; const filePath = path.join(root, 'ledger.json');
    const a = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 10 });
    const b = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 10 });
    const first = a.claim(op('op-00000003'), 'a'); assert.equal(first.granted, true);
    assert.equal(b.claim(op('op-00000003'), 'b').reason, 'claim_active');
    assert.equal(a.claim(op('op-00000003'), 'a').reason, 'claim_active');
    assert.throws(() => b.claim(op('op-00000005'), 'b'), /Duplicate same-file operation sequence/);
    now = 100; const takeover = b.claim(op('op-00000003'), 'b'); assert.equal(takeover.granted, true);
    assert.throws(() => a.transition('op-00000003', 'acknowledged', { ownerId: 'a', fence: first.fence }), /fence/);
    assert.doesNotThrow(() => b.transition('op-00000003', 'acknowledged', { ownerId: 'b', fence: takeover.fence }));
    assert.equal(a.claim(op('op-00000003'), 'a').reason, 'already_acknowledged');
    assert.throws(() => a.transition('op-00000003', 'not-a-state', { ownerId: 'a', fence: 1 }), /Invalid ledger transition/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed and permission-unsafe ledgers are preserved and refused, never reset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-quarantine-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const uncertain = (error) => error.code === 'vault_mutation_ledger_uncertain';
    fs.writeFileSync(filePath, '{not-json}', { mode: 0o600 });
    const ledger = createVaultMutationLedger({ filePath });
    assert.throws(() => ledger.read(), uncertain);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{not-json}');
    assert.equal(fs.existsSync(`${filePath}.quarantine`), false);
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, operations: {}, claims: {} }), { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);
    assert.throws(() => ledger.read(), uncertain);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o644);
    assert.equal(fs.existsSync(`${filePath}.quarantine`), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local write-ahead states and auditable operator resolution survive restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-local-'));
  try {
    const filePath = path.join(root, 'ledger.json'); const ledger = createVaultMutationLedger({ filePath });
    const claim = ledger.claim(op('op-00000006'), 'offline', { local: true });
    assert.equal(ledger.get('op-00000006').status, 'local_mutating');
    ledger.transition('op-00000006', 'local_applied', { ownerId: 'offline', fence: claim.fence });
    const restarted = createVaultMutationLedger({ filePath });
    assert.equal(restarted.get('op-00000006').status, 'local_applied');
    restarted.resolve('operator', 'op-00000006', 'abandoned', 'user selected recovery');
    assert.equal(restarted.get('op-00000006').history.at(-1).evidence.reason, 'user selected recovery');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('per-file sequence reservations are durable across ledger instances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-sequence-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const first = createVaultMutationLedger({ filePath });
    const second = createVaultMutationLedger({ filePath });
    assert.equal(first.nextSequence('vault', 'Notes/A.md'), 1);
    assert.equal(second.nextSequence('vault', 'Notes/A.md'), 2);
    assert.equal(first.nextSequence('vault', 'Notes/B.md'), 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('complete operations are planned atomically in submission order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-plan-'));
  try {
    const ledger = createVaultMutationLedger({ filePath: path.join(root, 'ledger.json') });
    const laterContext = op('op-00000021');
    const earlierContext = op('op-00000020');
    const submittedFirst = ledger.planNext(laterContext).operation;
    const submittedSecond = ledger.planNext(earlierContext).operation;
    assert.equal(submittedFirst.sequence, 1);
    assert.equal(submittedSecond.sequence, 2);
    assert.deepEqual(ledger.planNext({ ...laterContext, sequence: 99 }).operation, submittedFirst);
    assert.equal(Object.keys(ledger.read().operations).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an identified capture binds its first request hash to every stage of the identity, across instances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-capture-family-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const a = createVaultMutationLedger({ filePath });
    const b = createVaultMutationLedger({ filePath });
    const stage = (id, hash, vaultRelativePath) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath, sequence: 1, operationKind: 'create', captureRequestHash: hash, source: 'fixture-source' });
    const conflict = (error) => error.code === 'capture_identity_request_conflict';
    a.planNext(stage('capture:family-one:note', 'a'.repeat(64), 'Notes/A.md'));
    assert.throws(() => b.planNext(stage('capture:family-one:journal:create', 'b'.repeat(64), 'Journal/2030-02-03.md')), conflict);
    assert.equal(b.get('capture:family-one:journal:create'), null);
    assert.doesNotThrow(() => b.planNext(stage('capture:family-one:journal:create', 'a'.repeat(64), 'Journal/2030-02-03.md')));

    // Reverse direction, and a different identity stays independent.
    a.planNext(stage('capture:family-two:journal:section', 'c'.repeat(64), 'Journal/2030-02-04.md'));
    assert.throws(() => b.planNext(stage('capture:family-two:note', 'd'.repeat(64), 'Notes/B.md')), conflict);
    assert.doesNotThrow(() => b.planNext(stage('capture:family-three:note', 'd'.repeat(64), 'Notes/C.md')));

    // A ledger written before the binding map existed derives it from records.
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    delete raw.captureRequests;
    fs.writeFileSync(filePath, JSON.stringify(raw));
    assert.throws(() => a.planNext(stage('capture:family-one:journal:section', 'e'.repeat(64), 'Journal/2030-02-03.md')), conflict);
    assert.equal(a.get('capture:family-one:journal:section'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capture request bindings hold malformed, uncertain or mismatched authority and survive record pruning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-capture-held-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath });
    const stage = (id, overrides = {}) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Journal/2030-02-03.md',
      sequence: 1, operationKind: 'create', captureRequestHash: 'a'.repeat(64), source: 'fixture-source', ...overrides });
    const conflict = (error) => error.code === 'capture_identity_request_conflict';
    const rewrite = (mutate) => { const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); mutate(raw); fs.writeFileSync(filePath, JSON.stringify(raw)); };
    const held = (operation) => {
      const before = fs.readFileSync(filePath, 'utf8');
      assert.throws(() => ledger.planNext(operation), conflict, operation.operationId);
      assert.equal(fs.readFileSync(filePath, 'utf8'), before);
    };

    // An equal hash from another source or vault cannot claim an unused sibling.
    ledger.planNext(stage('capture:fence:note', { vaultRelativePath: 'Notes/A.md' }));
    held(stage('capture:fence:journal:create', { source: 'other-source' }));
    held(stage('capture:fence:journal:create', { vaultId: 'other-vault' }));
    assert.doesNotThrow(() => ledger.planNext(stage('capture:fence:journal:create')));

    // The binding outlives its records.
    rewrite((raw) => { for (const id of Object.keys(raw.operations)) if (id.startsWith('capture:fence:')) delete raw.operations[id]; });
    held(stage('capture:fence:journal:section', { captureRequestHash: 'b'.repeat(64) }));

    // Malformed persisted bindings are held, never replaced.
    for (const malformed of [[], 'bindings', { 'capture:fence': true }, { 'capture:fence': {} },
      { 'capture:fence': { requestHash: 'short', vaultId: 'vault', source: 'fixture-source' } }]) {
      rewrite((raw) => { raw.captureRequests = malformed; });
      held(stage('capture:fence:journal:section'));
    }

    // Earlier records without a hash, or with inconsistent hashes, are uncertainty.
    const legacy = (operation) => ({ operation, status: 'unknown_after_dispatch', createdAt: 1, updatedAt: 1, attempts: 1, history: [] });
    rewrite((raw) => {
      delete raw.captureRequests;
      const { captureRequestHash, ...unhashed } = stage('capture:legacy-a:note', { vaultRelativePath: 'Notes/L.md' });
      raw.operations['capture:legacy-a:note'] = legacy(unhashed);
      raw.operations['capture:legacy-b:note'] = legacy(stage('capture:legacy-b:note', { vaultRelativePath: 'Notes/M.md' }));
      raw.operations['capture:legacy-b:journal:create'] = legacy(stage('capture:legacy-b:journal:create', { vaultRelativePath: 'Journal/2030-02-05.md', captureRequestHash: 'c'.repeat(64) }));
    });
    held(stage('capture:legacy-a:journal:create', { vaultRelativePath: 'Journal/2030-02-06.md' }));
    held(stage('capture:legacy-b:journal:section', { vaultRelativePath: 'Journal/2030-02-05.md' }));

    // Ordinary operations are unaffected.
    assert.doesNotThrow(() => ledger.planNext({ schemaVersion: 1, operationId: 'op-00000099', vaultId: 'vault', vaultRelativePath: 'Notes/Z.md', sequence: 1, operationKind: 'create' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ensure and claim admit capture family stages only under the same binding, before any grant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-capture-admission-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath });
    const stage = (id, overrides = {}) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Journal/2030-02-03.md',
      sequence: 1, operationKind: 'create', captureRequestHash: 'a'.repeat(64), source: 'fixture-source', ...overrides });
    const conflict = (error) => error.code === 'capture_identity_request_conflict';
    const read = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rewrite = (mutate) => { const raw = read(); mutate(raw); fs.writeFileSync(filePath, JSON.stringify(raw)); };
    const legacy = (operation) => ({ operation, status: 'unknown_after_dispatch', createdAt: 1, updatedAt: 1, attempts: 1, history: [] });
    const held = (admit, operationId) => {
      const before = fs.readFileSync(filePath, 'utf8');
      assert.throws(admit, conflict, operationId);
      assert.equal(fs.readFileSync(filePath, 'utf8'), before);
      assert.equal(ledger.get(operationId), null);
    };

    // First admission through ensure persists the binding for a reopened ledger.
    ledger.ensure(stage('capture:admit:note', { vaultRelativePath: 'Notes/A.md' }));
    const reopened = createVaultMutationLedger({ filePath });
    held(() => reopened.ensure(stage('capture:admit:journal:create', { captureRequestHash: 'b'.repeat(64) })), 'capture:admit:journal:create');
    held(() => reopened.claim(stage('capture:admit:journal:create', { captureRequestHash: 'b'.repeat(64) }), 'owner-b'), 'capture:admit:journal:create');
    held(() => reopened.claim(stage('capture:admit:journal:create', { source: 'other-source' }), 'owner-b'), 'capture:admit:journal:create');
    held(() => reopened.claim(stage('capture:admit:journal:create', { vaultId: 'other-vault' }), 'owner-b'), 'capture:admit:journal:create');
    assert.equal(reopened.claim(stage('capture:admit:journal:create'), 'owner-a').granted, true);

    // First admission through claim persists the binding after its record is gone.
    assert.equal(ledger.claim(stage('capture:claimed:note', { vaultRelativePath: 'Notes/B.md' }), 'owner-c').granted, true);
    rewrite((raw) => {
      delete raw.operations['capture:claimed:note'];
      for (const [claimKey, claim] of Object.entries(raw.claims)) if (claim.operationId === 'capture:claimed:note') delete raw.claims[claimKey];
    });
    held(() => ledger.ensure(stage('capture:claimed:journal:section', { vaultRelativePath: 'Journal/2030-02-04.md', captureRequestHash: 'c'.repeat(64) })), 'capture:claimed:journal:section');

    // Re-admitting an existing record on a ledger without the map persists its binding.
    rewrite((raw) => { delete raw.captureRequests; });
    ledger.ensure(stage('capture:admit:note', { vaultRelativePath: 'Notes/A.md' }));
    assert.deepEqual({ ...read().captureRequests['capture:admit'], boundAt: undefined },
      { requestHash: 'a'.repeat(64), vaultId: 'vault', source: 'fixture-source', boundAt: undefined });

    // A valid map entry does not skip an inconsistent earlier sibling.
    rewrite((raw) => {
      raw.captureRequests['capture:mixed'] = { requestHash: 'a'.repeat(64), vaultId: 'vault', source: 'fixture-source', boundAt: 1 };
      raw.operations['capture:mixed:note'] = legacy(stage('capture:mixed:note', { vaultRelativePath: 'Notes/C.md', captureRequestHash: 'e'.repeat(64) }));
    });
    held(() => ledger.ensure(stage('capture:mixed:journal:create', { vaultRelativePath: 'Journal/2030-02-06.md' })), 'capture:mixed:journal:create');
    held(() => ledger.claim(stage('capture:mixed:journal:create', { vaultRelativePath: 'Journal/2030-02-06.md' }), 'owner-m'), 'capture:mixed:journal:create');

    // An incoming reserved family stage without a hash is held before any grant.
    const { captureRequestHash, ...unhashed } = stage('capture:unhashed:note', { vaultRelativePath: 'Notes/D.md' });
    held(() => ledger.claim(unhashed, 'owner-d'), 'capture:unhashed:note');
    held(() => ledger.ensure(unhashed), 'capture:unhashed:note');
    held(() => ledger.planNext(unhashed), 'capture:unhashed:note');

    // Ordinary operations are unaffected.
    assert.equal(ledger.claim({ schemaVersion: 1, operationId: 'op-00000077', vaultId: 'vault', vaultRelativePath: 'Notes/E.md', sequence: 1, operationKind: 'create' }, 'owner-e').granted, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an existing planned capture stage is held on malformed, uncertain or inconsistent family authority before any claim', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-capture-existing-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath });
    const stage = (id, overrides = {}) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Journal/2030-02-03.md',
      sequence: 1, operationKind: 'create', captureRequestHash: 'a'.repeat(64), source: 'fixture-source', ...overrides });
    const conflict = (error) => error.code === 'capture_identity_request_conflict';
    const read = () => JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rewrite = (mutate) => { const raw = read(); mutate(raw); fs.writeFileSync(filePath, JSON.stringify(raw)); };
    const heldExisting = (operation) => {
      const before = fs.readFileSync(filePath, 'utf8');
      for (const admit of [() => ledger.ensure(operation), () => ledger.claim(operation, 'owner-held'), () => ledger.planNext(operation)]) {
        assert.throws(admit, conflict, operation.operationId);
        assert.equal(fs.readFileSync(filePath, 'utf8'), before);
      }
      const record = ledger.get(operation.operationId);
      assert.equal(record.status, 'planned');
      assert.equal(record.history.length, 1);
      assert.equal(Object.values(read().claims).some((claim) => claim.operationId === operation.operationId), false);
    };

    const exact = stage('capture:planned:note', { vaultRelativePath: 'Notes/P.md' });
    ledger.ensure(exact);
    const validMap = read().captureRequests;
    assert.ok(validMap['capture:planned']);

    // Malformed persisted bindings hold the exact stored record too.
    for (const malformed of [[], 'bindings', { 'capture:planned': true }, { 'capture:planned': {} }]) {
      rewrite((raw) => { raw.captureRequests = malformed; });
      heldExisting(exact);
    }

    // A valid map entry plus an inconsistent sibling holds it.
    rewrite((raw) => {
      raw.captureRequests = validMap;
      raw.operations['capture:planned:journal:create'] = { operation: stage('capture:planned:journal:create', { captureRequestHash: 'f'.repeat(64) }),
        status: 'unknown_after_dispatch', createdAt: 1, updatedAt: 1, attempts: 1, history: [] };
    });
    heldExisting(exact);

    // A stored family record without a source is never admitted as unbound.
    const { source, ...sourceless } = stage('capture:sourceless:note', { vaultRelativePath: 'Notes/S.md' });
    rewrite((raw) => {
      raw.operations['capture:sourceless:note'] = { operation: sourceless, status: 'planned', createdAt: 1, updatedAt: 1, attempts: 0, history: [{ status: 'planned', at: 1 }] };
    });
    heldExisting(sourceless);

    // A valid, consistent family still reconciles its exact stored record.
    rewrite((raw) => { delete raw.operations['capture:planned:journal:create']; });
    assert.equal(ledger.claim(exact, 'owner-valid').granted, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// P1/P2 fixtures: a real valid ledger built through the ledger API.
const captureStage = (id, overrides = {}) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Journal/2030-02-03.md',
  sequence: 1, operationKind: 'create', captureRequestHash: 'a'.repeat(64), source: 'fixture-source', ...overrides });
const ledgerUncertain = (error) => error.code === 'vault_mutation_ledger_uncertain';
const captureConflictCode = (error) => error.code === 'capture_identity_request_conflict';

function seededUnknownCaptureLedger() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-p1-'));
  const filePath = path.join(root, 'ledger.json');
  const ledger = createVaultMutationLedger({ filePath });
  const granted = ledger.claim(captureStage('capture:p1:note', { vaultRelativePath: 'Notes/P1.md' }), 'owner-seed');
  assert.equal(granted.granted, true);
  ledger.transition('capture:p1:note', 'unknown_after_dispatch', { ownerId: 'owner-seed', fence: granted.fence });
  return { root, filePath };
}

const P1_DAMAGE = {
  truncated: (text) => text.slice(0, Math.floor(text.length / 2)),
  wrongSchema: (text) => JSON.stringify({ ...JSON.parse(text), schemaVersion: 2 }),
  missingOperations: (text) => { const raw = JSON.parse(text); delete raw.operations; return JSON.stringify(raw); },
  claimsArray: (text) => JSON.stringify({ ...JSON.parse(text), claims: [] }),
  legacySequenceZero: (text) => { const raw = JSON.parse(text); raw.operations['capture:p1:note'].operation.sequence = 0; return JSON.stringify(raw); },
  legacyMissingOperation: (text) => { const raw = JSON.parse(text); delete raw.operations['capture:p1:note'].operation; return JSON.stringify(raw); },
  legacyWrongKey: (text) => { const raw = JSON.parse(text); raw.operations['capture:p1:note'].operation.operationId = 'capture:p1:journal:create'; return JSON.stringify(raw); },
  legacyBadStatus: (text) => { const raw = JSON.parse(text); raw.operations['capture:p1:note'].status = 'mystery'; return JSON.stringify(raw); },
};

test('P1 damaged, unsafe or unreadable ledgers are refused unchanged by every read and admission path', () => {
  const sibling = captureStage('capture:p1:journal:section', { captureRequestHash: 'b'.repeat(64) });
  const entries = {
    read: (ledger) => ledger.read(),
    get: (ledger) => ledger.get('capture:p1:note'),
    planNext: (ledger) => ledger.planNext(sibling),
    ensure: (ledger) => ledger.ensure(sibling),
    claim: (ledger) => ledger.claim(sibling, 'owner-replacement'),
  };
  // A fresh seeded ledger per attempt, so no attempt depends on another's effects.
  const attempt = (label, entry, prepare, fsImplFor) => {
    const { root, filePath } = seededUnknownCaptureLedger();
    try {
      prepare(filePath);
      const before = fs.readFileSync(filePath);
      const mode = fs.statSync(filePath).mode;
      const ledger = createVaultMutationLedger({ filePath, ...(fsImplFor ? { fsImpl: fsImplFor(filePath) } : {}) });
      assert.throws(() => entries[entry](ledger), ledgerUncertain, label);
      assert.deepEqual(fs.readFileSync(filePath), before, label);
      assert.equal(fs.statSync(filePath).mode, mode, label);
      assert.equal(fs.existsSync(`${filePath}.quarantine`), false, label);
      assert.deepEqual(fs.readdirSync(root), ['ledger.json'], label);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  const withoutMap = (filePath) => {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    delete raw.captureRequests;
    fs.writeFileSync(filePath, JSON.stringify(raw));
  };
  // The ledger file exists and stat succeeds; only the read fails. ENOENT here
  // is a vanished existing ledger, not a new store.
  const unreadable = (code) => (filePath) => ({
    ...fs,
    readFileSync(target, ...rest) {
      if (target === filePath) { const error = new Error('injected read failure'); error.code = code; throw error; }
      return fs.readFileSync(target, ...rest);
    },
  });
  for (const withMap of [true, false]) {
    const mapLabel = withMap ? 'map' : 'no-map';
    for (const entry of Object.keys(entries)) {
      for (const [name, damage] of Object.entries(P1_DAMAGE)) {
        attempt(`${name}/${entry}/${mapLabel}`, entry, (filePath) => {
          if (!withMap) withoutMap(filePath);
          fs.writeFileSync(filePath, damage(fs.readFileSync(filePath, 'utf8')));
        });
      }
      attempt(`unsafe-mode/${entry}/${mapLabel}`, entry, (filePath) => {
        if (!withMap) withoutMap(filePath);
        fs.chmodSync(filePath, 0o644);
      });
      for (const code of ['EIO', 'ENOENT']) {
        attempt(`unreadable-${code}/${entry}/${mapLabel}`, entry, (filePath) => { if (!withMap) withoutMap(filePath); }, unreadable(code));
      }
    }
  }

  // A genuinely absent ledger file is still a usable new store.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-p1-new-'));
  try {
    const ledger = createVaultMutationLedger({ filePath: path.join(fresh, 'ledger.json') });
    assert.deepEqual(ledger.read().operations, {});
    assert.equal(ledger.claim(captureStage('capture:p1-new:note', { vaultRelativePath: 'Notes/New.md' }), 'owner-new').granted, true);
  } finally { fs.rmSync(fresh, { recursive: true, force: true }); }
});

function acknowledgedLedger(prefix, clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const filePath = path.join(root, 'ledger.json');
  const open = () => createVaultMutationLedger({ filePath, now: () => clock.value, retentionMs: 100 });
  const ledger = open();
  const acknowledge = (operation, owner) => {
    const granted = ledger.claim(operation, owner);
    assert.equal(granted.granted, true, operation.operationId);
    ledger.transition(operation.operationId, 'acknowledged', { ownerId: owner, fence: granted.fence });
  };
  const rewrite = (mutate) => { const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); mutate(raw); fs.writeFileSync(filePath, JSON.stringify(raw)); };
  return { root, filePath, ledger, open, acknowledge, rewrite };
}

test('P2 pruning migrates a complete valid map-less legacy capture family before deleting its records', () => {
  const clock = { value: 1000 };
  const { root, filePath, ledger, open, acknowledge, rewrite } = acknowledgedLedger('jarvos-ledger-p2-', clock);
  try {
    acknowledge(captureStage('capture:p2:note', { vaultRelativePath: 'Notes/P2.md' }), 'owner-note');
    acknowledge(captureStage('capture:p2:journal:create'), 'owner-journal');
    // A supported pre-map ledger: valid hashed records, no binding map.
    rewrite((raw) => { delete raw.captureRequests; });
    clock.value += 1000;
    ledger.pruneRetained();

    const reopened = open();
    assert.equal(reopened.get('capture:p2:note'), null);
    assert.equal(reopened.get('capture:p2:journal:create'), null);
    for (const changed of [{ captureRequestHash: 'b'.repeat(64) }, { source: 'other-source' }, { vaultId: 'other-vault' }]) {
      const before = fs.readFileSync(filePath, 'utf8');
      assert.throws(() => reopened.claim(captureStage('capture:p2:journal:section', changed), 'owner-changed'), captureConflictCode, JSON.stringify(changed));
      assert.equal(fs.readFileSync(filePath, 'utf8'), before);
      assert.equal(reopened.get('capture:p2:journal:section'), null);
    }
    const binding = JSON.parse(fs.readFileSync(filePath, 'utf8')).captureRequests?.['capture:p2'];
    assert.deepEqual({ ...binding, boundAt: undefined }, { requestHash: 'a'.repeat(64), vaultId: 'vault', source: 'fixture-source', boundAt: undefined });
    assert.equal(reopened.claim(captureStage('capture:p2:journal:section'), 'owner-same').granted, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('P2 pruning refuses atomically for an inconsistent legacy capture family, and ordinary retention still prunes', () => {
  const clock = { value: 1000 };
  const unsafe = acknowledgedLedger('jarvos-ledger-p2-held-', clock);
  const ordinary = acknowledgedLedger('jarvos-ledger-p2-ordinary-', clock);
  try {
    unsafe.acknowledge(captureStage('capture:p2u:note', { vaultRelativePath: 'Notes/P2U.md' }), 'owner-note');
    unsafe.acknowledge(captureStage('capture:p2u:journal:create'), 'owner-journal');
    unsafe.acknowledge(op('op-00000088'), 'owner-ordinary');
    unsafe.rewrite((raw) => {
      delete raw.captureRequests;
      raw.operations['capture:p2u:journal:create'].operation.captureRequestHash = 'c'.repeat(64);
    });
    clock.value += 1000;
    const before = fs.readFileSync(unsafe.filePath, 'utf8');
    assert.throws(() => unsafe.ledger.pruneRetained(), captureConflictCode);
    assert.equal(fs.readFileSync(unsafe.filePath, 'utf8'), before);
    assert.ok(unsafe.open().get('capture:p2u:note'));
    assert.ok(unsafe.open().get('op-00000088'));

    ordinary.acknowledge(op('op-00000089'), 'owner-ordinary');
    clock.value += 1000;
    ordinary.ledger.pruneRetained();
    assert.equal(ordinary.open().get('op-00000089'), null);
  } finally {
    fs.rmSync(unsafe.root, { recursive: true, force: true });
    fs.rmSync(ordinary.root, { recursive: true, force: true });
  }
});
