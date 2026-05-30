'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  ARTICLE_THREAD_KIND,
  CODE_THREAD_KIND,
  SESSION_STATE_SCHEMA_VERSION,
  buildArticleThreadCheckpoint,
  buildCodeThreadCheckpoint,
  buildLiveArtifactPointer,
  buildSessionCheckpoint,
  createFileSessionStateStore,
  createMemorySessionStateStore,
  readJarvosSessionState,
  writeJarvosSessionState,
} = require('../src/index.js');

test('live artifact pointers reject copied snapshots', () => {
  assert.deepEqual(buildLiveArtifactPointer({
    kind: 'paperclip-issue',
    issueIdentifier: 'SUP-2214',
  }), {
    kind: 'paperclip-issue',
    ref: 'SUP-2214',
    issueIdentifier: 'SUP-2214',
    path: null,
    branch: null,
    url: null,
  });

  assert.throws(() => buildLiveArtifactPointer({
    kind: 'markdown',
    path: '/notes/draft.md',
    markdown: '# copied snapshot',
  }), /pointers, not snapshots/);
});

test('session checkpoints share a generic shape for code and article work', () => {
  const sharedIssue = buildSessionCheckpoint({
    kind: 'article-thread',
    issueIdentifier: 'SUP-2214',
    stage: 'draft-section',
    nextStep: 'holisticReview',
    artifact: { kind: 'markdown', ref: 'vault:article-draft', path: '/notes/article-draft.md' },
  });

  assert.equal(sharedIssue.kind, ARTICLE_THREAD_KIND);
  assert.equal(sharedIssue.codeThread.nextStep, 'holisticReview');
  assert.equal(buildArticleThreadCheckpoint({
    issueIdentifier: 'SUP-2214',
    stage: 'draft-section',
    nextStep: 'holisticReview',
  }).kind, ARTICLE_THREAD_KIND);
  assert.equal(buildCodeThreadCheckpoint({
    issueIdentifier: 'SUP-2214',
    stage: 'claim',
    nextStep: 'branch',
  }).kind, CODE_THREAD_KIND);
});

test('memory session state checkpoints only the thin code thread', async () => {
  const store = createMemorySessionStateStore();
  const checkpoint = buildCodeThreadCheckpoint({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/jarvos-coding-host-adapters',
    stage: 'holisticReview',
    lastDecision: 'accepted-findings-fixed',
    nextStep: 'fixRerun',
  });

  assert.equal(checkpoint.schemaVersion, SESSION_STATE_SCHEMA_VERSION);
  assert.equal(checkpoint.kind, CODE_THREAD_KIND);
  assert.deepEqual(checkpoint.codeThread, {
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/jarvos-coding-host-adapters',
    stage: 'holisticReview',
    lastDecision: 'accepted-findings-fixed',
    nextStep: 'fixRerun',
  });

  await writeJarvosSessionState(store, checkpoint);
  const read = await readJarvosSessionState(store);

  assert.equal(read.schemaVersion, SESSION_STATE_SCHEMA_VERSION);
  assert.deepEqual(read.state, checkpoint);
  assert.equal(read.liveArtifact.kind, 'paperclip-issue');
  assert.equal(read.liveArtifact.issueIdentifier, 'SUP-2214');
});

test('file session state survives process boundaries', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-session-state-'));
  const store = createFileSessionStateStore(path.join(tmpDir, 'session-state.json'));
  const checkpoint = buildCodeThreadCheckpoint({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/file-backed-session',
    stage: 'branch',
    nextStep: 'sliceReview',
  });

  await writeJarvosSessionState(store, checkpoint);
  const read = await readJarvosSessionState(store);

  assert.deepEqual(read.state, checkpoint);
  assert.deepEqual(read.liveArtifact, {
    kind: 'paperclip-issue',
    ref: 'SUP-2214',
    issueIdentifier: 'SUP-2214',
    path: null,
    branch: 'SUP-2214/file-backed-session',
    url: null,
  });
});
