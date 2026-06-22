'use strict';

const ADAPTER_RESULT_SCHEMA_VERSION = '1.0';
const ADAPTER_STATUSES = Object.freeze(['ok', 'noop', 'unsupported', 'error']);

function stripUndefined(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

function normalizeStatus(status) {
  const normalized = String(status || 'ok').trim().toLowerCase();
  return ADAPTER_STATUSES.includes(normalized) ? normalized : 'error';
}

function statusOk(status) {
  return status === 'ok' || status === 'noop';
}

function errorToObject(error) {
  if (!error) return null;
  if (typeof error === 'object' && !(error instanceof Error)) {
    return stripUndefined({
      code: error.code,
      message: error.message || String(error),
      details: error.details,
    });
  }
  return stripUndefined({
    code: error.code,
    message: error.message || String(error),
  });
}

function createAdapterResult(input = {}) {
  const status = normalizeStatus(input.status);
  const provenance = stripUndefined({
    schemaVersion: ADAPTER_RESULT_SCHEMA_VERSION,
    adapter: input.adapter || 'unknown',
    backend: input.backend || 'unknown',
    operation: input.operation || 'unknown',
    target: input.target,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    at: input.at || new Date().toISOString(),
    ...(input.provenance || {}),
  });

  return stripUndefined({
    schemaVersion: ADAPTER_RESULT_SCHEMA_VERSION,
    ok: Object.prototype.hasOwnProperty.call(input, 'ok') ? Boolean(input.ok) : statusOk(status),
    status,
    operation: provenance.operation,
    target: provenance.target,
    idempotent: Boolean(input.idempotent || status === 'noop'),
    result: input.result,
    provenance,
    error: errorToObject(input.error),
    warnings: input.warnings,
  });
}

function createAdapterErrorResult(input = {}) {
  return createAdapterResult({
    ...input,
    status: 'error',
    ok: false,
    error: input.error || { message: 'Adapter operation failed' },
  });
}

function createUnsupportedAdapterResult(input = {}) {
  const operation = input.operation || 'unknown';
  const backend = input.backend || 'unknown';
  return createAdapterResult({
    ...input,
    status: 'unsupported',
    ok: false,
    idempotent: true,
    error: input.error || {
      code: 'UNSUPPORTED_ADAPTER_OPERATION',
      message: `Adapter backend "${backend}" does not support operation "${operation}".`,
    },
  });
}

function isAdapterResult(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.schemaVersion === ADAPTER_RESULT_SCHEMA_VERSION &&
    ADAPTER_STATUSES.includes(value.status) &&
    value.provenance &&
    typeof value.provenance === 'object'
  );
}

module.exports = {
  ADAPTER_RESULT_SCHEMA_VERSION,
  ADAPTER_STATUSES,
  createAdapterErrorResult,
  createAdapterResult,
  createUnsupportedAdapterResult,
  isAdapterResult,
};
