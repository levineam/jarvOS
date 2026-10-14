'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  COMMON_WORK_ACTIONS,
  COMMON_WORK_BRIDGE_VERSION,
  containsReservedAuthorityInput,
} = require('./harness-dispatch.js');

const COMMON_WORK_HARNESSES = new Set(['claude', 'codex', 'hermes', 'openclaw']);

function trustedOwnerOnlyFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    const real = fs.realpathSync(filePath);
    const stat = fs.statSync(real);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
    for (let cursor = path.dirname(real); ;) {
      const ancestor = fs.statSync(cursor);
      if ((ancestor.mode & 0o022) !== 0 && !(ancestor.isDirectory() && (ancestor.mode & 0o1000) !== 0)) return null;
      if (uid !== null && ancestor.uid !== uid && ancestor.uid !== 0) return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    return real;
  } catch {
    return null;
  }
}

function validateBridge(bridge) {
  return bridge
    && typeof bridge === 'object'
    && bridge.version === COMMON_WORK_BRIDGE_VERSION
    && COMMON_WORK_ACTIONS.every((action) => typeof bridge[action] === 'function');
}

function loadCommonWorkService({ serviceModule, harness } = {}) {
  if (!COMMON_WORK_HARNESSES.has(harness)) return { bridge: null, code: 'common_work_harness_unavailable' };
  const trusted = trustedOwnerOnlyFile(serviceModule);
  if (!trusted) return { bridge: null, code: serviceModule ? 'common_work_service_refused' : 'common_work_service_unavailable' };
  try {
    const loaded = require(trusted);
    const factory = typeof loaded === 'function' ? loaded : loaded?.createCommonWorkService;
    if (typeof factory !== 'function') return { bridge: null, code: 'common_work_service_invalid' };
    const bridge = factory({ harness });
    return validateBridge(bridge)
      ? { bridge, code: null }
      : { bridge: null, code: 'common_work_service_invalid' };
  } catch {
    return { bridge: null, code: 'common_work_service_unavailable' };
  }
}

async function invokeCommonWork({ serviceModule, harness, action, input } = {}) {
  // Check untrusted caller data before loading a host module: a hostile request
  // must never gain a module-load side effect, even from a trusted owner file.
  if (!COMMON_WORK_ACTIONS.includes(action)) return { ok: false, code: 'common_work_action_unavailable' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'common_work_input_invalid' };
  if (containsReservedAuthorityInput(input)) return { ok: false, code: 'reserved_authority_input' };
  const { bridge, code } = loadCommonWorkService({ serviceModule, harness });
  if (!bridge) return { ok: false, code };
  return bridge[action](input);
}

module.exports = {
  COMMON_WORK_HARNESSES,
  invokeCommonWork,
  loadCommonWorkService,
  trustedOwnerOnlyFile,
  validateBridge,
};
