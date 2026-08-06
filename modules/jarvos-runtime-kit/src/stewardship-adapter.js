'use strict';

const STEWARDSHIP_ADAPTER_VERSION = 'jarvos-stewardship-adapter.v1';
const ISOLATION_MODES = ['native', 'managed-launcher'];
const REQUIRED_LIFECYCLE_CAPABILITIES = ['startOrResume', 'heartbeat', 'checkpoint', 'stop', 'nextTurnInput'];
const HARNESS_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateStewardshipAdapter(adapter = {}) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return { ok: false, errors: ['stewardship adapter must be an object'] };
  if (adapter.version !== STEWARDSHIP_ADAPTER_VERSION) errors.push(`adapter.version must be ${STEWARDSHIP_ADAPTER_VERSION}`);
  if (typeof adapter.harness !== 'string' || !HARNESS_IDENTIFIER.test(adapter.harness)) errors.push('adapter.harness must be a bounded identifier');
  if (!ISOLATION_MODES.includes(adapter.isolationMode)) errors.push(`adapter.isolationMode must be one of: ${ISOLATION_MODES.join(', ')}`);
  if (adapter.isolatedWorktrees !== true) errors.push('adapter must provide isolated worktrees');
  for (const capability of REQUIRED_LIFECYCLE_CAPABILITIES) {
    if (typeof adapter[capability] !== 'function') errors.push(`adapter must implement ${capability}`);
  }
  if (adapter.preEditObservation !== undefined && typeof adapter.preEditObservation !== 'function') {
    errors.push('adapter.preEditObservation must be a function when provided');
  }
  return { ok: errors.length === 0, errors };
}

function assertStewardshipAdapter(adapter) {
  const result = validateStewardshipAdapter(adapter);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return adapter;
}

module.exports = { HARNESS_IDENTIFIER, ISOLATION_MODES, REQUIRED_LIFECYCLE_CAPABILITIES, STEWARDSHIP_ADAPTER_VERSION, assertStewardshipAdapter, validateStewardshipAdapter };
