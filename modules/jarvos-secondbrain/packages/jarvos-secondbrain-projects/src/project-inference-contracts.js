'use strict';

const crypto = require('node:crypto');

// This module is deliberately independent from records.js, registry.js, and
// ActivityStore. It is the portable, opt-in boundary for inference state. The
// raw source that produced an Evidence Unit belongs to its adapter and never
// crosses this boundary.
const EVIDENCE_UNIT_CONTRACT = 'jarvos.project-inference-evidence/v1';
const CORRECTION_EVIDENCE_CONTRACT = 'jarvos.project-inference-correction/v1';
const CORRECTION_ADMISSION_CONTRACT = 'jarvos.project-inference-correction-admission/v1';
const PROJECT_CANDIDATE_CONTRACT = 'jarvos.project-inference-candidate/v1';
const INFERENCE_DECISION_CONTRACT = 'jarvos.project-inference-decision/v1';
const COVERAGE_CONTRACT = 'jarvos.project-inference-coverage/v1';

const SOURCE_CLASSES = Object.freeze(['note', 'chat', 'execution', 'release', 'stewardship']);
const COVERAGE_STATES = Object.freeze(['fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty']);
const SENSITIVITY_CLASSES = Object.freeze(['public-fixture', 'owner-private', 'restricted']);
const PROJECT_KINDS = Object.freeze(['project', 'outcome']);
const CANDIDATE_DISPOSITIONS = Object.freeze(['provisional', 'quarantined', 'established', 'rejected', 'superseded']);
const DECISION_DISPOSITIONS = Object.freeze([
  'established', 'associated', 'corrected', 'quarantined', 'provisional',
  'unchanged', 'superseded', 'rejected', 'not-evaluable',
]);
const CORRECTION_OPERATIONS = Object.freeze(['rename', 'reparent', 'merge', 'split', 'reject', 'restore', 'establish']);
const CANDIDATE_ORIGINS = Object.freeze(['inference', 'correction', 'replay', 'migration']);
const CONFIDENCE_AXES = Object.freeze([
  'identityMatch', 'novelty', 'sourceDiversity', 'temporalContinuity', 'parentFit', 'sourceCoverage',
]);
const CORRECTION_ATTESTATION_METHODS = Object.freeze([
  'telegram-owner',
  'owner-bound-interactive',
  'obsidian-human-edit',
  'harness-owner-turn',
  // These are explicitly support-only. Including them in the enum lets a
  // source preserve an unverified correction without granting mutation power.
  'conversation-text',
  'agent-authored',
  'pasted-text',
  'ambiguous-authorship',
]);
const VERIFIED_ATTESTATION_METHODS = Object.freeze([
  'telegram-owner', 'owner-bound-interactive', 'obsidian-human-edit', 'harness-owner-turn',
]);

const EVIDENCE_FIELDS = Object.freeze([
  'contract', 'observationId', 'evidenceId', 'sourceClass', 'occurredAt', 'observedAt',
  'sourceRevision', 'sensitivity', 'coverageState', 'contentDigest',
]);
const CORRECTION_FIELDS = Object.freeze([
  'contract', 'observationId', 'evidenceId', 'sourceClass', 'occurredAt', 'observedAt',
  'sourceRevision', 'sensitivity', 'coverageState', 'contentDigest', 'correctionId',
  'target', 'operation', 'assertedChange', 'attestation', 'trustTier',
]);
const CANDIDATE_FIELDS = Object.freeze([
  'contract', 'candidateId', 'origin', 'evidenceIds', 'evidenceSetWatermark', 'engineRevision',
  'policyRevision', 'kind', 'title', 'aliases', 'parentId', 'parentAlternatives', 'confidence',
  'disposition', 'reasonCodes', 'lineage',
]);
const DECISION_FIELDS = Object.freeze([
  'contract', 'decisionId', 'candidateId', 'policyRevision', 'disposition', 'canonical',
  'reasonCodes', 'suppressionKey', 'supersededBy', 'lineage',
]);
const CANONICAL_FIELDS = Object.freeze(['recordId', 'kind', 'revision', 'parentId', 'refDigest']);
const CONFIDENCE_FIELDS = Object.freeze([...CONFIDENCE_AXES]);
const ATTESTATION_FIELDS = Object.freeze(['method', 'admission', 'status']);
const ADMISSION_FIELDS = Object.freeze(['issuerId', 'authorityDigest', 'claimDigest', 'signature']);
const TARGET_FIELDS = Object.freeze(['candidateId', 'canonicalId', 'alias']);
const ASSERTED_CHANGE_FIELDS = Object.freeze(['title', 'aliases', 'parentId', 'kind', 'canonicalId']);
const COVERAGE_FIELDS = Object.freeze(['contract', 'sourceClass', 'state', 'observedAt', 'sourceRevision']);

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ATTESTOR_STATE = new WeakMap();

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableDigest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function without(value, ...fields) {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
}

function assertPlain(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function assertExactKeys(value, fields, label) {
  assertPlain(value, label);
  const expected = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} must contain exact fields: ${fields.join(', ')}`);
  }
}

function assertKnownKeys(value, fields, label) {
  assertPlain(value, label);
  const expected = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function requiredString(value, field, { max = 256 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  if (normalized.length > max) throw new TypeError(`${field} exceeds ${max} characters`);
  if (/[\u0000\r\n]/.test(normalized)) throw new TypeError(`${field} contains control characters`);
  return normalized;
}

function nullableString(value, field, options = {}) {
  if (value === null || value === undefined) return null;
  return requiredString(value, field, options);
}

function opaque(value, field, { nullable = false, max = 256 } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  const normalized = requiredString(value, field, { max });
  if (/\s/.test(normalized) || /[\\/]/.test(normalized) || /:\/\//.test(normalized) || normalized.startsWith('~')) {
    throw new TypeError(`${field} must be an opaque identifier without paths or locators`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  return normalized;
}

function label(value, field, { nullable = false, max = 160 } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be a non-empty label`);
  }
  const normalized = requiredString(value, field, { max }).replace(/\s+/g, ' ');
  if (normalized.startsWith('/') || normalized.startsWith('~') || /:\/\//.test(normalized)) {
    throw new TypeError(`${field} cannot contain a path or locator`);
  }
  return normalized;
}

function enumValue(value, field, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function isoTimestamp(value, field) {
  const source = requiredString(value, field, { max: 64 });
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function digestOrNull(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
}

function normalizeIdList(value, field, { min = 0, prefix = null } = {}) {
  if (!Array.isArray(value) || value.length < min) throw new TypeError(`${field} must be an array of opaque IDs`);
  const normalized = value.map((entry, index) => {
    const id = opaque(entry, `${field}[${index}]`);
    if (prefix && !id.startsWith(prefix)) throw new TypeError(`${field}[${index}] must start with ${prefix}`);
    return id;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${field} must not contain duplicates`);
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeLabels(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const normalized = value.map((entry, index) => label(entry, `${field}[${index}]`));
  const keys = normalized.map((entry) => entry.toLocaleLowerCase('en-US'));
  if (new Set(keys).size !== keys.length) throw new TypeError(`${field} must not contain duplicate labels`);
  return normalized.sort((left, right) => left.localeCompare(right, 'en-US'));
}

function normalizeReasonCodes(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of opaque IDs`);
  const normalized = value.map((entry, index) => opaque(entry, `${field}[${index}]`).toLocaleLowerCase('en-US'));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${field} must not contain duplicates`);
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeConfidence(value) {
  assertExactKeys(value, CONFIDENCE_FIELDS, 'confidence');
  const result = {};
  for (const axis of CONFIDENCE_AXES) {
    if (typeof value[axis] !== 'number' || !Number.isFinite(value[axis]) || value[axis] < 0 || value[axis] > 1) {
      throw new TypeError(`confidence.${axis} must be a number between 0 and 1`);
    }
    result[axis] = value[axis];
  }
  return result;
}

function normalizeEvidence(input, { correction = false } = {}) {
  const fields = correction ? CORRECTION_FIELDS : EVIDENCE_FIELDS;
  assertKnownKeys(input, fields, correction ? 'correction evidence' : 'evidence unit');
  if (input.contract !== undefined) {
    const expected = correction ? CORRECTION_EVIDENCE_CONTRACT : EVIDENCE_UNIT_CONTRACT;
    if (input.contract !== expected) throw new TypeError(`contract must be ${expected}`);
  }
  const sourceClass = enumValue(input.sourceClass, 'sourceClass', SOURCE_CLASSES);
  const occurredAt = isoTimestamp(input.occurredAt, 'occurredAt');
  const observedAt = isoTimestamp(input.observedAt, 'observedAt');
  const sourceRevision = opaque(input.sourceRevision, 'sourceRevision');
  const sensitivity = enumValue(input.sensitivity, 'sensitivity', SENSITIVITY_CLASSES);
  const coverageState = enumValue(input.coverageState, 'coverageState', COVERAGE_STATES);
  const contentDigest = digestOrNull(input.contentDigest, 'contentDigest');
  const observationSeed = { sourceClass, occurredAt, observedAt, sourceRevision, sensitivity, coverageState, contentDigest };
  const observationId = input.observationId === undefined
    ? `obs_${stableDigest(observationSeed).slice(0, 32)}`
    : opaque(input.observationId, 'observationId');
  const evidenceId = input.evidenceId === undefined
    ? `ev_${stableDigest({ ...observationSeed, observationId }).slice(0, 32)}`
    : opaque(input.evidenceId, 'evidenceId');
  const output = {
    contract: correction ? CORRECTION_EVIDENCE_CONTRACT : EVIDENCE_UNIT_CONTRACT,
    observationId,
    evidenceId,
    sourceClass,
    occurredAt,
    observedAt,
    sourceRevision,
    sensitivity,
    coverageState,
    contentDigest,
  };
  return output;
}

function createEvidenceUnit(input) {
  return normalizeEvidence(input);
}

function validateEvidenceUnit(input) {
  try {
    const evidence = normalizeEvidence(input);
    if (stableStringify(evidence) !== stableStringify(input)) throw new TypeError('evidence unit is not normalized');
    return { ok: true, evidence };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function evidenceUnitDigest(input) {
  const evidence = createEvidenceUnit(input);
  return stableDigest(without(evidence, 'contract'));
}

function normalizeCandidate(input) {
  assertKnownKeys(input, CANDIDATE_FIELDS, 'project candidate');
  if (input.contract !== undefined && input.contract !== PROJECT_CANDIDATE_CONTRACT) {
    throw new TypeError(`contract must be ${PROJECT_CANDIDATE_CONTRACT}`);
  }
  const evidenceIds = normalizeIdList(input.evidenceIds, 'evidenceIds', { min: 1 });
  const evidenceSetWatermark = input.evidenceSetWatermark === undefined
    ? stableDigest({ evidenceIds })
    : digestOrNull(input.evidenceSetWatermark, 'evidenceSetWatermark');
  const engineRevision = opaque(input.engineRevision, 'engineRevision');
  const policyRevision = opaque(input.policyRevision, 'policyRevision');
  const origin = enumValue(input.origin === undefined ? 'inference' : input.origin, 'origin', CANDIDATE_ORIGINS);
  const kind = enumValue(input.kind, 'kind', PROJECT_KINDS);
  const title = label(input.title, 'title');
  const aliases = normalizeLabels(input.aliases === undefined ? [] : input.aliases, 'aliases');
  const parentId = input.parentId === undefined || input.parentId === null ? null : opaque(input.parentId, 'parentId');
  if (parentId && !parentId.startsWith('prj_')) throw new TypeError('parentId must reference a project');
  if (kind === 'outcome' && !parentId) throw new TypeError('outcome candidates require a project parent');
  const parentAlternatives = normalizeIdList(input.parentAlternatives === undefined ? [] : input.parentAlternatives, 'parentAlternatives');
  const confidence = normalizeConfidence(input.confidence);
  const disposition = enumValue(input.disposition === undefined ? 'provisional' : input.disposition, 'disposition', CANDIDATE_DISPOSITIONS);
  const reasonCodes = normalizeReasonCodes(input.reasonCodes === undefined ? [] : input.reasonCodes, 'reasonCodes');
  const lineage = normalizeIdList(input.lineage === undefined ? [] : input.lineage, 'lineage');
  const identity = { origin, evidenceIds };
  const candidateId = input.candidateId === undefined
    ? `cand_${stableDigest(identity).slice(0, 32)}`
    : opaque(input.candidateId, 'candidateId');
  return {
    contract: PROJECT_CANDIDATE_CONTRACT,
    candidateId,
    origin,
    evidenceIds,
    evidenceSetWatermark,
    engineRevision,
    policyRevision,
    kind,
    title,
    aliases,
    parentId,
    parentAlternatives,
    confidence,
    disposition,
    reasonCodes,
    lineage,
  };
}

function createProjectCandidate(input) {
  return normalizeCandidate(input);
}

function validateProjectCandidate(input) {
  try {
    const candidate = normalizeCandidate(input);
    if (stableStringify(candidate) !== stableStringify(input)) throw new TypeError('project candidate is not normalized');
    return { ok: true, candidate };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function projectCandidateDigest(input) {
  const candidate = createProjectCandidate(input);
  return stableDigest(without(candidate, 'contract'));
}

function normalizeCanonical(value) {
  if (value === null || value === undefined) return null;
  assertKnownKeys(value, CANONICAL_FIELDS, 'canonical record metadata');
  const recordId = opaque(value.recordId, 'canonical.recordId');
  const kind = enumValue(value.kind, 'canonical.kind', PROJECT_KINDS);
  if ((kind === 'project' && !recordId.startsWith('prj_')) || (kind === 'outcome' && !recordId.startsWith('out_'))) {
    throw new TypeError('canonical record ID does not match kind');
  }
  const revision = positiveInteger(value.revision, 'canonical.revision');
  const parentId = value.parentId === undefined || value.parentId === null ? null : opaque(value.parentId, 'canonical.parentId');
  if (parentId && !parentId.startsWith('prj_')) throw new TypeError('canonical.parentId must reference a project');
  if (kind === 'outcome' && !parentId) throw new TypeError('outcome canonical records require a project parent');
  return {
    recordId,
    kind,
    revision,
    parentId,
    refDigest: digestOrNull(value.refDigest, 'canonical.refDigest'),
  };
}

function normalizeDecision(input) {
  assertKnownKeys(input, DECISION_FIELDS, 'inference decision');
  if (input.contract !== undefined && input.contract !== INFERENCE_DECISION_CONTRACT) {
    throw new TypeError(`contract must be ${INFERENCE_DECISION_CONTRACT}`);
  }
  const candidateId = opaque(input.candidateId, 'candidateId');
  const policyRevision = opaque(input.policyRevision, 'policyRevision');
  const disposition = enumValue(input.disposition, 'disposition', DECISION_DISPOSITIONS);
  const canonical = normalizeCanonical(input.canonical);
  const reasonCodes = normalizeReasonCodes(input.reasonCodes === undefined ? [] : input.reasonCodes, 'reasonCodes');
  // Suppression keys are policy identifiers, not content/capability digests.
  const suppressionKey = input.suppressionKey === null || input.suppressionKey === undefined
    ? null
    : opaque(input.suppressionKey, 'suppressionKey');
  const supersededBy = input.supersededBy === undefined || input.supersededBy === null ? null : opaque(input.supersededBy, 'supersededBy');
  if (supersededBy && !supersededBy.startsWith('dec_')) throw new TypeError('supersededBy must reference a decision');
  const lineage = normalizeIdList(input.lineage === undefined ? [] : input.lineage, 'lineage');
  const identity = { candidateId, policyRevision, disposition, canonical, reasonCodes, suppressionKey, supersededBy, lineage };
  const decisionId = input.decisionId === undefined
    ? `dec_${stableDigest(identity).slice(0, 32)}`
    : opaque(input.decisionId, 'decisionId');
  return {
    contract: INFERENCE_DECISION_CONTRACT,
    decisionId,
    candidateId,
    policyRevision,
    disposition,
    canonical,
    reasonCodes,
    suppressionKey,
    supersededBy,
    lineage,
  };
}

function createInferenceDecision(input) {
  return normalizeDecision(input);
}

function validateInferenceDecision(input) {
  try {
    const decision = normalizeDecision(input);
    if (stableStringify(decision) !== stableStringify(input)) throw new TypeError('inference decision is not normalized');
    return { ok: true, decision };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function inferenceDecisionDigest(input) {
  const decision = createInferenceDecision(input);
  return stableDigest(without(decision, 'contract'));
}

function normalizeTarget(value) {
  assertExactKeys(value, TARGET_FIELDS, 'correction target');
  const candidateId = value.candidateId === null || value.candidateId === undefined ? null : opaque(value.candidateId, 'target.candidateId');
  const canonicalId = value.canonicalId === null || value.canonicalId === undefined ? null : opaque(value.canonicalId, 'target.canonicalId');
  const alias = value.alias === null || value.alias === undefined ? null : label(value.alias, 'target.alias');
  if (!candidateId && !canonicalId && !alias) throw new TypeError('correction target must identify a candidate, canonical record, or alias');
  return { candidateId, canonicalId, alias };
}

function normalizeAssertedChange(value) {
  assertExactKeys(value, ASSERTED_CHANGE_FIELDS, 'correction asserted change');
  const kind = value.kind === null || value.kind === undefined ? null : enumValue(value.kind, 'assertedChange.kind', PROJECT_KINDS);
  const parentId = value.parentId === null || value.parentId === undefined ? null : opaque(value.parentId, 'assertedChange.parentId');
  if (parentId && !parentId.startsWith('prj_')) throw new TypeError('assertedChange.parentId must reference a project');
  return {
    title: value.title === null || value.title === undefined ? null : label(value.title, 'assertedChange.title'),
    aliases: normalizeLabels(value.aliases === undefined ? [] : value.aliases, 'assertedChange.aliases'),
    parentId,
    kind,
    canonicalId: value.canonicalId === null || value.canonicalId === undefined ? null : opaque(value.canonicalId, 'assertedChange.canonicalId'),
  };
}

function normalizeAdmission(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, ADMISSION_FIELDS, 'correction admission');
  return {
    issuerId: opaque(value.issuerId, 'admission.issuerId'),
    authorityDigest: digestOrNull(value.authorityDigest, 'admission.authorityDigest'),
    claimDigest: digestOrNull(value.claimDigest, 'admission.claimDigest'),
    signature: digestOrNull(value.signature, 'admission.signature'),
  };
}

function normalizeAttestation(value) {
  const source = value === undefined ? { method: 'conversation-text', admission: null } : value;
  // Creation may omit the derived status, but persisted corrections still
  // normalize to the exact method/admission/status shape.
  assertKnownKeys(source, ATTESTATION_FIELDS, 'correction attestation');
  const method = enumValue(source.method, 'attestation.method', CORRECTION_ATTESTATION_METHODS);
  const admission = normalizeAdmission(source.admission);
  const requestedStatus = source.status === undefined ? null : enumValue(source.status, 'attestation.status', ['verified', 'unverified']);
  if (admission && !VERIFIED_ATTESTATION_METHODS.includes(method)) {
    throw new TypeError('support-only correction methods cannot carry an admission');
  }
  const status = admission ? 'verified' : 'unverified';
  if (requestedStatus && requestedStatus !== status) throw new TypeError('correction attestation status does not match its admission');
  return { method, admission, status };
}

function attestorState(value) {
  return value && typeof value === 'object' ? ATTESTOR_STATE.get(value) || null : null;
}

function trustedAttestor(options) {
  if (!options) return null;
  const candidate = options.attestor === undefined
    ? (attestorState(options) ? options : (Object.keys(options).length === 0 ? null : options))
    : options.attestor;
  if (candidate === null || candidate === undefined) return null;
  if (!attestorState(candidate)) throw new TypeError('correction verification requires a trusted host attestor');
  return candidate;
}

function correctionClaim(correction) {
  return without(correction, 'contract', 'attestation', 'trustTier');
}

function normalizeCorrection(input, { attestor = null } = {}) {
  // Creation accepts omitted derived fields (contract/correctionId), while
  // validation below still emits and checks one exact normalized shape.
  assertKnownKeys(input, CORRECTION_FIELDS, 'correction evidence');
  if (input.contract !== undefined && input.contract !== CORRECTION_EVIDENCE_CONTRACT) {
    throw new TypeError(`contract must be ${CORRECTION_EVIDENCE_CONTRACT}`);
  }
  const trusted = attestor ? trustedAttestor(attestor) : null;
  const evidence = normalizeEvidence(input, { correction: true });
  const target = normalizeTarget(input.target);
  const operation = enumValue(input.operation, 'operation', CORRECTION_OPERATIONS);
  const assertedChange = normalizeAssertedChange(input.assertedChange);
  const attestation = normalizeAttestation(input.attestation);
  const trustTier = attestation.status === 'verified' ? 'verified' : 'unverified';
  const identity = { evidenceId: evidence.evidenceId, target, operation, assertedChange };
  const correctionId = input.correctionId === undefined
    ? `corr_${stableDigest(identity).slice(0, 32)}`
    : opaque(input.correctionId, 'correctionId');
  const correction = {
    ...evidence,
    correctionId,
    target,
    operation,
    assertedChange,
    attestation,
    trustTier,
  };
  if (attestation.status === 'verified') {
    if (!trusted) throw new TypeError('verified correction admission requires a trusted host attestor');
    const state = attestorState(trusted);
    if (!state.verifyAdmission(correction)) throw new TypeError('correction admission signature or claim is invalid');
  }
  return correction;
}

function createCorrectionEvidence(input, options = {}) {
  return normalizeCorrection(input, { attestor: trustedAttestor(options) });
}

function createCorrection(input, options = {}) {
  return createCorrectionEvidence(input, options);
}

function validateCorrectionEvidence(input, options = {}) {
  try {
    const correction = createCorrectionEvidence(input, options);
    if (stableStringify(correction) !== stableStringify(input)) throw new TypeError('correction evidence is not normalized');
    return { ok: true, correction };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateCorrection(input, options = {}) {
  return validateCorrectionEvidence(input, options);
}

function correctionClaimDigest(input, options = {}) {
  const correction = createCorrectionEvidence(input, options);
  return stableDigest(correctionClaim(correction));
}

function correctionDigest(input, options = {}) {
  const correction = createCorrectionEvidence(input, options);
  return stableDigest(without(correction, 'contract'));
}

function verifyCorrection(input, attestor) {
  try {
    const trusted = trustedAttestor(attestor);
    if (!trusted) return false;
    const correction = normalizeCorrection(input, { attestor: trusted });
    return correction.trustTier === 'verified' && correction.attestation.status === 'verified';
  } catch (_) {
    return false;
  }
}

function isVerifiedCorrection(input, attestor) {
  return verifyCorrection(input, attestor);
}

function normalizeAttestorList(value, field, allowed) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`);
  const normalized = value.map((entry) => enumValue(entry, `${field} entry`, allowed));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${field} must not contain duplicates`);
  return normalized.sort((left, right) => left.localeCompare(right));
}

function secretBytes(value) {
  if (typeof value === 'string') {
    if (!value) throw new TypeError('attestor.secret must not be empty');
    return Buffer.from(value, 'utf8');
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    if (value.length === 0) throw new TypeError('attestor.secret must not be empty');
    return Buffer.from(value);
  }
  throw new TypeError('attestor.secret must be a non-empty string or byte array');
}

function createCorrectionAttestor(input) {
  assertKnownKeys(input, ['issuerId', 'secret', 'allowedMethods', 'allowedSourceClasses'], 'correction attestor');
  const issuerId = opaque(input.issuerId, 'attestor.issuerId');
  const secret = secretBytes(input.secret);
  const allowedMethods = normalizeAttestorList(
    input.allowedMethods === undefined ? VERIFIED_ATTESTATION_METHODS : input.allowedMethods,
    'attestor.allowedMethods',
    VERIFIED_ATTESTATION_METHODS,
  );
  const allowedSourceClasses = normalizeAttestorList(
    input.allowedSourceClasses === undefined ? SOURCE_CLASSES : input.allowedSourceClasses,
    'attestor.allowedSourceClasses',
    SOURCE_CLASSES,
  );
  const authorityDigest = stableDigest({
    contract: CORRECTION_ADMISSION_CONTRACT,
    issuerId,
    allowedMethods,
    allowedSourceClasses,
  });
  const state = {
    issuerId,
    secret,
    authorityDigest,
    allowedMethods,
    allowedSourceClasses,
    signatureFor(correction, admission) {
      const signingPayload = {
        contract: CORRECTION_ADMISSION_CONTRACT,
        issuerId: admission.issuerId,
        authorityDigest: admission.authorityDigest,
        claimDigest: admission.claimDigest,
        method: correction.attestation.method,
        sourceClass: correction.sourceClass,
      };
      return crypto.createHmac('sha256', secret).update(stableStringify(signingPayload)).digest('hex');
    },
    verifyAdmission(correction) {
      const admission = correction.attestation.admission;
      if (!admission || admission.issuerId !== issuerId || admission.authorityDigest !== authorityDigest) return false;
      if (!allowedMethods.includes(correction.attestation.method) || !allowedSourceClasses.includes(correction.sourceClass)) return false;
      if (admission.claimDigest !== stableDigest(correctionClaim(correction))) return false;
      const expected = this.signatureFor(correction, admission);
      const actual = Buffer.from(admission.signature, 'hex');
      const expectedBytes = Buffer.from(expected, 'hex');
      return actual.length === expectedBytes.length && crypto.timingSafeEqual(actual, expectedBytes);
    },
  };
  const sign = (inputCorrection) => {
    const correction = createCorrectionEvidence(inputCorrection);
    if (!allowedMethods.includes(correction.attestation.method)) {
      throw new TypeError('correction attestation method is not allowed by this host attestor');
    }
    if (!allowedSourceClasses.includes(correction.sourceClass)) {
      throw new TypeError('correction source class is not allowed by this host attestor');
    }
    const claimDigest = stableDigest(correctionClaim(correction));
    const unsignedAdmission = { issuerId, authorityDigest, claimDigest, signature: '0'.repeat(64) };
    const admission = {
      ...unsignedAdmission,
      signature: state.signatureFor(correction, unsignedAdmission),
    };
    return createCorrectionEvidence({
      ...correction,
      attestation: { method: correction.attestation.method, admission, status: 'verified' },
    }, { attestor: attestor });
  };
  const adopt = (inputCorrection) => createCorrectionEvidence(inputCorrection, { attestor });
  const attestor = {
    issuerId,
    authorityDigest,
    allowedMethods: Object.freeze([...allowedMethods]),
    allowedSourceClasses: Object.freeze([...allowedSourceClasses]),
    attest(inputCorrection) {
      if (inputCorrection && inputCorrection.attestation && inputCorrection.attestation.admission) return adopt(inputCorrection);
      return sign(inputCorrection);
    },
    adopt,
    verify(inputCorrection) {
      return verifyCorrection(inputCorrection, attestor);
    },
  };
  ATTESTOR_STATE.set(attestor, state);
  return Object.freeze(attestor);
}

function normalizeCoverage(input) {
  assertKnownKeys(input, COVERAGE_FIELDS, 'coverage status');
  if (input.contract !== undefined && input.contract !== COVERAGE_CONTRACT) throw new TypeError(`contract must be ${COVERAGE_CONTRACT}`);
  return {
    contract: COVERAGE_CONTRACT,
    sourceClass: enumValue(input.sourceClass, 'sourceClass', SOURCE_CLASSES),
    state: enumValue(input.state, 'state', COVERAGE_STATES),
    observedAt: isoTimestamp(input.observedAt, 'observedAt'),
    sourceRevision: opaque(input.sourceRevision, 'sourceRevision'),
  };
}

function createCoverageStatus(input) {
  return normalizeCoverage(input);
}

function validateCoverageStatus(input) {
  try {
    const coverage = normalizeCoverage(input);
    if (stableStringify(coverage) !== stableStringify(input)) throw new TypeError('coverage status is not normalized');
    return { ok: true, coverage };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  ADMISSION_FIELDS,
  ASSERTED_CHANGE_FIELDS,
  ATTESTATION_FIELDS,
  CANDIDATE_DISPOSITIONS,
  CANDIDATE_FIELDS,
  CANDIDATE_ORIGINS,
  CANONICAL_FIELDS,
  CORRECTION_ATTESTATION_METHODS,
  CORRECTION_ADMISSION_CONTRACT,
  CORRECTION_EVIDENCE_CONTRACT,
  CORRECTION_FIELDS,
  CORRECTION_OPERATIONS,
  COVERAGE_CONTRACT,
  COVERAGE_FIELDS,
  COVERAGE_STATES,
  CONFIDENCE_AXES,
  CONFIDENCE_FIELDS,
  DECISION_DISPOSITIONS,
  DECISION_FIELDS,
  EVIDENCE_FIELDS,
  EVIDENCE_UNIT_CONTRACT,
  INFERENCE_DECISION_CONTRACT,
  PROJECT_CANDIDATE_CONTRACT,
  PROJECT_KINDS,
  SENSITIVITY_CLASSES,
  SOURCE_CLASSES,
  TARGET_FIELDS,
  VERIFIED_ATTESTATION_METHODS,
  clone,
  correctionClaimDigest,
  correctionDigest,
  createCorrectionAttestor,
  createCorrection,
  createCorrectionEvidence,
  createCoverageStatus,
  createEvidenceUnit,
  createInferenceDecision,
  createProjectCandidate,
  evidenceUnitDigest,
  inferenceDecisionDigest,
  isPlainObject,
  isVerifiedCorrection,
  projectCandidateDigest,
  stableDigest,
  stableStringify,
  verifyCorrection,
  validateCorrection,
  validateCorrectionEvidence,
  validateCoverageStatus,
  validateEvidenceUnit,
  validateInferenceDecision,
  validateProjectCandidate,
};
