'use strict';
const assert = require('node:assert/strict'); const test = require('node:test');
const { createSchedulerAdapter } = require('../src');
test('scheduler adapter is truthful when unsupported and requires acknowledgement when registered', () => {
  assert.equal(createSchedulerAdapter({ platform: 'win32' }).register({ id: 'x' }).status, 'scheduler_unsupported');
  const calls = []; const adapter = createSchedulerAdapter({ platform: 'darwin', launchd: { register(job) { calls.push(job); return { status: 'registered', jobId: job.id, nextRun: '2026-08-15T00:00:00Z' }; }, remove() { return { status: 'removed' }; } } });
  const receipt = adapter.register({ id: 'jarvos-shared-skills', operation: 'repair' });
  assert.equal(receipt.status, 'registered'); assert.equal(calls[0].operation, 'repair'); assert.equal(adapter.remove('jarvos-shared-skills').status, 'removed');
});
