'use strict';

// Derived, read-only accountability attention. Like intent-gap-attention it
// accepts only host-admitted transient evidence (pins and signals whose
// admitted Evidence Unit contentDigest binds the exact descriptor). It never
// reads a filesystem, never writes the Projects registry, never changes a
// lifecycle and never turns an unverified claim into acceptance: anything
// without a trusted producer stays unknown / pending-reconciliation.
const {
  accountabilityCriterionDigest,
  accountabilityPinDigest,
  accountabilityScopeDigest,
  createAccountabilityPin,
  digest,
  normalizeAccountabilityCheckpoint,
  normalizeAccountabilityCriteria,
  validateAccountabilityPin,
} = require('./provider-contracts');

const SIGNAL_TYPES = Object.freeze(['brief', 'progress', 'event', 'claim']);
const BRIEF_STATUSES = Object.freeze(['current', 'superseded']);
const PROGRESS_STATES = Object.freeze(['progress', 'accepted', 'failed']);
const CLAIM_STATES = Object.freeze(['held', 'released', 'lost']);
const EXCEPTION_TYPES = Object.freeze(['stale-scope', 'ownership-conflict', 'continuation-lost', 'acceptance-failed', 'checkpoint-missed']);
const DEFAULT_MAX_CLAIM_AGE_SECONDS = 3600;
const SIGNAL_FIELDS = Object.freeze({
  brief: ['type', 'referenceId', 'briefDigest', 'status', 'criteria', 'sourceRef', 'sourceDigest'],
  progress: ['type', 'referenceId', 'criterionId', 'criterionDigest', 'state', 'remaining', 'nextCheckpoint', 'actor', 'sourceRef', 'sourceDigest'],
  event: ['type', 'referenceId', 'event', 'occurredAt', 'sourceRef', 'sourceDigest'],
  claim: ['type', 'referenceId', 'owner', 'state', 'sourceRef', 'sourceDigest'],
});

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function timestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
function canonicalId(value, field) {
  if (typeof value !== 'string' || !/^(?:prj|out)_[0-9]{6,}$/.test(value)) throw new TypeError(`${field} must be a canonical Project or Outcome ID`);
  return value;
}
function opaque(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000\r\n]/.test(value)) throw new TypeError(`${field} must be a non-empty reference`);
  return value.trim();
}
function digestValue(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a sha256 digest`);
  return value;
}

// Normalizes an accountability signal descriptor (without evidence). Producers
// admit `accountabilitySignalDigest(descriptor)` as the Evidence Unit
// contentDigest; that is the only way a signal becomes trusted here.
function normalizeSignal(input) {
  if (!isPlainObject(input) || !SIGNAL_TYPES.includes(input.type)) throw new TypeError('accountability signal type is unsupported');
  const { evidence: _evidence, ...descriptor } = input;
  if (!exactKeys(descriptor, SIGNAL_FIELDS[input.type])) throw new TypeError('accountability signal has unsupported fields');
  const base = {
    type: input.type,
    referenceId: canonicalId(input.referenceId, 'accountability signal referenceId'),
    sourceRef: opaque(input.sourceRef, 'accountability signal sourceRef'),
    sourceDigest: digestValue(input.sourceDigest, 'accountability signal sourceDigest'),
  };
  if (input.type === 'brief') {
    if (!BRIEF_STATUSES.includes(input.status)) throw new TypeError('accountability brief status is unsupported');
    return {
      ...base,
      briefDigest: digestValue(input.briefDigest, 'accountability brief briefDigest'),
      status: input.status,
      criteria: normalizeAccountabilityCriteria(input.criteria, 'accountability brief criteria'),
    };
  }
  if (input.type === 'progress') {
    if (!PROGRESS_STATES.includes(input.state)) throw new TypeError('accountability progress state is unsupported');
    const accepted = input.state === 'accepted';
    if (accepted && (input.remaining !== null || input.nextCheckpoint !== null)) throw new TypeError('accepted progress cannot carry remaining work or a next checkpoint');
    if (input.state === 'progress' && input.nextCheckpoint === null) throw new TypeError('progress requires a next checkpoint');
    return {
      ...base,
      criterionId: opaque(input.criterionId, 'accountability progress criterionId', 64),
      criterionDigest: digestValue(input.criterionDigest, 'accountability progress criterionDigest'),
      state: input.state,
      remaining: accepted ? null : opaque(input.remaining, 'accountability progress remaining', 1000),
      nextCheckpoint: input.nextCheckpoint === null ? null : normalizeAccountabilityCheckpoint(input.nextCheckpoint, 'accountability progress nextCheckpoint'),
      actor: opaque(input.actor, 'accountability progress actor'),
    };
  }
  if (input.type === 'event') {
    return { ...base, event: opaque(input.event, 'accountability event', 128), occurredAt: timestamp(input.occurredAt, 'accountability event occurredAt') };
  }
  if (!CLAIM_STATES.includes(input.state)) throw new TypeError('accountability claim state is unsupported');
  return { ...base, owner: opaque(input.owner, 'accountability claim owner'), state: input.state };
}

function accountabilitySignalDigest(descriptor) { return digest(normalizeSignal(descriptor)); }

// Activity, diagnostics and anything not bound to a pinned criterion are
// never progress. They are dropped with a visible omission, never thrown, so
// one foreign item cannot blank the whole packet.
function looksLikeActivity(input) {
  return !isPlainObject(input) || !SIGNAL_TYPES.includes(input.type) || (input.type === 'progress' && !input.criterionId);
}

function verifyAdmitted(evidence, expectedDigest, { sourceAuthority, now }) {
  if (!sourceAuthority || typeof sourceAuthority.verifyAdmittedInferenceEvidence !== 'function') return { ok: false, reason: 'no-trusted-producer' };
  let verified;
  try { verified = sourceAuthority.verifyAdmittedInferenceEvidence(evidence); } catch (_) { return { ok: false, reason: 'unverified' }; }
  if (!verified || !verified.ok) return { ok: false, reason: 'unverified' };
  if (verified.evidence.contentDigest !== expectedDigest) return { ok: false, reason: 'digest-mismatch' };
  const observedAt = Date.parse(verified.evidence.observedAt);
  const nowMillis = Date.parse(now);
  if (verified.evidence.coverageState !== 'fresh' || !Number.isFinite(observedAt) || observedAt > nowMillis) return { ok: false, reason: 'not-fresh' };
  return { ok: true, observedAt: new Date(observedAt).toISOString(), evidenceId: verified.evidence.evidenceId };
}

function byObserved(left, right) {
  return Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.sourceRef.localeCompare(right.sourceRef);
}

function latest(values) { return values.length ? [...values].sort(byObserved)[values.length - 1] : null; }

function checkpointMissed(checkpoint, { events, progress, now }) {
  if (!checkpoint) return false;
  if (checkpoint.type === 'time') return Date.parse(checkpoint.at) < Date.parse(now);
  const reached = events.filter((event) => event.event === checkpoint.event && Date.parse(event.occurredAt) <= Date.parse(now));
  if (!reached.length) return false;
  const reachedAt = Math.min(...reached.map((event) => Date.parse(event.occurredAt)));
  return !progress.some((item) => Date.parse(item.observedAt) >= reachedAt);
}

function fingerprintFor({ referenceId, revision, criterionId, disposition, checkpoint }) {
  return digest({ referenceId, revision, criterionId, disposition, checkpoint });
}

function pendingEntry({ pin, referenceId, referenceKind, repair, title = null, currentRevision = null, registryGeneration, nextOwner }) {
  const fingerprint = fingerprintFor({
    referenceId, revision: pin ? pin.reference.revision : null, criterionId: null, disposition: 'pending-reconciliation', checkpoint: repair,
  });
  return {
    id: `acct_${fingerprint.slice(0, 32)}`,
    referenceId,
    referenceKind,
    title,
    pinnedRevision: pin ? pin.reference.revision : null,
    currentRevision,
    registryGeneration,
    owner: pin ? pin.owner : null,
    responsibility: pin ? pin.responsibility : null,
    referenceState: 'unknown',
    briefState: 'unknown',
    disposition: 'pending-reconciliation',
    repair,
    nextOwner,
    criteria: [],
    proposal: null,
    maintenance: null,
    fingerprint,
  };
}

function deriveEntry(pin, context) {
  const { record, registryGeneration, signals, now, conflictingOwners } = context;
  const referenceId = pin.reference.id;
  const base = { pin, referenceId, referenceKind: pin.reference.kind, registryGeneration, nextOwner: pin.owner };
  // Missing, compacted or projection-only detail cannot prove material scope:
  // canonical records omit unset goal/definitionOfDone (absent === null), but a
  // record must be the exact canonical shape (id, kind, integer revision).
  if (!record || record.kind !== pin.reference.kind || !Number.isInteger(record.revision) || record.compacted === true) {
    return pendingEntry({ ...base, repair: 'exact-record-detail-required', title: record && record.title ? record.title : null });
  }
  const mine = signals.filter((signal) => signal.referenceId === referenceId);
  const brief = latest(mine.filter((signal) => signal.type === 'brief'));
  let briefState = 'unknown';
  let currentCriteria = pin.milestone.criteria;
  if (brief && brief.status === 'superseded') briefState = 'superseded';
  else if (brief) {
    briefState = brief.briefDigest === pin.briefDigest ? 'current' : 'revised';
    currentCriteria = brief.criteria;
  }
  const scopeOf = (criteria) => accountabilityScopeDigest({
    reference: pin.reference, goal: record.goal, definitionOfDone: record.definitionOfDone, criteria,
  });
  const scopeCurrent = scopeOf(currentCriteria) === pin.scopeDigest;
  const intentChanged = !scopeCurrent && scopeOf(pin.milestone.criteria) !== pin.scopeDigest;
  const referenceState = !scopeCurrent || briefState === 'superseded'
    ? 'stale-scope'
    : (record.revision === pin.reference.revision ? 'pinned' : 'refreshed');

  const allowedActors = new Set([pin.owner, ...(pin.maintenance ? [pin.maintenance.owner] : [])]);
  const progressAll = mine.filter((signal) => signal.type === 'progress');
  const events = mine.filter((signal) => signal.type === 'event');
  const claim = latest(mine.filter((signal) => signal.type === 'claim' && signal.claimFresh));
  const claimConflict = Boolean(claim && claim.state === 'held' && !allowedActors.has(claim.owner));
  const continuationLost = Boolean(claim && claim.owner === pin.owner && claim.state !== 'held');

  const pinnedById = new Map(pin.milestone.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const currentById = new Map(currentCriteria.map((criterion) => [criterion.criterionId, criterion]));
  const criterionIds = [...new Set([...pinnedById.keys(), ...currentById.keys()])];
  const unlinked = progressAll.filter((item) => !criterionIds.includes(item.criterionId));
  const criteria = criterionIds.map((criterionId) => {
    const pinned = pinnedById.get(criterionId) || null;
    const current = currentById.get(criterionId) || null;
    const pinnedDigest = pinned ? accountabilityCriterionDigest(pinned) : null;
    const activeDigest = current ? accountabilityCriterionDigest(current) : pinnedDigest;
    const change = !current ? 'criterion-removed' : (!pinned ? 'criterion-added' : (pinnedDigest !== activeDigest ? 'criterion-changed' : null));
    const forCriterion = progressAll.filter((item) => item.criterionId === criterionId);
    // Progress recorded against superseded acceptance text no longer counts:
    // only the affected criterion reopens; unchanged criteria keep acceptance.
    const matching = forCriterion.filter((item) => item.criterionDigest === activeDigest);
    const owned = matching.filter((item) => allowedActors.has(item.actor));
    const foreign = matching.some((item) => !allowedActors.has(item.actor));
    const last = latest(owned);
    let state = last ? last.state : 'ready';
    if (change === 'criterion-removed') state = 'withdrawn';
    const checkpoint = last && last.nextCheckpoint ? last.nextCheckpoint : pin.milestone.checkpoint;
    let exception = null;
    if (briefState === 'superseded') exception = { type: 'stale-scope', reason: 'brief-superseded' };
    else if (change) exception = { type: 'stale-scope', reason: change };
    else if (intentChanged) exception = { type: 'stale-scope', reason: 'intent-changed' };
    else if (conflictingOwners || claimConflict || foreign) exception = { type: 'ownership-conflict', reason: conflictingOwners ? 'multiple-pinned-owners' : (claimConflict ? 'claim-held-by-other-owner' : 'progress-by-unpinned-actor') };
    else if (state !== 'accepted' && continuationLost) exception = { type: 'continuation-lost', reason: `owner-claim-${claim.state}` };
    else if (state === 'failed') exception = { type: 'acceptance-failed', reason: 'acceptance-check-failed' };
    else if (state !== 'accepted' && checkpointMissed(checkpoint, { events, progress: owned, now })) {
      exception = { type: 'checkpoint-missed', reason: owned.length ? 'no-progress-since-checkpoint' : 'no-progress' };
    }
    const disposition = exception ? exception.type : state;
    const fingerprint = fingerprintFor({ referenceId, revision: pin.reference.revision, criterionId, disposition, checkpoint });
    return {
      criterionId,
      criterionDigest: activeDigest,
      state,
      reopened: change === 'criterion-changed',
      available: !exception && state !== 'accepted' && state !== 'withdrawn',
      remaining: last ? last.remaining : null,
      nextCheckpoint: checkpoint,
      exception,
      nextOwner: pin.responsibility === 'ongoing' && pin.maintenance && state === 'accepted' ? pin.maintenance.owner : pin.owner,
      evidenceRefs: last ? [last.sourceRef, `digest:${last.sourceDigest}`] : [],
      fingerprint,
    };
  });
  const hasException = criteria.some((criterion) => criterion.exception);
  const allAccepted = criteria.every((criterion) => criterion.state === 'accepted');
  // Readiness (finite proposal or ongoing milestone acceptance) additionally
  // requires the latest trusted admitted brief to be current and to carry the
  // exact pinned briefDigest. Missing/unverified (unknown), revised or
  // superseded briefs withhold readiness without touching criterion history.
  const milestoneReady = allAccepted && !hasException && briefState === 'current';
  let repair = null;
  if (referenceState === 'stale-scope' || briefState === 'revised') repair = 're-pin-with-owner';
  else if (allAccepted && !hasException && !milestoneReady) repair = 'current-brief-required';
  let proposal = null;
  let maintenance = null;
  let disposition = hasException ? 'exception' : 'on-track';
  if (pin.responsibility === 'finite-outcome' && milestoneReady) {
    // Readiness proposal only: the owner decides; lifecycle is never changed here.
    proposal = { type: 'outcome-complete-ready', referenceId, decisionOwner: pin.owner, lifecycleChange: 'none' };
    disposition = 'outcome-complete-ready';
  }
  if (pin.responsibility === 'ongoing') {
    const trigger = pin.maintenance.revisitTrigger;
    const due = trigger.type === 'time'
      ? Date.parse(trigger.at) <= Date.parse(now)
      : events.some((event) => event.event === trigger.event && Date.parse(event.occurredAt) <= Date.parse(now));
    // Ongoing Project responsibility never completes: the milestone may be
    // accepted, but the maintenance owner + revisit trigger stay open.
    maintenance = { state: 'retained', owner: pin.maintenance.owner, revisitTrigger: trigger, due, milestoneAccepted: milestoneReady };
    if (!hasException) disposition = 'maintenance-retained';
  }
  const fingerprint = fingerprintFor({ referenceId, revision: pin.reference.revision, criterionId: null, disposition, checkpoint: pin.milestone.checkpoint });
  return {
    entry: {
      id: `acct_${fingerprint.slice(0, 32)}`,
      referenceId,
      referenceKind: pin.reference.kind,
      title: record.title || null,
      pinnedRevision: pin.reference.revision,
      currentRevision: record.revision,
      registryGeneration,
      owner: pin.owner,
      responsibility: pin.responsibility,
      referenceState,
      briefState,
      disposition,
      repair,
      nextOwner: pin.owner,
      criteria,
      proposal,
      maintenance,
      fingerprint,
    },
    unlinked: unlinked.length,
  };
}

function alertsFor(entry) {
  const label = entry.title || entry.referenceId;
  if (entry.disposition === 'pending-reconciliation') {
    return [{
      fingerprint: entry.fingerprint, referenceId: entry.referenceId, criterionId: null, disposition: 'pending-reconciliation',
      reason: entry.repair, nextOwner: entry.nextOwner, evidenceRefs: [],
      title: `Accountability: ${label} pending reconciliation (${entry.repair}); next owner: ${entry.nextOwner}`,
    }];
  }
  const alerts = entry.criteria.filter((criterion) => criterion.exception).map((criterion) => ({
    fingerprint: criterion.fingerprint,
    referenceId: entry.referenceId,
    criterionId: criterion.criterionId,
    disposition: criterion.exception.type,
    reason: criterion.exception.reason,
    nextOwner: criterion.nextOwner,
    evidenceRefs: criterion.evidenceRefs,
    title: `Accountability: ${label} / ${criterion.criterionId} (${criterion.exception.type}: ${criterion.exception.reason}); next owner: ${criterion.nextOwner}`,
  }));
  if (entry.proposal) {
    alerts.push({
      fingerprint: entry.fingerprint, referenceId: entry.referenceId, criterionId: null, disposition: 'outcome-complete-ready', reason: 'all-criteria-accepted',
      nextOwner: entry.proposal.decisionOwner, evidenceRefs: [],
      title: `Accountability: ${label} all criteria accepted — readiness proposal only; owner decision: ${entry.proposal.decisionOwner}`,
    });
  }
  if (entry.maintenance && entry.maintenance.due) {
    const trigger = entry.maintenance.revisitTrigger;
    const fingerprint = fingerprintFor({ referenceId: entry.referenceId, revision: entry.pinnedRevision, criterionId: null, disposition: 'maintenance-due', checkpoint: trigger });
    alerts.push({
      fingerprint, referenceId: entry.referenceId, criterionId: null, disposition: 'maintenance-due', reason: 'revisit-trigger-reached',
      nextOwner: entry.maintenance.owner, evidenceRefs: [],
      title: `Accountability: ${label} maintenance revisit due (${trigger.type === 'time' ? trigger.at : trigger.event}); maintenance owner: ${entry.maintenance.owner}`,
    });
  }
  return alerts;
}

function deriveAccountabilityAttention({
  records, registryGeneration, pins = [], signals = [], sourceAuthority = null, now = new Date().toISOString(), maxClaimAgeSeconds = DEFAULT_MAX_CLAIM_AGE_SECONDS,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('accountability records must be an array');
  if (!Number.isInteger(registryGeneration) || registryGeneration < 0) throw new TypeError('accountability registryGeneration is invalid');
  if (!Array.isArray(pins) || !Array.isArray(signals)) throw new TypeError('accountability pins and signals must be arrays');
  if (!Number.isInteger(maxClaimAgeSeconds) || maxClaimAgeSeconds < 1 || maxClaimAgeSeconds > 86_400) throw new TypeError('accountability maxClaimAgeSeconds is invalid');
  const capturedAt = timestamp(now, 'accountability now');
  const omissions = new Set();
  const verifyContext = { sourceAuthority, now: capturedAt };

  const trustedSignals = [];
  for (const input of signals) {
    if (looksLikeActivity(input)) { omissions.add('accountability:activity-not-progress'); continue; }
    let descriptor;
    try { descriptor = normalizeSignal(input); } catch (_) { omissions.add('accountability:invalid-signal'); continue; }
    const verified = verifyAdmitted(input.evidence, digest(descriptor), verifyContext);
    if (!verified.ok) { omissions.add(`accountability:signal-${verified.reason}`); continue; }
    // Continuation status must be recent to count; stale claims are unknown.
    const claimFresh = descriptor.type !== 'claim' || Date.parse(capturedAt) - Date.parse(verified.observedAt) <= maxClaimAgeSeconds * 1000;
    trustedSignals.push({ ...descriptor, observedAt: verified.observedAt, claimFresh });
  }

  const recordsById = new Map(records.filter(isPlainObject).map((record) => [record.id, record]));
  const entries = [];
  const trustedPins = [];
  for (const input of pins) {
    let pin;
    try { pin = validateAccountabilityPin(input && input.pin).pin; } catch (_) { omissions.add('accountability:invalid-pin'); continue; }
    const verified = verifyAdmitted(input.evidence, accountabilityPinDigest(pin), verifyContext);
    if (!verified.ok) {
      // An unadmitted pin names nobody authoritatively.
      const record = recordsById.get(pin.reference.id);
      entries.push(pendingEntry({
        pin: null, referenceId: pin.reference.id, referenceKind: pin.reference.kind, repair: `pin-admission-required:${verified.reason}`,
        title: record ? record.title || null : null, currentRevision: record ? record.revision : null, registryGeneration, nextOwner: 'protected-project-owner',
      }));
      continue;
    }
    trustedPins.push(pin);
  }
  const byReference = new Map();
  for (const pin of trustedPins) byReference.set(pin.reference.id, [...(byReference.get(pin.reference.id) || []), pin]);
  let unlinked = 0;
  for (const [referenceId, group] of byReference) {
    const owners = new Set(group.map((pin) => pin.owner));
    const selected = [...group].sort((left, right) => Date.parse(left.pinnedAt) - Date.parse(right.pinnedAt))[group.length - 1];
    const result = deriveEntry(selected, {
      record: recordsById.get(referenceId), registryGeneration, signals: trustedSignals, now: capturedAt, conflictingOwners: owners.size > 1,
    });
    if (result.entry) { entries.push(result.entry); unlinked += result.unlinked; } else entries.push(result);
  }
  const pinnedReferences = new Set(trustedPins.map((pin) => pin.reference.id));
  if (unlinked || trustedSignals.some((signal) => !pinnedReferences.has(signal.referenceId) && signal.type === 'progress')) omissions.add('accountability:activity-not-progress');
  entries.sort((left, right) => left.referenceId.localeCompare(right.referenceId) || left.id.localeCompare(right.id));
  const alerts = entries.flatMap(alertsFor);
  return { entries: entries.map(clone), alerts: alerts.map(clone), omissions: [...omissions].sort() };
}

// Packet-compatible attention summaries (same shape as intent-gap summaries).
function accountabilityAttentionSummaries(result, { observedAt } = {}) {
  const capturedAt = timestamp(observedAt || new Date().toISOString(), 'accountability attention observedAt');
  const alerts = Array.isArray(result) ? result : (result && Array.isArray(result.alerts) ? result.alerts : []);
  const maintained = result && Array.isArray(result.entries)
    ? result.entries.filter((entry) => entry.maintenance && !entry.maintenance.due && entry.disposition === 'maintenance-retained')
    : [];
  return [
    ...alerts.map((alert) => ({
      id: `acct_${alert.fingerprint.slice(0, 32)}`,
      canonicalId: alert.referenceId,
      category: 'attention',
      status: alert.disposition,
      title: alert.title,
      occurredAt: null,
      observedAt: capturedAt,
      evidenceRefs: [...alert.evidenceRefs],
      canonicalAtAdmission: null,
      source: 'projects-accountability',
    })),
    ...maintained.map((entry) => ({
      id: `acct_${entry.fingerprint.slice(0, 32)}`,
      canonicalId: entry.referenceId,
      category: 'attention',
      status: 'maintenance-retained',
      title: `Accountability: ${entry.title || entry.referenceId} ongoing — maintenance owner: ${entry.maintenance.owner}; revisit: ${entry.maintenance.revisitTrigger.type === 'time' ? entry.maintenance.revisitTrigger.at : entry.maintenance.revisitTrigger.event}`,
      occurredAt: null,
      observedAt: capturedAt,
      evidenceRefs: [],
      canonicalAtAdmission: null,
      source: 'projects-accountability',
    })),
  ];
}

function pendingReconciliation(pin, repair, extra = {}) {
  return { status: 'pending-reconciliation', referenceId: pin.reference.id, owner: pin.owner, repair, pin: null, admission: 'not-applicable', ...extra };
}

// Owner-authorized scope synchronization. The caller must inject the trusted,
// already-qualified owner amendment + exact full-record readback port. This
// module never touches the registry directly; without a port, on denial, on a
// concurrent CAS conflict, or on readback mismatch the result is an owned
// pending-reconciliation naming the repair, never a live write.
async function reconcileAccountabilityScope({ pin, current, proposedScope, ownerPort = null, now = new Date().toISOString() } = {}) {
  const normalizedPin = validateAccountabilityPin(pin).pin;
  if (!isPlainObject(current) || !Number.isInteger(current.registryGeneration) || current.registryGeneration < 0
    || !Number.isInteger(current.revision) || current.revision < 1) throw new TypeError('accountability reconciliation requires current coordinates');
  if (!isPlainObject(proposedScope)) throw new TypeError('accountability proposedScope is required');
  const criteria = normalizeAccountabilityCriteria(proposedScope.criteria, 'accountability proposed criteria');
  const briefDigest = digestValue(proposedScope.briefDigest, 'accountability proposed briefDigest');
  const pinnedAt = timestamp(now, 'accountability reconciliation now');
  const patch = {};
  for (const field of ['goal', 'definitionOfDone']) {
    if (Object.prototype.hasOwnProperty.call(proposedScope, field)) {
      if (proposedScope[field] !== null && typeof proposedScope[field] !== 'string') throw new TypeError(`accountability proposed ${field} must be a string or null`);
      patch[field] = proposedScope[field];
    }
  }
  const recordId = normalizedPin.reference.id;
  if (!ownerPort || typeof ownerPort.readRecord !== 'function' || (Object.keys(patch).length && typeof ownerPort.amend !== 'function')) {
    return pendingReconciliation(normalizedPin, 'owner-amend-port-unavailable', { patch });
  }
  let coordinates = { generation: current.registryGeneration, revision: current.revision };
  if (Object.keys(patch).length) {
    let committed;
    try {
      committed = await ownerPort.amend({
        recordId, expectedGeneration: current.registryGeneration, expectedRevision: current.revision, patch: clone(patch), actor: normalizedPin.owner,
      });
    } catch (_) {
      return pendingReconciliation(normalizedPin, 'owner-amend-failed', { patch });
    }
    if (!committed || committed.status === 'denied') return pendingReconciliation(normalizedPin, 'owner-amend-denied', { patch });
    if (committed.status === 'conflict') return pendingReconciliation(normalizedPin, 'owner-amend-conflict', { patch });
    if (committed.status !== 'committed' || !Number.isInteger(committed.generation) || !Number.isInteger(committed.revision)
      || committed.generation <= current.registryGeneration || committed.revision <= current.revision) {
      return pendingReconciliation(normalizedPin, 'owner-amend-indeterminate', { patch });
    }
    coordinates = { generation: committed.generation, revision: committed.revision };
  }
  let readback;
  try {
    readback = await ownerPort.readRecord({ recordId, expectedGeneration: coordinates.generation, expectedRevision: coordinates.revision });
  } catch (_) {
    return pendingReconciliation(normalizedPin, 'readback-unavailable', { patch, expected: coordinates });
  }
  const read = readback && readback.status === 'ok' ? readback.read : null;
  const record = read && isPlainObject(read.record) ? read.record : null;
  if (!record || read.generation !== coordinates.generation || record.id !== recordId || record.revision !== coordinates.revision
    || record.kind !== normalizedPin.reference.kind) {
    return pendingReconciliation(normalizedPin, 'readback-unavailable', { patch, expected: coordinates });
  }
  // A compacted/projection readback omits canonical text: never hash it as null.
  if (record.compacted === true) {
    return pendingReconciliation(normalizedPin, 'exact-record-detail-required', { patch, expected: coordinates });
  }
  const norm = (value) => (typeof value === 'string' ? value.trim() : (value === undefined ? null : value));
  if (Object.keys(patch).some((field) => norm(record[field]) !== norm(patch[field]))) {
    return pendingReconciliation(normalizedPin, 'readback-mismatch', { patch, expected: coordinates });
  }
  const scopeDigest = accountabilityScopeDigest({
    reference: normalizedPin.reference, goal: record.goal, definitionOfDone: record.definitionOfDone, criteria,
  });
  const { contract: _contract, ...rest } = normalizedPin;
  const repinned = createAccountabilityPin({
    ...rest,
    reference: { ...normalizedPin.reference, revision: coordinates.revision },
    registryGeneration: coordinates.generation,
    scopeDigest,
    briefDigest,
    milestone: { ...normalizedPin.milestone, criteria },
    reason: 'scope-change',
    pinnedAt,
  });
  // The re-pin is unadmitted transient metadata until the host admits it.
  return { status: 'reconciled', referenceId: recordId, owner: normalizedPin.owner, repair: null, pin: repinned, admission: 'required', readback: coordinates, scopeDigest };
}

module.exports = {
  BRIEF_STATUSES,
  CLAIM_STATES,
  DEFAULT_MAX_CLAIM_AGE_SECONDS,
  EXCEPTION_TYPES,
  PROGRESS_STATES,
  SIGNAL_TYPES,
  accountabilityAttentionSummaries,
  accountabilitySignalDigest,
  deriveAccountabilityAttention,
  reconcileAccountabilityScope,
};
