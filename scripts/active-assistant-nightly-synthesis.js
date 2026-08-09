#!/usr/bin/env node
'use strict';

/**
 * Portable Active Assistant runtime bridge.
 *
 * jarvOS owns this public entrypoint. The host owns the reviewed synthesis
 * implementation, private configuration, and state. A managed runtime places
 * both in one immutable tree and supplies its root explicitly; this bridge
 * refuses development checkouts and arbitrary implementation paths.
 */

const fs = require('node:fs');
const path = require('node:path');

const IMPLEMENTATION_RELATIVE_PATH = 'scripts/active-assistant-nightly-synthesis.js';
const PUBLIC_RELATIVE_PATH = 'repos/jarvOS';
const ROOT_ENV = 'ACTIVE_ASSISTANT_IMPLEMENTATION_ROOT';

function bridgeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerPath(target, { directory, fsImpl = fs } = {}) {
  const stat = fsImpl.lstatSync(target);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()) {
    throw bridgeError('active_assistant_runtime_path_invalid');
  }
  if (uid != null && stat.uid !== uid) throw bridgeError('active_assistant_runtime_owner_mismatch');
  return stat;
}

function resolveImplementationEntrypoint({
  runtimeRoot,
  publicRoot = path.resolve(__dirname, '..'),
  fsImpl = fs,
} = {}) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw bridgeError('active_assistant_runtime_root_required');
  }

  const resolvedRuntime = fsImpl.realpathSync(runtimeRoot);
  ownerPath(resolvedRuntime, { directory: true, fsImpl });

  const resolvedPublic = fsImpl.realpathSync(publicRoot);
  const expectedPublic = fsImpl.realpathSync(path.join(resolvedRuntime, PUBLIC_RELATIVE_PATH));
  if (resolvedPublic !== expectedPublic) throw bridgeError('active_assistant_public_runtime_mismatch');

  const entrypoint = path.join(resolvedRuntime, IMPLEMENTATION_RELATIVE_PATH);
  const resolvedEntrypoint = fsImpl.realpathSync(entrypoint);
  if (resolvedEntrypoint !== entrypoint) throw bridgeError('active_assistant_runtime_path_invalid');
  ownerPath(resolvedEntrypoint, { directory: false, fsImpl });
  if (resolvedEntrypoint === fsImpl.realpathSync(__filename)) {
    throw bridgeError('active_assistant_runtime_recursion');
  }
  return resolvedEntrypoint;
}

function loadImplementation({ env = process.env, fsImpl = fs } = {}) {
  const entrypoint = resolveImplementationEntrypoint({
    runtimeRoot: env[ROOT_ENV],
    fsImpl,
  });
  // The resolved file is owner-controlled and pinned inside the verified
  // managed runtime; caller input never supplies a module path directly.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const implementation = require(entrypoint);
  if (!implementation || typeof implementation.runSynthesis !== 'function') {
    throw bridgeError('active_assistant_runtime_contract_invalid');
  }
  return implementation;
}

const bridgeApi = {
  IMPLEMENTATION_RELATIVE_PATH,
  PUBLIC_RELATIVE_PATH,
  ROOT_ENV,
  bridgeError,
  loadImplementation,
  ownerPath,
  resolveImplementationEntrypoint,
};

module.exports = new Proxy(bridgeApi, {
  get(target, property, receiver) {
    if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
    return loadImplementation()[property];
  },
  has(target, property) {
    return Reflect.has(target, property) || property in loadImplementation();
  },
  ownKeys(target) {
    return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(loadImplementation())])];
  },
  getOwnPropertyDescriptor(target, property) {
    return Reflect.getOwnPropertyDescriptor(target, property)
      || Object.getOwnPropertyDescriptor(loadImplementation(), property)
      || { configurable: true, enumerable: true, writable: false, value: undefined };
  },
});

if (require.main === module) {
  try {
    const implementation = loadImplementation();
    if (typeof implementation.main !== 'function') throw bridgeError('active_assistant_runtime_contract_invalid');
    implementation.main();
  } catch (error) {
    process.stderr.write(`Active Assistant runtime unavailable: ${error?.code || error?.message || 'unknown'}\n`);
    process.exitCode = 1;
  }
}
