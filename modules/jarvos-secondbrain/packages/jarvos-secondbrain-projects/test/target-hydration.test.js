'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OMISSION_CODES, TARGET_HYDRATION_CONTRACT, assessTargetHydration } = require('../src/target-hydration');

const KEY = `dwe_${'a'.repeat(32)}`;
const OTHER = `dwe_${'b'.repeat(32)}`;

function record(id, parentId = null, title = `Record ${id}`) {
  return { id, kind: 'project', title, parentId, revision: 1 };
}

function packet({ scope = { projectIds: ['prj_000001'], outcomeIds: [], includeDescendants: true }, records = [record('prj_000001')], activity = [], truncation, providerState = 'fresh', generation = 5 } = {}) {
  return {
    status: 'ok',
    packet: {
      packetId: `ctx_${'0'.repeat(32)}`,
      query: { scope, include: ['hierarchy', 'activity'], limits: { maxItems: 10, maxBytes: 20000, maxProviderAgeSeconds: 3600 } },
      canonical: { generation, records, revisions: {} },
      activity,
      currentWork: [],
      attention: [],
      evidence: [],
      inference: { candidates: [] },
      providers: { activity: { state: providerState } },
      truncation: truncation || { truncated: false, maxItems: 10, maxBytes: 20000, omittedItems: 0, sections: [] },
    },
  };
}

const activity = (id, canonicalId = 'prj_000001') => ({ id, canonicalId, category: 'activity', canonicalAtAdmission: null });

test('present target with its expected activity reports no omissions', () => {
  const result = assessTargetHydration({ targetId: 'prj_000001', result: packet({ activity: [activity(KEY)] }), expected: [{ causalKey: KEY }] });
  assert.equal(result.contract, TARGET_HYDRATION_CONTRACT);
  assert.equal(result.status, 'present');
  assert.deepEqual(result.omissions, []);
  assert.deepEqual(result.presentCausalKeys, [KEY]);
  assert.match(result.assessmentDigest, /^[a-f0-9]{64}$/);
});

test('every omission code is typed and reachable', () => {
  const found = new Set();
  const collect = (result) => { for (const entry of result.omissions) found.add(entry.code); return result; };
  assert.equal(collect(assessTargetHydration({ targetId: 'prj_000002', result: packet(), expected: [{ causalKey: KEY }] })).status, 'omitted');
  collect(assessTargetHydration({ targetId: 'prj_000001', result: packet({ activity: [activity(KEY)] }), expected: [{ causalKey: KEY }], expectedGeneration: 6 }));
  collect(assessTargetHydration({
    targetId: 'prj_000001',
    result: packet({ scope: { projectIds: [], outcomeIds: [], includeDescendants: true }, records: [], truncation: { truncated: true, maxItems: 1, maxBytes: 20000, omittedItems: 4, sections: ['canonical.records'] } }),
  }));
  collect(assessTargetHydration({ targetId: 'prj_000001', result: { status: 'unavailable', code: 'CONTEXT_BUDGET_TOO_SMALL' } }));
  collect(assessTargetHydration({
    targetId: 'prj_000001', result: packet(), expected: [{ causalKey: OTHER, occurredAt: '2020-01-01T00:00:00.000Z' }],
    activityWindow: { from: '2026-09-22T00:00:00.000Z', to: '2026-09-24T00:00:00.000Z' },
  }));
  collect(assessTargetHydration({ targetId: 'prj_000001', result: packet(), rendered: { text: '## Projects Context\n', markers: ['Record prj_000001'] } }));
  collect(assessTargetHydration({ targetId: 'prj_000001', result: packet({ providerState: 'unavailable' }), expected: [{ causalKey: KEY }] }));
  collect(assessTargetHydration({ targetId: null, result: packet() }));
  assert.deepEqual([...found].sort(), [...OMISSION_CODES].sort());
});

test('item and byte truncation are distinguished from the packet truncation counts', () => {
  const itemOnly = assessTargetHydration({
    targetId: 'prj_000001', result: packet({ scope: { projectIds: [], outcomeIds: [], includeDescendants: true }, records: [record('prj_000003')], truncation: { truncated: true, maxItems: 1, maxBytes: 20000, omittedItems: 3, sections: ['canonical.records'] } }),
  });
  assert.deepEqual(itemOnly.omissions.map((entry) => entry.code), ['item_limit']);
  const byteOnly = assessTargetHydration({
    targetId: 'prj_000001', result: packet({ scope: { projectIds: [], outcomeIds: [], includeDescendants: true }, records: [record('prj_000003')], truncation: { truncated: true, maxItems: 10, maxBytes: 600, omittedItems: 2, sections: ['canonical.records'] } }),
  });
  assert.deepEqual(byteOnly.omissions.map((entry) => entry.code), ['byte_limit']);
});

test('generation mismatch on a failed roster/packet is typed rather than generic', () => {
  const result = assessTargetHydration({ targetId: 'prj_000001', result: { status: 'unavailable', code: 'ROSTER_GENERATION_MISMATCH' } });
  assert.deepEqual(result.omissions, [{ code: 'generation_mismatch', subject: 'packet' }]);
  assert.equal(result.status, 'omitted');
});

test('a descendant is in scope only through ancestry the packet itself proves', () => {
  const scoped = packet({ records: [record('prj_000001'), record('prj_000004', 'prj_000001')], activity: [activity(KEY, 'prj_000004')] });
  assert.equal(assessTargetHydration({ targetId: 'prj_000004', result: scoped, expected: [{ causalKey: KEY }] }).status, 'present');
  const notDescendant = assessTargetHydration({ targetId: 'prj_000009', result: scoped });
  assert.deepEqual(notDescendant.omissions, [{ code: 'scope', subject: 'record' }]);
});

test('rejects malformed expectations rather than silently ignoring them', () => {
  assert.throws(() => assessTargetHydration({ targetId: 'prj_000001', result: packet(), expected: [{ causalKey: 'raw-key' }] }), /causalKey/);
  assert.throws(() => assessTargetHydration({ targetId: '/tmp/prj', result: packet() }), /targetId/);
});
