'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  createMemoryStore,
} = require('../src/index.js');

test('compare-and-set lease grants one current holder for one mutation resource', async () => {
  const store = createMemoryStore();
  const attempts = await Promise.all([
    Promise.resolve().then(() => store.acquireLease({ key: 'machine:repo:cleanup', holder: 'command-a' })),
    Promise.resolve().then(() => store.acquireLease({ key: 'machine:repo:cleanup', holder: 'command-b' })),
  ]);

  const winners = attempts.filter((attempt) => attempt.ok);
  const conflicts = attempts.filter((attempt) => !attempt.ok);
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'lease_conflict');
  assert.equal(conflicts[0].holder, winners[0].lease.holder);
});

test('independent resources acquire leases without global serialization', async () => {
  const store = createMemoryStore();
  const attempts = await Promise.all([
    Promise.resolve().then(() => store.acquireLease({ key: 'machine:repo-a:cleanup', holder: 'command-a' })),
    Promise.resolve().then(() => store.acquireLease({ key: 'machine:repo-b:cleanup', holder: 'command-b' })),
  ]);

  assert.equal(attempts.every((attempt) => attempt.ok), true);
  assert.notEqual(attempts[0].lease.key, attempts[1].lease.key);
  assert.equal(attempts[0].lease.fence, 1);
  assert.equal(attempts[1].lease.fence, 1);
});
