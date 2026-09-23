'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DURABLE_WORK_CONFORMANCE_CONTRACT, loadFixtures, runDurableWorkConformance } = require('../src/durable-work-conformance');
const { EVENT_KINDS, receiptKind } = require('../src/durable-work-event');
const { OMISSION_CODES } = require('../src/target-hydration');
const { createHostAdmission } = require('../src/provider-contracts');

function workDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-durable-work-conformance-')); }

const REQUIRED_CASES = [
  'signed_admission', 'generation_guard', 'identical_replay_noop', 'evidence_merge_advances', 'causal_conflict_quarantined',
  'unsigned_rejected', 'wrong_producer_rejected', 'binding_unmapped', 'binding_shared_unqualified', 'binding_shared_branch_qualified',
  'binding_ambiguous_duplicate', 'binding_linked_worktree_equivalence', 'reject_causal_key_mismatch',
  ...OMISSION_CODES.map((code) => `omission_${code}`),
];

test('the public fixture adapter passes every durable-work conformance case', () => {
  const receipt = runDurableWorkConformance({ workDir: workDir() });
  assert.equal(receipt.contract, DURABLE_WORK_CONFORMANCE_CONTRACT);
  const failed = receipt.cases.filter((entry) => entry.status !== 'pass');
  assert.deepEqual(failed, []);
  assert.equal(receipt.status, 'pass');
  const ids = new Set(receipt.cases.map((entry) => entry.id));
  for (const id of REQUIRED_CASES) assert.ok(ids.has(id), id);
  for (const redaction of loadFixtures().redactionCases) assert.ok(ids.has(redaction.id), redaction.id);
});

test('an adapter-supplied host admission and producer run the same cases', () => {
  const producerId = 'adapter.durable-work-collector';
  const admission = createHostAdmission({ producerId, secret: 'adapter-secret', allowedKinds: EVENT_KINDS.map(receiptKind) });
  const receipt = runDurableWorkConformance({ workDir: workDir(), admission, producerId });
  assert.equal(receipt.producerId, producerId);
  assert.equal(receipt.status, 'pass', JSON.stringify(receipt.cases.filter((entry) => entry.status !== 'pass')));
});

test('an adapter that admits any kind is still bound by the replay and conflict cases', () => {
  const producerId = 'adapter.permissive';
  const admission = createHostAdmission({ producerId, secret: 'adapter-secret' });
  const receipt = runDurableWorkConformance({ workDir: workDir(), admission, producerId });
  assert.equal(receipt.cases.find((entry) => entry.id === 'identical_replay_noop').status, 'pass');
  assert.equal(receipt.cases.find((entry) => entry.id === 'causal_conflict_quarantined').status, 'pass');
});

test('the conformance receipt is metadata-only', () => {
  const dir = workDir();
  const serialized = JSON.stringify(runDurableWorkConformance({ workDir: dir }));
  assert.equal(serialized.includes(dir), false);
  assert.equal(/https?:\/\/|\/Users\/|secret/i.test(serialized), false);
  assert.throws(() => runDurableWorkConformance({ workDir: 'relative/dir' }), /absolute/);
});
