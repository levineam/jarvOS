'use strict';

// Owner-only, local decision ledger.  This deliberately contains no transport
// details: a selected runtime may claim an outbox item and acknowledge it, but
// agents and transports cannot manufacture a decision or a resolution.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, ensureDir, SUPPORTED_HARNESSES } = require('./config');

const SCHEMA_VERSION = 'jarvos.skill-owner-decisions/v2';
const FALLBACK_MS = 24 * 60 * 60 * 1000;
const OPTION_SETS = Object.freeze({
  needs_owner_input: ['share', 'keep-local', 'exclude', 'details'],
  semantic_collision: ['keep-local', 'exclude', 'details'],
  ambiguous_identity: ['keep-local', 'exclude', 'details'],
  capability_unsupported: ['keep-local', 'exclude', 'details'],
  source_absent: ['keep-local', 'exclude', 'details'],
  // Unsafe, private, or under-trusted sources can never be shared by a
  // decision; the owner can only keep them local or exclude them.
  privacy_restricted: ['keep-local', 'exclude', 'details'],
  trust_class_insufficient: ['keep-local', 'exclude', 'details'],
  unsafe_source: ['keep-local', 'exclude', 'details'],
});
// A blocked classification becomes an owner decision only when its reason has
// a known option set that cannot share: the owner may keep it local or exclude
// it, but a decision never admits an ambiguous, colliding, unsafe, private, or
// under-trusted skill.
const BLOCKED_DECISION_REASONS = new Set(Object.keys(OPTION_SETS).filter((reason) => !OPTION_SETS[reason].includes('share')));
// Owner-facing facts are allowlisted: harness ids and one preserved-state
// word. Paths, bodies, digests, and diagnostics never enter them.
const PRESERVED_STATES = Object.freeze(['unchanged', 'shared-copies-kept']);
// Reminder occurrences are scheduler keys. An hourly key is a series name, a
// `-` or `:`, and a UTC hour, such as `hour-2026-08-16T16` or
// `jarvos-shared-skill-repair:2026-08-16T16`. A production runner that stamps
// its run key to the minute (`…T16:30`) names the same hourly occurrence: the
// minutes are a sub-occurrence of that hour, so its retries within the hour
// still dedupe exactly and it never fills the bounded custom-key history.
// An hourly key is ordered, so a record keeps only the latest hour it claimed
// per series: that hour and every earlier one can never be claimed again,
// however many later occurrences pass. Any other key is remembered exactly and
// never forgotten; a record refuses a new series or custom key past its bound
// instead of forgetting one.
const OCCURRENCE_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const HOURLY_OCCURRENCE_RE = /^([A-Za-z0-9][A-Za-z0-9:._-]*?)[-:](\d{4}-\d{2}-\d{2}T\d{2})(?::\d{2}(?::\d{2})?)?$/;
const OCCURRENCE_SERIES_LIMIT = 16;
const CUSTOM_OCCURRENCE_LIMIT = 256;
// An hourly occurrence may start at most this far ahead of the claim time, so
// a mistaken future key cannot silence the hours before it.
const OCCURRENCE_SKEW_MS = 60 * 60 * 1000;
// Every ledger change runs under one cross-process lease beside the ledger.
// Holders are short-lived; a competitor waits briefly rather than failing.
const LEDGER_LEASE_WAIT_MS = 5000;
const LEASE_STALE_MS = 6 * 60 * 60 * 1000;
const LEASE_MALFORMED_GRACE_MS = 60 * 1000;
const LEASE_POLL_MS = 25;
// Every change to a lease name (create, reclaim, release) happens inside a
// short atomic gate beside it, so no process can replace a lease between
// another's inspection and its change. The gate spans a few filesystem calls;
// one that outlives this wait was left by an interrupted process and is never
// removed automatically, so it fails closed until an operator clears it.
const LEASE_GATE_WAIT_MS = 2000;
const LEASE_GATE_POLL_MS = 5;
const heldLeases = new Set();

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)); }
// A lease is stale when its holder is gone or it outlived the stale bound; a
// lease whose content is unreadable gets a short grace period.
function leaseIsStale(leasePath, { staleAfterMs, malformedGraceMs }) {
  const stat = fs.lstatSync(leasePath);
  try {
    const prior = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    const startedAt = Date.parse(prior.startedAt);
    const tooOld = Number.isFinite(startedAt) && Date.now() - startedAt > staleAfterMs;
    let alive = typeof prior.pid === 'number' && prior.pid > 0;
    if (alive) {
      try { process.kill(prior.pid, 0); } catch { alive = false; }
    }
    return tooOld || !alive;
  } catch {
    return Date.now() - stat.mtimeMs > malformedGraceMs;
  }
}
function enterGate(gate, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.mkdirSync(gate, { mode: 0o700 }); return true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (Date.now() >= deadline) return false;
    sleepSync(Math.min(LEASE_GATE_POLL_MS, deadline - Date.now()));
  }
}
// Runs inside the gate: take the free name, or remove a stale holder and take
// it. Nothing else can change the name meanwhile, so a live lease is never
// removed. The holder record is written before the gate opens again.
function takeLease(target, operation, staleness) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(target, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!leaseIsStale(target, staleness)) return null;
      fs.unlinkSync(target);
      continue;
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString() }));
    } catch (error) {
      try { fs.unlinkSync(target); } catch { /* left for stale recovery */ }
      fs.closeSync(fd);
      throw error;
    }
    return fd;
  }
  return null;
}
// Shared cross-process lease. A nested acquisition in the same process fails
// immediately instead of waiting on itself; release only removes our own file.
function withFileLease(leasePath, { operation = 'mutation', busyMessage, waitMs = 0, gateWaitMs = LEASE_GATE_WAIT_MS, staleAfterMs = LEASE_STALE_MS, malformedGraceMs = LEASE_MALFORMED_GRACE_MS } = {}, fn) {
  const target = path.resolve(leasePath);
  const gate = `${target}.gate`;
  const busyText = busyMessage || `${operation} is already running`;
  // Failures carry a code and the lease operation, so a caller can report a
  // safe cause without reading the message.
  const busy = () => Object.assign(new Error(busyText), { code: 'ELEASEBUSY', operation });
  if (heldLeases.has(target)) throw busy();
  const inGate = (step) => {
    if (!enterGate(gate, Math.max(0, Number(gateWaitMs) || 0))) {
      throw Object.assign(new Error(`${busyText}; a lock gate was left behind, so manual recovery may be needed: confirm no jarvOS process is running, then remove ${path.basename(gate)}`), { code: 'ELEASEGATE', operation });
    }
    try { return step(); } finally { fs.rmdirSync(gate); }
  };
  const staleness = { staleAfterMs, malformedGraceMs };
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let fd = inGate(() => takeLease(target, operation, staleness));
  while (fd === null) {
    if (Date.now() >= deadline) throw busy();
    sleepSync(Math.min(LEASE_POLL_MS, deadline - Date.now()));
    fd = inGate(() => takeLease(target, operation, staleness));
  }
  heldLeases.add(target);
  try {
    return fn();
  } finally {
    heldLeases.delete(target);
    try {
      inGate(() => {
        const mine = fs.fstatSync(fd); const current = fs.lstatSync(target);
        if (mine.dev === current.dev && mine.ino === current.ino) fs.unlinkSync(target);
      });
    } catch { /* already reclaimed, or the gate is stuck: never remove a lease outside the gate */ }
    fs.closeSync(fd);
  }
}

function stable(value) { return JSON.stringify(value); }
function digest(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function nowIso(now) { return now || new Date().toISOString(); }
function isIsoTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}
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
function reasonFor(skill) {
  const reason = skill?.disposition?.reasonCode;
  return Object.prototype.hasOwnProperty.call(OPTION_SETS, reason) ? reason : 'needs_owner_input';
}
function semanticKey(skill, options) {
  return digest({
    skill: skill.logicalId,
    treeDigest: skill.treeDigest,
    reason: reasonFor(skill),
    policyVersion: 1,
    options,
  });
}
function validSkill(skill) {
  // Every decision needs actionable attention. A source that disappeared before
  // it was ever accepted is quiet in assessment and never asks the owner; an
  // accepted source that disappeared stays actionable until retirement.
  // Incomplete observation has nothing to decide.
  const kind = skill?.disposition?.kind; const reason = skill?.disposition?.reasonCode;
  return skill && typeof skill.logicalId === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(skill.logicalId)
    && typeof skill.treeDigest === 'string' && /^[a-f0-9]{64}$/i.test(skill.treeDigest)
    && skill.attention === 'actionable'
    && (kind === 'needs_input' || (kind === 'blocked' && BLOCKED_DECISION_REASONS.has(reason)));
}
function ownerFacts(skill) {
  const rows = Array.isArray(skill?.matrix) ? skill.matrix : [];
  const affectedHarnesses = [...new Set(rows
    .filter((row) => row?.projection !== 'source_present' && SUPPORTED_HARNESSES.includes(row?.harness))
    .map((row) => row.harness))].sort();
  // An accepted source that disappeared keeps its earlier shared copies until
  // the retirement grace period; every other hold leaves everything as it was.
  const preservedState = reasonFor(skill) === 'source_absent' && skill.attention === 'actionable' ? 'shared-copies-kept' : 'unchanged';
  return { affectedHarnesses, preservedState };
}
// Records written before reminders existed have no reminder data and are
// active. A deferral without a valid deadline is active too: only an explicit,
// well-formed owner pause may silence a reminder.
function reminderState(decision) {
  const reminder = decision.reminder && typeof decision.reminder === 'object' ? decision.reminder : {};
  const deferred = reminder.status === 'deferred' && isIsoTime(reminder.until);
  const status = reminder.status === 'acknowledged' ? 'acknowledged' : deferred ? 'deferred' : 'active';
  return {
    status,
    until: deferred ? reminder.until : null,
    seen: occurrenceRecord(reminder),
    count: Number.isInteger(reminder.count) && reminder.count > 0 ? reminder.count : 0,
  };
}
function occurrenceError(message) { return Object.assign(new Error(message), { code: 'EOCCURRENCE' }); }
function hourlyOccurrence(key) {
  const match = typeof key === 'string' ? HOURLY_OCCURRENCE_RE.exec(key) : null;
  if (!match) return null;
  const start = Date.parse(`${match[2]}:00:00.000Z`);
  // A key that only looks hourly (an impossible date) is a custom key.
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 13) !== match[2]) return null;
  return { series: match[1], hour: match[2], start };
}
// What a record has claimed: the latest hour per hourly series and every
// custom key. Records written before hourly series fold their recent keys in.
function occurrenceRecord(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const hours = Object.create(null); const occurrences = [];
  const note = (hourly) => { if (!(Object.hasOwn(hours, hourly.series) && hours[hourly.series] >= hourly.hour)) hours[hourly.series] = hourly.hour; };
  if (source.hours && typeof source.hours === 'object') {
    for (const [series, hour] of Object.entries(source.hours)) {
      const hourly = typeof hour === 'string' ? hourlyOccurrence(`${series}-${hour}`) : null;
      if (hourly && hourly.series === series) note(hourly);
    }
  }
  for (const key of Array.isArray(source.occurrences) ? source.occurrences : []) {
    if (typeof key !== 'string') continue;
    const hourly = hourlyOccurrence(key);
    if (hourly) note(hourly);
    else if (!occurrences.includes(key)) occurrences.push(key);
  }
  return { hours, occurrences };
}
function occurrenceSeen(record, key) {
  const hourly = hourlyOccurrence(key);
  if (!hourly) return record.occurrences.includes(key);
  return Object.hasOwn(record.hours, hourly.series) && record.hours[hourly.series] >= hourly.hour;
}
// Whether this record claimed exactly this occurrence, rather than this one or
// any later one. Because an hourly record keeps only the latest hour it claimed
// per series, the latest hour being exactly this hour means this hour is the
// one it claimed and no later hour has followed. That makes the check both the
// membership test for an occurrence and the test for it still being current:
// an earlier hour, once a later one has been claimed, is never exact again.
// A custom key is remembered verbatim, so its membership is exact already, but
// custom keys carry no order, so they are never treated as current.
function occurrenceClaimedExactly(record, key) {
  const hourly = hourlyOccurrence(key);
  if (!hourly) return false;
  return Object.hasOwn(record.hours, hourly.series) && record.hours[hourly.series] === hourly.hour;
}
// Records an occurrence that is not yet seen. A record that is full refuses
// the new series or custom key rather than forget an earlier one.
function rememberOccurrence(record, key) {
  const hourly = hourlyOccurrence(key);
  if (hourly) {
    if (!Object.hasOwn(record.hours, hourly.series) && Object.keys(record.hours).length >= OCCURRENCE_SERIES_LIMIT) {
      throw occurrenceError('reminder occurrence history is full');
    }
    record.hours[hourly.series] = hourly.hour;
  } else {
    if (record.occurrences.length >= CUSTOM_OCCURRENCE_LIMIT) throw occurrenceError('reminder occurrence history is full');
    record.occurrences.push(key);
  }
  return record;
}
function publicReminder(decision) {
  const { status, until } = reminderState(decision);
  return until ? { status, until } : { status };
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
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Object.assign(new Error('decision state is unsafe'), { code: 'EDECISIONSTATE' });
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed?.schemaVersion === SCHEMA_VERSION && Array.isArray(parsed.decisions)) {
      return { ...parsed, migrations: parsed.migrations && typeof parsed.migrations === 'object' ? parsed.migrations : {} };
    }
  } catch { /* fail closed below */ }
  throw Object.assign(new Error('decision state is unsupported'), { code: 'EDECISIONSTATE' });
}
function save(statePath, state) { atomicWriteJson(statePath, { ...state, schemaVersion: SCHEMA_VERSION }); }
// The only way to change the ledger: load, change, and atomically save under
// the ledger lease. `commit` persists the loaded state; reads stay unleased.
function mutateLedger(statePath, leaseWaitMs, fn) {
  safeStatePath(statePath);
  return withFileLease(`${statePath}.lock`, {
    operation: 'decision-ledger', busyMessage: 'decision state is busy',
    waitMs: leaseWaitMs === undefined ? LEDGER_LEASE_WAIT_MS : leaseWaitMs,
  }, () => {
    const state = load(statePath);
    return fn(state, () => save(statePath, state));
  });
}
// Ids are unique from now on, but a ledger written before that may repeat one;
// the newest record is the live one because a recurrence is only appended
// after its predecessor stopped being pending.
function byId(state, decisionId) {
  if (typeof decisionId !== 'string' || !decisionId) return null;
  for (let index = state.decisions.length - 1; index >= 0; index -= 1) {
    if (state.decisions[index].id === decisionId) return state.decisions[index];
  }
  return null;
}
// The first record for a semantic key keeps the historical id; a recurrence
// gets a distinct deterministic id so a lookup can never land on a retired one.
function recordId(state, key) {
  const taken = new Set(state.decisions.map((decision) => decision.id));
  for (let recurrence = 0; ; recurrence += 1) {
    const id = `decision-${(recurrence === 0 ? key : digest({ semanticKey: key, recurrence })).slice(0, 24)}`;
    if (!taken.has(id)) return id;
  }
}
function publicDecision(decision) {
  return {
    id: decision.id, decisionReference: decision.decisionReference, skill: decision.skill, revision: decision.revision, reason: decision.reason,
    options: [...decision.options], affectedHarnesses: [...(decision.affectedHarnesses || [])],
    preservedState: PRESERVED_STATES.includes(decision.preservedState) ? decision.preservedState : 'unchanged',
    status: decision.status, deliveryStatus: decision.deliveryStatus, reminder: publicReminder(decision),
    createdAt: decision.createdAt, updatedAt: decision.updatedAt,
  };
}
function findDecision(state, { decisionId, decisionReference } = {}) {
  if (typeof decisionReference === 'string' && decisionReference) {
    const byReference = state.decisions.find((item) => item.decisionReference === decisionReference);
    if (!byReference || (decisionId && byReference.id !== decisionId)) return null;
    return byReference;
  }
  return byId(state, decisionId);
}

function reconcileLoadedState(state, { skills = [], observedAt, generationId } = {}) {
  const at = nowIso(observedAt); const created = [];
  const current = new Map(skills.filter(validSkill).map((skill) => [skill.logicalId, skill]));
  for (const decision of state.decisions) {
    if (decision.status !== 'pending') continue;
    const skill = current.get(decision.skill);
    if (!skill) { decision.status = 'disappeared'; decision.updatedAt = at; continue; }
    const identity = semanticKey(skill, optionsFor(skill));
    if (identity !== decision.semanticKey) { decision.status = 'superseded'; decision.updatedAt = at; continue; }
    // Harness coverage can change without changing what the owner decides;
    // refresh the redacted facts in place so reminders stay truthful.
    const facts = ownerFacts(skill);
    if (stable(facts.affectedHarnesses) !== stable(decision.affectedHarnesses) || facts.preservedState !== decision.preservedState) {
      Object.assign(decision, facts); decision.updatedAt = at;
    }
  }
  for (const skill of current.values()) {
    const options = optionsFor(skill); const key = semanticKey(skill, options);
    // A resolution is durable policy for this exact source/policy identity.
    // Do not turn a healthy replay into a new owner interruption; a changed
    // digest gets a distinct semantic key and therefore a fresh assessment.
    if (state.decisions.some((decision) => decision.semanticKey === key
      && ['pending', 'resolved'].includes(decision.status))) continue;
    const decision = {
      id: recordId(state, key), semanticKey: key, skill: skill.logicalId, treeDigest: skill.treeDigest,
      // Transport-safe correlation is intentionally distinct from the stable
      // semantic id. It is random, base64url, and survives every retry for
      // this decision revision without disclosing the skill or source.
      decisionReference: crypto.randomBytes(18).toString('base64url'),
      reason: reasonFor(skill), options, ...ownerFacts(skill), revision: 1, status: 'pending',
      deliveryStatus: 'pending', attempts: [], generationId: generationId || null, createdAt: at, updatedAt: at,
    };
    state.decisions.push(decision); created.push(publicDecision(decision));
  }
  // Least recently reminded first, so a bounded reminder batch rotates through
  // every pending decision across occurrences.
  const remindedAt = (decision) => {
    const claimedAt = Date.parse(decision.reminder?.lastClaimedAt);
    return Number.isFinite(claimedAt) ? claimedAt : 0;
  };
  return {
    created,
    pending: state.decisions.filter((d) => d.status === 'pending').sort((a, b) => remindedAt(a) - remindedAt(b)).map(publicDecision),
    changed: created.length > 0 || state.decisions.some((d) => d.updatedAt === at),
  };
}

function reconcileDecisions({ statePath, skills = [], observedAt, generationId, leaseWaitMs } = {}) {
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    const result = reconcileLoadedState(state, { skills, observedAt, generationId });
    if (result.changed) commit();
    return { created: result.created, pending: result.pending };
  });
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
function migrateV1Attention({ statePath, attentionPath, skills = [], observedAt, generationId, leaseWaitMs } = {}) {
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    if (state.migrations?.attentionV1) return { migrated: false, replay: true, summary: state.migrations.attentionV1.summary };
    const legacy = legacyAttention(attentionPath);
    if (!legacy) return { migrated: false, replay: false, summary: null };
    const eligible = new Map(skills.filter(validSkill).map((skill) => [`${skill.logicalId}:${skill.disposition.reasonCode}`, skill]));
    const current = legacy.map((item) => eligible.get(`${item.logicalId}:${item.reasonCode}`)).filter(Boolean);
    const result = reconcileLoadedState(state, { skills: current, observedAt, generationId });
    const summary = {
      reference: `batch-${digest({ legacy: legacy.map((item) => item.fingerprint || digest({ id: item.logicalId, reason: item.reasonCode })).sort(), generationId: generationId || null }).slice(0, 24)}`,
      pendingCount: result.pending.length,
      migratedCount: result.created.length,
    };
    state.migrations = { ...state.migrations, attentionV1: { summary, migratedAt: nowIso(observedAt) } };
    commit();
    return { migrated: true, replay: false, summary };
  });
}

function reconcileDecisionsWithMigration({ statePath, leaseWaitMs, ...options } = {}) {
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => reconcileLoadedStateWithMigration(state, commit, options));
}
function reconcileLoadedStateWithMigration(state, commit, { attentionPath, skills = [], observedAt, generationId } = {}) {
  let migration = { migrated: false, replay: false, summary: null };
  let changed = false;

  if (state.migrations?.attentionV1) {
    migration = { migrated: false, replay: true, summary: state.migrations.attentionV1.summary };
  } else {
    const legacy = legacyAttention(attentionPath);
    if (legacy) {
      const eligible = new Map(skills.filter(validSkill).map((skill) => [`${skill.logicalId}:${skill.disposition.reasonCode}`, skill]));
      const current = legacy.map((item) => eligible.get(`${item.logicalId}:${item.reasonCode}`)).filter(Boolean);
      const migrated = reconcileLoadedState(state, { skills: current, observedAt, generationId });
      const summary = {
        reference: `batch-${digest({ legacy: legacy.map((item) => item.fingerprint || digest({ id: item.logicalId, reason: item.reasonCode })).sort(), generationId: generationId || null }).slice(0, 24)}`,
        pendingCount: migrated.pending.length,
        migratedCount: migrated.created.length,
      };
      state.migrations = { ...state.migrations, attentionV1: { summary, migratedAt: nowIso(observedAt) } };
      migration = { migrated: true, replay: false, summary };
      changed = true;
    }
  }

  const decisions = reconcileLoadedState(state, { skills, observedAt, generationId });
  if (decisions.changed) changed = true;
  if (changed) commit();
  return { migration, created: decisions.created, pending: decisions.pending };
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
// The owner mutation runs inside the ledger lease, between the revision check
// and the receipt, so no competing change can slip in between them. It must
// not change the ledger itself; a nested ledger mutation fails fast.
function resolveDecision({ statePath, principal, decisionId, decisionReference, revision, option, currentSkill, mutate, leaseWaitMs } = {}) {
  requireOwner(principal, 'skills.decisions.resolve');
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    const decision = findDecision(state, { decisionId, decisionReference });
    if (!decision) return { status: 'not_found' };
    if (decision.status === 'resolved') return { status: 'already_resolved', receipt: decision.receipt };
    if (decision.status !== 'pending' || decision.revision !== revision) return { status: 'stale' };
    if (!decision.options.includes(option)) return { status: 'invalid_option' };
    if (!validSkill(currentSkill) || currentSkill.logicalId !== decision.skill || currentSkill.treeDigest !== decision.treeDigest) return { status: 'stale' };
    // The reply must match what the skill is now, not only which skill it is.
    // A reassessment can turn a shareable skill into a privacy-restricted,
    // under-trusted, or unsafe one without changing its logical id or tree
    // digest; the recorded option set then no longer describes what the owner
    // may choose. Such a reply is superseded: it never mutates and is never
    // recorded as resolved, and the next reconciliation asks again with the
    // current reason and options.
    const currentOptions = optionsFor(currentSkill);
    if (reasonFor(currentSkill) !== decision.reason
      || stable(currentOptions) !== stable(decision.options)
      || semanticKey(currentSkill, currentOptions) !== decision.semanticKey) return { status: 'stale', superseded: true };
    if (option === 'details') return { status: 'pending', decision: publicDecision(decision) };
    if (typeof mutate !== 'function') throw new Error('resolution mutation is required');
    mutate({ skill: decision.skill, option, decisionId: decision.id, revision: decision.revision });
    const at = new Date().toISOString();
    decision.status = 'resolved'; decision.updatedAt = at;
    decision.receipt = Object.freeze({ id: `receipt-${crypto.randomUUID()}`, decisionId: decision.id, decisionReference: decision.decisionReference, revision: decision.revision, option, resolvedAt: at, treeDigest: decision.treeDigest });
    commit();
    return { status: 'resolved', receipt: decision.receipt };
  });
}
function claimDelivery({ statePath, decisionId, now, leaseWaitMs } = {}) {
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => claimLoadedDelivery(state, commit, { decisionId, now }));
}
function claimLoadedDelivery(state, commit, { decisionId, now }) {
  const decision = byId(state, decisionId);
  if (!decision || decision.status !== 'pending' || decision.deliveryStatus === 'delivered' || decision.deliveryStatus === 'delivery_stalled') return null;
  const at = new Date(nowIso(now)); const previous = decision.attempts.at(-1);
  const active = decision.attempts.find((attempt) => attempt.outcome === 'claimed');
  if (active) {
    if (at.getTime() - new Date(active.claimedAt).getTime() < FALLBACK_MS) return null;
    // A sender that disappeared after claiming an attempt must not strand the
    // decision forever. Treat the abandoned claim as an ambiguous delivery;
    // the first abandoned attempt may move to the one bounded fallback, while
    // an abandoned fallback becomes stalled and waits for owner attention.
    active.outcome = 'ambiguous';
    active.outcomeAt = at.toISOString();
    decision.deliveryStatus = decision.attempts.filter((item) => item.outcome !== 'claimed').length >= 2
      ? 'delivery_stalled' : 'delivery_unknown';
    decision.updatedAt = at.toISOString();
    if (decision.deliveryStatus === 'delivery_stalled') {
      commit();
      return null;
    }
  }
  if (previous && previous.outcome !== 'claimed' && at.getTime() - new Date(previous.claimedAt).getTime() < FALLBACK_MS) return null;
  const kind = decision.attempts.length === 0 ? 'initial' : 'fallback';
  const attempt = { id: `attempt-${crypto.randomUUID()}`, kind, claimedAt: at.toISOString(), outcome: 'claimed' };
  decision.attempts.push(attempt); decision.deliveryStatus = 'claimed'; decision.updatedAt = at.toISOString(); commit();
  return { decisionId: decision.id, decisionReference: decision.decisionReference, revision: decision.revision, attemptId: attempt.id, kind };
}
function acknowledgeDelivery({ statePath, principal, decisionId, revision, attemptId, outcome, providerMessageId, leaseWaitMs } = {}) {
  requireDeliveryPrincipal(principal);
  if (!['accepted', 'rejected', 'ambiguous'].includes(outcome)) throw new Error('delivery outcome is invalid');
  const messageId = typeof providerMessageId === 'string' && providerMessageId ? providerMessageId : null;
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    const decision = byId(state, decisionId);
    const attempt = decision?.attempts.find((item) => item.id === attemptId);
    // A sender whose acknowledgement landed but who stopped before its own
    // receipt may replay it exactly; that changes nothing. Any difference, or
    // an attempt that was abandoned rather than acknowledged, stays stale.
    if (decision && decision.revision === revision && attempt?.acknowledged === true
      && attempt.outcome === outcome && (attempt.providerMessageId || null) === messageId) return publicDecision(decision);
    if (!decision || decision.status !== 'pending' || decision.revision !== revision || !attempt || attempt.outcome !== 'claimed') throw new Error('delivery acknowledgement is stale');
    attempt.outcome = outcome; attempt.acknowledged = true; attempt.outcomeAt = new Date().toISOString(); if (messageId) attempt.providerMessageId = messageId;
    decision.updatedAt = new Date().toISOString();
    if (outcome === 'accepted') decision.deliveryStatus = 'delivered';
    else if (decision.attempts.filter((item) => item.outcome !== 'claimed').length >= 2) decision.deliveryStatus = 'delivery_stalled';
    else decision.deliveryStatus = outcome === 'ambiguous' ? 'delivery_unknown' : 'pending';
    commit(); return publicDecision(decision);
  });
}

// Reminders are separate from the two delivery attempts above: those attempts
// resolve transport uncertainty, while each scheduler occurrence may remind the
// owner once until the decision is resolved, disappears, or is explicitly
// paused. The caller supplies a deterministic occurrence key.
function claimLoadedReminder(decision, occurrenceKey, at) {
  if (!decision || decision.status !== 'pending') return null;
  const reminder = reminderState(decision);
  const expired = reminder.status === 'deferred' && Date.parse(reminder.until) <= Date.parse(at);
  if ((reminder.status !== 'active' && !expired) || occurrenceSeen(reminder.seen, occurrenceKey)) return null;
  const { hours, occurrences } = rememberOccurrence(reminder.seen, occurrenceKey);
  const { until: _expiredUntil, ...kept } = decision.reminder || {};
  decision.reminder = { ...kept, status: 'active', hours, occurrences, count: reminder.count + 1, lastClaimedAt: at };
  return { decisionId: decision.id, decisionReference: decision.decisionReference, revision: decision.revision, occurrenceKey, sequence: reminder.count + 1 };
}
// Re-renders what the current occurrence already claimed for one decision. It
// reads the ledger and changes nothing: no reminder count moves, no occurrence
// is remembered again, and no decision is newly claimed. A decision replays
// only while it would still be remindable now, so a decision the owner has
// since resolved, acknowledged, or deferred, or one that has disappeared or
// been superseded, is silently left out of the replay rather than revived.
function replayLoadedReminder(decision, occurrenceKey, at) {
  if (!decision || decision.status !== 'pending') return null;
  const reminder = reminderState(decision);
  if (!occurrenceClaimedExactly(reminder.seen, occurrenceKey)) return null;
  const expired = reminder.status === 'deferred' && Date.parse(reminder.until) <= Date.parse(at);
  if (reminder.status !== 'active' && !expired) return null;
  return {
    decisionId: decision.id, decisionReference: decision.decisionReference, revision: decision.revision,
    occurrenceKey, sequence: reminder.count, replay: true,
  };
}
function validOccurrence(occurrenceKey, at) {
  if (typeof occurrenceKey !== 'string' || !OCCURRENCE_RE.test(occurrenceKey)) throw occurrenceError('reminder occurrence is invalid');
  const hourly = hourlyOccurrence(occurrenceKey);
  if (hourly && hourly.start > Date.parse(at) + OCCURRENCE_SKEW_MS) throw occurrenceError('reminder occurrence is invalid');
}
function claimReminder({ statePath, decisionId, occurrenceKey, now, leaseWaitMs } = {}) {
  validOccurrence(occurrenceKey, nowIso(now));
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    const claim = claimLoadedReminder(byId(state, decisionId), occurrenceKey, nowIso(now));
    if (claim) commit();
    return claim;
  });
}
// One scheduler occurrence reminds a bounded batch in one ledger transition.
// The ledger itself remembers every occurrence that sent a batch, so a retry,
// a replay any number of occurrences later, or a batch whose membership
// changed never claims a second reminder for it; decisions left out of the
// batch lead a later occurrence instead.
//
// Sending is not claiming, though. A transport that accepted some of an
// occurrence's bounded messages and failed the rest needs the occurrence
// rendered again to recover the missing ones, and the transport, not this
// ledger, owns per-message accepted-delivery dedupe. So a repeat of the
// occurrence that is still the current one for its hourly series replays what
// that occurrence already claimed: the same membership, reconstituted from the
// per-decision reminder records this ledger already keeps, with no new state
// and no second ledger. A replay is a pure read. It never increments a
// reminder count, never remembers the occurrence again, never claims a
// decision that occurrence did not claim, and never revives a decision that
// has since been resolved, acknowledged, deferred, disappeared, or superseded.
// Only the current occurrence is replayable: once a later hour of the series
// has been claimed, every earlier hour is closed for good, so a historical
// delivery can never be reopened.
function claimReminders({ statePath, decisionIds, occurrenceKey, now, limit, leaseWaitMs } = {}) {
  const at = nowIso(now);
  validOccurrence(occurrenceKey, at);
  const ids = Array.isArray(decisionIds) ? decisionIds : [];
  const bound = Number.isInteger(limit) && limit > 0 ? limit : ids.length;
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    const sent = occurrenceRecord(state.reminderOccurrences);
    if (occurrenceSeen(sent, occurrenceKey)
      || state.decisions.some((decision) => occurrenceSeen(reminderState(decision).seen, occurrenceKey))) {
      if (!occurrenceClaimedExactly(sent, occurrenceKey)) return [];
      return ids.map((decisionId) => replayLoadedReminder(byId(state, decisionId), occurrenceKey, at)).filter(Boolean);
    }
    const claims = [];
    for (const decisionId of ids) {
      if (claims.length >= bound) break;
      const claim = claimLoadedReminder(byId(state, decisionId), occurrenceKey, at);
      if (claim) claims.push(claim);
    }
    if (claims.length > 0) {
      state.reminderOccurrences = rememberOccurrence(sent, occurrenceKey);
      commit();
    }
    return claims;
  });
}
// Owner reminder controls pause or restore reminders only. They never resolve
// a decision or touch delivery attempts, and repeating one is a no-op.
function updateReminders(action, { statePath, principal, decisionId, decisionReference, until, now, leaseWaitMs } = {}) {
  requireOwner(principal, 'skills.decisions.resolve');
  const at = nowIso(now);
  if (action === 'defer' && (!isIsoTime(until) || !(Date.parse(until) > Date.parse(at)))) return { status: 'invalid_until' };
  const next = action === 'defer'
    ? { status: 'deferred', until: new Date(until).toISOString() }
    : { status: action === 'acknowledge' ? 'acknowledged' : 'active' };
  return mutateLedger(statePath, leaseWaitMs, (state, commit) => {
    const decision = findDecision(state, { decisionId, decisionReference });
    if (!decision) return { status: 'not_found' };
    if (decision.status !== 'pending') return { status: 'stale' };
    const current = reminderState(decision);
    if (current.status === next.status && current.until === (next.until || null)) return { status: 'unchanged', decision: publicDecision(decision) };
    const { until: _previousUntil, ...kept } = decision.reminder || {};
    decision.reminder = { ...kept, ...next, updatedAt: at };
    commit();
    return { status: 'updated', decision: publicDecision(decision) };
  });
}
function acknowledgeDecision(options) { return updateReminders('acknowledge', options); }
function deferDecision(options) { return updateReminders('defer', options); }
function resumeDecision(options) { return updateReminders('resume', options); }

function approvedShareMap({ statePath } = {}) {
  return new Map(load(statePath).decisions
    .filter((decision) => decision.status === 'resolved' && decision.receipt?.option === 'share')
    .map((decision) => [decision.skill, { treeDigest: decision.treeDigest, decisionReference: decision.decisionReference }]));
}

module.exports = {
  SCHEMA_VERSION,
  reconcileDecisions,
  migrateV1Attention,
  reconcileDecisionsWithMigration,
  listDecisions,
  explainDecision,
  resolveDecision,
  claimDelivery,
  acknowledgeDelivery,
  claimReminder,
  claimReminders,
  acknowledgeDecision,
  deferDecision,
  resumeDecision,
  approvedShareMap,
  semanticKey,
  withFileLease,
};
