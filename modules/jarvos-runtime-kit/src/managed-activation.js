'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANAGED_ACTIVATION_CONTRACT_VERSION = 'jarvos-managed-activation/v1';
const MANAGED_ACTIVATION_RECEIPT_VERSION = 'jarvos-managed-activation-receipt/v1';
const MANAGED_ACTIVATION_STATUS_VERSION = 'jarvos-managed-activation-status/v1';
const LIVE_PROOF_FRESHNESS_SECONDS = 900;
const LIVE_PROOF_FORWARD_SKEW_SECONDS = 30;

const CANONICAL_HARNESS_IDS = Object.freeze(new Set(['claude', 'codex', 'hermes', 'openclaw']));
const HARNESS_ALIASES = Object.freeze(Object.create(null, {
  'claude-code': { value: 'claude', enumerable: true },
}));

const MANAGED_ACTIVATION_STATES = Object.freeze(new Set([
  'unconfigured',
  'prepared',
  'awaiting_live_proof',
  'active',
  'degraded',
  'rollback_pending',
  'rolled_back',
]));

const MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES = Object.freeze(new Set(['session', 'turn']));
const MANAGED_ACTIVATION_RECEIPT_PRODUCERS = Object.freeze(new Set([
  'selected-runtime-bridge',
  'test-fixture',
]));
const MANAGED_ACTIVATION_PRODUCER_EVENTS = Object.freeze({
  claude: Object.freeze({ session: 'SessionStart', turn: 'UserPromptSubmit' }),
  codex: Object.freeze({ session: 'SessionStart', turn: 'UserPromptSubmit' }),
  hermes: Object.freeze({ session: 'managed_session_start', turn: 'pre_llm_call' }),
  openclaw: Object.freeze({ session: 'managed_session_start', turn: 'agent_turn_prepare' }),
});

const MANAGED_ACTIVATION_REASON_CODES = Object.freeze(new Set([
  'missing_configuration',
  'prepared',
  'awaiting_live_proof',
  'no_live_receipt',
  'live_proof_fresh',
  'receipt_stale',
  'receipt_future',
  'receipt_invalid',
  'receipt_before_baseline',
  'receipt_replay',
  'challenge_mismatch',
  'selected_tuple_mismatch',
  'asset_digest_mismatch',
  'entrypoint_digest_mismatch',
  'config_binding_mismatch',
  'attestation_unavailable',
  'health_degraded',
  'health_unavailable',
  'rollback_pending',
  'rollback_refused_modified',
  'generation_invalidated',
  'rolled_back',
  'invalid_evidence',
  'unknown_harness',
  'sequence_incomplete',
  'sequence_out_of_order',
  'evidence_unreadable',
  'unsafe_path',
]));

const CONTRACT_FIELDS = new Set([
  'version',
  'harness',
  'executionOwner',
  'backgroundProcess',
  'preparation',
  'liveProof',
  'health',
  'rollback',
]);

const RECEIPT_FIELDS = new Set([
  'schemaVersion',
  'harness',
  'correlation',
  'eventClass',
  'producer',
  'producerEvent',
  'tupleDigest',
  'producedAt',
]);

const PUBLIC_STATUS_FIELDS = Object.freeze([
  'schemaVersion',
  'harness',
  'state',
  'generationDigest',
  'evidenceClasses',
  'freshThrough',
  'reasons',
  'evaluatedAt',
]);

const EXECUTION_OWNERS = new Set(['native-hooks', 'harness-process']);
const BACKGROUND_OWNERS = new Set(['none', 'harness']);
const ROLLBACK_OWNERSHIP = new Set(['exact-owned']);
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256Text(value) {
  return sha256Buffer(Buffer.from(String(value), 'utf8'));
}

function unknownFields(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} has unknown field: ${key}`);
  }
}

function parseIsoMs(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

/** Canonicalize public harness ids; `claude-code` is accepted only as an alias. */
function normalizeHarnessId(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (CANONICAL_HARNESS_IDS.has(value)) return value;
  if (Object.prototype.hasOwnProperty.call(HARNESS_ALIASES, value)) return HARNESS_ALIASES[value];
  return null;
}

function validateBackgroundProcess(background, errors) {
  if (!isObject(background)) {
    errors.push('backgroundProcess must be an object');
    return;
  }
  unknownFields(background, new Set(['owner', 'jarvosStartsProcess']), 'backgroundProcess', errors);
  if (!BACKGROUND_OWNERS.has(background.owner)) {
    errors.push('backgroundProcess.owner must be none or harness');
  }
  if (background.jarvosStartsProcess !== false) {
    errors.push('backgroundProcess.jarvosStartsProcess must be false');
  }
}

function validatePreparation(preparation, errors) {
  if (!isObject(preparation)) {
    errors.push('preparation must be an object');
    return;
  }
  unknownFields(preparation, new Set(['requiresExactSetup', 'requiresSelectedTuple']), 'preparation', errors);
  if (preparation.requiresExactSetup !== true) errors.push('preparation.requiresExactSetup must be true');
  if (preparation.requiresSelectedTuple !== true) errors.push('preparation.requiresSelectedTuple must be true');
}

function validateLiveProof(liveProof, errors) {
  if (!isObject(liveProof)) {
    errors.push('liveProof must be an object');
    return;
  }
  unknownFields(
    liveProof,
    new Set(['qualifyingEventClasses', 'requiredSequence', 'producerEvents', 'freshnessSeconds', 'forwardSkewSeconds']),
    'liveProof',
    errors,
  );
  const hasQualifying = Array.isArray(liveProof.qualifyingEventClasses);
  const hasSequence = Array.isArray(liveProof.requiredSequence);
  if (hasQualifying === hasSequence) {
    errors.push('liveProof must declare exactly one of qualifyingEventClasses or requiredSequence');
  }
  if (hasQualifying) {
    if (liveProof.qualifyingEventClasses.length === 0
      || liveProof.qualifyingEventClasses.some((value) => !MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES.has(value))
      || new Set(liveProof.qualifyingEventClasses).size !== liveProof.qualifyingEventClasses.length) {
      errors.push('liveProof.qualifyingEventClasses must be a unique non-empty list of session|turn');
    }
  }
  if (hasSequence) {
    if (liveProof.requiredSequence.length < 2
      || liveProof.requiredSequence.some((value) => !MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES.has(value))) {
      errors.push('liveProof.requiredSequence must list at least two session|turn classes');
    }
  }
  if (!isObject(liveProof.producerEvents)) {
    errors.push('liveProof.producerEvents must declare exact session and turn lifecycle events');
  } else {
    unknownFields(liveProof.producerEvents, new Set(['session', 'turn']), 'liveProof.producerEvents', errors);
    // Harness-specific equality is enforced by the parent contract validator;
    // this structural pass still requires both bounded event names.
    for (const eventClass of ['session', 'turn']) {
      if (typeof liveProof.producerEvents[eventClass] !== 'string'
        || !/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/.test(liveProof.producerEvents[eventClass])) {
        errors.push(`liveProof.producerEvents.${eventClass} must be a bounded lifecycle event`);
      }
    }
  }
  if (liveProof.freshnessSeconds !== LIVE_PROOF_FRESHNESS_SECONDS) {
    errors.push(`liveProof.freshnessSeconds must be ${LIVE_PROOF_FRESHNESS_SECONDS}`);
  }
  if (liveProof.forwardSkewSeconds !== LIVE_PROOF_FORWARD_SKEW_SECONDS) {
    errors.push(`liveProof.forwardSkewSeconds must be ${LIVE_PROOF_FORWARD_SKEW_SECONDS}`);
  }
}

function validateHealth(health, errors) {
  if (!isObject(health)) {
    errors.push('health must be an object');
    return;
  }
  unknownFields(health, new Set(['mayActivate', 'mayExplainDegradation']), 'health', errors);
  if (health.mayActivate !== false) errors.push('health.mayActivate must be false');
  if (health.mayExplainDegradation !== true) errors.push('health.mayExplainDegradation must be true');
}

function validateRollback(rollback, errors) {
  if (!isObject(rollback)) {
    errors.push('rollback must be an object');
    return;
  }
  unknownFields(rollback, new Set(['ownership', 'invalidatesGeneration', 'refuseModified']), 'rollback', errors);
  if (!ROLLBACK_OWNERSHIP.has(rollback.ownership)) errors.push('rollback.ownership must be exact-owned');
  if (rollback.invalidatesGeneration !== true) errors.push('rollback.invalidatesGeneration must be true');
  if (rollback.refuseModified !== true) errors.push('rollback.refuseModified must be true');
}

function validateManagedActivationContract(contract) {
  const errors = [];
  if (!isObject(contract)) return { ok: false, errors: ['managed activation contract must be an object'] };
  unknownFields(contract, CONTRACT_FIELDS, 'managed activation contract', errors);
  if (contract.version !== MANAGED_ACTIVATION_CONTRACT_VERSION) {
    errors.push(`managed activation contract.version must be ${MANAGED_ACTIVATION_CONTRACT_VERSION}`);
  }
  const harness = normalizeHarnessId(contract.harness);
  if (!harness) errors.push('managed activation contract.harness must be a supported harness id');
  if (!EXECUTION_OWNERS.has(contract.executionOwner)) {
    errors.push('managed activation contract.executionOwner must be native-hooks or harness-process');
  }
  validateBackgroundProcess(contract.backgroundProcess, errors);
  validatePreparation(contract.preparation, errors);
  validateLiveProof(contract.liveProof, errors);
  if (harness && isObject(contract.liveProof?.producerEvents)) {
    for (const eventClass of ['session', 'turn']) {
      if (contract.liveProof.producerEvents[eventClass] !== MANAGED_ACTIVATION_PRODUCER_EVENTS[harness][eventClass]) {
        errors.push(`liveProof.producerEvents.${eventClass} must be ${MANAGED_ACTIVATION_PRODUCER_EVENTS[harness][eventClass]} for ${harness}`);
      }
    }
  }
  validateHealth(contract.health, errors);
  validateRollback(contract.rollback, errors);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      ...contract,
      harness,
    },
  };
}

function computeTupleDigest({
  harness,
  generation,
  assetDigest,
  entrypointDigest,
  configBindingDigest,
} = {}) {
  const normalizedHarness = normalizeHarnessId(harness);
  if (!normalizedHarness) throw new TypeError('tuple harness is required');
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) {
    throw new TypeError('tuple generation is required');
  }
  for (const [name, value] of [
    ['assetDigest', assetDigest],
    ['entrypointDigest', entrypointDigest],
    ['configBindingDigest', configBindingDigest],
  ]) {
    if (!isSha256(value)) throw new TypeError(`tuple ${name} must be a SHA-256 digest`);
  }
  const canonical = [
    `harness=${normalizedHarness}`,
    `generation=${generation}`,
    `assetDigest=${assetDigest.toLowerCase()}`,
    `entrypointDigest=${entrypointDigest.toLowerCase()}`,
    `configBindingDigest=${configBindingDigest.toLowerCase()}`,
  ].join('\n');
  return sha256Text(canonical);
}

function buildSelectedTuple(input = {}) {
  const harness = normalizeHarnessId(input.harness);
  if (!harness) throw new TypeError('selected tuple harness is required');
  const tuple = {
    harness,
    generation: input.generation,
    assetDigest: typeof input.assetDigest === 'string' ? input.assetDigest.toLowerCase() : input.assetDigest,
    entrypointDigest: typeof input.entrypointDigest === 'string' ? input.entrypointDigest.toLowerCase() : input.entrypointDigest,
    configBindingDigest: typeof input.configBindingDigest === 'string' ? input.configBindingDigest.toLowerCase() : input.configBindingDigest,
  };
  tuple.tupleDigest = computeTupleDigest(tuple);
  return tuple;
}

function validateManagedActivationReceipt(receipt, { allowTestFixture = false } = {}) {
  const errors = [];
  if (!isObject(receipt)) return { ok: false, errors: ['managed activation receipt must be an object'] };
  unknownFields(receipt, RECEIPT_FIELDS, 'managed activation receipt', errors);
  if (receipt.schemaVersion !== MANAGED_ACTIVATION_RECEIPT_VERSION) {
    errors.push(`receipt.schemaVersion must be ${MANAGED_ACTIVATION_RECEIPT_VERSION}`);
  }
  const harness = normalizeHarnessId(receipt.harness);
  if (!harness) errors.push('receipt.harness must be a supported harness id');
  if (typeof receipt.correlation !== 'string' || !CORRELATION_PATTERN.test(receipt.correlation)) {
    errors.push('receipt.correlation must be a bounded opaque identifier');
  }
  if (!MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES.has(receipt.eventClass)) {
    errors.push('receipt.eventClass must be session or turn');
  }
  if (!MANAGED_ACTIVATION_RECEIPT_PRODUCERS.has(receipt.producer)) {
    errors.push('receipt.producer must be selected-runtime-bridge or test-fixture');
  } else if (receipt.producer === 'test-fixture' && allowTestFixture !== true) {
    errors.push('receipt.producer test-fixture is not accepted outside explicit test verification');
  }
  const expectedProducerEvent = harness
    && MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES.has(receipt.eventClass)
    ? MANAGED_ACTIVATION_PRODUCER_EVENTS[harness]?.[receipt.eventClass]
    : null;
  if (!expectedProducerEvent || receipt.producerEvent !== expectedProducerEvent) {
    errors.push('receipt.producerEvent must match the harness lifecycle event for eventClass');
  }
  if (!isSha256(receipt.tupleDigest)) errors.push('receipt.tupleDigest must be a SHA-256 digest');
  if (!Number.isFinite(parseIsoMs(receipt.producedAt))) {
    errors.push('receipt.producedAt must be an ISO-8601 UTC timestamp');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      schemaVersion: MANAGED_ACTIVATION_RECEIPT_VERSION,
      harness,
      correlation: receipt.correlation,
      eventClass: receipt.eventClass,
      producer: receipt.producer,
      producerEvent: receipt.producerEvent,
      tupleDigest: receipt.tupleDigest.toLowerCase(),
      producedAt: receipt.producedAt,
    },
  };
}

function safeReason(code) {
  return MANAGED_ACTIVATION_REASON_CODES.has(code) ? code : 'invalid_evidence';
}

function failClosed(reasonCode, extra = {}) {
  return {
    ok: false,
    reasonCode: safeReason(reasonCode),
    ...extra,
  };
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function permissionBits(mode) {
  return mode & 0o777;
}

function isSticky(mode) {
  return (mode & 0o1000) !== 0;
}

function isGroupOrWorldWritable(mode) {
  return (permissionBits(mode) & 0o022) !== 0;
}

function isOwnerOnlyFileMode(mode) {
  return (permissionBits(mode) & 0o077) === 0;
}

function isUnsafeAncestorDirectory(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  // Sticky world/group-writable directories (for example /tmp) are acceptable
  // waypoints; non-sticky writable ancestors enable path replacement attacks.
  if (isGroupOrWorldWritable(stat.mode) && !isSticky(stat.mode)) return true;
  return false;
}

function inspectSafeRegularFile(absolutePath, { ownerOnly = false } = {}) {
  if (!isAbsolutePath(absolutePath)) {
    return failClosed('unsafe_path');
  }
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return failClosed('unsafe_path');
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return failClosed('unsafe_path');
  }
  if (isGroupOrWorldWritable(stat.mode)) {
    return failClosed('unsafe_path');
  }
  if (ownerOnly && !isOwnerOnlyFileMode(stat.mode)) {
    return failClosed('unsafe_path');
  }

  let current = path.dirname(absolutePath);
  for (;;) {
    let parentStat;
    try {
      parentStat = fs.lstatSync(current);
    } catch {
      return failClosed('unsafe_path');
    }
    if (isUnsafeAncestorDirectory(parentStat)) {
      return failClosed('unsafe_path');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { ok: true, stat };
}

function readSafeFileBytes(absolutePath, options = {}) {
  const inspection = inspectSafeRegularFile(absolutePath, options);
  if (!inspection.ok) return inspection;
  try {
    const bytes = fs.readFileSync(absolutePath);
    return { ok: true, bytes, digest: sha256Buffer(bytes) };
  } catch {
    return failClosed(options.ownerOnly ? 'evidence_unreadable' : 'unsafe_path');
  }
}

/**
 * Side-effect-free live attestation collector.
 * Recomputes digests from explicit absolute regular files only.
 * Evidence never attests itself; callers must not pass receipt paths here.
 */
function collectManagedActivationAttestation({
  harness,
  generation,
  assetPaths,
  entrypointPath,
  configBindingPath,
  expected,
} = {}) {
  const normalizedHarness = normalizeHarnessId(harness);
  if (!normalizedHarness) return failClosed('unknown_harness');
  if (typeof generation !== 'string' || !GENERATION_PATTERN.test(generation)) {
    return failClosed('invalid_evidence');
  }
  if (!Array.isArray(assetPaths) || assetPaths.length === 0) {
    return failClosed('attestation_unavailable');
  }

  const assetDigests = [];
  for (const assetPath of assetPaths) {
    const read = readSafeFileBytes(assetPath, { ownerOnly: false });
    if (!read.ok) return failClosed('attestation_unavailable');
    assetDigests.push(read.digest);
  }
  const assetDigest = assetDigests.length === 1
    ? assetDigests[0]
    : sha256Text(assetDigests.join('\0'));

  const entry = readSafeFileBytes(entrypointPath, { ownerOnly: false });
  if (!entry.ok) return failClosed('attestation_unavailable');
  const config = readSafeFileBytes(configBindingPath, { ownerOnly: false });
  if (!config.ok) return failClosed('attestation_unavailable');

  if (isObject(expected)) {
    if (isSha256(expected.assetDigest) && expected.assetDigest.toLowerCase() !== assetDigest) {
      return failClosed('asset_digest_mismatch', {
        ok: false,
        harness: normalizedHarness,
        generation,
        assetDigest,
        entrypointDigest: entry.digest,
        configBindingDigest: config.digest,
      });
    }
    if (isSha256(expected.entrypointDigest) && expected.entrypointDigest.toLowerCase() !== entry.digest) {
      return failClosed('entrypoint_digest_mismatch', {
        harness: normalizedHarness,
        generation,
        assetDigest,
        entrypointDigest: entry.digest,
        configBindingDigest: config.digest,
      });
    }
    if (isSha256(expected.configBindingDigest) && expected.configBindingDigest.toLowerCase() !== config.digest) {
      return failClosed('config_binding_mismatch', {
        harness: normalizedHarness,
        generation,
        assetDigest,
        entrypointDigest: entry.digest,
        configBindingDigest: config.digest,
      });
    }
  }

  let tuple;
  try {
    tuple = buildSelectedTuple({
      harness: normalizedHarness,
      generation,
      assetDigest,
      entrypointDigest: entry.digest,
      configBindingDigest: config.digest,
    });
  } catch {
    return failClosed('attestation_unavailable');
  }

  return {
    ok: true,
    harness: tuple.harness,
    generation: tuple.generation,
    assetDigest: tuple.assetDigest,
    entrypointDigest: tuple.entrypointDigest,
    configBindingDigest: tuple.configBindingDigest,
    tupleDigest: tuple.tupleDigest,
  };
}

/** Read owner-local evidence from an explicit absolute regular file with safe ancestry. */
function loadOwnerEvidence(absolutePath) {
  const read = readSafeFileBytes(absolutePath, { ownerOnly: true });
  if (!read.ok) {
    return failClosed('evidence_unreadable');
  }
  let parsed;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8'));
  } catch {
    return failClosed('evidence_unreadable');
  }
  if (!isObject(parsed)) return failClosed('invalid_evidence');
  return { ok: true, value: parsed };
}

function normalizeChallenges(challenges, harness) {
  if (!Array.isArray(challenges)) return [];
  const out = [];
  for (const challenge of challenges) {
    if (!isObject(challenge)) continue;
    const challengeHarness = normalizeHarnessId(challenge.harness) || harness;
    if (challengeHarness !== harness) continue;
    if (typeof challenge.correlation !== 'string' || !CORRELATION_PATTERN.test(challenge.correlation)) continue;
    const baselineMs = parseIsoMs(challenge.baselineAt);
    if (!Number.isFinite(baselineMs)) continue;
    out.push({
      correlation: challenge.correlation,
      harness: challengeHarness,
      baselineAt: challenge.baselineAt,
      baselineMs,
    });
  }
  return out;
}

function normalizeReceipts(receipts, harness, { allowTestFixture = false } = {}) {
  if (!Array.isArray(receipts)) return { receipts: [], invalid: receipts == null ? false : true };
  const out = [];
  let invalid = false;
  for (const item of receipts) {
    const validated = validateManagedActivationReceipt(item, { allowTestFixture });
    if (!validated.ok) {
      invalid = true;
      continue;
    }
    if (validated.value.harness !== harness) {
      invalid = true;
      continue;
    }
    out.push({
      ...validated.value,
      producedMs: parseIsoMs(validated.value.producedAt),
    });
  }
  return { receipts: out, invalid };
}

function receiptIdentity(receipt) {
  return [
    receipt.harness,
    receipt.correlation,
    receipt.eventClass,
    receipt.tupleDigest,
    receipt.producedAt,
  ].join('\0');
}

function evaluateFreshness(receipt, nowMs, contract) {
  const ageMs = nowMs - receipt.producedMs;
  const freshnessMs = contract.liveProof.freshnessSeconds * 1000;
  const skewMs = contract.liveProof.forwardSkewSeconds * 1000;
  if (receipt.producedMs > nowMs + skewMs) return 'receipt_future';
  if (ageMs > freshnessMs) return 'receipt_stale';
  return null;
}

function selectLiveProof(contract, receipts, challenges, consumedCorrelations, tupleDigest, nowMs) {
  const reasons = [];
  if (receipts.length === 0) {
    return { ok: false, reasons: ['no_live_receipt'] };
  }

  const challengeByCorrelation = new Map(challenges.map((item) => [item.correlation, item]));
  const consumed = new Set(Array.isArray(consumedCorrelations) ? consumedCorrelations : []);
  const seenIdentities = new Set();
  const accepted = [];

  for (const receipt of receipts) {
    const identity = receiptIdentity(receipt);
    if (seenIdentities.has(identity) || consumed.has(receipt.correlation)) {
      reasons.push('receipt_replay');
      continue;
    }
    seenIdentities.add(identity);

    if (receipt.tupleDigest !== tupleDigest) {
      reasons.push('selected_tuple_mismatch');
      continue;
    }

    const challenge = challengeByCorrelation.get(receipt.correlation);
    if (!challenge) {
      reasons.push('challenge_mismatch');
      continue;
    }
    if (receipt.producedMs <= challenge.baselineMs) {
      reasons.push('receipt_before_baseline');
      continue;
    }

    const freshness = evaluateFreshness(receipt, nowMs, contract);
    if (freshness) {
      reasons.push(freshness);
      continue;
    }

    accepted.push(receipt);
  }

  // A proof set containing replayed or consumed material is ambiguous even
  // when another copy would otherwise qualify. Never let a valid first copy
  // mask duplicated evidence.
  if (reasons.includes('receipt_replay')) {
    return { ok: false, reasons: ['receipt_replay'] };
  }

  if (accepted.length === 0) {
    return {
      ok: false,
      reasons: reasons.length ? [...new Set(reasons)] : ['no_live_receipt'],
    };
  }

  if (Array.isArray(contract.liveProof.requiredSequence)) {
    const sequence = contract.liveProof.requiredSequence;
    // Prefer a single correlation that carries the full ordered sequence.
    const byCorrelation = new Map();
    for (const receipt of accepted) {
      if (!byCorrelation.has(receipt.correlation)) byCorrelation.set(receipt.correlation, []);
      byCorrelation.get(receipt.correlation).push(receipt);
    }
    for (const group of byCorrelation.values()) {
      group.sort((left, right) => left.producedMs - right.producedMs);
      let index = 0;
      const matched = [];
      for (const receipt of group) {
        if (receipt.eventClass === sequence[index]) {
          const previous = matched[matched.length - 1];
          if (previous && receipt.producedMs <= previous.producedMs) {
            reasons.push('sequence_out_of_order');
            continue;
          }
          matched.push(receipt);
          index += 1;
          if (index === sequence.length) {
            const latest = matched[matched.length - 1];
            return {
              ok: true,
              reasons: ['live_proof_fresh'],
              receipts: matched,
              freshThrough: toIso(latest.producedMs + contract.liveProof.freshnessSeconds * 1000),
              evidenceClasses: [...new Set(matched.map((item) => item.eventClass))],
            };
          }
        }
      }
      if (matched.length > 0 && matched.length < sequence.length) {
        reasons.push('sequence_incomplete');
      } else if (group.some((item) => sequence.includes(item.eventClass))) {
        reasons.push('sequence_out_of_order');
      }
    }
    return {
      ok: false,
      reasons: [...new Set(reasons.length ? reasons : ['sequence_incomplete'])],
    };
  }

  const qualifying = new Set(contract.liveProof.qualifyingEventClasses || []);
  const matches = accepted.filter((receipt) => qualifying.has(receipt.eventClass));
  if (matches.length === 0) {
    return { ok: false, reasons: [...new Set(reasons.length ? reasons : ['no_live_receipt'])] };
  }
  matches.sort((left, right) => right.producedMs - left.producedMs);
  const best = matches[0];
  return {
    ok: true,
    reasons: ['live_proof_fresh'],
    receipts: [best],
    freshThrough: toIso(best.producedMs + contract.liveProof.freshnessSeconds * 1000),
    evidenceClasses: [best.eventClass],
  };
}

function uniqueReasons(reasons) {
  const out = [];
  for (const reason of reasons) {
    const code = safeReason(reason);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Pure activation evaluator.
 * Precedence: rollback → configuration/integrity → attested tuple → causal live proof → health/freshness.
 * Never restarts or repairs; degraded/stale paths remain read-only.
 */
function evaluateManagedActivation({
  contract,
  evidence = {},
  now = Date.now(),
  allowTestFixtureReceipts = false,
} = {}) {
  const contractResult = validateManagedActivationContract(contract);
  if (!contractResult.ok) {
    return {
      ok: false,
      state: 'unconfigured',
      harness: null,
      generationDigest: null,
      evidenceClasses: [],
      freshThrough: null,
      reasons: uniqueReasons(['invalid_evidence']),
      evaluatedAt: toIso(now),
      errors: contractResult.errors,
    };
  }
  const activeContract = contractResult.value;
  const harness = activeContract.harness;
  const nowMs = Number(now);
  const reasons = [];

  if (!isObject(evidence)) {
    return {
      ok: false,
      state: 'unconfigured',
      harness,
      generationDigest: null,
      evidenceClasses: [],
      freshThrough: null,
      reasons: uniqueReasons(['invalid_evidence']),
      evaluatedAt: toIso(nowMs),
    };
  }

  const rollback = isObject(evidence.rollback) ? evidence.rollback : { status: 'none' };
  const rollbackStatuses = new Set(['none', 'completed', 'requested', 'refused']);
  if (!rollbackStatuses.has(rollback.status)) {
    return {
      ok: true,
      state: 'rollback_pending',
      harness,
      generationDigest: null,
      evidenceClasses: ['rollback'],
      freshThrough: null,
      reasons: uniqueReasons(['invalid_evidence', 'rollback_pending']),
      evaluatedAt: toIso(nowMs),
    };
  }
  if (rollback.status === 'completed') {
    return {
      ok: true,
      state: 'rolled_back',
      harness,
      generationDigest: null,
      evidenceClasses: ['rollback'],
      freshThrough: null,
      reasons: uniqueReasons(['rolled_back', 'generation_invalidated']),
      evaluatedAt: toIso(nowMs),
    };
  }
  if (rollback.status === 'requested') {
    return {
      ok: true,
      state: 'rollback_pending',
      harness,
      generationDigest: null,
      evidenceClasses: ['rollback'],
      freshThrough: null,
      reasons: uniqueReasons(['rollback_pending']),
      evaluatedAt: toIso(nowMs),
    };
  }
  if (rollback.status === 'refused' || rollback.modifiedOrAmbiguous === true) {
    return {
      ok: true,
      state: 'rollback_pending',
      harness,
      generationDigest: null,
      evidenceClasses: ['rollback'],
      freshThrough: null,
      reasons: uniqueReasons(['rollback_refused_modified', 'rollback_pending']),
      evaluatedAt: toIso(nowMs),
    };
  }

  if (evidence.configured !== true) {
    return {
      ok: true,
      state: 'unconfigured',
      harness,
      generationDigest: null,
      evidenceClasses: [],
      freshThrough: null,
      reasons: uniqueReasons(['missing_configuration']),
      evaluatedAt: toIso(nowMs),
    };
  }

  const attestation = isObject(evidence.attestation) ? evidence.attestation : { ok: false };
  const tupleReady = attestation.ok === true
    && normalizeHarnessId(attestation.harness) === harness
    && typeof attestation.generation === 'string'
    && isSha256(attestation.tupleDigest)
    && isSha256(attestation.assetDigest)
    && isSha256(attestation.entrypointDigest)
    && isSha256(attestation.configBindingDigest);

  if (evidence.prepared !== true) {
    return {
      ok: true,
      state: 'unconfigured',
      harness,
      generationDigest: null,
      evidenceClasses: [],
      freshThrough: null,
      reasons: uniqueReasons(['missing_configuration']),
      evaluatedAt: toIso(nowMs),
    };
  }

  if (!tupleReady) {
    return {
      ok: true,
      state: 'prepared',
      harness,
      generationDigest: null,
      evidenceClasses: ['preparation'],
      freshThrough: null,
      reasons: uniqueReasons([
        'prepared',
        safeReason(attestation.reasonCode || 'attestation_unavailable'),
      ]),
      evaluatedAt: toIso(nowMs),
    };
  }

  let expectedDigest;
  try {
    expectedDigest = computeTupleDigest({
      harness,
      generation: attestation.generation,
      assetDigest: attestation.assetDigest,
      entrypointDigest: attestation.entrypointDigest,
      configBindingDigest: attestation.configBindingDigest,
    });
  } catch {
    return {
      ok: true,
      state: 'prepared',
      harness,
      generationDigest: null,
      evidenceClasses: ['preparation'],
      freshThrough: null,
      reasons: uniqueReasons(['prepared', 'attestation_unavailable']),
      evaluatedAt: toIso(nowMs),
    };
  }
  if (expectedDigest !== attestation.tupleDigest.toLowerCase()) {
    return {
      ok: true,
      state: 'degraded',
      harness,
      generationDigest: attestation.tupleDigest.toLowerCase(),
      evidenceClasses: ['attestation'],
      freshThrough: null,
      reasons: uniqueReasons(['selected_tuple_mismatch']),
      evaluatedAt: toIso(nowMs),
    };
  }

  const challenges = normalizeChallenges(evidence.challenges, harness);
  const { receipts, invalid: invalidReceipts } = normalizeReceipts(evidence.receipts, harness, {
    allowTestFixture: allowTestFixtureReceipts,
  });
  if (invalidReceipts) reasons.push('receipt_invalid');

  const live = selectLiveProof(
    activeContract,
    receipts,
    challenges,
    evidence.consumedCorrelations,
    attestation.tupleDigest.toLowerCase(),
    nowMs,
  );

  if (invalidReceipts) {
    return {
      ok: true,
      state: 'degraded',
      harness,
      generationDigest: attestation.tupleDigest.toLowerCase(),
      evidenceClasses: ['attestation', 'receipt'],
      freshThrough: null,
      reasons: uniqueReasons(['receipt_invalid']),
      evaluatedAt: toIso(nowMs),
    };
  }

  if (!live.ok) {
    const liveReasons = uniqueReasons([...reasons, ...live.reasons]);
    const degraded = liveReasons.some((code) => [
      'receipt_stale',
      'receipt_future',
      'selected_tuple_mismatch',
      'receipt_replay',
      'challenge_mismatch',
      'receipt_before_baseline',
      'receipt_invalid',
      'sequence_out_of_order',
    ].includes(code));
    return {
      ok: true,
      state: degraded ? 'degraded' : 'awaiting_live_proof',
      harness,
      generationDigest: attestation.tupleDigest.toLowerCase(),
      evidenceClasses: degraded ? ['attestation', 'receipt'] : ['attestation'],
      freshThrough: null,
      reasons: liveReasons.length ? liveReasons : uniqueReasons(['awaiting_live_proof', 'no_live_receipt']),
      evaluatedAt: toIso(nowMs),
    };
  }

  const health = isObject(evidence.health) ? evidence.health : { available: false };
  if (health.available === true && health.healthy === false && activeContract.health.mayExplainDegradation) {
    const evidenceClasses = [...live.evidenceClasses];
    if (!evidenceClasses.includes('health')) evidenceClasses.push('health');
    return {
      ok: true,
      state: 'degraded',
      harness,
      generationDigest: attestation.tupleDigest.toLowerCase(),
      evidenceClasses,
      freshThrough: live.freshThrough,
      reasons: uniqueReasons([...live.reasons, 'health_degraded']),
      evaluatedAt: toIso(nowMs),
    };
  }

  return {
    ok: true,
    state: 'active',
    harness,
    generationDigest: attestation.tupleDigest.toLowerCase(),
    evidenceClasses: live.evidenceClasses,
    freshThrough: live.freshThrough,
    reasons: uniqueReasons(live.reasons),
    evaluatedAt: toIso(nowMs),
  };
}

function toPublicActivationStatus(result = {}) {
  const reasons = Array.isArray(result.reasons)
    ? uniqueReasons(result.reasons).filter((code) => MANAGED_ACTIVATION_REASON_CODES.has(code))
    : [];
  const state = MANAGED_ACTIVATION_STATES.has(result.state) ? result.state : 'unconfigured';
  const harness = normalizeHarnessId(result.harness);
  const status = {
    schemaVersion: MANAGED_ACTIVATION_STATUS_VERSION,
    harness: harness || null,
    state,
    generationDigest: isSha256(result.generationDigest) ? result.generationDigest.toLowerCase() : null,
    evidenceClasses: Array.isArray(result.evidenceClasses)
      ? result.evidenceClasses.filter((value) => typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value))
      : [],
    freshThrough: Number.isFinite(parseIsoMs(result.freshThrough)) ? result.freshThrough : null,
    reasons,
    evaluatedAt: Number.isFinite(parseIsoMs(result.evaluatedAt)) ? result.evaluatedAt : toIso(Date.now()),
  };

  // Closed outward projection: drop any accidental private fields by reconstruction.
  const publicStatus = {};
  for (const field of PUBLIC_STATUS_FIELDS) publicStatus[field] = status[field];
  return publicStatus;
}

module.exports = {
  CANONICAL_HARNESS_IDS,
  LIVE_PROOF_FORWARD_SKEW_SECONDS,
  LIVE_PROOF_FRESHNESS_SECONDS,
  MANAGED_ACTIVATION_CONTRACT_VERSION,
  MANAGED_ACTIVATION_REASON_CODES,
  MANAGED_ACTIVATION_RECEIPT_EVENT_CLASSES,
  MANAGED_ACTIVATION_RECEIPT_PRODUCERS,
  MANAGED_ACTIVATION_PRODUCER_EVENTS,
  MANAGED_ACTIVATION_RECEIPT_VERSION,
  MANAGED_ACTIVATION_STATES,
  MANAGED_ACTIVATION_STATUS_VERSION,
  buildSelectedTuple,
  collectManagedActivationAttestation,
  computeTupleDigest,
  evaluateManagedActivation,
  loadOwnerEvidence,
  normalizeHarnessId,
  toPublicActivationStatus,
  validateManagedActivationContract,
  validateManagedActivationReceipt,
};
