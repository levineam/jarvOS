'use strict';

const { createHash } = require('node:crypto');
const { canonicalJson } = require('./capture-identity');

const OP_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$';

function validateCaptureOpId(opId) {
  if (typeof opId !== 'string' || !new RegExp(OP_ID_PATTERN).test(opId)) {
    throw new Error(`opId must match ${OP_ID_PATTERN}`);
  }
}

function captureOperationRequest(capture) {
  validateCaptureOpId(capture.opId);
  const hash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  const source = typeof capture.source === 'string' ? capture.source
    : capture.source?.label || capture.source?.tool;
  return {
    // Hash the namespace to keep arbitrary source labels and 80-byte IDs within
    // the mutation contract's operation ID limit, including artifact suffixes.
    intentId: `capture:op:${hash({ source, opId: capture.opId })}`,
    requestHash: hash(capture),
  };
}

module.exports = { OP_ID_PATTERN, captureOperationRequest, validateCaptureOpId };
