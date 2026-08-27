'use strict';

const fs = require('fs');
const path = require('path');

const MODULE_SNAPSHOT_SCHEMA = 'jarvos-health-module-snapshot/v1';
const HEALTH_MODULE_DIRECTORY = path.join('.jarvos', 'health-modules');
const PUBLIC_MODULE_ID = 'memory';
const CONTINUITY_MODULE_ID = 'gbrain-continuity';
const MODULE_IDS = Object.freeze([PUBLIC_MODULE_ID, CONTINUITY_MODULE_ID]);
const PUBLIC_MODULE_FILE = PUBLIC_MODULE_ID + '.json';
const CONTINUITY_MODULE_FILE = CONTINUITY_MODULE_ID + '.json';
const PUBLIC_STATES = Object.freeze(['healthy', 'update available', 'repair needed', 'needs your attention']);
const SNAPSHOT_FIELDS = Object.freeze(['schema', 'moduleId', 'generation', 'observedAt', 'validUntil', 'trust', 'repairable', 'updateAvailable']);
const CONTINUITY_SNAPSHOT_FIELDS = Object.freeze(['schema', 'moduleId', 'generation', 'observedAt', 'validUntil', 'trust', 'factsVersion', 'facts']);
const CONTINUITY_FACTS_VERSION = 'jarvos-gbrain-continuity-facts/v1';
const CONTINUITY_TARGETS = Object.freeze(['codex', 'hermes', 'openclaw']);
const KNOWN_CONTINUITY_PRODUCERS = Object.freeze(['jarvos-gbrain']);
const CONTINUITY_EVIDENCE_STATES = Object.freeze([
  'absent', 'unsafe-runtime', 'unregistered', 'unreachable', 'wrong-brain',
  'missing-capability', 'stale-probe', 'maintenance-blocked', 'backup-stale',
  'machine-proven', 'live-turn-proven',
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function moduleFile(moduleId) {
  return moduleId + '.json';
}

function modulePath(workspace, moduleId = PUBLIC_MODULE_ID) {
  if (!MODULE_IDS.includes(moduleId)) throw new RangeError('unsupported health module');
  return path.join(path.resolve(workspace), HEALTH_MODULE_DIRECTORY, moduleFile(moduleId));
}

function ownerOnly(stat) {
  const mode = stat?.mode;
  if (typeof mode === 'number' && (mode & 0o077) !== 0) return false;
  if (typeof process.getuid === 'function' && typeof stat?.uid === 'number' && stat.uid !== process.getuid()) return false;
  return true;
}

function ownedHealthDirectory(workspace, fsImpl = fs) {
  const root = path.resolve(workspace || '');
  const directory = path.resolve(root, HEALTH_MODULE_DIRECTORY);
  if (directory !== root && !directory.startsWith(root + path.sep)) return { ok: false, reasonClass: 'module-invalid' };
  try {
    const stat = fsImpl.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOnly(stat)) return { ok: false, reasonClass: 'module-invalid' };
    return { ok: true, directory };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, missing: true, directory };
    return { ok: false, reasonClass: 'module-invalid' };
  }
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function exactObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = fields.slice().sort();
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function publicAttention(reasonClass = 'module-invalid', details = {}, moduleId = PUBLIC_MODULE_ID) {
  return {
    id: moduleId,
    state: 'needs your attention',
    generation: Number.isSafeInteger(details.generation) ? details.generation : 0,
    observedAt: details.observedAt || null,
    validUntil: details.validUntil || null,
    reasonClass,
  };
}

function missingContinuityModule(reasonClass = 'module-missing') {
  return {
    id: CONTINUITY_MODULE_ID,
    state: 'needs your attention',
    generation: 0,
    observedAt: null,
    validUntil: null,
    reasonClass: 'continuity-evidence-missing',
    targets: CONTINUITY_TARGETS.map((target) => ({
      target,
      evidenceState: 'stale-probe',
      generation: 0,
      observedAt: null,
      validUntil: null,
      reasonClass,
      jarvosRuntimeDigest: null,
      gbrainRuntimeDigest: null,
      logicalBrainDigest: null,
      storeDigest: null,
      fixtureDigest: null,
    })),
  };
}

function validateBaseSnapshot(snapshot, now) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !MODULE_IDS.includes(snapshot.moduleId)) return { ok: false, reasonClass: 'module-invalid' };
  const fields = snapshot.moduleId === PUBLIC_MODULE_ID ? SNAPSHOT_FIELDS : CONTINUITY_SNAPSHOT_FIELDS;
  if (!exactObject(snapshot, fields) || snapshot.schema !== MODULE_SNAPSHOT_SCHEMA || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1) return { ok: false, reasonClass: 'module-invalid' };
  const observedAt = isoDate(snapshot.observedAt);
  const validUntil = isoDate(snapshot.validUntil);
  if (!observedAt || !validUntil || validUntil <= observedAt || observedAt > now || !['trusted', 'untrusted'].includes(snapshot.trust)) return { ok: false, reasonClass: 'module-invalid' };
  return { ok: true, snapshot, observedAt, validUntil };
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function nullableDigest(value) {
  return value === null || isDigest(value);
}

function validDates(value) {
  const observedAt = isoDate(value.observedAt);
  const validUntil = isoDate(value.validUntil);
  return observedAt && validUntil && validUntil > observedAt;
}

function validateLiveTurn(receipt) {
  const fields = ['producer', 'target', 'challengeDigest', 'jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest', 'probeGeneration', 'observedAt', 'validUntil', 'consumed'];
  if (!exactObject(receipt, fields) || !CONTINUITY_TARGETS.includes(receipt.target) || typeof receipt.producer !== 'string' || !Number.isSafeInteger(receipt.probeGeneration) || receipt.probeGeneration < 1 || typeof receipt.consumed !== 'boolean' || !validDates(receipt)) return false;
  return ['challengeDigest', 'jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest'].every((field) => isDigest(receipt[field]));
}

function validateContinuityTarget(target) {
  const fields = ['target', 'binaryPresent', 'runtimeVerified', 'runtimeFresh', 'nativeRegistered', 'serviceReachable', 'sameBrain', 'capabilityProven', 'skillifyProven', 'maintenanceBlocked', 'backupFresh', 'machineProven', 'probeGeneration', 'observedAt', 'validUntil', 'challengeDigest', 'jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest', 'liveTurn'];
  if (!exactObject(target, fields) || !CONTINUITY_TARGETS.includes(target.target) || !Number.isSafeInteger(target.probeGeneration) || target.probeGeneration < 1 || !validDates(target)) return false;
  const booleans = ['binaryPresent', 'runtimeVerified', 'runtimeFresh', 'nativeRegistered', 'serviceReachable', 'sameBrain', 'capabilityProven', 'skillifyProven', 'maintenanceBlocked', 'backupFresh', 'machineProven'];
  if (!booleans.every((field) => typeof target[field] === 'boolean')) return false;
  if (!['challengeDigest', 'jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest'].every((field) => nullableDigest(target[field]))) return false;
  return target.liveTurn === null || validateLiveTurn(target.liveTurn);
}

function validateContinuityFacts(facts) {
  if (!exactObject(facts, ['producer', 'targets']) || typeof facts.producer !== 'string' || !Array.isArray(facts.targets) || facts.targets.length !== CONTINUITY_TARGETS.length) return false;
  return facts.targets.every((target, index) => validateContinuityTarget(target) && target.target === CONTINUITY_TARGETS[index]);
}

function validateSnapshot(snapshot, now = new Date()) {
  const base = validateBaseSnapshot(snapshot, now);
  if (!base.ok) return base;
  if (snapshot.moduleId === PUBLIC_MODULE_ID) {
    if (typeof snapshot.repairable !== 'boolean' || typeof snapshot.updateAvailable !== 'boolean') return { ok: false, reasonClass: 'module-invalid' };
  } else if (snapshot.factsVersion !== CONTINUITY_FACTS_VERSION || !validateContinuityFacts(snapshot.facts)) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  return base;
}

function reduceHealthModule(snapshot, { now = new Date(), validation = null } = {}) {
  const checked = validation || validateSnapshot(snapshot, now);
  if (!checked.ok) return publicAttention(checked.reasonClass);
  let state = 'healthy';
  let reasonClass = 'none';
  if (snapshot.trust !== 'trusted') [state, reasonClass] = ['needs your attention', 'module-untrusted'];
  else if (checked.validUntil <= now) [state, reasonClass] = ['needs your attention', 'module-stale'];
  else if (snapshot.repairable) [state, reasonClass] = ['repair needed', 'repairable-fault'];
  else if (snapshot.updateAvailable) [state, reasonClass] = ['update available', 'update-available'];
  return { id: PUBLIC_MODULE_ID, state, generation: snapshot.generation, observedAt: snapshot.observedAt, validUntil: snapshot.validUntil, reasonClass };
}

function liveTurnProven(target, factsProducer, snapshotGeneration, now) {
  const receipt = target.liveTurn;
  if (!isDigest(target.challengeDigest) || !receipt || !receipt.consumed || !KNOWN_CONTINUITY_PRODUCERS.includes(factsProducer) || receipt.producer !== factsProducer || receipt.target !== target.target || receipt.probeGeneration !== target.probeGeneration || receipt.challengeDigest !== target.challengeDigest) return false;
  if (target.probeGeneration !== snapshotGeneration) return false;
  const tupleFields = ['jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest'];
  if (!tupleFields.every((field) => receipt[field] === target[field])) return false;
  const observedAt = isoDate(receipt.observedAt);
  const validUntil = isoDate(receipt.validUntil);
  const targetObservedAt = isoDate(target.observedAt);
  const targetValidUntil = isoDate(target.validUntil);
  return observedAt >= targetObservedAt && observedAt <= now && validUntil > now && validUntil <= targetValidUntil;
}

function machineTupleProven(target) {
  return ['jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest'].every((field) => isDigest(target[field]));
}

function reduceContinuityTarget(target, factsProducer, snapshotGeneration, now) {
  let evidenceState = 'live-turn-proven';
  let reasonClass = 'none';
  if (!target.binaryPresent) [evidenceState, reasonClass] = ['absent', 'binary-absent'];
  else if (!target.runtimeVerified || !target.runtimeFresh) [evidenceState, reasonClass] = ['unsafe-runtime', 'runtime-unsafe'];
  else if (!target.nativeRegistered) [evidenceState, reasonClass] = ['unregistered', 'harness-unregistered'];
  else if (!target.serviceReachable) [evidenceState, reasonClass] = ['unreachable', 'service-unreachable'];
  else if (!target.sameBrain) [evidenceState, reasonClass] = ['wrong-brain', 'brain-mismatch'];
  else if (!target.capabilityProven || (target.target === 'codex' && !target.skillifyProven)) [evidenceState, reasonClass] = ['missing-capability', 'capability-missing'];
  else if (isoDate(target.observedAt) > now || isoDate(target.validUntil) <= now || !target.machineProven || !machineTupleProven(target)) [evidenceState, reasonClass] = ['stale-probe', target.machineProven ? 'probe-stale' : 'machine-unproven'];
  else if (target.maintenanceBlocked) [evidenceState, reasonClass] = ['maintenance-blocked', 'maintenance-blocked'];
  else if (!target.backupFresh) [evidenceState, reasonClass] = ['backup-stale', 'backup-stale'];
  else if (!liveTurnProven(target, factsProducer, snapshotGeneration, now)) [evidenceState, reasonClass] = ['machine-proven', 'live-turn-unproven'];
  return {
    target: target.target, evidenceState, generation: target.probeGeneration,
    observedAt: target.observedAt, validUntil: target.validUntil, reasonClass,
    jarvosRuntimeDigest: target.jarvosRuntimeDigest, gbrainRuntimeDigest: target.gbrainRuntimeDigest,
    logicalBrainDigest: target.logicalBrainDigest, storeDigest: target.storeDigest, fixtureDigest: target.fixtureDigest,
  };
}

function reduceContinuityModule(snapshot, { now = new Date(), validation = null } = {}) {
  const checked = validation || validateSnapshot(snapshot, now);
  if (!checked.ok) return publicAttention(checked.reasonClass, {}, CONTINUITY_MODULE_ID);
  if (snapshot.trust !== 'trusted') return publicAttention('module-untrusted', snapshot, CONTINUITY_MODULE_ID);
  if (checked.validUntil <= now) return publicAttention('module-stale', snapshot, CONTINUITY_MODULE_ID);
  let targets = snapshot.facts.targets.map((target) => reduceContinuityTarget(target, snapshot.facts.producer, snapshot.generation, now));
  const tupleFields = ['jarvosRuntimeDigest', 'gbrainRuntimeDigest', 'logicalBrainDigest', 'storeDigest', 'fixtureDigest'];
  const reference = targets[0];
  const sharedTuple = reference && targets.every((target) => (
    tupleFields.every((field) => target[field] === reference[field])
  ));
  if (!sharedTuple && targets.every((target) => target.evidenceState === 'live-turn-proven')) {
    targets = targets.map((target) => ({
      ...target,
      evidenceState: 'wrong-brain',
      reasonClass: 'cross-harness-tuple-mismatch',
    }));
  }
  const complete = targets.every((target) => target.evidenceState === 'live-turn-proven');
  return {
    id: CONTINUITY_MODULE_ID, state: complete ? 'healthy' : 'needs your attention',
    generation: snapshot.generation, observedAt: snapshot.observedAt, validUntil: snapshot.validUntil,
    reasonClass: complete ? 'none' : 'continuity-incomplete', targets,
  };
}

function reduceModule(snapshot, options) {
  return snapshot.moduleId === CONTINUITY_MODULE_ID ? reduceContinuityModule(snapshot, options) : reduceHealthModule(snapshot, options);
}

function loadHealthModules({ workspace, now = new Date(), fsImpl = fs, expectedContinuity = false } = {}) {
  const directory = ownedHealthDirectory(workspace, fsImpl);
  if (!directory.ok) {
    const modules = [publicAttention(directory.reasonClass)];
    if (expectedContinuity) modules.push(missingContinuityModule(directory.reasonClass));
    return { modules, issues: [directory.reasonClass] };
  }
  if (directory.missing) {
    return expectedContinuity
      ? { modules: [missingContinuityModule()], issues: ['continuity-evidence-missing'] }
      : { modules: [], issues: [] };
  }
  const modules = [];
  const issues = [];
  for (const moduleId of MODULE_IDS) {
    const filePath = path.join(directory.directory, moduleFile(moduleId));
    let stat;
    try {
      stat = fsImpl.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      modules.push(publicAttention('module-invalid', {}, moduleId));
      issues.push('module-invalid');
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !ownerOnly(stat)) {
      modules.push(publicAttention('module-invalid', {}, moduleId));
      issues.push('module-invalid');
      continue;
    }
    let snapshot;
    try {
      snapshot = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      modules.push(publicAttention('module-invalid', {}, moduleId));
      issues.push('module-invalid');
      continue;
    }
    const validation = validateSnapshot(snapshot, now);
    if (!validation.ok || snapshot.moduleId !== moduleId) {
      modules.push(publicAttention(validation.reasonClass || 'module-invalid', {}, moduleId));
      issues.push(validation.reasonClass || 'module-invalid');
      continue;
    }
    modules.push(reduceModule(snapshot, { now, validation }));
  }
  if (expectedContinuity && !modules.some((module) => module.id === CONTINUITY_MODULE_ID)) {
    modules.push(missingContinuityModule());
    issues.push('continuity-evidence-missing');
  }
  return { modules, issues };
}

module.exports = {
  HEALTH_MODULE_DIRECTORY, MODULE_SNAPSHOT_SCHEMA, PUBLIC_MODULE_ID, PUBLIC_STATES, PUBLIC_MODULE_FILE,
  CONTINUITY_MODULE_ID, CONTINUITY_MODULE_FILE, CONTINUITY_FACTS_VERSION, CONTINUITY_TARGETS, CONTINUITY_EVIDENCE_STATES,
  loadHealthModules, missingContinuityModule, modulePath, ownerOnly, reduceHealthModule, reduceContinuityModule, validateSnapshot,
};
