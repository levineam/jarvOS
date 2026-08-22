'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const contracts = require('../src/project-inference-contracts');
const ledgerModule = require('../src/project-inference-ledger');

const DIGEST = 'b'.repeat(64);

function evidence(id, observedAt, overrides = {}) {
  return contracts.createEvidenceUnit({
    evidenceId: id,
    observationId: `obs_${id.slice(3)}`,
    sourceClass: 'note',
    occurredAt: observedAt,
    observedAt,
    sourceRevision: 'note-r1',
    sensitivity: 'public-fixture',
    coverageState: 'fresh',
    contentDigest: DIGEST,
    ...overrides,
  });
}

test('memory ledger is owner-only, append-only, idempotent, and conflicts on reused IDs', () => {
  const ledger = ledgerModule.createMemoryInferenceLedger();
  const first = ledger.appendEvidence(evidence('ev_001', '2026-08-01T00:00:00.000Z'));
  const duplicate = ledger.appendEvidence(evidence('ev_001', '2026-08-01T00:00:00.000Z'));
  assert.equal(first.status, 'appended');
  assert.equal(duplicate.status, 'duplicate');
  assert.deepEqual(first.event, duplicate.event);
  assert.throws(() => ledger.appendEvidence(evidence('ev_001', '2026-08-02T00:00:00.000Z')), /conflict|digest/i);
  assert.throws(() => ledgerModule.createMemoryInferenceLedger({ mode: 'public' }), /owner-only|owner mode/i);
  assert.throws(() => ledgerModule.createMemoryInferenceLedger({ root: '/tmp/not-memory' }), /memory.*persistence/i);
  assert.throws(() => ledgerModule.createFileInferenceLedger(), /file.*requires/i);
  assert.equal(ledger.listEvents().length, 1);
});

test('reordered replay converges to deterministic events, coverage, and latest watermarks', () => {
  const one = evidence('ev_001', '2026-08-01T00:00:00.000Z');
  const two = evidence('ev_002', '2026-08-02T00:00:00.000Z', { sourceClass: 'chat', sourceRevision: 'chat-r2' });
  const first = ledgerModule.createMemoryInferenceLedger();
  const second = ledgerModule.createMemoryInferenceLedger();
  first.replay([one, two]);
  second.replay([two, one]);
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.deepEqual(first.latestWatermarks(), second.latestWatermarks());
  assert.equal(first.latestWatermarks().note.evidenceId, 'ev_001');
  assert.equal(first.latestWatermarks().chat.evidenceId, 'ev_002');
  assert.equal(first.latestWatermarks().note.state, 'fresh');
  first.appendEvidence(evidence('ev_003', '2026-08-03T00:00:00.000Z', { sourceClass: 'release', coverageState: 'healthy-empty' }));
  assert.equal(first.latestWatermarks().release.state, 'healthy-empty');
});

test('file ledger survives restart and keeps an unavailable source distinct from healthy-empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inference-ledger-'));
  try {
    const first = ledgerModule.createFileInferenceLedger({ root });
    first.appendEvidence(evidence('ev_unavailable', '2026-08-04T00:00:00.000Z', {
      sourceClass: 'chat', coverageState: 'unavailable', contentDigest: null,
    }));
    first.appendEvidence(evidence('ev_empty', '2026-08-04T00:00:00.000Z', {
      sourceClass: 'release', coverageState: 'healthy-empty', contentDigest: null,
    }));
    const second = ledgerModule.createFileInferenceLedger({ root });
    assert.deepEqual(second.snapshot(), first.snapshot());
    assert.equal(second.latestWatermarks().chat.state, 'unavailable');
    assert.equal(second.latestWatermarks().release.state, 'healthy-empty');
    assert.match(fs.readFileSync(path.join(root, 'inference-events.jsonl'), 'utf8'), /\n/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file replay refreshes the append-only ledger once for a batch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inference-ledger-batch-'));
  try {
    const ledger = ledgerModule.createFileInferenceLedger({ root });
    const readDisk = ledger._readDisk.bind(ledger);
    let reads = 0;
    ledger._readDisk = () => { reads += 1; return readDisk(); };
    const result = ledger.replay([
      evidence('ev_batch_1', '2026-08-04T00:00:00.000Z'),
      evidence('ev_batch_2', '2026-08-05T00:00:00.000Z'),
    ]);
    assert.deepEqual(result.map((entry) => entry.status), ['appended', 'appended']);
    assert.equal(reads, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file ledger repairs and enforces owner-only modes after reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inference-ledger-modes-'));
  const filePath = path.join(root, 'inference-events.jsonl');
  try {
    const first = ledgerModule.createFileInferenceLedger({ root });
    first.appendEvidence(evidence('ev_modes', '2026-08-05T00:00:00.000Z'));
    fs.chmodSync(root, 0o755);
    fs.chmodSync(filePath, 0o644);
    const reopened = ledgerModule.createFileInferenceLedger({ root });
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(reopened.size, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file ledger does not retain an append when durable write fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inference-ledger-failure-'));
  const originalWriteFileSync = fs.writeFileSync;
  try {
    const ledger = ledgerModule.createFileInferenceLedger({ root });
    fs.writeFileSync = function failDataAppend(fd, data, ...rest) {
      if (typeof fd === 'number' && typeof data === 'string' && data.includes('"eventType":"evidence"')) {
        throw new Error('simulated durable append failure');
      }
      return originalWriteFileSync.call(this, fd, data, ...rest);
    };
    assert.throws(() => ledger.appendEvidence(evidence('ev_failed', '2026-08-06T00:00:00.000Z')), /durable append failure/);
    assert.equal(ledger.size, 0);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ledger never accepts a registry payload or writes outside its owned root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inference-ledger-owner-'));
  try {
    const ledger = ledgerModule.createFileInferenceLedger({ root });
    assert.throws(() => ledger.append({ eventType: 'registry', payload: { generation: 1 } }), /eventType|unsupported|registry/i);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name !== 'inference-events.jsonl'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
