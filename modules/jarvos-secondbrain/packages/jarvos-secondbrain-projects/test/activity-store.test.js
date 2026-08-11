'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ActivityStore } = require('../src/activity-store');
const { createHostAdmission } = require('../src/provider-contracts');

const NOW = '2026-08-10T12:00:00.000Z';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-activity-store-')); }

function receipt({ eventId = 'event-1', dedupeKey = 'causal-1', occurredAt = NOW, evidenceRefs = ['note:rev-1'] } = {}) {
  const base = {
    contract: 'jarvos.verified-activity/v1',
    eventId,
    canonicalId: 'prj_000001',
    producerId: 'notes',
    kind: 'note_revision',
    occurredAt,
    observedAt: NOW,
    evidenceRefs,
    sourceRevision: 'rev-1',
    sensitivity: 'private',
    dedupeKey,
  };
  return createHostAdmission({ producerId: 'notes', secret: 'activity-test-secret', allowedKinds: ['note_revision'] }).admitVerifiedReceipt(base);
}

test('admits a verified receipt once and replays it by exact causal identity', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW });
  const first = store.admit(receipt());
  assert.equal(first.status, 'admitted');
  const second = store.admit(receipt({ eventId: 'event-1-retry' }));
  assert.equal(second.status, 'deduped');
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 1);
  assert.equal(store.generation, 2);
});

test('exact derived identity collapses direct and derived evidence while preserving refs', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW });
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
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW });
  store.admit(receipt({ dedupeKey: 'causal-a', eventId: 'event-a' }));
  store.admit(receipt({ dedupeKey: 'causal-b', eventId: 'event-b' }));
  assert.equal(store.query({ from: NOW, to: NOW }).activities.length, 2);
});

test('unattributed observations are quarantined and cannot assert a canonical project', () => {
  const stateDir = tmpDir();
  const store = new ActivityStore({ stateDir, now: () => NOW });
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

test('occurrence-time query is bounded, cursorable, and returns a stable watermark', () => {
  const store = new ActivityStore({ stateDir: tmpDir(), now: () => NOW });
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
  const store = new ActivityStore({ stateDir, now: () => NOW });
  store.admit(receipt());
  const reloaded = new ActivityStore({ stateDir, now: () => NOW });
  assert.equal(reloaded.generation, 1);
  assert.equal(reloaded.query({ from: NOW, to: NOW }).activities.length, 1);
  assert.equal((fs.statSync(path.join(stateDir, 'CURRENT')).mode & 0o777), 0o600);
  assert.ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(stateDir, 'CURRENT'))).digest('hex'));
});
