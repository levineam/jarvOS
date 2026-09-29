'use strict';

// Pure, metadata-only durable work event contract. A host collector observes a
// commit, merged PR, applied migration, ready deployment, or verified
// production behavior and describes it only with hashed session/repository
// tokens, optional Git/PR identity, opaque evidence references, timestamps,
// and an invocation reference. This module performs no I/O. It never accepts
// paths, URLs, commands, prompts, stdout, commit subjects, or credentials.

const crypto = require('node:crypto');

const DURABLE_WORK_EVENT_CONTRACT = 'jarvos.durable-work-event/v1';
const EVENT_KINDS = Object.freeze(['commit', 'merged_pr', 'migration_applied', 'deployment_ready', 'production_verified']);
const EVENT_FIELDS = Object.freeze([
  'contract', 'eventKind', 'harness', 'sessionDigest', 'repositoryDigest', 'worktreeDigest', 'branchDigest',
  'pullRequest', 'commitOid', 'subjectRef', 'causalKey', 'evidenceRefs', 'occurredAt', 'observedAt', 'invocationRef',
]);
const EVENT_INPUT_FIELDS = Object.freeze(EVENT_FIELDS.filter((field) => field !== 'contract' && field !== 'causalKey'));
const RECEIPT_KIND_PREFIX = 'durable_work_';
const RECEIPT_SENSITIVITY = 'metadata-only';
const MAX_EVIDENCE_REFS = 16;
const MAX_EVENT_BYTES = 4096;
const MAX_PULL_REQUEST = 10_000_000;

const DIGEST = /^[a-f0-9]{64}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
const COMMIT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const CAUSAL_KEY = /^dwe_[a-f0-9]{32}$/;
const INVOCATION_REF = /^inv_[a-f0-9]{32}$/;
// A subject reference names an external durable fact by an opaque id (a
// migration version, a deployment id, a verification id). No separators that
// could form a path or URL, and no whitespace.
const SUBJECT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
// Evidence references are `<class>:<opaque id>` tokens, e.g. `git-commit:<oid>`,
// `marker:<id>`, `harness:claude`. Never a path or URL.
const EVIDENCE_REF = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Credential-shaped values are rejected by label prefix or known secret-key
// shape, mirroring the runtime-kit refresh validator.
const CREDENTIAL_LABEL = /(?:^|:)(?:bearer|api[-_]?key|apikey|secret|password|passwd|credential|authorization|auth|token)s?(?::|$)/i;
const CREDENTIAL_SHAPE = /(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex'); }

function credentialShaped(value) {
  return CREDENTIAL_LABEL.test(value) || CREDENTIAL_SHAPE.test(value);
}

function token(value, pattern, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} is required`);
  }
  if (typeof value !== 'string' || value.length > 160 || !pattern.test(value) || credentialShaped(value)) {
    throw new TypeError(`${field} is not a bounded metadata token`);
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value)) || /\s/.test(value.trim()) || value !== value.trim()) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function pullRequestNumber(value, field) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PULL_REQUEST) throw new TypeError(`${field} must be a positive pull request number`);
  return value;
}

function evidenceRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_REFS) throw new TypeError('evidenceRefs must be a bounded non-empty array');
  const refs = value.map((ref, index) => token(ref, EVIDENCE_REF, `evidenceRefs[${index}]`));
  if (new Set(refs).size !== refs.length) throw new TypeError('evidenceRefs must not contain duplicates');
  return [...refs].sort();
}

// The causal key is deterministic over the durable fact itself -- kind,
// repository, and the fact's own identity -- and deliberately excludes the
// session, harness, worktree, branch, evidence, and times. The same commit
// observed from two harnesses or a linked worktree therefore dedupes into one
// ActivityStore record instead of conflicting.
function durableWorkCausalKey({ eventKind, repositoryDigest, pullRequest = null, commitOid = null, subjectRef = null } = {}) {
  return `dwe_${sha256({
    contract: DURABLE_WORK_EVENT_CONTRACT,
    eventKind,
    repositoryDigest,
    pullRequest: pullRequest === undefined ? null : pullRequest,
    commitOid: commitOid === undefined || commitOid === null ? null : String(commitOid).toLowerCase(),
    subjectRef: subjectRef === undefined ? null : subjectRef,
  }).slice(0, 32)}`;
}

function normalizeFields(input) {
  const eventKind = input.eventKind;
  if (!EVENT_KINDS.includes(eventKind)) throw new TypeError('eventKind is unsupported');
  const normalized = {
    contract: DURABLE_WORK_EVENT_CONTRACT,
    eventKind,
    harness: token(input.harness, HARNESS, 'harness'),
    sessionDigest: token(input.sessionDigest, DIGEST, 'sessionDigest'),
    repositoryDigest: token(input.repositoryDigest, DIGEST, 'repositoryDigest'),
    worktreeDigest: token(input.worktreeDigest, DIGEST, 'worktreeDigest', { nullable: true }),
    branchDigest: token(input.branchDigest, DIGEST, 'branchDigest', { nullable: true }),
    pullRequest: pullRequestNumber(input.pullRequest, 'pullRequest'),
    commitOid: input.commitOid === null || input.commitOid === undefined
      ? null
      : token(String(input.commitOid).toLowerCase(), COMMIT_OID, 'commitOid'),
    subjectRef: token(input.subjectRef, SUBJECT_REF, 'subjectRef', { nullable: true }),
    causalKey: null,
    evidenceRefs: evidenceRefs(input.evidenceRefs),
    occurredAt: timestamp(input.occurredAt, 'occurredAt'),
    observedAt: timestamp(input.observedAt, 'observedAt'),
    invocationRef: token(input.invocationRef, INVOCATION_REF, 'invocationRef'),
  };
  if (Date.parse(normalized.occurredAt) > Date.parse(normalized.observedAt)) throw new RangeError('occurredAt must not be after observedAt');
  // Kind-specific identity. Each durable fact must carry exactly the identity
  // that makes its causal key meaningful; nothing more is inferred.
  if (eventKind === 'commit') {
    if (!normalized.commitOid || normalized.subjectRef !== null) throw new TypeError('commit events require commitOid and no subjectRef');
  } else if (eventKind === 'merged_pr') {
    if (normalized.pullRequest === null || normalized.subjectRef !== null) throw new TypeError('merged_pr events require pullRequest and no subjectRef');
  } else if (normalized.subjectRef === null) {
    throw new TypeError(`${eventKind} events require subjectRef`);
  }
  normalized.causalKey = durableWorkCausalKey(normalized);
  return normalized;
}

function checkBytes(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_EVENT_BYTES) throw new RangeError('durable work event exceeds its byte bound');
}

function createDurableWorkEvent(input) {
  if (!isPlainObject(input)) throw new TypeError('durable work event input must be an object');
  if (Object.prototype.hasOwnProperty.call(input, 'contract') || Object.prototype.hasOwnProperty.call(input, 'causalKey')) {
    throw new TypeError('durable work event input must not assert its own contract or causal key');
  }
  const unknown = Object.keys(input).filter((key) => !EVENT_INPUT_FIELDS.includes(key));
  if (unknown.length) throw new TypeError('durable work event input has unsupported fields');
  const normalized = normalizeFields(input);
  checkBytes(normalized);
  return normalized;
}

function validateDurableWorkEvent(event) {
  try {
    if (!exactKeys(event, EVENT_FIELDS)) throw new TypeError('durable work event has unsupported fields');
    if (event.contract !== DURABLE_WORK_EVENT_CONTRACT) throw new TypeError('durable work event has an unsupported contract');
    token(event.causalKey, CAUSAL_KEY, 'causalKey');
    checkBytes(event);
    const normalized = normalizeFields(event);
    if (normalized.causalKey !== event.causalKey) throw new TypeError('causalKey does not match the durable fact');
    if (stableStringify(normalized) !== stableStringify(event)) throw new TypeError('durable work event is not normalized');
    return { ok: true, event: normalized };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Projects a valid event into the existing jarvos.verified-activity/v1 base
// receipt. The ActivityStore persistence format is unchanged: the event's
// causal key is both the receipt event id and its dedupe key, and only opaque
// evidence references plus the observing harness are carried forward. The
// session digest, invocation reference, worktree, and branch stay out of the
// canonical record so an identical replay is byte-for-byte identical.
function projectDurableWorkEvent(event, { canonicalId, producerId } = {}) {
  const validation = validateDurableWorkEvent(event);
  if (!validation.ok) throw new TypeError(`durable work event is invalid: ${validation.reason}`);
  const normalized = validation.event;
  if (typeof canonicalId !== 'string' || !/^(?:prj|out)_[0-9]{6,}$/.test(canonicalId)) throw new TypeError('canonicalId must be a canonical project or outcome ID');
  if (typeof producerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(producerId)) throw new TypeError('producerId must be an opaque identifier');
  const harnessRef = `harness:${normalized.harness}`;
  return {
    contract: 'jarvos.verified-activity/v1',
    eventId: normalized.causalKey,
    canonicalId,
    producerId,
    kind: `${RECEIPT_KIND_PREFIX}${normalized.eventKind}`,
    occurredAt: normalized.occurredAt,
    observedAt: normalized.observedAt,
    evidenceRefs: [...new Set([...normalized.evidenceRefs, harnessRef])].sort(),
    sourceRevision: normalized.commitOid || normalized.subjectRef || `pr-${normalized.pullRequest}`,
    sensitivity: RECEIPT_SENSITIVITY,
    dedupeKey: normalized.causalKey,
  };
}

function receiptKind(eventKind) {
  if (!EVENT_KINDS.includes(eventKind)) throw new TypeError('eventKind is unsupported');
  return `${RECEIPT_KIND_PREFIX}${eventKind}`;
}

function invocationReference(nonce) {
  if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) throw new TypeError('invocation nonce is required');
  return `inv_${sha256({ contract: DURABLE_WORK_EVENT_CONTRACT, kind: 'invocation', nonce }).slice(0, 32)}`;
}

module.exports = {
  DURABLE_WORK_EVENT_CONTRACT,
  EVENT_FIELDS,
  EVENT_INPUT_FIELDS,
  EVENT_KINDS,
  MAX_EVENT_BYTES,
  MAX_EVIDENCE_REFS,
  RECEIPT_KINDS: Object.freeze(EVENT_KINDS.map((kind) => `${RECEIPT_KIND_PREFIX}${kind}`)),
  RECEIPT_SENSITIVITY,
  createDurableWorkEvent,
  durableWorkCausalKey,
  invocationReference,
  projectDurableWorkEvent,
  receiptKind,
  validateDurableWorkEvent,
};
