'use strict';

const crypto = require('crypto');

const CONTRACT_VERSION = '1.0.0';
const CONTRACT_MAJOR = 1;
const SUPPORTED_CONTRACT_VERSIONS = new Set([CONTRACT_VERSION]);
const RECORD_SCHEMA_VERSION = 'jarvos-control-plane.record.v1';
const MANAGER_SCHEMA_VERSION = 'jarvos-control-plane.manager.v1';

const RECORD_TYPES = [
  'desired-state',
  'observation',
  'request',
  'policy-decision',
  'command',
  'command-result',
  'evidence',
  'schedule-projection',
  'lease',
  'manager-manifest',
  'finding',
];

const COMMAND_STATUSES = [
  'requested',
  'policy_allowed',
  'policy_denied',
  'approval_required',
  'deferred',
  'lease_acquired',
  'dispatching',
  'checkpointed',
  'executed',
  'verifying',
  'satisfied',
  'failed',
  'unverifiable',
  'superseded',
  'expired',
  'conflict',
];

const POLICY_OUTCOMES = ['allow', 'deny', 'require_approval', 'defer'];
const ACTOR_KINDS = ['human', 'agent', 'schedule', 'system'];
const SENSITIVITY_LEVELS = ['public', 'internal', 'private', 'secret'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite numbers are not valid canonical values');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') throw new Error(`Unsupported canonical value type: ${typeof value}`);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function digest(value) {
  return sha256(typeof value === 'string' ? value : stableStringify(value));
}

function assertCompatibleVersion(version, label = 'contractVersion') {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || !SUPPORTED_CONTRACT_VERSIONS.has(version)) {
    throw new Error(`${label} must be compatible with ${CONTRACT_VERSION}`);
  }
}

function normalizeTimestamp(value, fallback) {
  if (value == null) return fallback || new Date().toISOString();
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return timestamp.toISOString();
}

function canonicalResourceKey(resource = {}) {
  if (!isObject(resource)) throw new Error('resource must be an object');
  for (const field of ['machineId', 'type', 'id']) {
    if (!resource[field]) throw new Error(`resource.${field} is required`);
  }
  return `resource:${digest([resource.machineId, resource.type, resource.id])}`;
}

function canonicalMutationKey({ machineId, resource, mutationClass }) {
  if (!mutationClass) throw new Error('mutationClass is required');
  const base = resource ? [resource.machineId, resource.type, resource.id] : [machineId];
  if (!base[0]) throw new Error('machineId or resource is required');
  return `mutation:${digest([...base, mutationClass])}`;
}

function canonicalCommandSpec(spec = {}) {
  if (!isObject(spec)) throw new Error('command spec must be an object');
  const normalized = {
    operation: spec.operation,
    arguments: spec.arguments || {},
    constraints: spec.constraints || {},
    lifecycle: spec.lifecycle || {},
    budget: spec.budget || null,
  };
  if (!normalized.operation) throw new Error('command spec.operation is required');
  return normalized;
}

function commandSpecDigest(spec = {}) {
  return digest(canonicalCommandSpec(spec));
}

function buildActionKey(command = {}) {
  for (const field of ['managerId', 'mutationClass', 'desiredGeneration']) {
    if (!command[field]) throw new Error(`${field} is required`);
  }
  const resourceKey = command.resourceKey || (command.resource && canonicalResourceKey(command.resource));
  if (!resourceKey) throw new Error('resourceKey or resource is required');
  const specDigest = command.specDigest || commandSpecDigest(command.commandSpec || command.spec || {});
  return digest({
    managerId: command.managerId,
    resourceKey,
    mutationClass: command.mutationClass,
    desiredGeneration: command.desiredGeneration,
    specDigest,
  });
}

function baseRecord(type, input = {}) {
  if (!RECORD_TYPES.includes(type)) throw new Error(`Unknown record type: ${type}`);
  assertCompatibleVersion(input.contractVersion || CONTRACT_VERSION);
  const createdAt = normalizeTimestamp(input.createdAt);
  const record = {
    schemaVersion: input.schemaVersion || RECORD_SCHEMA_VERSION,
    contractVersion: input.contractVersion || CONTRACT_VERSION,
    type,
    id: input.id || digest({ type, createdAt, seed: input.seed || Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) }),
    createdAt,
    updatedAt: normalizeTimestamp(input.updatedAt || createdAt),
    authority: input.authority || null,
    provenance: input.provenance || null,
    sensitivity: input.sensitivity || { level: 'internal' },
    adapterExtensions: input.adapterExtensions || {},
  };
  validateSensitivity(record.sensitivity);
  return record;
}

function createDesiredState(input = {}) {
  const record = {
    ...baseRecord('desired-state', input),
    subject: input.subject,
    authoritativeSource: input.authoritativeSource,
    generation: input.generation,
    desired: input.desired || {},
    conflictBehavior: input.conflictBehavior || 'fail_closed',
  };
  validateRecord(record);
  return record;
}

function createObservation(input = {}) {
  const record = {
    ...baseRecord('observation', input),
    resource: input.resource,
    observed: input.observed || {},
    observedAt: normalizeTimestamp(input.observedAt),
    freshUntil: input.freshUntil ? normalizeTimestamp(input.freshUntil) : null,
    observer: input.observer || null,
  };
  validateRecord(record);
  return record;
}

function createRequest(input = {}) {
  const record = {
    ...baseRecord('request', input),
    principal: input.principal,
    actor: input.actor,
    resource: input.resource,
    mutationClass: input.mutationClass,
    desiredGeneration: input.desiredGeneration,
    intent: input.intent || null,
    commandSpec: canonicalCommandSpec(input.commandSpec || input.spec || {}),
    idempotencyKey: input.idempotencyKey || null,
    correlation: input.correlation || {},
  };
  record.resourceKey = canonicalResourceKey(record.resource);
  record.specDigest = commandSpecDigest(record.commandSpec);
  validateRecord(record);
  return record;
}

function createPolicyDecision(input = {}) {
  const record = {
    ...baseRecord('policy-decision', input),
    requestId: input.requestId,
    outcome: input.outcome,
    reason: input.reason || '',
    constraints: input.constraints || {},
    evidenceRefs: input.evidenceRefs || [],
    expiresAt: input.expiresAt ? normalizeTimestamp(input.expiresAt) : null,
  };
  validateRecord(record);
  return record;
}

function createCommand(input = {}) {
  const commandSpec = canonicalCommandSpec(input.commandSpec || input.spec || {});
  const record = {
    ...baseRecord('command', input),
    requestId: input.requestId,
    policyDecisionId: input.policyDecisionId || null,
    managerId: input.managerId,
    resource: input.resource,
    resourceKey: input.resourceKey || canonicalResourceKey(input.resource),
    mutationClass: input.mutationClass,
    desiredGeneration: input.desiredGeneration,
    commandSpec,
    specDigest: commandSpecDigest(commandSpec),
    actionKey: input.actionKey || null,
    status: input.status || 'requested',
    lifecycle: input.lifecycle || [],
    leaseId: input.leaseId || null,
    fence: input.fence || null,
    checkpoint: input.checkpoint || null,
    approval: input.approval || null,
  };
  record.actionKey = record.actionKey || buildActionKey(record);
  validateRecord(record);
  return record;
}

function createEvidence(input = {}) {
  const record = {
    ...baseRecord('evidence', input),
    commandId: input.commandId || null,
    managerId: input.managerId || null,
    verifier: input.verifier || null,
    outcome: input.outcome,
    postcondition: input.postcondition || null,
    observedAt: normalizeTimestamp(input.observedAt),
    freshUntil: input.freshUntil ? normalizeTimestamp(input.freshUntil) : null,
    data: input.data || {},
  };
  validateRecord(record);
  return record;
}

function createManagerManifest(input = {}) {
  const manifest = {
    schemaVersion: input.schemaVersion || MANAGER_SCHEMA_VERSION,
    contractVersion: input.contractVersion || CONTRACT_VERSION,
    managerId: input.managerId || input.id,
    displayName: input.displayName || input.name || input.managerId || input.id,
    artifact: input.artifact || null,
    supportedCoreVersions: input.supportedCoreVersions || [CONTRACT_VERSION],
    capabilities: input.capabilities || [],
    resourceSelectors: input.resourceSelectors || [],
    mutationClasses: input.mutationClasses || [],
    requiredAuthorities: input.requiredAuthorities || [],
    health: input.health || {},
    operationContract: input.operationContract || {},
    migrations: input.migrations || {},
    trust: input.trust || { level: 'data-only' },
  };
  validateManagerManifest(manifest);
  return manifest;
}

function validateSensitivity(sensitivity = {}) {
  if (!isObject(sensitivity)) throw new Error('sensitivity must be an object');
  if (!SENSITIVITY_LEVELS.includes(sensitivity.level)) {
    throw new Error(`sensitivity.level must be one of: ${SENSITIVITY_LEVELS.join(', ')}`);
  }
  if (sensitivity.fields != null && !Array.isArray(sensitivity.fields)) {
    throw new Error('sensitivity.fields must be an array');
  }
}

function pathParts(path) {
  if (typeof path !== 'string' || !path || path.startsWith('.') || path.endsWith('.')) {
    throw new Error('sensitive field path must be a non-empty dot path');
  }
  const parts = path.split('.');
  if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error(`invalid sensitive field path: ${path}`);
  }
  return parts;
}

function sensitivePathParent(record, path, requireLeaf = true) {
  const parts = pathParts(path);
  let parent = record;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isObject(parent) && !Array.isArray(parent) || !Object.prototype.hasOwnProperty.call(parent, part)) {
      if (!requireLeaf) return null;
      throw new Error(`sensitive field path does not exist: ${path}`);
    }
    parent = parent[part];
  }
  const leaf = parts[parts.length - 1];
  if (requireLeaf && (!isObject(parent) && !Array.isArray(parent) || !Object.prototype.hasOwnProperty.call(parent, leaf))) {
    throw new Error(`sensitive field path does not exist: ${path}`);
  }
  return { parent, leaf };
}

function validateSensitivePaths(record) {
  const fields = record.sensitivity && record.sensitivity.fields;
  if (!fields) return;
  for (const field of fields) {
    if (!isObject(field) || !SENSITIVITY_LEVELS.includes(field.level)) {
      throw new Error('sensitivity.fields entries require a valid level');
    }
    sensitivePathParent(record, field.path);
  }
}

function validateActor(actor = {}) {
  if (!isObject(actor)) throw new Error('actor must be an object');
  if (!ACTOR_KINDS.includes(actor.kind)) {
    throw new Error(`actor.kind must be one of: ${ACTOR_KINDS.join(', ')}`);
  }
}

function validateRecord(record = {}) {
  if (!isObject(record)) throw new Error('record must be an object');
  if (record.schemaVersion !== RECORD_SCHEMA_VERSION) throw new Error(`Unsupported schemaVersion: ${record.schemaVersion}`);
  assertCompatibleVersion(record.contractVersion);
  if (!RECORD_TYPES.includes(record.type)) throw new Error(`Unknown record type: ${record.type}`);
  if (!record.id) throw new Error('record.id is required');
  validateSensitivity(record.sensitivity || { level: 'internal' });

  if (record.type === 'desired-state') {
    if (!record.subject) throw new Error('desired-state.subject is required');
    if (!record.authoritativeSource) throw new Error('desired-state.authoritativeSource is required');
    if (!record.generation) throw new Error('desired-state.generation is required');
  }
  if (record.type === 'observation') {
    canonicalResourceKey(record.resource);
    if (!record.observedAt) throw new Error('observation.observedAt is required');
  }
  if (record.type === 'request') {
    if (!record.principal || !record.principal.id) throw new Error('request.principal.id is required');
    validateActor(record.actor);
    canonicalResourceKey(record.resource);
    if (!record.mutationClass) throw new Error('request.mutationClass is required');
    if (!record.desiredGeneration) throw new Error('request.desiredGeneration is required');
    canonicalCommandSpec(record.commandSpec);
  }
  if (record.type === 'policy-decision') {
    if (!record.requestId) throw new Error('policy-decision.requestId is required');
    if (!POLICY_OUTCOMES.includes(record.outcome)) throw new Error(`policy-decision.outcome must be one of: ${POLICY_OUTCOMES.join(', ')}`);
  }
  if (record.type === 'command') {
    if (!record.managerId) throw new Error('command.managerId is required');
    if (!COMMAND_STATUSES.includes(record.status)) throw new Error(`command.status must be one of: ${COMMAND_STATUSES.join(', ')}`);
    buildActionKey(record);
  }
  if (record.type === 'evidence') {
    if (!record.outcome) throw new Error('evidence.outcome is required');
  }
  validateSensitivePaths(record);
  return { ok: true, record };
}

function validateManagerManifest(manifest = {}) {
  if (!isObject(manifest)) throw new Error('manager manifest must be an object');
  if (manifest.schemaVersion !== MANAGER_SCHEMA_VERSION) throw new Error(`Unsupported manager schemaVersion: ${manifest.schemaVersion}`);
  assertCompatibleVersion(manifest.contractVersion);
  if (!manifest.managerId) throw new Error('managerId is required');
  if (!Array.isArray(manifest.capabilities)) throw new Error('capabilities must be an array');
  if (!Array.isArray(manifest.mutationClasses)) throw new Error('mutationClasses must be an array');
  for (const mutation of manifest.mutationClasses) {
    if (!mutation || !mutation.class) throw new Error('mutationClasses entries require class');
    if (!mutation.resourceType) throw new Error(`mutation ${mutation.class} requires resourceType`);
  }
  const fence = manifest.operationContract && manifest.operationContract.finalSideEffectFence;
  if (manifest.trust && manifest.trust.level === 'trusted' &&
      (!isObject(fence) || fence.required !== true || !['compare-and-set', 'target-fenced'].includes(fence.mode))) {
    throw new Error('trusted managers require a target-side finalSideEffectFence declaration');
  }
  if (manifest.trust && !['data-only', 'trusted'].includes(manifest.trust.level)) {
    throw new Error('trust.level must be data-only or trusted');
  }
  return { ok: true, manifest };
}

function toPublicProjection(record, options = {}) {
  const projection = clone(record);
  const maxLevel = options.maxSensitivity || 'internal';
  const order = new Map(SENSITIVITY_LEVELS.map((level, index) => [level, index]));
  if (order.get(record.sensitivity && record.sensitivity.level || 'internal') > order.get(maxLevel)) {
    return {
      schemaVersion: record.schemaVersion,
      contractVersion: record.contractVersion,
      type: record.type,
      id: record.id,
      sensitivity: record.sensitivity,
      redacted: true,
    };
  }
  if (!options.includeAdapterExtensions) delete projection.adapterExtensions;
  if (projection.sensitivity && projection.sensitivity.fields) {
    for (const field of projection.sensitivity.fields) {
      if (order.get(field.level) > order.get(maxLevel)) {
        const target = sensitivePathParent(projection, field.path, false);
        if (target && (isObject(target.parent) || Array.isArray(target.parent)) && Object.prototype.hasOwnProperty.call(target.parent, target.leaf)) {
          delete target.parent[target.leaf];
        }
      }
    }
  }
  return projection;
}

/**
 * Merge a phase/status checkpoint onto an existing command checkpoint so
 * reconciler phase updates (dispatching, verifying, …) do not erase
 * reattachment hints such as branch/PR/session pointers.
 *
 * Lifecycle history still records the phase patch as provided; only the
 * durable command.checkpoint field merges.
 */
function mergeCommandCheckpoint(existing, incoming) {
  if (incoming === undefined) return existing || null;
  if (incoming === null) return null;
  const prev = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {};
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ...prev, value: incoming };
  }
  return { ...prev, ...incoming };
}

function lifecycleTransition(command, status, patch = {}) {
  if (!COMMAND_STATUSES.includes(status)) throw new Error(`Unknown command status: ${status}`);
  const next = clone(command);
  next.status = status;
  next.updatedAt = normalizeTimestamp(patch.at);
  next.lifecycle = Array.isArray(next.lifecycle) ? next.lifecycle : [];
  next.lifecycle.push({
    status,
    at: next.updatedAt,
    actor: patch.actor || null,
    runId: patch.runId || null,
    requestId: next.requestId || null,
    generation: next.desiredGeneration || null,
    checkpoint: patch.checkpoint || null,
    reason: patch.reason || null,
  });
  if (Object.prototype.hasOwnProperty.call(patch, 'checkpoint')) {
    next.checkpoint = mergeCommandCheckpoint(next.checkpoint, patch.checkpoint);
  }
  if (patch.leaseId) next.leaseId = patch.leaseId;
  if (patch.fence) next.fence = patch.fence;
  validateRecord(next);
  return next;
}

module.exports = {
  ACTOR_KINDS,
  COMMAND_STATUSES,
  CONTRACT_VERSION,
  MANAGER_SCHEMA_VERSION,
  POLICY_OUTCOMES,
  RECORD_SCHEMA_VERSION,
  RECORD_TYPES,
  SENSITIVITY_LEVELS,
  assertCompatibleVersion,
  baseRecord,
  buildActionKey,
  canonicalCommandSpec,
  canonicalMutationKey,
  canonicalResourceKey,
  clone,
  commandSpecDigest,
  mergeCommandCheckpoint,
  createCommand,
  createDesiredState,
  createEvidence,
  createManagerManifest,
  createObservation,
  createPolicyDecision,
  createRequest,
  digest,
  lifecycleTransition,
  stableStringify,
  toPublicProjection,
  validateManagerManifest,
  validateRecord,
};
