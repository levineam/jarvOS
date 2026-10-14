'use strict';

const SESSION_STATE_SCHEMA_VERSION = 'jarvos-session-state/v1';
const ARTICLE_THREAD_KIND = 'article-thread';
const ARTICLE_SESSION_KIND = ARTICLE_THREAD_KIND;
const CODE_THREAD_KIND = 'code-thread';
const DEFAULT_SESSION_STATE_FILE = '.jarvos/session-state.json';
const WORK_HANDOFF_POINTER_FIELDS = Object.freeze(['workId', 'workspaceId', 'headOid']);

function isCanonicalPointerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}

function isGitObjectId(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value);
}

// Session state may retain this compact handoff only. Resolution, cleanliness,
// ownership, and authority are deliberately reread by the receiving runtime.
function buildWorkHandoff(input = {}) {
  const source = input.handoff || input.workHandoff || input;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('work handoff must be an object');
  }
  const keys = Object.keys(source).sort();
  const expected = [...WORK_HANDOFF_POINTER_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('work handoff stores only workId, workspaceId, and headOid');
  }
  const handoff = {
    workId: source.workId,
    workspaceId: source.workspaceId,
    headOid: source.headOid,
  };
  if (!isCanonicalPointerId(handoff.workId)) throw new Error('work handoff requires a canonical workId');
  if (!isCanonicalPointerId(handoff.workspaceId)) throw new Error('work handoff requires a canonical workspaceId');
  if (!isGitObjectId(handoff.headOid)) throw new Error('work handoff requires a Git headOid');
  return handoff;
}

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

  const authority = String(input.authority || '').trim();
  const itemId = String(input.itemId || '').trim();
  if (authority) pointer.authority = authority;
  if (itemId) pointer.itemId = itemId;

  if (!pointer.ref) throw new Error('live artifact pointer needs a ref, issueIdentifier, path, url, or branch');
  return pointer;
}

function normalizeWorkReference(input = {}) {
  const source = input.workReference || input.workRef || input.beadsReference;
  if (!source) return null;
  const reference = typeof source === 'string' ? { itemId: source } : source;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('work reference must be an object or item id');
  const authority = String(reference.authority || input.authority || '').trim();
  const itemId = String(reference.itemId || reference.id || reference.ref || '').trim();
  if (!authority || !itemId) throw new Error('work reference requires authority and itemId');
  const normalized = { authority, itemId };
  if (reference.operationId) normalized.operationId = String(reference.operationId);
  if (reference.revision !== undefined) normalized.revision = reference.revision;
  return normalized;
}

function buildSessionCheckpoint(input = {}) {
  const issueIdentifier = String(input.issueIdentifier || input.issue?.identifier || '').trim();
  const workReference = normalizeWorkReference(input);
  const handoffInput = input.handoff || input.workHandoff || null;
  const workHandoff = handoffInput ? buildWorkHandoff(handoffInput) : null;
  const identifier = issueIdentifier || workReference?.itemId || workHandoff?.workId || '';
  const stage = String(input.stage || input.loopStage || '').trim();
  const nextStep = String(input.nextStep || '').trim();
  if (!identifier) throw new Error('session checkpoint requires an issue or work identifier');
  if (!stage) throw new Error('session checkpoint requires a loop stage');
  if (!nextStep) throw new Error('session checkpoint requires a next step');

  const kind = String(input.kind || input.codeKind || input.kindHint || CODE_THREAD_KIND).trim();
  if (!kind) throw new Error('session checkpoint requires a kind');

  const artifact = buildLiveArtifactPointer({
    kind: input.artifact?.kind || (workHandoff ? 'work-handoff' : workReference ? 'beads-work-item' : 'paperclip-issue'),
    issueIdentifier,
    itemId: workReference?.itemId,
    authority: workReference?.authority,
    branch: input.branch || input.artifact?.branch,
    path: input.artifact?.path,
    url: input.artifact?.url,
    ref: input.artifact?.ref || identifier,
  });

  const codeThread = {
    issueIdentifier: issueIdentifier || null,
    branch: input.branch || null,
    stage,
    lastDecision: input.lastDecision || null,
    nextStep,
  };
  if (workReference) codeThread.workReference = workReference;
  if (workHandoff) codeThread.handoff = workHandoff;

  return {
    schemaVersion: SESSION_STATE_SCHEMA_VERSION,
    kind,
    artifact,
    codeThread,
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
  WORK_HANDOFF_POINTER_FIELDS,
  buildSessionCheckpoint,
  buildCodeThreadCheckpoint,
  buildArticleThreadCheckpoint,
  buildLiveArtifactPointer,
  buildWorkHandoff,
  createFileSessionStateStore,
  createMemorySessionStateStore,
  readJarvosSessionState,
  writeJarvosSessionState,
};
