'use strict';

const fs = require('fs');
const path = require('path');

const MODULE_SNAPSHOT_SCHEMA = 'jarvos-health-module-snapshot/v1';
const HEALTH_MODULE_DIRECTORY = path.join('.jarvos', 'health-modules');
const PUBLIC_MODULE_ID = 'memory';
const CONTINUITY_MODULE_ID = 'gbrain-continuity';
const SYSTEM_MODULE_ID = 'system';
const MODULE_IDS = Object.freeze([PUBLIC_MODULE_ID, CONTINUITY_MODULE_ID, SYSTEM_MODULE_ID]);
const PUBLIC_MODULE_FILE = PUBLIC_MODULE_ID + '.json';
const CONTINUITY_MODULE_FILE = CONTINUITY_MODULE_ID + '.json';
const SYSTEM_MODULE_FILE = SYSTEM_MODULE_ID + '.json';
const PUBLIC_STATES = Object.freeze(['healthy', 'update available', 'repair needed', 'needs your attention']);
const SNAPSHOT_FIELDS = Object.freeze(['schema', 'moduleId', 'generation', 'observedAt', 'validUntil', 'trust', 'repairable', 'updateAvailable']);
const CONTINUITY_SNAPSHOT_FIELDS = Object.freeze(['schema', 'moduleId', 'generation', 'observedAt', 'validUntil', 'trust', 'factsVersion', 'facts']);
const CONTINUITY_FACTS_VERSION = 'jarvos-gbrain-continuity-facts/v1';
const SYSTEM_FACTS_VERSION = 'jarvos-system-doctor-facts/v2';
const SYSTEM_FACTS_VERSION_V3 = 'jarvos-system-doctor-facts/v3';
const SYSTEM_FACTS_VERSION_V4 = 'jarvos-system-doctor-facts/v4';
const SYSTEM_FACTS_VERSIONS = Object.freeze([SYSTEM_FACTS_VERSION, SYSTEM_FACTS_VERSION_V3, SYSTEM_FACTS_VERSION_V4]);
const SYSTEM_COMPONENT_FIELDS_V2 = Object.freeze(['id', 'state', 'reasonClass', 'evidence']);
const SYSTEM_COMPONENT_FIELDS_V3 = Object.freeze(['id', 'state', 'reasonClass', 'evidence', 'observedAt', 'validUntil']);
const SYSTEM_COMPONENT_STATES = Object.freeze(['healthy', 'warning', 'repair needed', 'not configured']);
// v4 product rows: a row is only as good as its worst check (worst first).
const STATE_SEVERITY = Object.freeze({ healthy: 0, 'not configured': 1, warning: 2, 'repair needed': 3 });
const PRODUCT_FIELDS_V4 = Object.freeze(['id', 'label', 'maker', 'order', 'state', 'reasonClass', 'observedAt', 'validUntil', 'checks']);
const PRODUCT_CHECK_FIELDS_V4 = Object.freeze(['id', 'label', 'state', 'reasonClass', 'observedAt', 'validUntil', 'evidence']);
const DOCTOR_FIELDS_V4 = Object.freeze(['label', 'state', 'reasonClass', 'observedAt', 'validUntil', 'checks']);
const DOCTOR_CHECK_FIELDS_V4 = Object.freeze(['id', 'part', 'label', 'state', 'reasonClass', 'observedAt', 'validUntil']);
const VERSION_FIELDS_V4 = Object.freeze(['installedVersion', 'latestVersion', 'versionSource', 'latestCheckedAt']);
const DOCTOR_PARTS = Object.freeze(['last-run', 'reviewed-release', 'repairs', 'alerts']);
const DOCTOR_ROLLUP_ID = 'doctor';
const MAX_PRODUCTS = 32;
const MAX_ROW_CHECKS = 8;
const MEMORY_COMPONENTS = Object.freeze([
  ['memory.gbrain', 'GBrain core'],
  ['memory.gbrain-semantic-coverage', 'GBrain semantic coverage'],
  ['memory.lossless-claw', 'Lossless Claw'],
  ['memory.qmd-search', 'QMD search'],
  ['memory.memory-wiki', 'memory-wiki'],
  ['memory.notes-provenance', 'Notes & provenance'],
  ['memory.recall-evaluation', 'Recall evaluation'],
  ['memory.scheduled-maintenance', 'Scheduled maintenance'],
  ['memory.runtime-checkout', 'Reviewed runtime'],
  ['memory.automatic-repair', 'Automatic repair'],
  ['memory.notification-follow-up', 'Telegram follow-up & proof'],
]);
const PROVIDER_LABELS = Object.freeze({
  'provider.gbrain': 'GBrain',
  'provider.searxng': 'SearXNG',
  'provider.paperclip': 'Paperclip',
  'provider.openclaw': 'OpenClaw',
  'provider.telegram': 'Telegram',
});
const SAFE_PUBLIC_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
// RegExp.test coerces its argument, so 42 would pass as "42"; require a string first.
const safeId = (value) => typeof value === 'string' && SAFE_PUBLIC_ID.test(value);
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
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : date;
}

function exactObject(value, fields, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return fields.every((field) => keys.includes(field))
    && keys.every((key) => fields.includes(key) || optional.includes(key));
}

function displayText(value, max = 80) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
    && value === value.trim() && !/\p{Cc}/u.test(value);
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

function validComponentCheckDates(component, now) {
  const { observedAt, validUntil } = component;
  if (observedAt === null && validUntil === null) return true;
  if (observedAt === null || validUntil === null) return false;
  const observed = isoDate(observedAt);
  const valid = isoDate(validUntil);
  return Boolean(observed) && Boolean(valid) && valid > observed && observed <= now;
}

function validateSystemComponent(component, factsVersion, now) {
  const isV3 = factsVersion === SYSTEM_FACTS_VERSION_V3;
  const fields = isV3 ? SYSTEM_COMPONENT_FIELDS_V3 : SYSTEM_COMPONENT_FIELDS_V2;
  if (!exactObject(component, fields)
    || !safeId(component.id)
    || !SYSTEM_COMPONENT_STATES.includes(component.state)
    || !safeId(component.reasonClass)) return false;
  if (isV3 && !validComponentCheckDates(component, now)) return false;
  if (component.id !== 'provider.searxng') return component.evidence === null;
  return validSearchEvidence(component.evidence);
}

function validSearchEvidence(evidence) {
  return exactObject(evidence, ['httpReachable', 'searchResultCount', 'runtimeToolAvailable'])
    && typeof evidence.httpReachable === 'boolean'
    && Number.isSafeInteger(evidence.searchResultCount)
    && evidence.searchResultCount >= 0
    && typeof evidence.runtimeToolAvailable === 'boolean';
}

// First failed acceptance layer of a search proof, or null when it holds.
function searchEvidenceFault(evidence) {
  if (!evidence.httpReachable) return 'http-unreachable';
  if (evidence.searchResultCount < 1) return 'search-empty';
  if (!evidence.runtimeToolAvailable) return 'runtime-tool-missing';
  return null;
}

// v4 row aggregate: worst check state (first wins a tie), oldest observedAt,
// earliest validUntil. Undated checks are skipped; only a row with no dated
// check at all reports null/null. Timestamps are fixed-width ISO, so string
// order is time order.
function aggregateChecks(checks) {
  let worst = checks[0];
  for (const check of checks) {
    if (STATE_SEVERITY[check.state] > STATE_SEVERITY[worst.state]) worst = check;
  }
  const observed = checks.map((check) => check.observedAt).filter((value) => value !== null).sort();
  const valid = checks.map((check) => check.validUntil).filter((value) => value !== null).sort();
  return {
    state: worst.state,
    reasonClass: worst.state === 'healthy' ? 'none' : worst.reasonClass,
    observedAt: observed.length ? observed[0] : null,
    validUntil: valid.length ? valid[0] : null,
  };
}

function validateRowCheck(check, fields, now) {
  if (!exactObject(check, fields)
    || !safeId(check.id)
    || !displayText(check.label)
    || !SYSTEM_COMPONENT_STATES.includes(check.state)
    || !safeId(check.reasonClass)
    || !validComponentCheckDates(check, now)) return false;
  // Unlike v3, a green check can never have an unknown age.
  if (check.state === 'healthy' && check.observedAt === null) return false;
  if (!Object.hasOwn(check, 'evidence')) return true;
  if (check.id === 'provider.searxng') return validSearchEvidence(check.evidence);
  return check.evidence === null || validSearchEvidence(check.evidence);
}

function validateRow(row, checkFields, now) {
  if (!SYSTEM_COMPONENT_STATES.includes(row.state)
    || !safeId(row.reasonClass)
    || !validComponentCheckDates(row, now)
    || !Array.isArray(row.checks)
    || row.checks.length < 1
    || row.checks.length > MAX_ROW_CHECKS
    || !row.checks.every((check) => validateRowCheck(check, checkFields, now))) return false;
  // The row restates its checks and may not say anything kinder than them.
  const expected = aggregateChecks(row.checks);
  return row.state === expected.state
    && row.reasonClass === expected.reasonClass
    && row.observedAt === expected.observedAt
    && row.validUntil === expected.validUntil;
}

function validateProduct(product, now) {
  return exactObject(product, PRODUCT_FIELDS_V4, ['version'])
    && safeId(product.id)
    && displayText(product.label)
    && displayText(product.maker)
    && Number.isSafeInteger(product.order)
    && product.order >= 0
    && validateRow(product, PRODUCT_CHECK_FIELDS_V4, now);
}

function validateDoctor(doctor, now) {
  return exactObject(doctor, DOCTOR_FIELDS_V4)
    && displayText(doctor.label)
    && validateRow(doctor, DOCTOR_CHECK_FIELDS_V4, now)
    && doctor.checks.length === DOCTOR_PARTS.length
    && new Set(doctor.checks.map((check) => check.part)).size === DOCTOR_PARTS.length
    && doctor.checks.every((check) => DOCTOR_PARTS.includes(check.part));
}

function validateProductFacts(facts, now) {
  if (!exactObject(facts, ['profile', 'products', 'doctor'])
    || !safeId(facts.profile)
    || !Array.isArray(facts.products)
    || facts.products.length > MAX_PRODUCTS
    || !facts.products.every((product) => validateProduct(product, now))
    || !validateDoctor(facts.doctor, now)) return false;
  if (!facts.products.every((product, index) => index === 0 || product.order > facts.products[index - 1].order)) return false;
  const ids = [
    DOCTOR_ROLLUP_ID,
    ...facts.products.flatMap((product) => [product.id, ...product.checks.map((check) => check.id)]),
    ...facts.doctor.checks.map((check) => check.id),
  ];
  return new Set(ids).size === ids.length;
}

function validateSystemFacts(facts, factsVersion, now) {
  if (factsVersion === SYSTEM_FACTS_VERSION_V4) return validateProductFacts(facts, now);
  if (!exactObject(facts, ['profile', 'components'])
    || !safeId(facts.profile)
    || !Array.isArray(facts.components)
    || facts.components.length > 64
    || !facts.components.every((component) => validateSystemComponent(component, factsVersion, now))) return false;
  const ids = facts.components.map((component) => component.id);
  if (new Set(ids).size !== ids.length) return false;
  const memoryIds = ids.filter((id) => id.startsWith('memory.'));
  return memoryIds.length === 0
    || memoryIds.join('\n') === MEMORY_COMPONENTS.map(([id]) => id).join('\n');
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
  } else if (snapshot.moduleId === CONTINUITY_MODULE_ID) {
    if (snapshot.factsVersion !== CONTINUITY_FACTS_VERSION || !validateContinuityFacts(snapshot.facts)) {
      return { ok: false, reasonClass: 'module-invalid' };
    }
  } else if (!SYSTEM_FACTS_VERSIONS.includes(snapshot.factsVersion) || !validateSystemFacts(snapshot.facts, snapshot.factsVersion, now)) {
    return { ok: false, reasonClass: 'module-invalid' };
  }
  return base;
}

function systemComponentLabel(id) {
  const memory = MEMORY_COMPONENTS.find(([componentId]) => componentId === id);
  if (memory) return memory[1];
  if (PROVIDER_LABELS[id]) return PROVIDER_LABELS[id];
  return id
    .replace(/^[^.]+\./, '')
    .split(/[.-]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function componentCheckDates(component, factsVersion, now) {
  if (factsVersion !== SYSTEM_FACTS_VERSION_V3) return { observedAt: null, validUntil: null, stale: false };
  const { observedAt, validUntil } = component;
  if (observedAt === null || validUntil === null) return { observedAt: null, validUntil: null, stale: false };
  return { observedAt, validUntil, stale: isoDate(validUntil) <= now };
}

function reduceSystemComponent(component, factsVersion, now) {
  const { observedAt, validUntil, stale } = componentCheckDates(component, factsVersion, now);
  let reduced;
  if (component.id !== 'provider.searxng' || component.state !== 'healthy') {
    reduced = { ...component, label: systemComponentLabel(component.id) };
  } else {
    const reasonClass = searchEvidenceFault(component.evidence) || 'none';
    reduced = {
      ...component,
      label: systemComponentLabel(component.id),
      state: reasonClass === 'none' ? 'healthy' : 'warning',
      reasonClass,
    };
  }
  if (stale && reduced.state === 'healthy') {
    reduced.state = 'warning';
    reduced.reasonClass = 'component-stale';
  }
  reduced.observedAt = observedAt;
  reduced.validUntil = validUntil;
  return reduced;
}

// v4 check: same rules as v3 (search proof first, then own deadline), id-agnostic.
function reduceRowCheck(check, now) {
  let { state, reasonClass } = check;
  const fault = state === 'healthy' && check.evidence ? searchEvidenceFault(check.evidence) : null;
  if (fault) [state, reasonClass] = ['warning', fault];
  if (state === 'healthy' && isoDate(check.validUntil) <= now) [state, reasonClass] = ['warning', 'component-stale'];
  return { ...check, state, reasonClass };
}

function reduceRow(row, now) {
  const checks = row.checks.map((check) => reduceRowCheck(check, now));
  return { ...row, ...aggregateChecks(checks), checks };
}

// Display-only. Anything malformed is dropped to null rather than rejecting
// the snapshot: a version note can never change state or validity.
function displayVersion(version) {
  if (!exactObject(version, VERSION_FIELDS_V4) || !exactObject(version.versionSource, ['installed', 'latest'])) return null;
  const text = (value) => value === null || displayText(value, 64);
  const { installedVersion, latestVersion, versionSource, latestCheckedAt } = version;
  if (!text(installedVersion) || !text(latestVersion) || !text(versionSource.installed) || !text(versionSource.latest)
    || !(latestCheckedAt === null || isoDate(latestCheckedAt))) return null;
  return {
    installedVersion,
    latestVersion,
    versionSource: { installed: versionSource.installed, latest: versionSource.latest },
    latestCheckedAt,
  };
}

function reduceProductFacts(facts, now) {
  const products = facts.products.map((product) => ({
    ...reduceRow(product, now),
    version: displayVersion(product.version),
  }));
  const doctor = reduceRow(facts.doctor, now);
  const rollup = (row, id, kind) => ({
    id, label: row.label, state: row.state, reasonClass: row.reasonClass,
    observedAt: row.observedAt, validUntil: row.validUntil, rollup: kind,
  });
  return {
    products,
    doctor,
    // Flat per-row projection so receipt status and Doctor gating need no v4 knowledge.
    components: [
      ...products.map((product) => rollup(product, product.id, 'product')),
      rollup(doctor, DOCTOR_ROLLUP_ID, 'doctor'),
    ],
  };
}

function reduceSystemModule(snapshot, { now = new Date(), validation = null, profile = null } = {}) {
  const checked = validation || validateSnapshot(snapshot, now);
  if (!checked.ok) return publicAttention(checked.reasonClass, {}, SYSTEM_MODULE_ID);
  if (snapshot.trust !== 'trusted') return publicAttention('module-untrusted', snapshot, SYSTEM_MODULE_ID);
  if (checked.validUntil <= now) return publicAttention('module-stale', snapshot, SYSTEM_MODULE_ID);
  if (profile && snapshot.facts.profile !== profile) return publicAttention('profile-mismatch', snapshot, SYSTEM_MODULE_ID);
  const productFacts = snapshot.factsVersion === SYSTEM_FACTS_VERSION_V4 ? reduceProductFacts(snapshot.facts, now) : null;
  const components = productFacts
    ? productFacts.components
    : snapshot.facts.components.map((component) => reduceSystemComponent(component, snapshot.factsVersion, now));
  let state = 'healthy';
  let reasonClass = 'none';
  if (components.some((component) => component.state === 'repair needed')) {
    [state, reasonClass] = ['repair needed', 'component-failed'];
  } else if (components.some((component) => component.state !== 'healthy')) {
    [state, reasonClass] = ['needs your attention', 'component-degraded'];
  }
  return {
    id: SYSTEM_MODULE_ID,
    state,
    generation: snapshot.generation,
    observedAt: snapshot.observedAt,
    validUntil: snapshot.validUntil,
    reasonClass,
    factsVersion: snapshot.factsVersion,
    profile: snapshot.facts.profile,
    components,
    ...(productFacts ? { products: productFacts.products, doctor: productFacts.doctor } : {}),
  };
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
  if (snapshot.moduleId === CONTINUITY_MODULE_ID) return reduceContinuityModule(snapshot, options);
  if (snapshot.moduleId === SYSTEM_MODULE_ID) return reduceSystemModule(snapshot, options);
  return reduceHealthModule(snapshot, options);
}

function loadHealthModules({ workspace, now = new Date(), fsImpl = fs, expectedContinuity = false, profile = null } = {}) {
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
    modules.push(reduceModule(snapshot, { now, validation, profile }));
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
  SYSTEM_MODULE_ID, SYSTEM_MODULE_FILE, SYSTEM_FACTS_VERSION, SYSTEM_FACTS_VERSION_V3, SYSTEM_FACTS_VERSION_V4, SYSTEM_FACTS_VERSIONS, SYSTEM_COMPONENT_STATES, MEMORY_COMPONENTS,
  loadHealthModules, missingContinuityModule, modulePath, ownerOnly, reduceHealthModule, reduceContinuityModule,
  reduceSystemModule, systemComponentLabel, validateSnapshot,
};
