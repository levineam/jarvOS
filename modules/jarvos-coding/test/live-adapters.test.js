'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  buildLiveCodingAdapters,
  createLiveFixer,
  createLivePaperclipTracker,
  createLivePostMergeSweep,
  createLivePullRequest,
} = require('../src/index.js');

test('public package declares a registry-safe control-plane dependency', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.dependencies['@jarvos/control-plane'], '0.1.0');
  assert.doesNotMatch(manifest.dependencies['@jarvos/control-plane'], /^(file:|link:)/);
});

test('buildLiveCodingAdapters() constructs without clawd present (lazy clawd require)', () => {
  // In the public package clawd scripts are absent. Construction must NOT require
  // them — only actual live method calls do. Regression for premature clawd require.
  const adapters = buildLiveCodingAdapters();
  assert.ok(adapters.tracker, 'tracker built');
  assert.ok(adapters.postMerge, 'postMerge built');
  assert.ok(adapters.reviewEngine && typeof adapters.reviewEngine.sliceReview === 'function');
  assert.ok(adapters.git && adapters.fixer && adapters.pullRequest);
});

test('pre-PR fixer records real post-fix cleanliness and an explicit no-test rationale', async () => {
  const calls = [];
  const fixer = createLiveFixer({
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const result = await fixer.fixAndRerun({
    branch: 'SUP-3470/public-jarvos-coding',
    worktreeDir: '/tmp/SUP-3470',
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reasonCode, 'pre_pr_no_fix_context');
  assert.deepEqual(result.git, {
    clean: true,
    status: 'clean',
    worktreePath: '/tmp/SUP-3470',
    exitCode: 0,
  });
  assert.deepEqual(calls[0].args, ['status', '--porcelain']);
  assert.equal(calls[0].options.cwd, '/tmp/SUP-3470');
});

test('pre-PR fixer fails cleanliness closed when the post-fix worktree is dirty', async () => {
  const fixer = createLiveFixer({
    run: () => ({ status: 0, stdout: ' M src/index.js\n', stderr: '' }),
  });
  const result = await fixer.fixAndRerun({
    branch: 'SUP-3470/public-jarvos-coding',
    worktreeDir: '/tmp/SUP-3470',
  });
  assert.equal(result.git.clean, false);
  assert.equal(result.git.status, 'dirty');
});

test('PR-scoped fixer attaches post-fix git cleanliness to a successful primary pass', async () => {
  const fixer = createLiveFixer({
    primaryFixPass: () => ({ status: 'passed' }),
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const result = await fixer.fixAndRerun({
    branch: 'SUP-3470/public-jarvos-coding',
    worktreeDir: '/tmp/SUP-3470',
    pullRequest: { number: 112, headRefName: 'SUP-3470/public-jarvos-coding' },
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.git.clean, true);
  assert.equal(result.git.worktreePath, '/tmp/SUP-3470');
});

test('live PR adapter revalidates a merged reattachment by number after branch deletion', async () => {
  const calls = [];
  const adapter = createLivePullRequest({
    repo: 'levineam/jarVOS',
    run(command, args) {
      calls.push([command, args]);
      assert.deepEqual(args.slice(0, 3), ['pr', 'view', '112']);
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 112,
          url: 'https://github.com/levineam/jarVOS/pull/112',
          title: 'Coding compatibility',
          state: 'MERGED',
          headRefName: 'SUP-3470/public-jarvos-coding',
        }),
        stderr: '',
      };
    },
  });

  const result = await adapter.openPullRequest({
    branch: 'SUP-3470/public-jarvos-coding',
    existingPullRequest: { number: 112 },
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.state, 'MERGED');
  assert.equal(result.liveConfirmed, true);
  assert.equal(result.reattached, true);
  assert.equal(calls.length, 1);
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
