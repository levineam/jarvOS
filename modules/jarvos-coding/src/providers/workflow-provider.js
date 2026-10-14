'use strict';

const { OPERATIONS, WORKFLOW_PROVIDER_CONTRACT_VERSION } = require('./compound-engineering');

const WORKFLOW_PROVIDER_RECEIPT_VERSION = 'jarvos-workflow-provider-receipt/v1';
const WORKFLOW_PROVIDER_PUBLIC_RECEIPT_VERSION = 'jarvos-workflow-provider-public/v1';
const OPERATIONS_SET = new Set(OPERATIONS);
const STATUSES = new Set(['succeeded', 'failed', 'unavailable', 'incomplete', 'blocked']);
const HARNESS = /^[a-z][a-z0-9-]{1,31}$/;
const ADAPTER = /^[a-z][a-z0-9-]{1,47}\.v\d+$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_REFERENCE = /^artifact:[A-Za-z0-9._-]{6,160}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const ABSOLUTE_PATH = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/;
const SAFE_LABEL = /^[^\0\r\n]{1,160}$/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const SENSITIVE_PATH = /(?:^|[\\/])(?:\.env(?:\.|$)|credentials?|secrets?|tokens?)(?:[\\/]|$)/i;
const AUTHORITY_FIELDS = new Set(['branch', 'worktree', 'worktreePath', 'approval', 'submissionReady', 'completion', 'owner', 'authority', 'terminalStatus', 'nextStep', 'pr', 'pullRequest', 'baseBranch', 'mergeEligible']);
const REQUEST_FIELDS = new Set(['version', 'operation', 'workRunId', 'operationNonce', 'idempotencyKey', 'provider', 'canonicalWorktree', 'input', 'acceptedPlanDigest']);
const PROVIDER_FIELDS = new Set(['id', 'version', 'pinDigest', 'harness', 'adapterVersion']);
const INPUT_FIELDS = new Set(['kind', 'digest']);
const RECEIPT_FIELDS = new Set(['version', 'operation', 'status', 'workRunId', 'operationNonce', 'idempotencyKey', 'provider', 'artifact', 'planRevisionDigest', 'acceptedPlanDigest', 'publicLabel', 'diagnostics']);
const ARTIFACT_FIELDS = new Set(['kind', 'reference', 'path', 'digest']);
const PUBLIC_PROVIDER_FIELDS = new Set(['id', 'version', 'harness']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function addUnknownFields(value, allowed, prefix, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${prefix}.${key} is an unknown field`);
  }
}

function validateProvider(provider, { manifest, prefix = 'provider' } = {}) {
  const errors = [];
  if (!isObject(provider)) return [`${prefix} must be an object`];
  addUnknownFields(provider, PROVIDER_FIELDS, prefix, errors);
  if (!OPAQUE_ID.test(provider.id || '')) errors.push(`${prefix}.id must be an opaque identifier`);
  if (manifest && provider.id !== manifest.id) errors.push(`${prefix}.id must match the approved provider`);
  if (typeof provider.version !== 'string' || !/^\S{1,64}$/.test(provider.version)) errors.push(`${prefix}.version must be a bounded provider version`);
  if (manifest && provider.version !== manifest.version) errors.push(`${prefix}.version must match the approved provider`);
  if (!isDigest(provider.pinDigest)) errors.push(`${prefix}.pinDigest must be a SHA-256 digest`);
  if (manifest && provider.pinDigest !== manifest.source.contentDigest) errors.push(`${prefix}.pinDigest must match the approved provider pinDigest`);
  if (typeof provider.harness !== 'string' || !HARNESS.test(provider.harness)) errors.push(`${prefix}.harness must be a bounded harness name`);
  if (typeof provider.adapterVersion !== 'string' || !ADAPTER.test(provider.adapterVersion)) errors.push(`${prefix}.adapterVersion must be a versioned adapter identity`);
  if (manifest && provider.harness && manifest.harnesses?.[provider.harness]) {
    const harness = manifest.harnesses[provider.harness];
    // A provider snapshot may be recorded while its harness is unsupported;
    // the route selector is responsible for refusing invocation in that state.
    // Keeping the status in the manifest lets the contract describe discovery
    // and fallback without pretending that unsupported harnesses are healthy.
    if (harness.adapter !== provider.adapterVersion) errors.push(`${prefix}.adapterVersion must match the approved harness adapter`);
  } else if (manifest && provider.harness) {
    errors.push(`${prefix}.harness is not declared by the approved manifest`);
  }
  return errors;
}

function validateWorkflowProviderRequest(request = {}, { manifest } = {}) {
  const errors = [];
  if (!isObject(request)) return { ok: false, errors: ['provider request must be an object'] };
  addUnknownFields(request, REQUEST_FIELDS, 'request', errors);
  if (request.version !== WORKFLOW_PROVIDER_CONTRACT_VERSION) errors.push(`request.version must be ${WORKFLOW_PROVIDER_CONTRACT_VERSION}`);
  if (!OPERATIONS_SET.has(request.operation)) errors.push(`request.operation must be one of: ${OPERATIONS.join(', ')}`);
  for (const field of ['workRunId', 'operationNonce', 'idempotencyKey']) {
    if (!OPAQUE_ID.test(request[field] || '')) errors.push(`request.${field} must be an opaque identifier`);
  }
  errors.push(...validateProvider(request.provider, { manifest, prefix: 'request.provider' }));
  if (typeof request.canonicalWorktree !== 'string' || !ABSOLUTE_PATH.test(request.canonicalWorktree) || request.canonicalWorktree.includes('\0')) errors.push('request.canonicalWorktree must be an absolute path');
  if (!isObject(request.input)) {
    errors.push('request.input must be an object');
  } else {
    addUnknownFields(request.input, INPUT_FIELDS, 'request.input', errors);
    if (typeof request.input.kind !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(request.input.kind)) errors.push('request.input.kind must be a bounded kind');
    if (!isDigest(request.input.digest)) errors.push('request.input.digest must be a SHA-256 digest');
  }
  if (request.operation === 'plan') {
    if (request.acceptedPlanDigest !== undefined && request.acceptedPlanDigest !== null) errors.push('request.acceptedPlanDigest must be absent for plan');
  } else if (!isDigest(request.acceptedPlanDigest)) {
    errors.push(`request.acceptedPlanDigest must be a SHA-256 digest for ${request.operation}`);
  }
  return { ok: errors.length === 0, errors };
}

function buildWorkflowProviderRequest(input = {}) {
  const request = {
    version: WORKFLOW_PROVIDER_CONTRACT_VERSION,
    operation: input.operation,
    workRunId: input.workRunId,
    operationNonce: input.operationNonce,
    idempotencyKey: input.idempotencyKey,
    provider: input.provider,
    canonicalWorktree: input.canonicalWorktree,
    input: input.input,
  };
  if (input.acceptedPlanDigest !== undefined) request.acceptedPlanDigest = input.acceptedPlanDigest;
  const validation = validateWorkflowProviderRequest(request, { manifest: input.manifest });
  return validation.ok ? { ok: true, request } : { ok: false, errors: validation.errors, request };
}

function validateArtifact(artifact, prefix, errors) {
  if (!isObject(artifact)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  addUnknownFields(artifact, ARTIFACT_FIELDS, prefix, errors);
  if (!['plan', 'work', 'compound'].includes(artifact.kind)) errors.push(`${prefix}.kind must be plan, work, or compound`);
  if (typeof artifact.reference !== 'string' || !ARTIFACT_REFERENCE.test(artifact.reference)) errors.push(`${prefix}.reference must be an opaque artifact reference`);
  if (typeof artifact.path !== 'string' || !ABSOLUTE_PATH.test(artifact.path) || artifact.path.includes('\0') || SENSITIVE_PATH.test(artifact.path)) errors.push(`${prefix}.path must be an allowed private absolute artifact path`);
  if (!isDigest(artifact.digest)) errors.push(`${prefix}.digest must be a SHA-256 digest`);
}

function validateDiagnostics(diagnostics, errors) {
  if (!Array.isArray(diagnostics) || diagnostics.length > 10) {
    errors.push('receipt.diagnostics must be an array with at most 10 entries');
    return;
  }
  diagnostics.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 500 || /[\0\r\n]/.test(entry)) errors.push(`receipt.diagnostics[${index}] must be bounded single-line text`);
  });
}

function validateWorkflowProviderReceipt(receipt = {}, { manifest, request } = {}) {
  const errors = [];
  if (!isObject(receipt)) return { ok: false, errors: ['provider receipt must be an object'] };
  addUnknownFields(receipt, RECEIPT_FIELDS, 'receipt', errors);
  for (const field of AUTHORITY_FIELDS) if (Object.prototype.hasOwnProperty.call(receipt, field)) errors.push(`receipt.${field} is an authority-shaped field and is not allowed`);
  if (receipt.version !== WORKFLOW_PROVIDER_RECEIPT_VERSION) errors.push(`receipt.version must be ${WORKFLOW_PROVIDER_RECEIPT_VERSION}`);
  if (!OPERATIONS_SET.has(receipt.operation)) errors.push(`receipt.operation must be one of: ${OPERATIONS.join(', ')}`);
  if (!STATUSES.has(receipt.status)) errors.push('receipt.status is not a supported provider status');
  for (const field of ['workRunId', 'operationNonce', 'idempotencyKey']) if (!OPAQUE_ID.test(receipt[field] || '')) errors.push(`receipt.${field} must be an opaque identifier`);
  errors.push(...validateProvider(receipt.provider, { manifest, prefix: 'receipt.provider' }));
  if (request) {
    for (const field of ['operation', 'workRunId', 'operationNonce', 'idempotencyKey']) if (receipt[field] !== request[field]) errors.push(`receipt.${field} must match request.${field}`);
    if (receipt.provider?.pinDigest !== request.provider?.pinDigest) errors.push('receipt.provider.pinDigest must match request.provider.pinDigest');
  }
  validateArtifact(receipt.artifact, 'receipt.artifact', errors);
  if (receipt.artifact && receipt.artifact.kind !== receipt.operation) errors.push('receipt.artifact.kind must match receipt.operation');
  if (typeof receipt.planRevisionDigest !== 'string' && receipt.planRevisionDigest !== null) errors.push('receipt.planRevisionDigest must be a digest or null');
  if (receipt.planRevisionDigest !== null && receipt.planRevisionDigest !== undefined && !isDigest(receipt.planRevisionDigest)) errors.push('receipt.planRevisionDigest must be a SHA-256 digest');
  if (receipt.acceptedPlanDigest !== null && receipt.acceptedPlanDigest !== undefined && !isDigest(receipt.acceptedPlanDigest)) errors.push('receipt.acceptedPlanDigest must be a SHA-256 digest or null');
  if (receipt.operation === 'plan') {
    if (receipt.planRevisionDigest !== receipt.artifact?.digest) errors.push('receipt.planRevisionDigest must bind the plan artifact digest');
    if (receipt.acceptedPlanDigest !== null && receipt.acceptedPlanDigest !== undefined) errors.push('receipt.acceptedPlanDigest must be null for plan');
  } else {
    if (!isDigest(receipt.acceptedPlanDigest)) errors.push(`receipt.acceptedPlanDigest is required for ${receipt.operation}`);
    if (request && receipt.acceptedPlanDigest !== request.acceptedPlanDigest) errors.push('receipt.acceptedPlanDigest must match request.acceptedPlanDigest');
    if (receipt.planRevisionDigest !== null && receipt.planRevisionDigest !== undefined) errors.push(`receipt.planRevisionDigest must be null for ${receipt.operation}`);
  }
  if (typeof receipt.publicLabel !== 'string' || !SAFE_LABEL.test(receipt.publicLabel) || SECRET_VALUE.test(receipt.publicLabel) || ABSOLUTE_PATH.test(receipt.publicLabel)) errors.push('receipt.publicLabel must be public-safe bounded text');
  validateDiagnostics(receipt.diagnostics, errors);
  return { ok: errors.length === 0, errors, receipt };
}

function redactPublicText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-)[^\s]+/gi, '[redacted]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/(?:\/|[A-Za-z]:[\\/])[^\s]+/g, '[private-path]');
}

function projectPublicWorkflowProviderReceipt(receipt = {}) {
  const errors = [];
  if (!isObject(receipt)) return { ok: false, errors: ['provider receipt must be an object'] };
  if (receipt.version !== WORKFLOW_PROVIDER_RECEIPT_VERSION) errors.push('receipt must be validated before public projection');
  if (errors.length) return { ok: false, errors };
  const projection = {
    version: WORKFLOW_PROVIDER_PUBLIC_RECEIPT_VERSION,
    operation: receipt.operation,
    status: receipt.status,
    workRunId: receipt.workRunId,
    provider: {
      id: receipt.provider.id,
      version: receipt.provider.version,
      harness: receipt.provider.harness,
    },
    artifact: {
      kind: receipt.artifact.kind,
      reference: receipt.artifact.reference,
      digest: receipt.artifact.digest,
    },
    planRevisionDigest: receipt.planRevisionDigest ?? null,
    acceptedPlanDigest: receipt.acceptedPlanDigest ?? null,
    publicLabel: redactPublicText(receipt.publicLabel),
    diagnostics: (receipt.diagnostics || []).map(redactPublicText).filter((entry) => entry && !SENSITIVE_PATH.test(entry)),
  };
  return { ok: true, projection };
}

module.exports = {
  WORKFLOW_PROVIDER_CONTRACT_VERSION,
  WORKFLOW_PROVIDER_RECEIPT_VERSION,
  WORKFLOW_PROVIDER_PUBLIC_RECEIPT_VERSION,
  buildWorkflowProviderRequest,
  projectPublicWorkflowProviderReceipt,
  validateWorkflowProviderReceipt,
  validateWorkflowProviderRequest,
};
