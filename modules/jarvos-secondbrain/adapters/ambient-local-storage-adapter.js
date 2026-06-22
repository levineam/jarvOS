'use strict';

const {
  createLocalStorageAdapter,
} = require('../packages/jarvos-ambient/src/adapters');
const {
  createVaultStorageAdapter,
} = require('./obsidian/src/vault-storage-adapter.js');
const {
  createPaperclipClient,
} = require('../bridge/paperclip/client');

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function createLazyPaperclipClient(options = {}) {
  let client = null;
  function getClient() {
    if (!client) client = createPaperclipClient(options);
    return client;
  }

  return {
    createIssue: (...args) => getClient().createIssue(...args),
    addComment: (...args) => getClient().addComment(...args),
    updateIssue: (...args) => getClient().updateIssue(...args),
  };
}

function createUnavailableMemoryAdapter(loadError) {
  return {
    createMemoryRecord() {
      return {
        record: null,
        written: false,
        path: null,
        error: `@jarvos/memory is unavailable: ${loadError.message}`,
      };
    },
  };
}

function loadDefaultMemoryAdapter() {
  try {
    return require('@jarvos/memory');
  } catch (packageError) {
    try {
      return require('../../jarvos-memory/src');
    } catch {
      return createUnavailableMemoryAdapter(packageError);
    }
  }
}

function createAmbientLocalStorageAdapter(options = {}) {
  const storageAdapter = hasOwn(options, 'storageAdapter')
    ? options.storageAdapter
    : createVaultStorageAdapter(options.storage || {});
  const memoryAdapter = hasOwn(options, 'memoryAdapter')
    ? options.memoryAdapter
    : loadDefaultMemoryAdapter();
  const paperclipClient = hasOwn(options, 'paperclipClient')
    ? options.paperclipClient
    : createLazyPaperclipClient(options.paperclip || {});

  return createLocalStorageAdapter({
    ...options,
    adapterName: options.adapterName || 'jarvos-secondbrain-local-storage',
    backend: options.backend || 'jarvos-secondbrain-local',
    storageAdapter,
    memoryAdapter,
    paperclipClient,
  });
}

module.exports = {
  createAmbientLocalStorageAdapter,
};
