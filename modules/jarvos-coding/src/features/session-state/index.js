'use strict';

const SESSION_STATE_SCHEMA_VERSION = 'jarvos-session-state/v1';
const ARTICLE_THREAD_KIND = 'article-thread';
const ARTICLE_SESSION_KIND = ARTICLE_THREAD_KIND;
const CODE_THREAD_KIND = 'code-thread';
const DEFAULT_SESSION_STATE_FILE = '.jarvos/session-state.json';

function rejectSnapshotFields(value = {}) {
  const disallowed = ['body', 'content', 'snapshot', 'markdown', 'description'];
  const found = disallowed.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (found.length > 0) {
    throw new Error(`session state stores pointers, not snapshots: ${found.join(', ')}`);
  }
}

function buildLiveArtifactPointer(input = {}) {
  rejectSnapshotFields(input);
  const kind = String(input.kind || '').trim();
  if (!kind) throw new Error('live artifact pointer kind is required');

  const pointer = {
    kind,
    ref: input.ref || input.issueIdentifier || input.path || input.url || input.branch || '',
    issueIdentifier: input.issueIdentifier || null,
    path: input.path || null,
    branch: input.branch || null,
    url: input.url || null,
  };

  if (!pointer.ref) throw new Error('live artifact pointer needs a ref, issueIdentifier, path, url, or branch');
  return pointer;
}

function buildSessionCheckpoint(input = {}) {
  const issueIdentifier = String(input.issueIdentifier || input.issue?.identifier || '').trim();
  const stage = String(input.stage || input.loopStage || '').trim();
  const nextStep = String(input.nextStep || '').trim();
  if (!issueIdentifier) throw new Error('session checkpoint requires an issue identifier');
  if (!stage) throw new Error('session checkpoint requires a loop stage');
  if (!nextStep) throw new Error('session checkpoint requires a next step');

  const kind = String(input.kind || input.codeKind || input.kindHint || CODE_THREAD_KIND).trim();
  if (!kind) throw new Error('session checkpoint requires a kind');

  const artifact = buildLiveArtifactPointer({
    kind: input.artifact?.kind || 'paperclip-issue',
    issueIdentifier,
    branch: input.branch || input.artifact?.branch,
    path: input.artifact?.path,
    url: input.artifact?.url,
    ref: input.artifact?.ref || issueIdentifier,
  });

  return {
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    kind,
    artifact,
    codeThread: {
      issueIdentifier,
      branch: input.branch || null,
      stage,
      lastDecision: input.lastDecision || null,
      nextStep,
    },
  };
}

function buildCodeThreadCheckpoint(input = {}) {
  return buildSessionCheckpoint({
    ...input,
    kind: CODE_THREAD_KIND,
  });
}

function buildArticleThreadCheckpoint(input = {}) {
  return buildSessionCheckpoint({
    ...input,
    kind: ARTICLE_SESSION_KIND,
  });
}

async function readJarvosSessionState(store, fallbackPointer = null) {
  if (!store || typeof store.read !== 'function') {
    throw new Error('session state store must implement read()');
  }
  const state = await store.read();
  return {
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    state: state || null,
    liveArtifact: state?.artifact || fallbackPointer || null,
  };
}

async function writeJarvosSessionState(store, checkpoint) {
  if (!store || typeof store.write !== 'function') {
    throw new Error('session state store must implement write(checkpoint)');
  }
  if (!checkpoint || checkpoint.schemaVersion !== SESSION_STATE_SCHEMA_VERSION) {
    throw new Error('checkpoint must use jarvos session state schema');
  }
  await store.write(checkpoint);
  return {
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    status: 'written',
    liveArtifact: checkpoint.artifact,
    checkpoint,
  };
}

function resolveSessionStateFilePath(input = {}) {
  const rawInput = typeof input === 'string' ? input : (input.path || input.filePath || input.file || DEFAULT_SESSION_STATE_FILE);
  const raw = String(rawInput).trim();
  return raw || DEFAULT_SESSION_STATE_FILE;
}

function createFileSessionStateStore(path = {}) {
  const filePath = resolveSessionStateFilePath(path);
  const fs = require('fs');
  const pathLib = require('path');
  const normalized = pathLib.resolve(process.cwd(), filePath);

  return {
    async read() {
      if (!fs.existsSync(normalized)) return null;
      const payload = fs.readFileSync(normalized, 'utf8');
      if (!payload) return null;
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    },
    async write(nextState) {
      await fs.promises.mkdir(pathLib.dirname(normalized), { recursive: true });
      fs.writeFileSync(normalized, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
      return nextState;
    },
  };
}

function createMemorySessionStateStore(initialState = null) {
  let state = initialState;
  return {
    async read() {
      return state;
    },
    async write(nextState) {
      state = nextState;
      return state;
    },
  };
}

module.exports = {
  CODE_THREAD_KIND,
  ARTICLE_THREAD_KIND,
  SESSION_STATE_SCHEMA_VERSION,
  buildSessionCheckpoint,
  buildCodeThreadCheckpoint,
  buildArticleThreadCheckpoint,
  buildLiveArtifactPointer,
  createFileSessionStateStore,
  createMemorySessionStateStore,
  readJarvosSessionState,
  writeJarvosSessionState,
};
