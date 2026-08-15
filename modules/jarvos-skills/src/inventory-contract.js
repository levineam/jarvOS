'use strict';

/**
 * Versioned inventory/assessment contracts for machine-wide skill parity.
 *
 * Contracts only: validation, redaction, policy defaults, and owner-only
 * private state layout. No ambient scanning and no second projector.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Lazy config access avoids a circular dependency with config.js, which
// normalizes inventory policy through this module.
function configApi() {
  return require('./config');
}

const SUPPORTED_HARNESSES = Object.freeze(['codex', 'claude', 'openclaw', 'hermes']);

const INVENTORY_SCHEMA_VERSION = 'jarvos.skill-inventory/v1';
const STATUS_SCHEMA_VERSION = 'jarvos.skill-inventory-status/v1';
const INSPECT_SCHEMA_VERSION = 'jarvos.skill-inventory-inspect/v1';
const EXCLUSION_SCHEMA_VERSION = 'jarvos.skill-exclusions/v1';

const ROOT_LIFECYCLES = Object.freeze(['available', 'stale', 'unregistered']);
const TRUST_CLASSES = Object.freeze(['markdown-only', 'portable-bundles']);
const SOURCE_STATES = Object.freeze(['new', 'unchanged', 'changed', 'missing', 'unsafe']);
const DISPOSITIONS = Object.freeze([
  'shared',
  'already_managed',
  'harness_local',
  'blocked',
  'needs_input',
]);
const PROJECTION_STATES = Object.freeze([
  'source_present',
  'missing',
  'installed',
  'locally_modified',
  'conflict',
  'retired',
]);
const VERIFICATION_STATES = Object.freeze([
  'model_visible',
  'verification_pending',
  'unverifiable',
]);
const ATTENTION_STATES = Object.freeze(['quiet', 'actionable', 'resolved']);

const ALLOWED_REASON_CODES = Object.freeze([
  'rule_proven_portable',
  'already_managed_receipt',
  'harness_native',
  'vendor_managed',
  'unsafe_source',
  'privacy_restricted',
  'capability_unsupported',
  'ambiguous_identity',
  'semantic_collision',
  'owner_excluded',
  'trust_class_insufficient',
  'needs_owner_input',
  'incomplete_observation',
  'local_modification_preserved',
]);

const AUTONOMOUS_ALLOWED_CAPABILITIES = Object.freeze([
  'inventory.observe',
  'inventory.auto_admit_rule_proven',
  'inventory.reconcile_accepted',
]);

const AUTONOMOUS_DENIED_CAPABILITIES = Object.freeze([
  'roots.register',
  'policy.trust',
  'policy.privacy',
  'needs_input.approve',
  'harnesses.enable',
  'egress.authorize',
  'private.reveal',
  'local_modifications.overwrite',
  'generation.rollback',
]);

const AUTONOMOUS_SERVICE_PRINCIPAL = Object.freeze({
  kind: 'autonomous-inventory-service',
  capabilities: AUTONOMOUS_ALLOWED_CAPABILITIES,
  denied: AUTONOMOUS_DENIED_CAPABILITIES,
});

const SHA256_RE = /^[a-f0-9]{64}$/i;
const LOGICAL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ROOT_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const RELATIVE_PATH_RE = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const PRIVATE_STATUS_FIELDS = Object.freeze([
  'observedName',
  'name',
  'absolutePath',
  'root',
  'path',
  'body',
  'excerpt',
  'content',
  'parserError',
  'credential',
  'credentialHint',
  'secret',
  'token',
  'password',
]);

const DEFAULT_INVENTORY_LIMITS = Object.freeze({
  maxRoots: 32,
  maxEntriesPerRoot: 512,
  maxBundleFiles: 256,
  maxBundleBytes: 8 * 1024 * 1024,
  maxEventsPerRun: 256,
  maxRollbackGenerations: 8,
  maxAttentionHistory: 128,
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function inventoryDigest(value) {
  return digest(JSON.stringify(canonical(value)));
}

function nonEmptyObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function exactDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${field} must be an exact SHA-256 digest`);
  }
  return value.toLowerCase();
}

function assertEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function assertLogicalId(value, field) {
  if (typeof value !== 'string' || !LOGICAL_ID_RE.test(value)) {
    throw new Error(`${field} must be a canonical logical skill id`);
  }
  return value;
}

function assertRootId(value, field) {
  if (typeof value !== 'string' || !ROOT_ID_RE.test(value)) {
    throw new Error(`${field} must be a canonical root id`);
  }
  return value;
}

function assertIsoTimestamp(value, field, { allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function containedRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\\')) {
    throw new Error(`${field} must be a contained relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || !RELATIVE_PATH_RE.test(normalized)) {
    throw new Error(`${field} must be a contained relative path`);
  }
  return normalized;
}

function assertAbsolutePath(value, field) {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${field} must be an absolute path`);
  }
  const expanded = configApi().expandHome(value);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return path.resolve(expanded);
}

function assertReasonCode(value, field) {
  if (typeof value !== 'string' || !ALLOWED_REASON_CODES.includes(value)) {
    throw new Error(`${field} must be an allowlisted reason code`);
  }
  return value;
}

function assertSafeOwnedDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
}

function assertSafeOwnedFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
}

function defaultInventoryPolicy() {
  return {
    enabled: false,
    registeredRoots: [],
    limits: { ...DEFAULT_INVENTORY_LIMITS },
    exclusionOverlayPath: null,
    state: {
      stateRootName: 'inventory',
      sourceStoreName: 'source-store',
      observationsName: 'observations.json',
      attentionName: 'attention.json',
      leaseName: 'inventory.lock',
      acceptedGenerationName: 'accepted-generation.json',
    },
    retention: {
      rollbackGenerations: DEFAULT_INVENTORY_LIMITS.maxRollbackGenerations,
      attentionDays: 30,
    },
    eventQuiescence: {
      digestStabilityMs: 5_000,
      debounceMs: 1_000,
    },
    retirement: {
      minAbsenceObservations: 2,
      minAbsenceIntervalHours: 24,
      minSchedulerIntervals: 2,
    },
    autonomousPrincipal: {
      kind: AUTONOMOUS_SERVICE_PRINCIPAL.kind,
      capabilities: [...AUTONOMOUS_ALLOWED_CAPABILITIES],
      denied: [...AUTONOMOUS_DENIED_CAPABILITIES],
    },
  };
}

function normalizePositiveInt(value, field, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = value === undefined || value === null ? fallback : value;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeRegisteredRoot(raw, index) {
  const source = nonEmptyObject(raw, `inventory.registeredRoots[${index}]`);
  const rootId = assertRootId(source.rootId || source.id, `inventory.registeredRoots[${index}].rootId`);
  const harness = assertEnum(source.harness, SUPPORTED_HARNESSES, `inventory.registeredRoots[${index}].harness`);
  if (typeof source.root !== 'string' || !source.root) {
    throw new Error(`inventory.registeredRoots[${index}].root is required`);
  }
  const { expandHome, collapseHome } = configApi();
  const expanded = expandHome(source.root);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`inventory.registeredRoots[${index}].root must be an absolute path`);
  }
  return {
    rootId,
    harness,
    root: collapseHome(path.resolve(expanded)),
    trustClass: assertEnum(
      source.trustClass || 'markdown-only',
      TRUST_CLASSES,
      `inventory.registeredRoots[${index}].trustClass`,
    ),
    lifecycle: assertEnum(
      source.lifecycle || 'available',
      ROOT_LIFECYCLES,
      `inventory.registeredRoots[${index}].lifecycle`,
    ),
  };
}

function normalizeInventoryPolicy(raw = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = defaultInventoryPolicy();
  const limitsSource = source.limits && typeof source.limits === 'object' ? source.limits : {};
  const stateSource = source.state && typeof source.state === 'object' ? source.state : {};
  const retentionSource = source.retention && typeof source.retention === 'object' ? source.retention : {};
  const quiescenceSource = source.eventQuiescence && typeof source.eventQuiescence === 'object'
    ? source.eventQuiescence
    : {};
  const retirementSource = source.retirement && typeof source.retirement === 'object' ? source.retirement : {};

  const registeredRoots = Array.isArray(source.registeredRoots)
    ? source.registeredRoots.map((entry, index) => normalizeRegisteredRoot(entry, index))
    : [];
  const seenRootIds = new Set();
  for (const root of registeredRoots) {
    if (seenRootIds.has(root.rootId)) {
      throw new Error(`inventory.registeredRoots duplicates rootId: ${root.rootId}`);
    }
    seenRootIds.add(root.rootId);
  }

  const limits = {
    maxRoots: normalizePositiveInt(limitsSource.maxRoots, 'inventory.limits.maxRoots', defaults.limits.maxRoots, { max: 256 }),
    maxEntriesPerRoot: normalizePositiveInt(
      limitsSource.maxEntriesPerRoot,
      'inventory.limits.maxEntriesPerRoot',
      defaults.limits.maxEntriesPerRoot,
      { max: 10_000 },
    ),
    maxBundleFiles: normalizePositiveInt(
      limitsSource.maxBundleFiles,
      'inventory.limits.maxBundleFiles',
      defaults.limits.maxBundleFiles,
      { max: 10_000 },
    ),
    maxBundleBytes: normalizePositiveInt(
      limitsSource.maxBundleBytes,
      'inventory.limits.maxBundleBytes',
      defaults.limits.maxBundleBytes,
      { max: 64 * 1024 * 1024 },
    ),
    maxEventsPerRun: normalizePositiveInt(
      limitsSource.maxEventsPerRun,
      'inventory.limits.maxEventsPerRun',
      defaults.limits.maxEventsPerRun,
      { max: 10_000 },
    ),
    maxRollbackGenerations: normalizePositiveInt(
      limitsSource.maxRollbackGenerations,
      'inventory.limits.maxRollbackGenerations',
      defaults.limits.maxRollbackGenerations,
      { max: 64 },
    ),
    maxAttentionHistory: normalizePositiveInt(
      limitsSource.maxAttentionHistory,
      'inventory.limits.maxAttentionHistory',
      defaults.limits.maxAttentionHistory,
      { max: 10_000 },
    ),
  };

  if (registeredRoots.length > limits.maxRoots) {
    throw new Error(`inventory.registeredRoots exceeds maxRoots (${limits.maxRoots})`);
  }

  const exclusionOverlayPath = source.exclusionOverlayPath === null || source.exclusionOverlayPath === undefined
    ? null
    : configApi().collapseHome(assertAbsolutePath(source.exclusionOverlayPath, 'inventory.exclusionOverlayPath'));

  const autonomousPrincipal = assertAutonomousPrincipal(
    source.autonomousPrincipal || defaults.autonomousPrincipal,
  );

  return {
    enabled: source.enabled === true,
    registeredRoots,
    limits,
    exclusionOverlayPath,
    state: {
      stateRootName: typeof stateSource.stateRootName === 'string' && stateSource.stateRootName
        ? stateSource.stateRootName
        : defaults.state.stateRootName,
      sourceStoreName: typeof stateSource.sourceStoreName === 'string' && stateSource.sourceStoreName
        ? stateSource.sourceStoreName
        : defaults.state.sourceStoreName,
      observationsName: typeof stateSource.observationsName === 'string' && stateSource.observationsName
        ? stateSource.observationsName
        : defaults.state.observationsName,
      attentionName: typeof stateSource.attentionName === 'string' && stateSource.attentionName
        ? stateSource.attentionName
        : defaults.state.attentionName,
      leaseName: typeof stateSource.leaseName === 'string' && stateSource.leaseName
        ? stateSource.leaseName
        : defaults.state.leaseName,
      acceptedGenerationName: typeof stateSource.acceptedGenerationName === 'string'
        && stateSource.acceptedGenerationName
        ? stateSource.acceptedGenerationName
        : defaults.state.acceptedGenerationName,
    },
    retention: {
      rollbackGenerations: normalizePositiveInt(
        retentionSource.rollbackGenerations,
        'inventory.retention.rollbackGenerations',
        defaults.retention.rollbackGenerations,
        { max: limits.maxRollbackGenerations },
      ),
      attentionDays: normalizePositiveInt(
        retentionSource.attentionDays,
        'inventory.retention.attentionDays',
        defaults.retention.attentionDays,
        { max: 3650 },
      ),
    },
    eventQuiescence: {
      digestStabilityMs: normalizePositiveInt(
        quiescenceSource.digestStabilityMs,
        'inventory.eventQuiescence.digestStabilityMs',
        defaults.eventQuiescence.digestStabilityMs,
        { min: 100, max: 3_600_000 },
      ),
      debounceMs: normalizePositiveInt(
        quiescenceSource.debounceMs,
        'inventory.eventQuiescence.debounceMs',
        defaults.eventQuiescence.debounceMs,
        { min: 50, max: 600_000 },
      ),
    },
    retirement: {
      minAbsenceObservations: normalizePositiveInt(
        retirementSource.minAbsenceObservations,
        'inventory.retirement.minAbsenceObservations',
        defaults.retirement.minAbsenceObservations,
        { min: 2, max: 32 },
      ),
      minAbsenceIntervalHours: normalizePositiveInt(
        retirementSource.minAbsenceIntervalHours,
        'inventory.retirement.minAbsenceIntervalHours',
        defaults.retirement.minAbsenceIntervalHours,
        { min: 24, max: 24 * 30 },
      ),
      minSchedulerIntervals: normalizePositiveInt(
        retirementSource.minSchedulerIntervals,
        'inventory.retirement.minSchedulerIntervals',
        defaults.retirement.minSchedulerIntervals,
        { min: 2, max: 100 },
      ),
    },
    autonomousPrincipal: {
      kind: autonomousPrincipal.kind,
      capabilities: [...autonomousPrincipal.capabilities],
      denied: [...autonomousPrincipal.denied],
    },
  };
}

function normalizeRetirementPolicy(raw, { intervalMinutes } = {}) {
  const source = nonEmptyObject(raw || {}, 'retirement policy');
  const minAbsenceObservations = normalizePositiveInt(
    source.minAbsenceObservations,
    'retirement.minAbsenceObservations',
    2,
    { min: 2, max: 32 },
  );
  const minAbsenceIntervalHours = normalizePositiveInt(
    source.minAbsenceIntervalHours,
    'retirement.minAbsenceIntervalHours',
    24,
    { min: 24, max: 24 * 30 },
  );
  const minSchedulerIntervals = normalizePositiveInt(
    source.minSchedulerIntervals,
    'retirement.minSchedulerIntervals',
    2,
    { min: 2, max: 100 },
  );
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new Error('retirement policy requires a positive scheduler intervalMinutes');
  }
  const twoIntervalHours = (minSchedulerIntervals * intervalMinutes) / 60;
  const effectiveAbsenceIntervalHours = Math.max(minAbsenceIntervalHours, twoIntervalHours);
  return {
    minAbsenceObservations,
    minAbsenceIntervalHours,
    minSchedulerIntervals,
    effectiveAbsenceIntervalHours,
  };
}

function assertAutonomousPrincipal(raw) {
  const source = nonEmptyObject(raw, 'autonomous service principal');
  if (source.kind !== 'autonomous-inventory-service') {
    throw new Error('autonomous service principal kind is invalid');
  }
  if (!Array.isArray(source.capabilities) || source.capabilities.length === 0) {
    throw new Error('autonomous service principal capabilities are required');
  }
  if (!Array.isArray(source.denied) || source.denied.length === 0) {
    throw new Error('autonomous service principal denied capabilities are required');
  }

  const capabilities = [];
  const seen = new Set();
  for (const capability of source.capabilities) {
    if (typeof capability !== 'string' || !capability) {
      throw new Error('autonomous service principal capability must be a string');
    }
    if (AUTONOMOUS_DENIED_CAPABILITIES.includes(capability)) {
      throw new Error(`autonomous service principal has excess authority: ${capability}`);
    }
    if (!AUTONOMOUS_ALLOWED_CAPABILITIES.includes(capability)) {
      throw new Error(`autonomous service principal capability is not allowlisted: ${capability}`);
    }
    if (seen.has(capability)) {
      throw new Error(`autonomous service principal duplicates capability: ${capability}`);
    }
    seen.add(capability);
    capabilities.push(capability);
  }

  for (const required of AUTONOMOUS_ALLOWED_CAPABILITIES) {
    if (!seen.has(required)) {
      throw new Error(`autonomous service principal is missing required capability: ${required}`);
    }
  }

  const denied = [];
  const deniedSeen = new Set();
  for (const capability of source.denied) {
    if (typeof capability !== 'string' || !capability) {
      throw new Error('autonomous service principal denied capability must be a string');
    }
    if (!AUTONOMOUS_DENIED_CAPABILITIES.includes(capability)) {
      throw new Error(`autonomous service principal denied capability is unknown: ${capability}`);
    }
    if (deniedSeen.has(capability)) {
      throw new Error(`autonomous service principal duplicates denied capability: ${capability}`);
    }
    deniedSeen.add(capability);
    denied.push(capability);
  }
  for (const required of AUTONOMOUS_DENIED_CAPABILITIES) {
    if (!deniedSeen.has(required)) {
      throw new Error(`autonomous service principal denied set is incomplete: ${required}`);
    }
  }

  return {
    kind: 'autonomous-inventory-service',
    capabilities: capabilities.slice().sort(),
    denied: denied.slice().sort(),
  };
}

function normalizeObservation(raw, index, skillId) {
  const source = nonEmptyObject(raw, `skill ${skillId} observation[${index}]`);
  const field = `skill ${skillId} observation[${index}]`;
  return {
    rootId: assertRootId(source.rootId, `${field}.rootId`),
    relativePath: containedRelativePath(source.relativePath, `${field}.relativePath`),
    absolutePath: assertAbsolutePath(source.absolutePath, `${field}.absolutePath`),
    state: assertEnum(source.state, SOURCE_STATES, `${field}.state`),
    observedAt: assertIsoTimestamp(source.observedAt, `${field}.observedAt`),
  };
}

function normalizeMatrixRow(raw, index, skillId) {
  const source = nonEmptyObject(raw, `skill ${skillId} matrix[${index}]`);
  return {
    harness: assertEnum(source.harness, SUPPORTED_HARNESSES, `skill ${skillId} matrix[${index}].harness`),
    projection: assertEnum(
      source.projection,
      PROJECTION_STATES,
      `skill ${skillId} matrix[${index}].projection`,
    ),
    verification: assertEnum(
      source.verification,
      VERIFICATION_STATES,
      `skill ${skillId} matrix[${index}].verification`,
    ),
  };
}

function normalizeDisposition(raw, skillId) {
  const source = nonEmptyObject(raw, `skill ${skillId} disposition`);
  return {
    kind: assertEnum(source.kind, DISPOSITIONS, `skill ${skillId} disposition.kind`),
    reasonCode: assertReasonCode(source.reasonCode, `skill ${skillId} disposition.reasonCode`),
  };
}

function normalizeRoot(raw, index) {
  const source = nonEmptyObject(raw, `roots[${index}]`);
  return {
    rootId: assertRootId(source.rootId, `roots[${index}].rootId`),
    harness: assertEnum(source.harness, SUPPORTED_HARNESSES, `roots[${index}].harness`),
    root: assertAbsolutePath(source.root, `roots[${index}].root`),
    lifecycle: assertEnum(source.lifecycle, ROOT_LIFECYCLES, `roots[${index}].lifecycle`),
    trustClass: assertEnum(source.trustClass, TRUST_CLASSES, `roots[${index}].trustClass`),
    complete: source.complete === true,
  };
}

function normalizeSkill(raw, index, rootIds) {
  const source = nonEmptyObject(raw, `skills[${index}]`);
  const logicalId = assertLogicalId(source.logicalId || source.id, `skills[${index}].logicalId`);
  if (typeof source.observedName !== 'string' || !source.observedName.trim()) {
    throw new Error(`skills[${index}].observedName is required`);
  }
  const observations = Array.isArray(source.observations)
    ? source.observations.map((entry, observationIndex) => normalizeObservation(entry, observationIndex, logicalId))
    : [];
  if (observations.length === 0) {
    throw new Error(`skill ${logicalId} must include at least one observation`);
  }
  for (const observation of observations) {
    if (!rootIds.has(observation.rootId)) {
      throw new Error(`skill ${logicalId} observation references unknown rootId: ${observation.rootId}`);
    }
  }

  const matrix = Array.isArray(source.matrix)
    ? source.matrix.map((entry, matrixIndex) => normalizeMatrixRow(entry, matrixIndex, logicalId))
    : [];
  if (matrix.length !== SUPPORTED_HARNESSES.length) {
    throw new Error(`skill ${logicalId} matrix must include one row per supported harness`);
  }
  const matrixHarnesses = new Set();
  for (const row of matrix) {
    if (matrixHarnesses.has(row.harness)) {
      throw new Error(`skill ${logicalId} matrix duplicates harness: ${row.harness}`);
    }
    matrixHarnesses.add(row.harness);
  }
  for (const harness of SUPPORTED_HARNESSES) {
    if (!matrixHarnesses.has(harness)) {
      throw new Error(`skill ${logicalId} matrix is incomplete; missing harness: ${harness}`);
    }
  }
  matrix.sort((left, right) => left.harness.localeCompare(right.harness));

  return {
    logicalId,
    observedName: source.observedName.trim(),
    treeDigest: exactDigest(source.treeDigest, `skill ${logicalId} treeDigest`),
    observations: observations.sort((left, right) => {
      const byRoot = left.rootId.localeCompare(right.rootId);
      return byRoot !== 0 ? byRoot : left.relativePath.localeCompare(right.relativePath);
    }),
    disposition: normalizeDisposition(source.disposition, logicalId),
    matrix,
    attention: assertEnum(source.attention || 'quiet', ATTENTION_STATES, `skill ${logicalId} attention`),
  };
}

function normalizeExclusionEntry(raw, index) {
  const source = nonEmptyObject(raw, `exclusions[${index}]`);
  return {
    logicalId: assertLogicalId(source.logicalId || source.id, `exclusions[${index}].logicalId`),
    reasonCode: assertReasonCode(source.reasonCode || 'owner_excluded', `exclusions[${index}].reasonCode`),
    excludedAt: assertIsoTimestamp(source.excludedAt, `exclusions[${index}].excludedAt`),
  };
}

function validateInventoryDocument(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('inventory document must be an object');
  }
  if (document.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      mutate: false,
      reason: `unsupported inventory schemaVersion: ${document.schemaVersion || 'missing'}`,
    };
  }

  if (typeof document.generationId !== 'string' || !document.generationId.trim()) {
    throw new Error('inventory generationId is required');
  }
  const roots = Array.isArray(document.roots)
    ? document.roots.map((entry, index) => normalizeRoot(entry, index))
    : [];
  const rootIds = new Set();
  for (const root of roots) {
    if (rootIds.has(root.rootId)) {
      throw new Error(`inventory root identity is duplicated: ${root.rootId}`);
    }
    rootIds.add(root.rootId);
  }
  roots.sort((left, right) => left.rootId.localeCompare(right.rootId));

  const skills = Array.isArray(document.skills)
    ? document.skills.map((entry, index) => normalizeSkill(entry, index, rootIds))
    : [];
  const skillIds = new Set();
  for (const skill of skills) {
    if (skillIds.has(skill.logicalId)) {
      throw new Error(`inventory skill identity is duplicated: ${skill.logicalId}`);
    }
    skillIds.add(skill.logicalId);
  }
  skills.sort((left, right) => left.logicalId.localeCompare(right.logicalId));

  const exclusions = Array.isArray(document.exclusions)
    ? document.exclusions.map((entry, index) => normalizeExclusionEntry(entry, index))
    : [];
  const exclusionIds = new Set();
  for (const entry of exclusions) {
    if (exclusionIds.has(entry.logicalId)) {
      throw new Error(`inventory exclusion identity is duplicated: ${entry.logicalId}`);
    }
    exclusionIds.add(entry.logicalId);
  }
  exclusions.sort((left, right) => left.logicalId.localeCompare(right.logicalId));

  const normalized = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generationId: document.generationId.trim(),
    acceptedGenerationId: typeof document.acceptedGenerationId === 'string' && document.acceptedGenerationId.trim()
      ? document.acceptedGenerationId.trim()
      : null,
    acceptedAt: assertIsoTimestamp(document.acceptedAt, 'acceptedAt', { allowNull: true }),
    observedAt: assertIsoTimestamp(document.observedAt, 'observedAt'),
    roots,
    skills,
    exclusions,
  };

  return {
    status: 'valid',
    mutate: false,
    document: normalized,
    digest: inventoryDigest(normalized),
  };
}

function validateExclusionOverlay(overlay) {
  if (overlay === undefined || overlay === null) {
    const empty = { schemaVersion: EXCLUSION_SCHEMA_VERSION, entries: [] };
    return {
      status: 'absent',
      mutate: false,
      overlay: empty,
      digest: inventoryDigest(empty),
    };
  }
  const source = nonEmptyObject(overlay, 'exclusion overlay');
  if (source.schemaVersion !== EXCLUSION_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      mutate: false,
      reason: `unsupported exclusion overlay schemaVersion: ${source.schemaVersion || 'missing'}`,
    };
  }
  if (!Array.isArray(source.entries)) {
    throw new Error('exclusion overlay must contain an explicit entries array');
  }
  const entries = source.entries.map((entry, index) => normalizeExclusionEntry(entry, index));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.logicalId)) {
      throw new Error(`exclusion overlay identity is duplicated: ${entry.logicalId}`);
    }
    seen.add(entry.logicalId);
  }
  entries.sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  const normalized = {
    schemaVersion: EXCLUSION_SCHEMA_VERSION,
    entries,
  };
  return {
    status: 'valid',
    mutate: false,
    overlay: normalized,
    digest: inventoryDigest(normalized),
  };
}

function assertNoPrivateFields(value, fieldPath = 'status') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateFields(entry, `${fieldPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_STATUS_FIELDS.includes(key)) {
      throw new Error(`${fieldPath}.${key} is a forbidden private field`);
    }
    if (typeof child === 'string') {
      if (child.includes(path.sep) && path.isAbsolute(child)) {
        throw new Error(`${fieldPath}.${key} must not contain absolute paths`);
      }
      if (child.includes('\n') && child.length > 200) {
        throw new Error(`${fieldPath}.${key} must not contain body-like content`);
      }
    }
    assertNoPrivateFields(child, `${fieldPath}.${key}`);
  }
}

function defaultCounts(document) {
  const counts = {
    skills: document.skills.length,
    shared: 0,
    already_managed: 0,
    harness_local: 0,
    blocked: 0,
    needs_input: 0,
    actionable: 0,
    exclusions: document.exclusions.length,
  };
  for (const skill of document.skills) {
    if (Object.prototype.hasOwnProperty.call(counts, skill.disposition.kind)) {
      counts[skill.disposition.kind] += 1;
    }
    if (skill.attention === 'actionable') counts.actionable += 1;
  }
  return counts;
}

function serializeOutwardStatus(document, options = {}) {
  const validated = validateInventoryDocument(document);
  if (validated.status !== 'valid') {
    throw new Error(validated.reason || 'inventory document is invalid');
  }
  const source = validated.document;
  const status = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generationId: source.generationId,
    acceptedGenerationId: source.acceptedGenerationId,
    acceptedAt: source.acceptedAt,
    observedAt: source.observedAt,
    digest: validated.digest,
    counts: options.counts && typeof options.counts === 'object'
      ? {
        skills: Number(options.counts.skills) || 0,
        shared: Number(options.counts.shared) || 0,
        already_managed: Number(options.counts.already_managed) || 0,
        harness_local: Number(options.counts.harness_local) || 0,
        blocked: Number(options.counts.blocked) || 0,
        needs_input: Number(options.counts.needs_input) || 0,
        actionable: Number(options.counts.actionable) || 0,
        exclusions: Number(options.counts.exclusions) || source.exclusions.length,
      }
      : defaultCounts(source),
    roots: source.roots.map((root) => ({
      rootId: root.rootId,
      harness: root.harness,
      lifecycle: root.lifecycle,
      trustClass: root.trustClass,
      complete: root.complete === true,
    })),
    skills: source.skills.map((skill) => ({
      logicalId: skill.logicalId,
      treeDigest: skill.treeDigest,
      disposition: {
        kind: skill.disposition.kind,
        reasonCode: skill.disposition.reasonCode,
      },
      matrix: skill.matrix.map((row) => ({
        harness: row.harness,
        projection: row.projection,
        verification: row.verification,
      })),
      attention: skill.attention,
      observationCount: skill.observations.length,
    })),
    exclusions: source.exclusions.map((entry) => ({
      logicalId: entry.logicalId,
      reasonCode: entry.reasonCode,
      excludedAt: entry.excludedAt,
    })),
  };
  validateOutwardStatus(status);
  return status;
}

function validateOutwardStatus(status) {
  const source = nonEmptyObject(status, 'outward status');
  if (source.schemaVersion !== STATUS_SCHEMA_VERSION) {
    throw new Error(`unsupported outward status schemaVersion: ${source.schemaVersion || 'missing'}`);
  }
  assertNoPrivateFields(source, 'status');
  if (typeof source.generationId !== 'string' || !source.generationId) {
    throw new Error('outward status generationId is required');
  }
  if (!Array.isArray(source.skills)) throw new Error('outward status skills must be an array');
  if (!Array.isArray(source.roots)) throw new Error('outward status roots must be an array');
  for (const skill of source.skills) {
    assertLogicalId(skill.logicalId, 'status skill logicalId');
    exactDigest(skill.treeDigest, 'status skill treeDigest');
    assertEnum(skill.disposition?.kind, DISPOSITIONS, 'status skill disposition.kind');
    assertReasonCode(skill.disposition?.reasonCode, 'status skill disposition.reasonCode');
    assertEnum(skill.attention, ATTENTION_STATES, 'status skill attention');
  }
  return source;
}

function serializeOwnerInspect(document, options = {}) {
  if (options.authorized !== true) {
    throw new Error('owner inspect requires local owner authorization');
  }
  const validated = validateInventoryDocument(document);
  if (validated.status !== 'valid') {
    throw new Error(validated.reason || 'inventory document is invalid');
  }
  const source = validated.document;
  const inspect = {
    schemaVersion: INSPECT_SCHEMA_VERSION,
    authorized: true,
    generationId: source.generationId,
    acceptedGenerationId: source.acceptedGenerationId,
    acceptedAt: source.acceptedAt,
    observedAt: source.observedAt,
    digest: validated.digest,
    roots: source.roots.map((root) => ({
      rootId: root.rootId,
      harness: root.harness,
      root: root.root,
      lifecycle: root.lifecycle,
      trustClass: root.trustClass,
      complete: root.complete === true,
    })),
    skills: source.skills.map((skill) => ({
      logicalId: skill.logicalId,
      observedName: skill.observedName,
      treeDigest: skill.treeDigest,
      disposition: {
        kind: skill.disposition.kind,
        reasonCode: skill.disposition.reasonCode,
      },
      attention: skill.attention,
      matrix: skill.matrix.map((row) => ({
        harness: row.harness,
        projection: row.projection,
        verification: row.verification,
      })),
      observations: skill.observations.map((observation) => ({
        rootId: observation.rootId,
        relativePath: observation.relativePath,
        absolutePath: observation.absolutePath,
        state: observation.state,
        observedAt: observation.observedAt,
      })),
    })),
    exclusions: source.exclusions.map((entry) => ({
      logicalId: entry.logicalId,
      reasonCode: entry.reasonCode,
      excludedAt: entry.excludedAt,
    })),
  };
  validateOwnerInspect(inspect);
  return inspect;
}

function validateOwnerInspect(inspect) {
  const source = nonEmptyObject(inspect, 'owner inspect');
  if (source.schemaVersion !== INSPECT_SCHEMA_VERSION) {
    throw new Error(`unsupported owner inspect schemaVersion: ${source.schemaVersion || 'missing'}`);
  }
  if (source.authorized !== true) {
    throw new Error('owner inspect requires authorized=true');
  }
  if (!Array.isArray(source.skills)) throw new Error('owner inspect skills must be an array');
  for (const skill of source.skills) {
    if (skill.body !== undefined || skill.excerpt !== undefined || skill.content !== undefined) {
      throw new Error('owner inspect must not include skill bodies by default');
    }
    if (skill.credential !== undefined || skill.secret !== undefined || skill.token !== undefined) {
      throw new Error('owner inspect must not include secret material');
    }
    for (const observation of skill.observations || []) {
      if (observation.parserError !== undefined || observation.excerpt !== undefined) {
        throw new Error('owner inspect must not include parser errors or excerpts by default');
      }
      if (observation.credentialHint !== undefined || observation.credential !== undefined) {
        throw new Error('owner inspect must not include secret material');
      }
    }
  }
  return source;
}

function ensureOwnerOnlyDir(dirPath, label) {
  const resolved = path.resolve(dirPath);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    assertSafeOwnedDirectory(stat, label);
    return fs.realpathSync(resolved);
  }
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  assertSafeOwnedDirectory(stat, label);
  return fs.realpathSync(resolved);
}

function ensureInventoryStateLayout({ controlRoot, inventory } = {}) {
  if (!controlRoot) throw new Error('controlRoot is required');
  const { expandHome } = configApi();
  const policy = normalizeInventoryPolicy(inventory || defaultInventoryPolicy());
  const control = ensureOwnerOnlyDir(path.resolve(expandHome(controlRoot)), 'control root');
  const stateRoot = ensureOwnerOnlyDir(
    path.join(control, policy.state.stateRootName),
    'inventory state root',
  );
  const sourceStorePath = ensureOwnerOnlyDir(
    path.join(stateRoot, policy.state.sourceStoreName),
    'inventory source store',
  );
  const exclusionOverlayPath = policy.exclusionOverlayPath
    ? path.resolve(expandHome(policy.exclusionOverlayPath))
    : path.join(stateRoot, 'exclusions.json');
  ensureOwnerOnlyDir(path.dirname(exclusionOverlayPath), 'exclusion overlay parent');

  return {
    controlRoot: control,
    stateRoot,
    sourceStorePath,
    exclusionOverlayPath,
    observationsPath: path.join(stateRoot, policy.state.observationsName),
    attentionPath: path.join(stateRoot, policy.state.attentionName),
    leasePath: path.join(stateRoot, policy.state.leaseName),
    acceptedGenerationPath: path.join(stateRoot, policy.state.acceptedGenerationName),
    policy,
  };
}

function loadExclusionOverlay(filePath) {
  const { expandHome } = configApi();
  const file = path.resolve(expandHome(filePath));
  if (!fs.existsSync(file)) {
    return {
      path: file,
      existed: false,
      ...validateExclusionOverlay(null),
    };
  }
  const stat = fs.lstatSync(file);
  assertSafeOwnedFile(stat, 'exclusion overlay');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validated = validateExclusionOverlay(raw);
  if (validated.status === 'unsupported') {
    return {
      path: file,
      existed: true,
      ...validated,
    };
  }
  return {
    path: file,
    existed: true,
    ...validated,
  };
}

function saveExclusionOverlay(overlay, filePath) {
  const { expandHome, atomicWriteJson } = configApi();
  const validated = validateExclusionOverlay(overlay);
  if (validated.status !== 'valid' && validated.status !== 'absent') {
    throw new Error(validated.reason || 'exclusion overlay is unsupported');
  }
  const file = path.resolve(expandHome(filePath));
  ensureOwnerOnlyDir(path.dirname(file), 'exclusion overlay parent');
  atomicWriteJson(file, validated.overlay);
  const stat = fs.lstatSync(file);
  assertSafeOwnedFile(stat, 'exclusion overlay');
  return {
    path: file,
    overlay: validated.overlay,
    digest: validated.digest,
  };
}

module.exports = {
  INVENTORY_SCHEMA_VERSION,
  STATUS_SCHEMA_VERSION,
  INSPECT_SCHEMA_VERSION,
  EXCLUSION_SCHEMA_VERSION,
  ROOT_LIFECYCLES,
  TRUST_CLASSES,
  SOURCE_STATES,
  DISPOSITIONS,
  PROJECTION_STATES,
  VERIFICATION_STATES,
  ATTENTION_STATES,
  ALLOWED_REASON_CODES,
  AUTONOMOUS_SERVICE_PRINCIPAL,
  AUTONOMOUS_ALLOWED_CAPABILITIES,
  AUTONOMOUS_DENIED_CAPABILITIES,
  DEFAULT_INVENTORY_LIMITS,
  inventoryDigest,
  defaultInventoryPolicy,
  normalizeInventoryPolicy,
  normalizeRetirementPolicy,
  assertAutonomousPrincipal,
  validateInventoryDocument,
  validateExclusionOverlay,
  serializeOutwardStatus,
  validateOutwardStatus,
  serializeOwnerInspect,
  validateOwnerInspect,
  ensureInventoryStateLayout,
  loadExclusionOverlay,
  saveExclusionOverlay,
};
