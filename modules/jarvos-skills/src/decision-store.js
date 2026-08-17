'use strict';

// Owner-only, local decision ledger.  This deliberately contains no transport
// details: a selected runtime may claim an outbox item and acknowledge it, but
// agents and transports cannot manufacture a decision or a resolution.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, ensureDir } = require('./config');

const SCHEMA_VERSION = 'jarvos.skill-owner-decisions/v2';
const FALLBACK_MS = 24 * 60 * 60 * 1000;
const OPTION_SETS = Object.freeze({
  needs_owner_input: ['share', 'keep-local', 'exclude', 'details'],
  semantic_collision: ['keep-local', 'exclude', 'details'],
  ambiguous_identity: ['keep-local', 'exclude', 'details'],
  capability_unsupported: ['keep-local', 'exclude', 'details'],
  source_absent: ['keep-local', 'exclude', 'details'],
});

function stable(value) { return JSON.stringify(value); }
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function nowIso(now) { return now || new Date().toISOString(); }
function requireOwner(principal, capability) {
  if (principal?.kind !== 'owner' || !principal.capabilities?.includes(capability)) throw new Error('owner authorization is required');
}
function requireDeliveryPrincipal(principal) {
  if (principal?.kind !== 'selected-runtime' || !principal.capabilities?.includes('skills.delivery.ack')) throw new Error('delivery authorization is required');
}
function optionsFor(skill) {
  const options = OPTION_SETS[skill?.disposition?.reasonCode] || OPTION_SETS.needs_owner_input;
  return [...options];
}
function semanticKey(skill, options) {
  return digest({
    skill: skill.logicalId,
    treeDigest: skill.treeDigest,
    reason: skill.disposition?.reasonCode || 'needs_owner_input',
    policyVersion: 1,
    options,
  });
}
function validSkill(skill) {
  return skill && typeof skill.logicalId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(skill.logicalId)
    && typeof skill.treeDigest === 'string' && /^[a-f0-9]{64}$/i.test(skill.treeDigest)
    && skill.attention === 'actionable' && skill.disposition?.kind === 'needs_input';
}
function safeStatePath(statePath) {
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) throw new Error('decision state path is required');
  ensureDir(path.dirname(statePath), 'decision state parent');
  return statePath;
}
function load(statePath) {
  safeStatePath(statePath);
  if (!fs.existsSync(statePath)) return { schemaVersion: SCHEMA_VERSION, decisions: [], migrations: {} };
  const stat = fs.lstatSync(statePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('decision state is unsafe');
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed?.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.decisions)) {
      return { ...parsed, migrations: parsed.migrations && typeof parsed.migrations === 'object' ? parsed.migrations : {} };
    }
  } catch { /* fail closed below */ }
  throw new Error('decision state is unsupported');
}
function save(statePath, state) { atomicWriteJson(statePath, { ...state, schemaVersion: SCHEMA_VERSION }); }
function publicDecision(decision) {
  return {
    id: decision.id, decisionReference: decision.decisionReference, skill: decision.skill, revision: decision.revision, reason: decision.reason,
    options: [...decision.options], status: decision.status, deliveryStatus: decision.deliveryStatus,
    createdAt: decision.createdAt, updatedAt: decision.updatedAt,
  };
}
function findDecision(state, { decisionId, decisionReference } = {}) {
  if (typeof decisionReference === 'string' && decisionReference) {
    const byReference = state.decisions.find((item) => item.decisionReference === decisionReference);
    if (!byReference || (decisionId && byReference.id !== decisionId)) return null;
    return byReference;
  }
  return typeof decisionId === 'string' && decisionId ? state.decisions.find((item) => item.id === decisionId) : null;
}

function reconcileDecisions({ statePath, skills = [], observedAt, generationId } = {}) {
  const state = load(statePath); const at = nowIso(observedAt); const created = [];
  const current = new Map(skills.filter(validSkill).map((skill) => [skill.logicalId, skill]));
  for (const decision of state.decisions) {
    if (decision.status !== 'pending') continue;
    const skill = current.get(decision.skill);
    if (!skill) { decision.status = 'disappeared'; decision.updatedAt = at; continue; }
    const identity = semanticKey(skill, optionsFor(skill));
    if (identity !== decision.semanticKey) { decision.status = 'superseded'; decision.updatedAt = at; }
  }
  for (const skill of current.values()) {
    const options = optionsFor(skill); const key = semanticKey(skill, options);
    // A resolution is durable policy for this exact source/policy identity.
    // Do not turn a healthy replay into a new owner interruption; a changed
    // digest gets a distinct semantic key and therefore a fresh assessment.
    if (state.decisions.some((decision) => decision.semanticKey === key
      && ['pending', 'resolved'].includes(decision.status))) continue;
    const decision = {
      id: `decision-${key.slice(0, 24)}`, semanticKey: key, skill: skill.logicalId, treeDigest: skill.treeDigest,
      // Transport-safe correlation is intentionally distinct from the stable
      // semantic id. It is random, base64url, and survives every retry for
      // this decision revision without disclosing the skill or source.
      decisionReference: crypto.randomBytes(18).toString('base64url'),
      reason: skill.disposition.reasonCode || 'needs_owner_input', options, revision: 1, status: 'pending',
      deliveryStatus: 'pending', attempts: [], generationId: generationId || null, createdAt: at, updatedAt: at,
    };
    state.decisions.push(decision); created.push(publicDecision(decision));
  }
  if (created.length || state.decisions.some((d) => d.updatedAt === at)) save(statePath, state);
  return { created, pending: state.decisions.filter((d) => d.status === 'pending').map(publicDecision) };
}

function legacyAttention(attentionPath) {
  if (typeof attentionPath !== 'string' || !path.isAbsolute(attentionPath) || !fs.existsSync(attentionPath)) return null;
  try {
    const stat = fs.lstatSync(attentionPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(fs.readFileSync(attentionPath, 'utf8'));
    if (parsed?.schemaVersion !== 'jarvos.skill-attention/v1' || !Array.isArray(parsed.active)) return null;
    return parsed.active.filter((item) => typeof item?.logicalId === 'string' && typeof item?.reasonCode === 'string');
  } catch { return null; }
}

// The v1 attention file was notification state, not an approval ledger.  On
// upgrade we retain only entries that a fresh assessment still calls
// actionable; resolving/absent holds disappear quietly.  The return value is
// safe for a batch event: it exposes a random-looking reference and counts,
// never an id, reason, path, or source data.
function migrateV1Attention({ statePath, attentionPath, skills = [], observedAt, generationId } = {}) {
  const state = load(statePath);
  if (state.migrations?.attentionV1) return { migrated: false, replay: true, summary: state.migrations.attentionV1.summary };
  const legacy = legacyAttention(attentionPath);
  if (!legacy) return { migrated: false, replay: false, summary: null };
  const eligible = new Map(skills.filter(validSkill).map((skill) => [`${skill.logicalId}:${skill.disposition.reasonCode}`, skill]));
  const current = legacy.map((item) => eligible.get(`${item.logicalId}:${item.reasonCode}`)).filter(Boolean);
  const result = reconcileDecisions({ statePath, skills: current, observedAt, generationId });
  const summary = {
    reference: `batch-${digest({ legacy: legacy.map((item) => item.fingerprint || digest({ id: item.logicalId, reason: item.reasonCode })).sort(), generationId: generationId || null }).slice(0, 24)}`,
    pendingCount: result.pending.length,
    migratedCount: result.created.length,
  };
  // reconcileDecisions wrote the current state; reload to avoid dropping its
  // decisions when recording the one-time migration receipt.
  const next = load(statePath);
  next.migrations = { ...next.migrations, attentionV1: { summary, migratedAt: nowIso(observedAt) } };
  save(statePath, next);
  return { migrated: true, replay: false, summary };
}
function listDecisions({ statePath, principal } = {}) {
  requireOwner(principal, 'skills.decisions.read');
  return { decisions: load(statePath).decisions.filter((d) => d.status === 'pending').map(publicDecision) };
}
function explainDecision({ statePath, principal, decisionId, decisionReference } = {}) {
  requireOwner(principal, 'skills.decisions.read');
  const decision = findDecision(load(statePath), { decisionId, decisionReference });
  return decision ? { found: true, decision: publicDecision(decision) } : { found: false };
}
function resolveDecision({ statePath, principal, decisionId, decisionReference, revision, option, currentSkill, mutate } = {}) {
  requireOwner(principal, 'skills.decisions.resolve');
  const state = load(statePath); const decision = findDecision(state, { decisionId, decisionReference });
  if (!decision) return { status: 'not_found' };
  if (decision.status === 'resolved') return { status: 'already_resolved', receipt: decision.receipt };
  if (decision.status !== 'pending' || decision.revision !== revision) return { status: 'stale' };
  if (!decision.options.includes(option)) return { status: 'invalid_option' };
  if (!validSkill(currentSkill) || currentSkill.logicalId !== decision.skill || currentSkill.treeDigest !== decision.treeDigest) return { status: 'stale' };
  if (option === 'details') return { status: 'pending', decision: publicDecision(decision) };
  if (typeof mutate !== 'function') throw new Error('resolution mutation is required');
  mutate({ skill: decision.skill, option, decisionId: decision.id, revision: decision.revision });
  const at = new Date().toISOString();
  decision.status = 'resolved'; decision.updatedAt = at;
  decision.receipt = Object.freeze({ id: `receipt-${crypto.randomUUID()}`, decisionId: decision.id, decisionReference: decision.decisionReference, revision: decision.revision, option, resolvedAt: at, treeDigest: decision.treeDigest });
  save(statePath, state);
  return { status: 'resolved', receipt: decision.receipt };
}
function claimDelivery({ statePath, decisionId, now } = {}) {
  const state = load(statePath); const decision = state.decisions.find((item) => item.id === decisionId);
  if (!decision || decision.status !== 'pending' || decision.deliveryStatus === 'delivered' || decision.deliveryStatus === 'delivery_stalled') return null;
  if (decision.attempts.some((attempt) => attempt.outcome === 'claimed')) return null;
  const at = new Date(nowIso(now)); const previous = decision.attempts.at(-1);
  if (previous && at.getTime() - new Date(previous.claimedAt).getTime() < FALLBACK_MS) return null;
  const kind = decision.attempts.length === 0 ? 'initial' : 'fallback';
  const attempt = { id: `attempt-${crypto.randomUUID()}`, kind, claimedAt: at.toISOString(), outcome: 'claimed' };
  decision.attempts.push(attempt); decision.deliveryStatus = 'claimed'; decision.updatedAt = at.toISOString(); save(statePath, state);
  return { decisionId: decision.id, revision: decision.revision, attemptId: attempt.id, kind };
}
function acknowledgeDelivery({ statePath, principal, decisionId, revision, attemptId, outcome, providerMessageId } = {}) {
  requireDeliveryPrincipal(principal);
  if (!['accepted', 'rejected', 'ambiguous'].includes(outcome)) throw new Error('delivery outcome is invalid');
  const state = load(statePath); const decision = state.decisions.find((item) => item.id === decisionId);
  const attempt = decision?.attempts.find((item) => item.id === attemptId);
  if (!decision || decision.status !== 'pending' || decision.revision !== revision || !attempt || attempt.outcome !== 'claimed') throw new Error('delivery acknowledgement is stale');
  attempt.outcome = outcome; if (typeof providerMessageId === 'string' && providerMessageId) attempt.providerMessageId = providerMessageId;
  decision.updatedAt = new Date().toISOString();
  if (outcome === 'accepted') decision.deliveryStatus = 'delivered';
  else if (decision.attempts.filter((item) => item.outcome !== 'claimed').length >= 2) decision.deliveryStatus = 'delivery_stalled';
  else decision.deliveryStatus = outcome === 'ambiguous' ? 'delivery_unknown' : 'pending';
  save(statePath, state); return publicDecision(decision);
}

module.exports = { SCHEMA_VERSION, reconcileDecisions, migrateV1Attention, listDecisions, explainDecision, resolveDecision, claimDelivery, acknowledgeDelivery, semanticKey };
