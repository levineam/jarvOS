'use strict';

const path = require('path');

const STEWARDSHIP_BOOTSTRAP_CONTRACT_VERSION = 'jarvos-stewardship-bootstrap.v1';
const STEWARDSHIP_STABLE_ROOT_ENV = 'JARVOS_STEWARDSHIP_STABLE_ROOT';
const STEWARDSHIP_DISPATCHER = 'jarvos-stewardship-dispatcher';
const STEWARDSHIP_ACTIONS = ['harness-launch', 'session-start', 'session-turn', 'bridge', 'provenance-probe', 'session-precompact'];
const STABLE_ENTRYPOINTS = {
  dispatcher: STEWARDSHIP_DISPATCHER,
  hermesShell: 'jarvos-hermes-pre-llm-hook.js',
  openclawPlugin: 'jarvos-openclaw-stewardship-plugin',
};
const HARNESS_ENTRYPOINT_KINDS = {
  claude: 'dispatcher',
  codex: 'dispatcher',
  hermes: 'hermesShell',
  openclaw: 'openclawPlugin',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRelativeAsset(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]+/).includes('..');
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

// This is intentionally declarative. The private installer materializes these
// stable paths under its owner-controlled state root; the dispatcher itself
// remains the sole selector resolver and is not reimplemented in adapter setup.
function stableEntrypoint(root, kind) {
  if (!path.isAbsolute(root || '')) throw new Error(`${STEWARDSHIP_STABLE_ROOT_ENV} must be an absolute path`);
  const name = STABLE_ENTRYPOINTS[kind];
  if (!name) throw new Error(`unknown stable stewardship entrypoint: ${kind}`);
  return path.join(root, name);
}

function validateStewardshipBootstrap(declaration, runtimeId) {
  const errors = [];
  if (!isPlainObject(declaration)) return { ok: false, errors: ['stewardship bootstrap declaration must be an object'] };
  if (declaration.version !== STEWARDSHIP_BOOTSTRAP_CONTRACT_VERSION) errors.push(`stewardship bootstrap version must be ${STEWARDSHIP_BOOTSTRAP_CONTRACT_VERSION}`);
  if (declaration.rootEnvironment !== STEWARDSHIP_STABLE_ROOT_ENV) errors.push(`stewardship bootstrap rootEnvironment must be ${STEWARDSHIP_STABLE_ROOT_ENV}`);
  if (declaration.dispatcher !== STEWARDSHIP_DISPATCHER) errors.push(`stewardship bootstrap dispatcher must be ${STEWARDSHIP_DISPATCHER}`);
  if (runtimeId && declaration.harness !== runtimeId) errors.push(`stewardship bootstrap harness must be ${runtimeId}`);
  if (!Object.prototype.hasOwnProperty.call(HARNESS_ENTRYPOINT_KINDS, declaration.harness)) errors.push('stewardship bootstrap harness must name a supported runtime');
  if (!sameStrings(declaration.actions, STEWARDSHIP_ACTIONS)) errors.push('stewardship bootstrap actions must declare the versioned action ABI in order');
  if (!Array.isArray(declaration.selectedRuntimeAssets) || declaration.selectedRuntimeAssets.length === 0
    || declaration.selectedRuntimeAssets.some((asset) => !isRelativeAsset(asset))
    || declaration.selectedRuntimeAssets.some((asset) => !asset.startsWith(`runtimes/${declaration.harness}/`))
    || new Set(declaration.selectedRuntimeAssets).size !== declaration.selectedRuntimeAssets.length) {
    errors.push('stewardship bootstrap selectedRuntimeAssets must be unique safe relative paths');
  }
  if (!isPlainObject(declaration.installedConfig)
    || declaration.installedConfig.inspection !== 'stable-entrypoint-only'
    || declaration.installedConfig.prepare !== 'reversible'
    || declaration.installedConfig.rollback !== 'exact-owned-state') {
    errors.push('stewardship bootstrap installedConfig must declare stable inspection and reversible ownership');
  }
  if (!isPlainObject(declaration.provenance)
    || declaration.provenance.action !== 'provenance-probe'
    || declaration.provenance.sideEffectFree !== true) {
    errors.push('stewardship bootstrap provenance must use the side-effect-free provenance-probe action');
  }
  const entrypoint = declaration.entrypoint;
  if (!isPlainObject(entrypoint) || !['dispatcher', 'hermesShell', 'openclawPlugin'].includes(entrypoint.kind)
    || entrypoint.kind !== HARNESS_ENTRYPOINT_KINDS[declaration.harness]
    || entrypoint.path !== STABLE_ENTRYPOINTS[entrypoint.kind]) {
    errors.push('stewardship bootstrap entrypoint must name a known stable bundle asset');
  }
  return { ok: errors.length === 0, errors };
}

function assertStewardshipBootstrap(declaration, runtimeId) {
  const result = validateStewardshipBootstrap(declaration, runtimeId);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return declaration;
}

module.exports = {
  STABLE_ENTRYPOINTS,
  STEWARDSHIP_ACTIONS,
  STEWARDSHIP_BOOTSTRAP_CONTRACT_VERSION,
  STEWARDSHIP_DISPATCHER,
  STEWARDSHIP_STABLE_ROOT_ENV,
  assertStewardshipBootstrap,
  stableEntrypoint,
  validateStewardshipBootstrap,
};
