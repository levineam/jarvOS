'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  lintOperatorMessage,
  lintOperatorMessages,
} = require('../src/index.js');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'operator-notification-lint');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8').trim();
}

test('accepts concise no-action and action-required messages', () => {
  const noAction = lintOperatorMessage(
    'Skill sync finished cleanly. jarvOS recorded the healthy run. No action needed. Next automatic check stays on schedule.',
  );
  assert.equal(noAction.ok, true, noAction.errors.join('\n'));

  const action = lintOperatorMessage(
    'Shared skill repair paused on a machine-wide inventory hold. jarvOS left local files unchanged. Please reply with approve-inventory or keep-hold. jarvOS will stay paused until you choose.',
  );
  assert.equal(action.ok, true, action.errors.join('\n'));
});

test('rejects raw codes, paths, stacks, and ambiguous actions', () => {
  const code = lintOperatorMessage('skill_sync_failed and needs attention');
  assert.equal(code.ok, false);
  assert.ok(code.errors.some((error) => error.startsWith('raw_internal_code:')));

  const filePath = lintOperatorMessage('Repair failed under /Users/andrew/clawd/skills/secret. Please restart the agent.');
  assert.equal(filePath.ok, false);
  assert.ok(filePath.errors.some((error) => error.startsWith('absolute_path:')));

  const stack = lintOperatorMessage('Error: boom\n    at run (/tmp/x.js:1:1)\nPlease restart the agent.');
  assert.equal(stack.ok, false);
  assert.ok(stack.errors.includes('stack_like_text'));

  const ambiguous = lintOperatorMessage('jarvOS skill sync needs attention.');
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.errors.includes('ambiguous_action') || ambiguous.errors.includes('missing_action_guidance'));
});

test('release-monitor authoring fixtures reject conflation, bare commits, and false publication failures', () => {
  const badConflate = readFixture('release-bad-conflated.txt');
  const badCommit = readFixture('release-bad-bare-commit.txt');
  const badFuture = readFixture('release-bad-future-failure.txt');
  const badStale = readFixture('release-bad-stale-current.txt');
  const good = readFixture('release-good-ae5.txt');

  assert.equal(lintOperatorMessage(badConflate, { mode: 'release' }).ok, false);
  assert.equal(lintOperatorMessage(badCommit, { mode: 'release' }).ok, false);
  assert.ok(lintOperatorMessage(badCommit, { mode: 'release' }).errors.includes('bare_commit')
    || lintOperatorMessage(badCommit, { mode: 'release' }).errors.includes('bare_commit_in_release_text'));
  assert.ok(lintOperatorMessage(badFuture, { mode: 'release' }).errors.includes('future_lane_marked_publication_failure'));
  assert.ok(lintOperatorMessage(badStale, { mode: 'release' }).errors.includes('current_or_ready_from_stale_observation'));

  const goodResult = lintOperatorMessage(good, { mode: 'release' });
  assert.equal(goodResult.ok, true, goodResult.errors.join('\n'));
});

test('batch helper reports per-message errors', () => {
  const batch = lintOperatorMessages([
    { id: 'ok', text: 'Recovery finished. jarvOS restored the last good projection. No action needed. Next scan runs on the hour.' },
    { id: 'bad', text: 'inventory_incomplete needs attention' },
  ]);
  assert.equal(batch.ok, false);
  assert.equal(batch.results[0].ok, true);
  assert.equal(batch.results[1].ok, false);
});
