'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  buildLiveCodingAdapters,
  createLivePaperclipTracker,
  createLivePostMergeSweep,
} = require('../src/index.js');

test('buildLiveCodingAdapters() constructs without clawd present (lazy clawd require)', () => {
  // In the public package clawd scripts are absent. Construction must NOT require
  // them — only actual live method calls do. Regression for premature clawd require.
  const adapters = buildLiveCodingAdapters();
  assert.ok(adapters.tracker, 'tracker built');
  assert.ok(adapters.postMerge, 'postMerge built');
  assert.ok(adapters.reviewEngine && typeof adapters.reviewEngine.sliceReview === 'function');
  assert.ok(adapters.git && adapters.fixer && adapters.pullRequest);
});

test('live tracker defers close until there is merge evidence', async () => {
  const tracker = createLivePaperclipTracker({
    prLink: {
      getIssueByIdentifier: () => ({ id: 'x', status: 'in_progress' }),
      transitionIssue: () => {
        throw new Error('must not transition an unmerged issue to done');
      },
    },
  });

  const open = await tracker.verifyAndClose({ issueIdentifier: 'SUP-1', pullRequest: { state: 'OPEN' } });
  assert.equal(open.status, 'deferred');
  assert.equal(open.ok, true);
  assert.match(open.reason, /not merged/);
});

test('live tracker closes once merge evidence is present', async () => {
  const transitions = [];
  const tracker = createLivePaperclipTracker({
    prLink: {
      getIssueByIdentifier: () => ({ id: 'x', status: 'in_progress' }),
      transitionIssue: (identifier, status) => {
        transitions.push([identifier, status]);
        return { ok: true };
      },
    },
  });

  const merged = await tracker.verifyAndClose({ issueIdentifier: 'SUP-1', pullRequest: { state: 'MERGED' } });
  assert.equal(merged.status, 'closed');
  assert.deepEqual(transitions, [['SUP-1', 'done']]);
});

test('post-merge sweep no-ops on an unmerged PR', async () => {
  const sweep = createLivePostMergeSweep({
    prLink: { onPRMerged: () => { throw new Error('must not sweep an unmerged PR'); } },
    repo: 'levineam/jarvOS',
  });
  const result = await sweep.sweep({ pullRequest: { number: 70, state: 'OPEN' } });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /not merged/);
});
