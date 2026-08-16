'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ATTENTION_SCHEMA_VERSION,
  durableHoldStatus,
  reconcileAttention,
  redactedAttention,
} = require('../src/attention');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-attention-'));
}

function statusWith(skills) {
  return { skills };
}

test('redactedAttention keeps only actionable items with reason codes for durable status', () => {
  const items = redactedAttention(statusWith([
    {
      logicalId: 'private-a',
      attention: 'actionable',
      disposition: { reasonCode: 'unsafe_source' },
    },
    {
      logicalId: 'quiet-b',
      attention: 'quiet',
      disposition: { reasonCode: 'rule_proven_portable' },
    },
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].logicalId, 'private-a');
  assert.equal(items[0].reasonCode, 'unsafe_source');
  assert.ok(items[0].fingerprint);
});

test('reconcileAttention records first-seen on raise and stays a no-op on healthy replay', () => {
  const root = tempDir();
  const attentionPath = path.join(root, 'attention.json');
  fs.chmodSync(root, 0o700);

  const first = reconcileAttention({
    attentionPath,
    observedAt: '2026-08-16T12:00:00.000Z',
    status: statusWith([
      {
        logicalId: 'private-a',
        attention: 'actionable',
        disposition: { reasonCode: 'unsafe_source' },
      },
    ]),
  });
  assert.equal(first.wrote, true);
  assert.equal(first.raised.length, 1);
  assert.equal(first.raised[0].occurrenceCount, 1);
  assert.equal(first.raised[0].firstSeenAt, '2026-08-16T12:00:00.000Z');
  assert.equal(first.durableStatus[0].reasonCode, 'unsafe_source');
  assert.equal(first.durableStatus[0].occurrenceCount, 1);

  const second = reconcileAttention({
    attentionPath,
    observedAt: '2026-08-16T13:00:00.000Z',
    status: statusWith([
      {
        logicalId: 'private-a',
        attention: 'actionable',
        disposition: { reasonCode: 'unsafe_source' },
      },
    ]),
  });
  assert.equal(second.raised.length, 0);
  assert.equal(second.resolved.length, 0);
  assert.equal(second.wrote, false);
  assert.equal(second.replay, true);
  assert.equal(second.durableStatus[0].occurrenceCount, 1);
  assert.equal(second.durableStatus[0].firstSeenAt, '2026-08-16T12:00:00.000Z');

  const stored = JSON.parse(fs.readFileSync(attentionPath, 'utf8'));
  assert.equal(stored.schemaVersion, ATTENTION_SCHEMA_VERSION);
  assert.equal(stored.active[0].firstSeenAt, '2026-08-16T12:00:00.000Z');
});

test('resolve transitions clear active holds while retaining reason codes on the transition', () => {
  const root = tempDir();
  const attentionPath = path.join(root, 'attention.json');
  fs.chmodSync(root, 0o700);

  reconcileAttention({
    attentionPath,
    observedAt: '2026-08-16T12:00:00.000Z',
    status: statusWith([
      {
        logicalId: 'private-a',
        attention: 'actionable',
        disposition: { reasonCode: 'unsafe_source' },
      },
    ]),
  });

  const resolved = reconcileAttention({
    attentionPath,
    observedAt: '2026-08-16T14:00:00.000Z',
    status: statusWith([]),
  });
  assert.equal(resolved.resolved.length, 1);
  assert.equal(resolved.resolved[0].reasonCode, 'unsafe_source');
  assert.equal(resolved.durableStatus.length, 0);
});

test('durableHoldStatus groups by reason with first-seen and occurrence count', () => {
  const summary = durableHoldStatus([
    {
      reasonCode: 'unsafe_source',
      firstSeenAt: '2026-08-16T10:00:00.000Z',
      fingerprint: 'a',
      occurrenceCount: 1,
    },
    {
      reasonCode: 'unsafe_source',
      firstSeenAt: '2026-08-16T11:00:00.000Z',
      fingerprint: 'b',
      occurrenceCount: 1,
    },
    {
      reasonCode: 'privacy_restricted',
      firstSeenAt: '2026-08-16T12:00:00.000Z',
      fingerprint: 'c',
      occurrenceCount: 1,
    },
  ]);
  assert.equal(summary.length, 2);
  const unsafe = summary.find((entry) => entry.reasonCode === 'unsafe_source');
  assert.equal(unsafe.occurrenceCount, 2);
  assert.equal(unsafe.firstSeenAt, '2026-08-16T10:00:00.000Z');
  assert.equal(unsafe.fingerprintCount, 2);
});
