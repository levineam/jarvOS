'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ActivityStore } = require('../src/activity-store');
const {
  createHostAdmission,
  createInferenceHostAuthority,
} = require('../src/provider-contracts');

const NOW = '2026-08-10T12:00:00.000Z';
const AUTHORITY = createHostAdmission({ producerId: 'notes', secret: 'activity-test-secret', allowedKinds: ['note_revision'] });
const INFERENCE_AUTHORITY = createInferenceHostAuthority({
  producerId: 'notes-adapter',
  secret: 'inference-test-secret',
  allowedSourceClasses: ['note', 'chat'],
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-activity-store-')); }

function waitForFile(filePath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${filePath}`));
      setTimeout(check, 10);
    };
    check();
  });
}

function runWorker(worker, role, stateDir, controlDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker, role, stateDir, controlDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function receipt({ eventId = 'event-1', dedupeKey = 'causal-1', occurredAt = NOW, evidenceRefs = ['note:rev-1'], canonicalId = 'prj_000001' } = {}) {
  const base = {
    contract: 'jarvos.verified-activity/v1',
    eventId,
    canonicalId,
    producerId: 'notes',
    kind: 'note_revision',
    occurredAt,
    observedAt: NOW,
    evidenceRefs,
    sourceRevision: 'rev-1',
    sensitivity: 'private',
    dedupeKey,
  };
  return AUTHORITY.admitVerifiedReceipt(base);
}

function canonicalRegistry() {
  const records = new Map([
    ['prj_000001', { id: 'prj_000001', kind: 'project', parentId: null, revision: 4, lifecycle: 'active' }],
    ['prj_000002', { id: 'prj_000002', kind: 'project', parentId: 'prj_000001', revision: 2, lifecycle: 'paused' }],
    ['out_000001', { id: 'out_000001', kind: 'outcome', parentId: 'prj_000002', revision: 3, lifecycle: 'active' }],
  ]);
  return { generation: 7, get: (id) => records.get(id) || null, records };
}

function inferenceEvidence(overrides = {}) {
  return {
    contract: 'jarvos.project-inference-evidence/v1',
    observationId: 'obs_unresolved_001',
    evidenceId: 'ev_unresolved_001',
    sourceClass: 'note',
    occurredAt: NOW,
    observedAt: NOW,
    sourceRevision: 'note-rev-1',
    sensitivity: 'public-fixture',
    coverageState: 'fresh',
    contentDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function admittedInference(overrides = {}, authority = INFERENCE_AUTHORITY) {
  return authority.admitEvidenceUnit(inferenceEvidence(overrides));
}

test('admits a verified receipt once and replays it by exact causal identity', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY });
  const first = store.admit(receipt());
  assert.equal(first.status, 'admitted');
  const second = store.admit(receipt({ eventId: 'event-1-retry' }));
  assert.equal(second.status, 'deduped');
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 1);
  assert.equal(store.generation, 2);
});

test('pins the authority-resolved root Project and lifecycle when activity is admitted', () => {
  const registry = canonicalRegistry();
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY, registry });
  const first = store.admit(receipt({ canonicalId: 'out_000001' }));
  assert.deepEqual(first.activity.canonicalAtAdmission, {
    canonicalId: 'out_000001',
    canonicalKind: 'outcome',
    canonicalRevision: 3,
    rootProjectId: 'prj_000001',
    rootProjectRevision: 4,
    rootProjectLifecycle: 'active',
    registryGeneration: 7,
  });

  registry.records.get('out_000001').parentId = 'prj_000001';
  registry.records.get('prj_000001').lifecycle = 'archived';
  registry.generation = 8;
  const historical = store.query({ from: NOW, to: NOW }).activities[0];
  assert.equal(historical.canonicalAtAdmission.rootProjectId, 'prj_000001');
  assert.equal(historical.canonicalAtAdmission.rootProjectLifecycle, 'active');
  assert.equal(historical.canonicalAtAdmission.registryGeneration, 7);
});

test('replay preserves the original admission-time canonical snapshot', () => {
  const registry = canonicalRegistry();
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY, registry });
  store.admit(receipt({ canonicalId: 'out_000001' }));
  registry.records.get('out_000001').parentId = 'prj_000001';
  registry.generation = 8;
  const replay = store.admit(receipt({ eventId: 'event-retry', canonicalId: 'out_000001' }));
  assert.equal(replay.status, 'deduped');
  assert.equal(replay.activity.canonicalAtAdmission.rootProjectRevision, 4);
  assert.equal(replay.activity.canonicalAtAdmission.registryGeneration, 7);
  assert.equal(store.generation, 2);
});

test('rejects shape-valid activity without a trusted host admission', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY });
  const unsigned = { ...receipt(), admission: { producerId: 'notes', digest: '0'.repeat(64), signature: '0'.repeat(64) } };
  assert.throws(() => store.admit(unsigned), /activity receipt admission invalid/);
  const unconfigured = new ActivityStore({ stateDir: tmpDir(), now: () => NOW });
  assert.throws(() => unconfigured.admit(receipt()), /activity receipt admission verifier required/);
});

test('exact derived identity collapses direct and derived evidence while preserving refs', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY });
  store.admit(receipt({ evidenceRefs: ['cass:session-1'] }));
  const derived = receipt({ eventId: 'activity-derived', dedupeKey: 'derived-record', evidenceRefs: ['projects:activity-1'] });
  const result = store.admit(derived, {
    provenanceClass: 'derived',
    derivedFrom: { causalIdentity: 'causal-1', sourceId: 'cass:session-1', role: 'project_activity' },
  });
  assert.equal(result.status, 'deduped');
  assert.deepEqual(result.activity.receipt.evidenceRefs, ['cass:session-1', 'projects:activity-1']);
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 1);
});

test('same-looking observations without exact identity remain separate', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY });
  store.admit(receipt({ dedupeKey: 'causal-a', eventId: 'event-a' }));
  store.admit(receipt({ dedupeKey: 'causal-b', eventId: 'event-b' }));
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 2);
});

test('unattributed observations are quarantined and cannot assert a canonical project', () => {
  const stateDir = tmpDir();
  const store = new ActivityStore({ stateDir, now: () => NOW, admission: AUTHORITY });
  const result = store.observeUnattributed({
    observationId: 'obs-1',
    sourceId: 'cass:session-unknown',
    sourceRevision: 'rev-2',
    receivedAt: NOW,
    evidenceRefs: ['cass:session-unknown'],
    reason: 'mapping_ambiguous',
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 0);
  assert.equal(store.listUnattributed()[0].trust, 'unattributed');
  assert.throws(() => store.observeUnattributed({ observationId: 'bad', canonicalId: 'prj_000001', receivedAt: NOW }), /cannot carry canonicalId/);
  assert.equal((fs.statSync(path.join(stateDir, 'unattributed.jsonl')).mode & 0o777), 0o600);
});

test('legacy unattributed observations cannot be lost during a concurrent evidence rewrite', async () => {
  const stateDir = tmpDir();
  const controlDir = tmpDir();
  const activityStorePath = path.resolve(__dirname, '../src/activity-store.js');
  const providerContractsPath = path.resolve(__dirname, '../src/provider-contracts.js');
  const worker = `
    const fs = require('node:fs');
    const path = require('node:path');
    const { ActivityStore } = require(${JSON.stringify(activityStorePath)});
    const { createInferenceHostAuthority } = require(${JSON.stringify(providerContractsPath)});
    const role = process.argv[1];
    const stateDir = process.argv[2];
    const controlDir = process.argv[3];
    const now = '2026-08-10T12:00:00.000Z';
    const store = new ActivityStore({ stateDir, now: () => now, inferenceVerifier: createInferenceHostAuthority({
      producerId: 'notes-adapter', secret: 'inference-test-secret', allowedSourceClasses: ['note', 'chat'],
    }) });
    if (role === 'admitter') {
      const authority = createInferenceHostAuthority({
        producerId: 'notes-adapter', secret: 'inference-test-secret', allowedSourceClasses: ['note', 'chat'],
      });
      const envelope = authority.admitEvidenceUnit({
        contract: 'jarvos.project-inference-evidence/v1', observationId: 'obs_race', evidenceId: 'ev_race',
        sourceClass: 'note', occurredAt: now, observedAt: now, sourceRevision: 'note-rev-race',
        sensitivity: 'public-fixture', coverageState: 'fresh', contentDigest: 'a'.repeat(64),
      });
      const write = store._writeUnattributedRows.bind(store);
      store._writeUnattributedRows = (rows) => {
        fs.writeFileSync(path.join(controlDir, 'rewrite-ready'), 'ready');
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(path.join(controlDir, 'release'))) {
          if (Date.now() >= deadline) throw new Error('timed out waiting for release');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return write(rows);
      };
      store.admitUnattributedEvidence(envelope);
    } else {
      fs.writeFileSync(path.join(controlDir, 'observe-started'), 'started');
      store.observeUnattributed({
        observationId: 'legacy_race', sourceId: 'cass:session-race', sourceRevision: 'rev-race',
        receivedAt: now, evidenceRefs: ['cass:session-race'], reason: 'mapping_ambiguous',
      });
    }
  `;

  const admitter = runWorker(worker, 'admitter', stateDir, controlDir);
  await waitForFile(path.join(controlDir, 'rewrite-ready'));
  const observer = runWorker(worker, 'observer', stateDir, controlDir);
  await waitForFile(path.join(controlDir, 'observe-started'));
  fs.writeFileSync(path.join(controlDir, 'release'), 'release');
  const [admitterResult, observerResult] = await Promise.all([admitter, observer]);
  assert.equal(admitterResult.code, 0, admitterResult.stderr);
  assert.equal(observerResult.code, 0, observerResult.stderr);

  const rows = new ActivityStore({ stateDir }).listUnattributed();
  assert.deepEqual(rows.map((row) => row.observationId).sort(), ['legacy_race', 'obs_race']);
  assert.equal(rows.find((row) => row.evidenceId === 'ev_race')?.trust, 'admitted-inference');
});

test('occurrence-time query is bounded, cursorable, and returns a stable watermark', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, admission: AUTHORITY });
  store.admit(receipt({ eventId: 'event-1', dedupeKey: 'causal-1', occurredAt: '2026-08-09T10:00:00.000Z' }));
  store.admit(receipt({ eventId: 'event-2', dedupeKey: 'causal-2', occurredAt: '2026-08-10T10:00:00.000Z' }));
  const first = store.query({ from: '2026-08-09T00:00:00.000Z', to: NOW, limit: 1 });
  const second = store.query({ from: '2026-08-09T00:00:00.000Z', to: NOW, limit: 1, cursor: first.cursor });
  assert.equal(first.activities.length, 1);
  assert.equal(first.truncated, true);
  assert.equal(second.activities.length, 1);
  assert.notEqual(first.activities[0].id, second.activities[0].id);
  assert.equal(first.watermark, second.watermark);
});

test('state generations are owner-only and durable across reload', () => {
  const stateDir = tmpDir();
  const store = new ActivityStore({ stateDir, now: () => NOW, admission: AUTHORITY });
  store.admit(receipt());
  const reloaded = new ActivityStore({ stateDir, now: () => NOW });
  assert.equal(reloaded.generation, 1);
  assert.equal(reloaded.query({ from: NOW, to: NOW }).activities.length, 1);
  assert.equal((fs.statSync(path.join(stateDir, 'CURRENT')).mode & 0o777), 0o600);
  assert.ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(stateDir, 'CURRENT'))).digest('hex'));
});

test('admitted unresolved evidence requires an injected verifier and never writes canonical activity', () => {
  const stateDir = tmpDir();
  const unconfigured = new ActivityStore({ stateDir, now: () => NOW });
  assert.throws(() => unconfigured.admitUnattributedEvidence(admittedInference()), /inference.*verifier required/i);

  const store = new ActivityStore({ stateDir, now: () => NOW, inferenceVerifier: INFERENCE_AUTHORITY });
  const result = store.admitUnattributedEvidence(admittedInference(), {
    candidateId: 'cand_0123456789abcdef0123456789abcdef',
    decisionId: 'dec_0123456789abcdef0123456789abcdef',
    reason: 'identity_unresolved',
  });
  assert.equal(result.status, 'admitted');
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 0);
  assert.equal(store.listUnattributed().length, 1);
  assert.equal(store.listUnattributed()[0].candidateId, 'cand_0123456789abcdef0123456789abcdef');
  assert.equal(store.listUnattributed()[0].decisionId, 'dec_0123456789abcdef0123456789abcdef');
  assert.equal(store.listUnattributed()[0].reason, 'identity_unresolved');
  assert.equal(Object.prototype.hasOwnProperty.call(store.listUnattributed()[0], 'sourceContent'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(store.listUnattributed()[0], 'path'), false);
  assert.equal((fs.statSync(path.join(stateDir, 'unattributed.jsonl')).mode & 0o777), 0o600);
});

test('observeUnattributed recognizes only the versioned admitted envelope as the opt-in path', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW, inferenceVerifier: INFERENCE_AUTHORITY });
  const result = store.observeUnattributed(admittedInference(), { reasonCode: 'Identity_Unresolved' });
  assert.equal(result.status, 'admitted');
  assert.equal(result.observation.reason, 'identity_unresolved');
  assert.throws(() => store.observeUnattributed({
    ...admittedInference(),
    extra: 'raw transcript',
  }), /unsupported|invalid/i);
});

test('admitted unresolved evidence is idempotent across retries and restart, with digest conflicts quarantined', () => {
  const stateDir = tmpDir();
  const firstStore = new ActivityStore({ stateDir, now: () => NOW, inferenceVerifier: INFERENCE_AUTHORITY });
  const envelope = admittedInference();
  const first = firstStore.admitUnattributedEvidence(envelope, { reason: 'mapping_ambiguous' });
  assert.equal(first.status, 'admitted');
  const second = firstStore.admitUnattributedEvidence(envelope, { reason: 'different_retry_reason' });
  assert.equal(second.status, 'deduped');

  const reloaded = new ActivityStore({ stateDir, now: () => NOW, inferenceVerifier: INFERENCE_AUTHORITY });
  const restarted = reloaded.admitUnattributedEvidence(envelope, { reason: 'mapping_ambiguous' });
  assert.equal(restarted.status, 'deduped');

  const conflictAuthority = createInferenceHostAuthority({
    producerId: 'notes-adapter',
    secret: 'inference-test-secret',
    allowedSourceClasses: ['note', 'chat'],
  });
  const conflict = reloaded.admitUnattributedEvidence(admittedInference({ contentDigest: 'b'.repeat(64) }, conflictAuthority));
  assert.equal(conflict.status, 'quarantined');
  assert.match(conflict.reason, /conflict/i);
  assert.equal(reloaded.listUnattributed().length, 1);
});

test('admitted unresolved evidence retains source coverage modes and converges out of order', () => {
  const modes = ['unavailable', 'healthy-empty', 'partial'];
  const oneDir = tmpDir();
  const twoDir = tmpDir();
  const one = new ActivityStore({ stateDir: oneDir, now: () => NOW, inferenceVerifier: INFERENCE_AUTHORITY });
  const two = new ActivityStore({ stateDir: twoDir, now: () => NOW, inferenceVerifier: INFERENCE_AUTHORITY });
  const envelopes = modes.map((coverageState, index) => admittedInference({
    observationId: `obs_mode_${index}`,
    evidenceId: `ev_mode_${index}`,
    coverageState,
    contentDigest: coverageState === 'partial' ? 'c'.repeat(64) : null,
  }));
  for (const envelope of envelopes) one.admitUnattributedEvidence(envelope);
  for (const envelope of [...envelopes].reverse()) two.admitUnattributedEvidence(envelope);
  const summarize = (store) => store.listUnattributed().map((entry) => ({
    evidenceId: entry.evidenceId,
    coverageState: entry.coverageState,
  })).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  assert.deepEqual(summarize(one), summarize(two));
  assert.deepEqual(summarize(one).map((entry) => entry.coverageState), ['unavailable', 'healthy-empty', 'partial']);
});
