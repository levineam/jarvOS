'use strict';

const {
  createAdapterErrorResult,
  createAdapterResult,
  createUnsupportedAdapterResult,
  isAdapterResult,
} = require('./contract');

const LOCAL_STORAGE_OPERATIONS = Object.freeze([
  'ensureJournal',
  'appendLineToJournalSection',
  'writeNote',
  'linkNoteToJournal',
  'createMemoryRecord',
  'writeMemoryRecord',
  'checkMemoryDedup',
  'createWorkIntakeIssue',
  'ensureTrackedWork',
  'addWorkIntakeComment',
  'updateWorkIntakeIssue',
]);

function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

function compactObject(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

function duplicateLike(error) {
  return /\b(duplicate|already exists|already present)\b/i.test(String(error || ''));
}

function classifyPayloadStatus(payload) {
  if (payload?.alreadyPresent) return 'noop';
  if (payload?.isDuplicate) return 'noop';
  if (payload?.written === false && !payload?.error) return 'noop';
  if (payload?.written === false && duplicateLike(payload?.error)) return 'noop';
  if (payload?.error) return 'error';
  return 'ok';
}

function payloadIdempotent(payload, status) {
  return Boolean(
    status === 'noop' ||
    payload?.alreadyPresent ||
    payload?.isDuplicate ||
    duplicateLike(payload?.error)
  );
}

function normalizePayload(payload, meta) {
  if (isAdapterResult(payload)) return payload;

  const status = classifyPayloadStatus(payload);
  if (status === 'error') {
    return createAdapterErrorResult({
      ...meta,
      result: payload,
      error: payload?.error || 'Adapter operation failed',
      idempotent: payloadIdempotent(payload, status),
    });
  }

  return createAdapterResult({
    ...meta,
    status,
    result: payload === undefined ? null : payload,
    idempotent: payloadIdempotent(payload, status),
  });
}

function operationTarget(operation, input = {}) {
  switch (operation) {
    case 'ensureJournal':
      return input.date ? `journal:${input.date}` : 'journal:today';
    case 'appendLineToJournalSection':
      return compactObject({
        kind: 'journal-section',
        date: input.date,
        heading: input.heading,
      });
    case 'writeNote':
      return compactObject({ kind: 'note', title: input.title });
    case 'linkNoteToJournal':
      return compactObject({ kind: 'journal-note-link', noteTitle: input.noteTitle, date: input.date });
    case 'createMemoryRecord':
    case 'writeMemoryRecord':
    case 'checkMemoryDedup':
      return compactObject({ kind: 'memory', class: input.class || input.memoryClass, content: input.content });
    case 'createWorkIntakeIssue':
    case 'ensureTrackedWork':
      return compactObject({ kind: 'paperclip-issue', title: input.title });
    case 'addWorkIntakeComment':
    case 'updateWorkIntakeIssue':
      return compactObject({ kind: 'paperclip-issue', issueRef: input.issueRef });
    default:
      return operation;
  }
}

function makeMeta(options, operation, input) {
  return {
    adapter: options.adapterName || 'ambient-local-storage',
    backend: options.backend || 'local',
    operation,
    target: operationTarget(operation, input),
    idempotencyKey: input?.idempotencyKey,
    source: input?.source || options.source,
  };
}

function invokeOperation(options, operation, input, fn) {
  const meta = makeMeta(options, operation, input);
  if (typeof fn !== 'function') {
    return createUnsupportedAdapterResult(meta);
  }

  try {
    const payload = fn(input || {});
    if (isPromiseLike(payload)) {
      return payload
        .then((resolved) => normalizePayload(resolved, meta))
        .catch((error) => createAdapterErrorResult({ ...meta, error }));
    }
    return normalizePayload(payload, meta);
  } catch (error) {
    return createAdapterErrorResult({ ...meta, error });
  }
}

function requiredInputError(options, operation, input, field) {
  return createAdapterErrorResult({
    ...makeMeta(options, operation, input),
    error: {
      code: 'INVALID_ADAPTER_INPUT',
      message: `${field} is required for ${operation}.`,
    },
  });
}

function createLocalStorageAdapter(options = {}) {
  const storageAdapter = options.storageAdapter || options.vaultAdapter || options.journalAdapter || options.notesAdapter || {};
  const memoryAdapter = options.memoryAdapter || {};
  const paperclipClient = options.paperclipClient || {};

  return {
    kind: 'local-storage',
    backend: options.backend || 'local',
    operations: LOCAL_STORAGE_OPERATIONS.slice(),

    ensureJournal(input = {}) {
      return invokeOperation(options, 'ensureJournal', input, storageAdapter.ensureJournal?.bind(storageAdapter));
    },

    appendLineToJournalSection(input = {}) {
      return invokeOperation(
        options,
        'appendLineToJournalSection',
        input,
        storageAdapter.appendLineToJournalSection?.bind(storageAdapter),
      );
    },

    writeNote(input = {}) {
      return invokeOperation(options, 'writeNote', input, storageAdapter.writeNote?.bind(storageAdapter));
    },

    linkNoteToJournal(input = {}) {
      return invokeOperation(options, 'linkNoteToJournal', input, storageAdapter.linkNoteToJournal?.bind(storageAdapter));
    },

    createMemoryRecord(input = {}) {
      return invokeOperation(options, 'createMemoryRecord', input, memoryAdapter.createMemoryRecord?.bind(memoryAdapter));
    },

    writeMemoryRecord(input = {}) {
      return invokeOperation(options, 'writeMemoryRecord', input, memoryAdapter.createMemoryRecord?.bind(memoryAdapter));
    },

    checkMemoryDedup(input = {}) {
      return invokeOperation(options, 'checkMemoryDedup', input, memoryAdapter.checkMemoryDedup?.bind(memoryAdapter));
    },

    createWorkIntakeIssue(input = {}) {
      return invokeOperation(options, 'createWorkIntakeIssue', input, paperclipClient.createIssue?.bind(paperclipClient));
    },

    ensureTrackedWork(input = {}) {
      return invokeOperation(options, 'ensureTrackedWork', input, paperclipClient.createIssue?.bind(paperclipClient));
    },

    addWorkIntakeComment(input = {}) {
      if (!input.issueRef) return requiredInputError(options, 'addWorkIntakeComment', input, 'issueRef');
      const body = Object.prototype.hasOwnProperty.call(input, 'comment') ? input.comment : input.body;
      if (body === undefined) return requiredInputError(options, 'addWorkIntakeComment', input, 'comment');
      return invokeOperation(options, 'addWorkIntakeComment', input, () => paperclipClient.addComment(input.issueRef, body));
    },

    updateWorkIntakeIssue(input = {}) {
      if (!input.issueRef) return requiredInputError(options, 'updateWorkIntakeIssue', input, 'issueRef');
      if (!input.updates || typeof input.updates !== 'object') {
        return requiredInputError(options, 'updateWorkIntakeIssue', input, 'updates');
      }
      return invokeOperation(options, 'updateWorkIntakeIssue', input, () => paperclipClient.updateIssue(input.issueRef, input.updates));
    },
  };
}

module.exports = {
  LOCAL_STORAGE_OPERATIONS,
  createLocalStorageAdapter,
};
