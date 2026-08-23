'use strict';

const crypto = require('node:crypto');

// U1 is deliberately a portable contract.  It can describe an authenticated
// host profile, but it never reads credentials, resolves an executable, calls
// a provider, or persists the owner-private operator record.
const PROVIDER_PROFILE_SCHEMA_VERSION = 'jarvos-provider-profile/v1';
const MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION = 'jarvos-managed-adapter/v1';
const PROVIDER_HEALTH_SCHEMA_VERSION = 'jarvos-provider-health/v1';
const PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION = 'jarvos-provider-runtime-view/v1';
const PROVIDER_SWITCH_INTENT_SCHEMA_VERSION = 'jarvos-provider-switch-intent/v1';
const PROVIDER_REGISTRY_SCHEMA_VERSION = 'jarvos-provider-registry/v1';

const PROVIDER_PROFILE_VERSION = PROVIDER_PROFILE_SCHEMA_VERSION;
const MANAGED_ADAPTER_DESCRIPTOR_VERSION = MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION;
const PROVIDER_HEALTH_VERSION = PROVIDER_HEALTH_SCHEMA_VERSION;
const PROVIDER_RUNTIME_VIEW_VERSION = PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION;
const PROVIDER_SWITCH_INTENT_VERSION = PROVIDER_SWITCH_INTENT_SCHEMA_VERSION;

const PROVIDER_HEALTH_STATUSES = Object.freeze([
  'available',
  'auth_required',
  'unsupported',
  'unhealthy',
  'active',
]);
const PROVIDER_PROFILE_STATES = Object.freeze([
  'unconfigured',
  'active',
  'candidate',
  'activating',
  'rollback_required',
]);
const PROVIDER_QUALIFICATION_STATES = Object.freeze(['absent', 'legacy', 'current']);
const PROVIDER_AUTH_MODES = Object.freeze(['none', 'subscription', 'api-key']);
const PROVIDER_PROMPT_TRANSPORTS = Object.freeze([
  'deterministic-memory',
  'owner-private-file',
  'stdin',
]);
const PROVIDER_ALLOWED_DATA_CLASSES = Object.freeze([
  'project_context',
  'source_excerpt',
  'decision_context',
]);
const PROVIDER_TOOL_POLICY_MODES = Object.freeze(['deny-all']);
const PROVIDER_SUPPORT_STATES = Object.freeze(['supported', 'unsupported']);
const PROVIDER_REASON_CODES = Object.freeze([
  'active',
  'auth_missing',
  'capability_proof_pending',
  'capability_unsupported',
  'executable_missing',
  'provider_unhealthy',
  'ready',
]);

const SHA256 = /^[a-f0-9]{64}$/i;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i;
const SAFE_SCHEMA_IDENTIFIER = /^[a-z0-9][a-z0-9._/-]*$/i;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const PROFILE_FIELDS = new Set([
  'schemaVersion',
  'profileId',
  'provider',
  'model',
  'adapterDistribution',
  'authMode',
  'promptTransport',
  'toolPolicy',
  'egressPolicy',
  'qualificationState',
  'state',
  'runtimeTuple',
]);
const ADAPTER_FIELDS = new Set([
  'schemaVersion',
  'profileId',
  'adapterId',
  'provider',
  'displayName',
  'distribution',
  'capabilityVersion',
  'models',
  'authModes',
  'promptTransports',
  'toolPolicy',
  'egressPolicy',
  'support',
  'reasonCode',
  'deterministic',
  'portable',
]);
const DISTRIBUTION_FIELDS = new Set(['name', 'version', 'revision']);
const PROFILE_ADAPTER_FIELDS = new Set(['id', 'version', 'capabilityVersion', 'revision']);
const TRANSPORT_FIELDS = new Set(['mode', 'version']);
const TOOL_POLICY_FIELDS = new Set(['mode', 'version']);
const EGRESS_FIELDS = new Set([
  'digest',
  'allowedDataClasses',
  'minimizationRevision',
  'disclosureRevision',
  'ownerAcceptance',
]);
const DESCRIPTOR_EGRESS_FIELDS = new Set([
  'digest',
  'allowedDataClasses',
  'minimizationRevision',
  'disclosureRevision',
]);
const RUNTIME_TUPLE_FIELDS = new Set(['tupleDigest', 'generation']);
const HEALTH_FIELDS = new Set([
  'schemaVersion',
  'profileId',
  'status',
  'reasonCode',
  'observedAt',
  'descriptorVersion',
  'generation',
]);
const VIEW_FIELDS = new Set([
  'schemaVersion',
  'source',
  'generation',
  'state',
  'readOnly',
  'activeProfile',
  'candidateProfile',
  'health',
  'qualification',
  'rollback',
]);
const VIEW_REFERENCE_FIELDS = new Set(['state', 'reference']);
const VIEW_ROLLBACK_FIELDS = new Set(['tupleDigest', 'generation']);
const INTENT_FIELDS = new Set([
  'schemaVersion',
  'intentId',
  'action',
  'candidate',
  'expectedGeneration',
]);
const INTENT_CANDIDATE_FIELDS = new Set(['profileId', 'tupleDigest']);

const FORBIDDEN_FIELD = /(?:authorization|credential|secret|token|password|private(?:key|path)?|signature|executable(?:path)?|hostpath|provideroutput|rawoutput|stdout|stderr|argv|environment|capabilitybody|apikey|api_key)/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function isSafeString(value, { identifier = false, schemaIdentifier = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false;
  if (value.includes('..') || value.startsWith('/') || value.startsWith('~') || value.startsWith('\\') || /^file:/i.test(value)) return false;
  if (identifier && !SAFE_IDENTIFIER.test(value)) return false;
  if (schemaIdentifier && !SAFE_SCHEMA_IDENTIFIER.test(value)) return false;
  return true;
}

function isOpaque(value) {
  return typeof value === 'string' && GENERATION_PATTERN.test(value);
}

function addUnknownAndForbidden(value, allowed, path, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELD.test(key)) errors.push(`${path}.${key} is a forbidden authority or private field`);
    if (!allowed.has(key)) errors.push(`${path} has unknown field: ${key}`);
  }
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  return true;
}

function requireSafe(value, path, errors, { identifier = false, schemaIdentifier = false } = {}) {
  if (!isSafeString(value, { identifier, schemaIdentifier })) errors.push(`${path} must be a safe non-empty string`);
}

function requireOpaque(value, path, errors) {
  if (!isOpaque(value)) errors.push(`${path} must be an opaque generation or reference`);
}

function requireEnum(value, path, values, errors) {
  if (!values.includes(value)) errors.push(`${path} must be one of: ${values.join(', ')}`);
}

function requireIso(value, path, errors) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be an ISO UTC timestamp`);
  }
}

function validateDigest(value, path, errors) {
  if (!isSha256(value)) errors.push(`${path} must be a SHA-256 digest`);
}

function validateDistribution(value, path, errors, { profile = false } = {}) {
  const fields = profile ? PROFILE_ADAPTER_FIELDS : DISTRIBUTION_FIELDS;
  if (!requireObject(value, path, errors)) return;
  addUnknownAndForbidden(value, fields, path, errors);
  const idField = profile ? 'id' : 'name';
  requireSafe(value[idField], `${path}.${idField}`, errors);
  requireSafe(value.version, `${path}.version`, errors);
  if (profile) requireSafe(value.capabilityVersion, `${path}.capabilityVersion`, errors, { schemaIdentifier: true });
  if (!profile && value.revision !== undefined) validateDigest(value.revision, `${path}.revision`, errors);
  if (profile && value.revision !== undefined) validateDigest(value.revision, `${path}.revision`, errors);
}

function validateTransport(value, path, errors) {
  if (!requireObject(value, path, errors)) return;
  addUnknownAndForbidden(value, TRANSPORT_FIELDS, path, errors);
  requireEnum(value.mode, `${path}.mode`, PROVIDER_PROMPT_TRANSPORTS, errors);
  requireSafe(value.version, `${path}.version`, errors, { identifier: true });
}

function validateToolPolicy(value, path, errors) {
  if (!requireObject(value, path, errors)) return;
  addUnknownAndForbidden(value, TOOL_POLICY_FIELDS, path, errors);
  requireEnum(value.mode, `${path}.mode`, PROVIDER_TOOL_POLICY_MODES, errors);
  requireSafe(value.version, `${path}.version`, errors, { identifier: true });
}

function validateDataClasses(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} must not contain duplicates`);
  for (const dataClass of value) requireEnum(dataClass, `${path}[]`, PROVIDER_ALLOWED_DATA_CLASSES, errors);
}

function validateEgressPolicy(value, path, errors, { descriptor = false } = {}) {
  const fields = descriptor ? DESCRIPTOR_EGRESS_FIELDS : EGRESS_FIELDS;
  if (!requireObject(value, path, errors)) return;
  addUnknownAndForbidden(value, fields, path, errors);
  validateDigest(value.digest, `${path}.digest`, errors);
  validateDataClasses(value.allowedDataClasses, `${path}.allowedDataClasses`, errors);
  requireSafe(value.minimizationRevision, `${path}.minimizationRevision`, errors, { identifier: true });
  requireSafe(value.disclosureRevision, `${path}.disclosureRevision`, errors, { identifier: true });
  if (!descriptor) requireEnum(value.ownerAcceptance, `${path}.ownerAcceptance`, ['required', 'accepted'], errors);
}

function validateRuntimeTuple(value, path, errors) {
  if (!requireObject(value, path, errors)) return;
  addUnknownAndForbidden(value, RUNTIME_TUPLE_FIELDS, path, errors);
  validateDigest(value.tupleDigest, `${path}.tupleDigest`, errors);
  requireOpaque(value.generation, `${path}.generation`, errors);
}

function validateProviderProfile(profile) {
  const errors = [];
  if (!requireObject(profile, 'provider profile', errors)) return { ok: false, errors };
  addUnknownAndForbidden(profile, PROFILE_FIELDS, 'provider profile', errors);
  if (profile.schemaVersion !== PROVIDER_PROFILE_SCHEMA_VERSION) errors.push(`provider profile.schemaVersion must be ${PROVIDER_PROFILE_SCHEMA_VERSION}`);
  requireSafe(profile.profileId, 'provider profile.profileId', errors, { identifier: true });
  requireSafe(profile.provider, 'provider profile.provider', errors, { identifier: true });
  requireSafe(profile.model, 'provider profile.model', errors);
  validateDistribution(profile.adapterDistribution, 'provider profile.adapterDistribution', errors, { profile: true });
  requireEnum(profile.authMode, 'provider profile.authMode', PROVIDER_AUTH_MODES, errors);
  validateTransport(profile.promptTransport, 'provider profile.promptTransport', errors);
  validateToolPolicy(profile.toolPolicy, 'provider profile.toolPolicy', errors);
  validateEgressPolicy(profile.egressPolicy, 'provider profile.egressPolicy', errors);
  requireEnum(profile.qualificationState, 'provider profile.qualificationState', PROVIDER_QUALIFICATION_STATES, errors);
  requireEnum(profile.state, 'provider profile.state', PROVIDER_PROFILE_STATES, errors);
  if (profile.runtimeTuple !== undefined) validateRuntimeTuple(profile.runtimeTuple, 'provider profile.runtimeTuple', errors);

  if (profile.state === 'active') {
    if (!['legacy', 'current'].includes(profile.qualificationState)) {
      errors.push('active provider profile must have qualificationState legacy or current');
    }
    if (profile.runtimeTuple === undefined) errors.push('active provider profile must bind an exact runtimeTuple');
  }
  if (profile.qualificationState === 'legacy' && profile.state !== 'active') {
    errors.push('legacy qualificationState is valid only for an active provider profile');
  }
  if (profile.state === 'unconfigured' && profile.qualificationState !== 'absent') {
    errors.push('unconfigured provider profile must have qualificationState absent');
  }
  if (profile.state === 'active' && profile.egressPolicy.ownerAcceptance !== 'accepted') {
    errors.push('active provider profile requires accepted egressPolicy');
  }
  return { ok: errors.length === 0, errors };
}

function validateManagedAdapterDescriptor(descriptor) {
  const errors = [];
  if (!requireObject(descriptor, 'managed adapter descriptor', errors)) return { ok: false, errors };
  addUnknownAndForbidden(descriptor, ADAPTER_FIELDS, 'managed adapter descriptor', errors);
  if (descriptor.schemaVersion !== MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION) errors.push(`managed adapter descriptor.schemaVersion must be ${MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION}`);
  requireSafe(descriptor.profileId, 'managed adapter descriptor.profileId', errors, { identifier: true });
  requireSafe(descriptor.adapterId, 'managed adapter descriptor.adapterId', errors, { identifier: true });
  requireSafe(descriptor.provider, 'managed adapter descriptor.provider', errors, { identifier: true });
  requireSafe(descriptor.displayName, 'managed adapter descriptor.displayName', errors);
  validateDistribution(descriptor.distribution, 'managed adapter descriptor.distribution', errors);
  requireSafe(descriptor.capabilityVersion, 'managed adapter descriptor.capabilityVersion', errors, { schemaIdentifier: true });
  if (!Array.isArray(descriptor.models) || descriptor.models.length === 0) errors.push('managed adapter descriptor.models must be a non-empty array');
  else descriptor.models.forEach((model, index) => requireSafe(model, `managed adapter descriptor.models[${index}]`, errors));
  if (!Array.isArray(descriptor.authModes) || descriptor.authModes.length === 0) errors.push('managed adapter descriptor.authModes must be a non-empty array');
  else descriptor.authModes.forEach((mode) => requireEnum(mode, 'managed adapter descriptor.authModes[]', PROVIDER_AUTH_MODES, errors));
  if (!Array.isArray(descriptor.promptTransports) || descriptor.promptTransports.length === 0) errors.push('managed adapter descriptor.promptTransports must be a non-empty array');
  else descriptor.promptTransports.forEach((mode) => requireEnum(mode, 'managed adapter descriptor.promptTransports[]', PROVIDER_PROMPT_TRANSPORTS, errors));
  validateToolPolicy(descriptor.toolPolicy, 'managed adapter descriptor.toolPolicy', errors);
  validateEgressPolicy(descriptor.egressPolicy, 'managed adapter descriptor.egressPolicy', errors, { descriptor: true });
  requireEnum(descriptor.support, 'managed adapter descriptor.support', PROVIDER_SUPPORT_STATES, errors);
  if (descriptor.support === 'unsupported') requireEnum(descriptor.reasonCode, 'managed adapter descriptor.reasonCode', PROVIDER_REASON_CODES, errors);
  else if (descriptor.reasonCode !== undefined) requireEnum(descriptor.reasonCode, 'managed adapter descriptor.reasonCode', PROVIDER_REASON_CODES, errors);
  if (typeof descriptor.deterministic !== 'boolean') errors.push('managed adapter descriptor.deterministic must be boolean');
  if (descriptor.portable !== true) errors.push('managed adapter descriptor.portable must be true');
  return { ok: errors.length === 0, errors };
}

function validateProviderHealth(health) {
  const errors = [];
  if (!requireObject(health, 'provider health', errors)) return { ok: false, errors };
  addUnknownAndForbidden(health, HEALTH_FIELDS, 'provider health', errors);
  if (health.schemaVersion !== PROVIDER_HEALTH_SCHEMA_VERSION) errors.push(`provider health.schemaVersion must be ${PROVIDER_HEALTH_SCHEMA_VERSION}`);
  if (health.profileId !== undefined) requireSafe(health.profileId, 'provider health.profileId', errors, { identifier: true });
  requireEnum(health.status, 'provider health.status', PROVIDER_HEALTH_STATUSES, errors);
  requireEnum(health.reasonCode, 'provider health.reasonCode', PROVIDER_REASON_CODES, errors);
  if (health.observedAt !== undefined) requireIso(health.observedAt, 'provider health.observedAt', errors);
  if (health.descriptorVersion !== undefined) requireSafe(health.descriptorVersion, 'provider health.descriptorVersion', errors, { schemaIdentifier: true });
  if (health.generation !== undefined) requireOpaque(health.generation, 'provider health.generation', errors);
  return { ok: errors.length === 0, errors };
}

function validateProviderRuntimeView(view) {
  const errors = [];
  if (!requireObject(view, 'provider runtime view', errors)) return { ok: false, errors };
  addUnknownAndForbidden(view, VIEW_FIELDS, 'provider runtime view', errors);
  for (const field of ['schemaVersion', 'source', 'generation', 'state', 'readOnly', 'activeProfile', 'candidateProfile', 'health', 'qualification', 'rollback']) {
    if (!Object.hasOwn(view, field)) errors.push(`provider runtime view.${field} is required`);
  }
  if (view.schemaVersion !== PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION) errors.push(`provider runtime view.schemaVersion must be ${PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION}`);
  if (view.source !== 'runtime-rendered') errors.push('provider runtime view.source must be runtime-rendered');
  requireOpaque(view.generation, 'provider runtime view.generation', errors);
  requireEnum(view.state, 'provider runtime view.state', PROVIDER_PROFILE_STATES, errors);
  if (view.readOnly !== true) errors.push('provider runtime view.readOnly must be true');
  if (view.activeProfile !== null && view.activeProfile !== undefined) {
    const profileResult = validateProviderProfile(view.activeProfile);
    errors.push(...profileResult.errors.map((error) => `activeProfile: ${error}`));
    if (view.state === 'active' && view.activeProfile.state !== 'active') errors.push('activeProfile.state must be active for an active view');
  }
  if (view.candidateProfile !== null && view.candidateProfile !== undefined) {
    const profileResult = validateProviderProfile(view.candidateProfile);
    errors.push(...profileResult.errors.map((error) => `candidateProfile: ${error}`));
  }
  if (view.health !== null && view.health !== undefined) {
    const healthResult = validateProviderHealth(view.health);
    errors.push(...healthResult.errors.map((error) => `health: ${error}`));
  }
  if (view.qualification !== null && view.qualification !== undefined) {
    if (!requireObject(view.qualification, 'provider runtime view.qualification', errors)) return { ok: false, errors };
    addUnknownAndForbidden(view.qualification, VIEW_REFERENCE_FIELDS, 'provider runtime view.qualification', errors);
    requireEnum(view.qualification.state, 'provider runtime view.qualification.state', PROVIDER_QUALIFICATION_STATES, errors);
    if (view.qualification.reference !== undefined) validateDigest(view.qualification.reference, 'provider runtime view.qualification.reference', errors);
  }
  if (view.rollback !== null && view.rollback !== undefined) {
    if (!requireObject(view.rollback, 'provider runtime view.rollback', errors)) return { ok: false, errors };
    addUnknownAndForbidden(view.rollback, VIEW_ROLLBACK_FIELDS, 'provider runtime view.rollback', errors);
    validateDigest(view.rollback.tupleDigest, 'provider runtime view.rollback.tupleDigest', errors);
    requireOpaque(view.rollback.generation, 'provider runtime view.rollback.generation', errors);
  }
  if (view.state === 'unconfigured' && view.activeProfile !== null) errors.push('unconfigured provider runtime view cannot expose an active profile');
  if (view.state === 'active' && !view.activeProfile) errors.push('active provider runtime view must expose its public active profile');
  return { ok: errors.length === 0, errors };
}

function validateProviderSwitchIntent(intent) {
  const errors = [];
  if (!requireObject(intent, 'provider switch intent', errors)) return { ok: false, errors };
  addUnknownAndForbidden(intent, INTENT_FIELDS, 'provider switch intent', errors);
  if (intent.schemaVersion !== PROVIDER_SWITCH_INTENT_SCHEMA_VERSION) errors.push(`provider switch intent.schemaVersion must be ${PROVIDER_SWITCH_INTENT_SCHEMA_VERSION}`);
  requireOpaque(intent.intentId, 'provider switch intent.intentId', errors);
  if (intent.action !== 'propose-switch') errors.push('provider switch intent.action must be propose-switch');
  if (!requireObject(intent.candidate, 'provider switch intent.candidate', errors)) return { ok: false, errors };
  addUnknownAndForbidden(intent.candidate, INTENT_CANDIDATE_FIELDS, 'provider switch intent.candidate', errors);
  requireSafe(intent.candidate.profileId, 'provider switch intent.candidate.profileId', errors, { identifier: true });
  validateDigest(intent.candidate.tupleDigest, 'provider switch intent.candidate.tupleDigest', errors);
  requireOpaque(intent.expectedGeneration, 'provider switch intent.expectedGeneration', errors);
  return { ok: errors.length === 0, errors };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function createProviderProfile(input = {}) {
  return {
    schemaVersion: PROVIDER_PROFILE_SCHEMA_VERSION,
    state: 'unconfigured',
    qualificationState: 'absent',
    ...input,
  };
}

function descriptorPolicyDigest(dataClasses = PROVIDER_ALLOWED_DATA_CLASSES) {
  return canonicalDigest({ allowedDataClasses: [...dataClasses].sort(), minimizationRevision: 'v1', disclosureRevision: 'v1' });
}

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR = deepFreeze({
  schemaVersion: MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  profileId: 'claude-subscription',
  adapterId: 'jarvos-claude-cli',
  provider: 'claude',
  displayName: 'Claude CLI subscription',
  distribution: {
    name: 'claude-cli',
    version: 'portable-v1',
  },
  capabilityVersion: 'jarvos-claude-cli-capability/v1',
  models: ['claude-sonnet-5'],
  authModes: ['subscription'],
  promptTransports: ['owner-private-file'],
  toolPolicy: { mode: 'deny-all', version: 'v1' },
  egressPolicy: {
    digest: descriptorPolicyDigest(['source_excerpt', 'project_context']),
    allowedDataClasses: ['source_excerpt', 'project_context'],
    minimizationRevision: 'v1',
    disclosureRevision: 'v1',
  },
  support: 'supported',
  deterministic: false,
  portable: true,
});

const DETERMINISTIC_ADAPTER_DESCRIPTOR = deepFreeze({
  schemaVersion: MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  profileId: 'deterministic-fixture',
  adapterId: 'jarvos-deterministic',
  provider: 'deterministic',
  displayName: 'Deterministic fixture adapter',
  distribution: {
    name: 'jarvos-runtime-kit',
    version: 'portable-v1',
  },
  capabilityVersion: 'jarvos-deterministic-capability/v1',
  models: ['deterministic-v1'],
  authModes: ['none'],
  promptTransports: ['deterministic-memory'],
  toolPolicy: { mode: 'deny-all', version: 'v1' },
  egressPolicy: {
    digest: descriptorPolicyDigest(['source_excerpt', 'project_context']),
    allowedDataClasses: ['source_excerpt', 'project_context'],
    minimizationRevision: 'v1',
    disclosureRevision: 'v1',
  },
  support: 'supported',
  deterministic: true,
  portable: true,
});

const GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR = deepFreeze({
  schemaVersion: MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  profileId: 'grok-subscription',
  adapterId: 'jarvos-grok-cli',
  provider: 'grok',
  displayName: 'Grok CLI subscription',
  distribution: {
    name: 'grok-cli',
    version: '1.0.3',
    revision: 'b5eef73b94fdc72b8c67218f19abe2b2728db38f1f0e66903de8fb931948bd26',
  },
  capabilityVersion: 'jarvos-grok-cli-capability/v1',
  models: ['grok-4.5'],
  authModes: ['subscription'],
  promptTransports: ['owner-private-file'],
  toolPolicy: { mode: 'deny-all', version: 'v1' },
  egressPolicy: {
    digest: descriptorPolicyDigest(['source_excerpt', 'project_context']),
    allowedDataClasses: ['source_excerpt', 'project_context'],
    minimizationRevision: 'v1',
    disclosureRevision: 'v1',
  },
  support: 'unsupported',
  reasonCode: 'capability_unsupported',
  deterministic: false,
  portable: true,
});

function getBuiltInAdapterDescriptors() {
  return {
    claude: PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR,
    deterministic: DETERMINISTIC_ADAPTER_DESCRIPTOR,
    grok: GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR,
  };
}

function profileFromDescriptor(descriptor, overrides = {}) {
  const validation = validateManagedAdapterDescriptor(descriptor);
  if (!validation.ok) throw providerError('invalid_adapter_descriptor', validation.errors.join('; '));
  const dataClasses = [...descriptor.egressPolicy.allowedDataClasses];
  return createProviderProfile({
    profileId: descriptor.profileId,
    provider: descriptor.provider,
    model: descriptor.models[0],
    adapterDistribution: {
      id: descriptor.adapterId,
      version: descriptor.distribution.version,
      capabilityVersion: descriptor.capabilityVersion,
      ...(descriptor.distribution.revision === undefined ? {} : { revision: descriptor.distribution.revision }),
    },
    authMode: descriptor.authModes[0],
    promptTransport: { mode: descriptor.promptTransports[0], version: 'v1' },
    toolPolicy: { ...descriptor.toolPolicy },
    egressPolicy: {
      digest: descriptor.egressPolicy.digest,
      allowedDataClasses: dataClasses,
      minimizationRevision: descriptor.egressPolicy.minimizationRevision,
      disclosureRevision: descriptor.egressPolicy.disclosureRevision,
      ownerAcceptance: 'required',
    },
    ...overrides,
  });
}

function createProviderRegistry({ descriptors, profiles } = {}) {
  const sourceDescriptors = descriptors || Object.values(getBuiltInAdapterDescriptors());
  const checkedDescriptors = sourceDescriptors.map((descriptor) => {
    const result = validateManagedAdapterDescriptor(descriptor);
    if (!result.ok) throw providerError('invalid_adapter_descriptor', result.errors.join('; '));
    return descriptor;
  });
  const byId = new Map(checkedDescriptors.map((descriptor) => [descriptor.profileId, descriptor]));
  if (byId.size !== checkedDescriptors.length) {
    throw providerError('duplicate_adapter_profile', 'managed adapter profileId values must be unique');
  }
  const sourceProfiles = profiles || checkedDescriptors.map((descriptor) => profileFromDescriptor(descriptor));
  const checkedProfiles = sourceProfiles.map((candidate) => {
    const result = validateProviderProfile(candidate);
    if (!result.ok) throw providerError('invalid_provider_profile', result.errors.join('; '));
    if (!byId.has(candidate.profileId)) throw providerError('profile_descriptor_missing', `No registered descriptor for ${candidate.profileId}`);
    return candidate;
  });
  if (new Set(checkedProfiles.map((candidate) => candidate.profileId)).size !== checkedProfiles.length) {
    throw providerError('duplicate_provider_profile', 'provider profileId values must be unique');
  }
  return {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    descriptors: Object.freeze([...checkedDescriptors]),
    profiles: Object.freeze([...checkedProfiles]),
    activeProfileId: checkedProfiles.find((candidate) => candidate.state === 'active')?.profileId || null,
    defaultProfileId: null,
  };
}

function registerManagedAdapter(registryOrOptions, maybeDescriptor) {
  const registry = registryOrOptions?.registry || registryOrOptions;
  const descriptor = registryOrOptions?.descriptor || maybeDescriptor;
  if (!registry || !descriptor) throw providerError('adapter_registration_invalid', 'registry and descriptor are required');
  const validation = validateManagedAdapterDescriptor(descriptor);
  if (!validation.ok) throw providerError('invalid_adapter_descriptor', validation.errors.join('; '));
  const descriptors = registry.descriptors.filter((item) => item.profileId !== descriptor.profileId).concat(descriptor);
  const profiles = registry.profiles.some((item) => item.profileId === descriptor.profileId)
    ? registry.profiles
    : registry.profiles.concat(profileFromDescriptor(descriptor));
  return createProviderRegistry({ descriptors, profiles });
}

function registerProviderProfile(registry, profile) {
  const validation = validateProviderProfile(profile);
  if (!validation.ok) throw providerError('invalid_provider_profile', validation.errors.join('; '));
  const descriptors = registry.descriptors;
  if (!descriptors.some((descriptor) => descriptor.profileId === profile.profileId)) {
    throw providerError('profile_descriptor_missing', `No registered descriptor for ${profile.profileId}`);
  }
  const profiles = registry.profiles.filter((item) => item.profileId !== profile.profileId).concat(profile);
  return createProviderRegistry({ descriptors, profiles });
}

function createFreshProviderView({ generation = 'fresh-generation' } = {}) {
  const view = {
    schemaVersion: PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
    source: 'runtime-rendered',
    generation,
    state: 'unconfigured',
    readOnly: true,
    activeProfile: null,
    candidateProfile: null,
    health: null,
    qualification: null,
    rollback: null,
  };
  const validation = validateProviderRuntimeView(view);
  if (!validation.ok) throw providerError('invalid_runtime_view', validation.errors.join('; '));
  return view;
}

function publicProfile(profile, { state } = {}) {
  if (!profile) return null;
  const output = {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    provider: profile.provider,
    model: profile.model,
    adapterDistribution: { ...profile.adapterDistribution },
    authMode: profile.authMode,
    promptTransport: { ...profile.promptTransport },
    toolPolicy: { ...profile.toolPolicy },
    egressPolicy: {
      digest: profile.egressPolicy.digest,
      allowedDataClasses: [...profile.egressPolicy.allowedDataClasses],
      minimizationRevision: profile.egressPolicy.minimizationRevision,
      disclosureRevision: profile.egressPolicy.disclosureRevision,
      ownerAcceptance: profile.egressPolicy.ownerAcceptance,
    },
    qualificationState: profile.qualificationState,
    state: state || profile.state,
  };
  if (profile.runtimeTuple) output.runtimeTuple = { ...profile.runtimeTuple };
  return output;
}

function renderProviderReadView({ generation = 'fresh-generation', operatorState = {} } = {}) {
  requireOpaque(generation, 'generation', []); // keep the public error below deterministic
  if (!isOpaque(generation)) throw providerError('invalid_generation', 'generation must be opaque');
  const state = operatorState.state || 'unconfigured';
  if (!PROVIDER_PROFILE_STATES.includes(state)) throw providerError('invalid_runtime_state', `state must be one of: ${PROVIDER_PROFILE_STATES.join(', ')}`);
  const activeProfile = operatorState.activeProfile || null;
  const candidateProfile = operatorState.candidateProfile || null;
  for (const [label, candidate] of [['activeProfile', activeProfile], ['candidateProfile', candidateProfile]]) {
    if (!candidate) continue;
    const result = validateProviderProfile(candidate);
    if (!result.ok) throw providerError('invalid_provider_profile', `${label}: ${result.errors.join('; ')}`);
  }
  const publicActive = publicProfile(activeProfile, { state: state === 'active' ? 'active' : activeProfile?.state });
  const publicCandidate = publicProfile(candidateProfile, { state: state === 'candidate' ? 'candidate' : candidateProfile?.state });
  const qualification = publicActive
    ? { state: publicActive.qualificationState, reference: publicActive.runtimeTuple?.tupleDigest }
    : null;
  const health = operatorState.health || null;
  if (health) {
    const result = validateProviderHealth(health);
    if (!result.ok) throw providerError('invalid_provider_health', result.errors.join('; '));
  }
  const rollbackPoint = operatorState.rollbackPoint || operatorState.rollback || null;
  const rollback = rollbackPoint
    ? { tupleDigest: rollbackPoint.tupleDigest, generation: rollbackPoint.generation }
    : null;
  const view = {
    schemaVersion: PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
    source: 'runtime-rendered',
    generation,
    state,
    readOnly: true,
    activeProfile: publicActive,
    candidateProfile: publicCandidate,
    health,
    qualification,
    rollback,
  };
  const validation = validateProviderRuntimeView(view);
  if (!validation.ok) throw providerError('invalid_runtime_view', validation.errors.join('; '));
  return view;
}

function isProviderViewPreparationEligible(view, { operatorGeneration, selectedTupleDigest } = {}) {
  if (!validateProviderRuntimeView(view).ok) return false;
  if (!isOpaque(operatorGeneration) || !isSha256(selectedTupleDigest)) return false;
  if (view.readOnly !== true || view.state !== 'active' || view.generation !== operatorGeneration) return false;
  const profile = view.activeProfile;
  if (!profile || !profile.runtimeTuple || !['legacy', 'current'].includes(profile.qualificationState)) return false;
  return profile.runtimeTuple.tupleDigest.toLowerCase() === selectedTupleDigest.toLowerCase()
    && profile.runtimeTuple.generation === operatorGeneration;
}

function canPrepareProviderView(view, options = {}) {
  return isProviderViewPreparationEligible(view, options);
}

function canDeliverProviderView() {
  // Delivery is a private operator concern. A public projection can never
  // authorize a sender, even when it is generation-current and active.
  return false;
}

function redactedProviderHealth({ profileId, status, reasonCode, observedAt, descriptorVersion, generation } = {}) {
  const health = {
    schemaVersion: PROVIDER_HEALTH_SCHEMA_VERSION,
    ...(profileId === undefined ? {} : { profileId }),
    status,
    reasonCode,
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(descriptorVersion === undefined ? {} : { descriptorVersion }),
    ...(generation === undefined ? {} : { generation }),
  };
  const validation = validateProviderHealth(health);
  if (!validation.ok) throw providerError('invalid_provider_health', validation.errors.join('; '));
  return health;
}

function classifyProviderHealth({ descriptor, evidence = {} } = {}) {
  const descriptorResult = validateManagedAdapterDescriptor(descriptor);
  if (!descriptorResult.ok) throw providerError('invalid_adapter_descriptor', descriptorResult.errors.join('; '));
  let status = 'available';
  let reasonCode = 'ready';
  if (descriptor.support === 'unsupported' || evidence.capability === 'unsupported') {
    status = 'unsupported';
    reasonCode = descriptor.reasonCode || 'capability_unsupported';
  } else if (evidence.executable === 'missing') {
    status = 'unhealthy';
    reasonCode = 'executable_missing';
  } else if (evidence.unhealthy === true) {
    status = 'unhealthy';
    reasonCode = 'provider_unhealthy';
  } else if (!descriptor.authModes.includes('none') && evidence.authenticated !== true) {
    status = 'auth_required';
    reasonCode = 'auth_missing';
  } else if (evidence.active === true) {
    status = 'active';
    reasonCode = 'active';
  }
  return redactedProviderHealth({
    profileId: descriptor.profileId,
    status,
    reasonCode,
    descriptorVersion: descriptor.capabilityVersion,
    ...(evidence.generation === undefined ? {} : { generation: evidence.generation }),
  });
}

function listProviderProfiles({ registry = createProviderRegistry() } = {}) {
  const descriptors = new Map(registry.descriptors.map((descriptor) => [descriptor.profileId, descriptor]));
  const profiles = registry.profiles.map((profile) => {
    const descriptor = descriptors.get(profile.profileId);
    const status = descriptor.support === 'unsupported'
      ? 'unsupported'
      : profile.state === 'active'
        ? 'active'
        : 'unconfigured';
    return {
      profileId: profile.profileId,
      provider: profile.provider,
      model: profile.model,
      status,
      state: profile.state,
      qualificationState: profile.qualificationState,
      support: descriptor.support,
      adapterVersion: descriptor.capabilityVersion,
    };
  });
  return {
    schemaVersion: PROVIDER_REGISTRY_SCHEMA_VERSION,
    ok: true,
    profiles,
    activeProfileId: registry.activeProfileId || null,
    defaultProfileId: null,
  };
}

function createProviderSwitchIntent({ profileId, tupleDigest, expectedGeneration = 'fresh-generation' } = {}) {
  const candidate = { profileId, tupleDigest };
  const intentId = `intent-${canonicalDigest({ action: 'propose-switch', candidate, expectedGeneration }).slice(0, 32)}`;
  const intent = {
    schemaVersion: PROVIDER_SWITCH_INTENT_SCHEMA_VERSION,
    intentId,
    action: 'propose-switch',
    candidate,
    expectedGeneration,
  };
  const validation = validateProviderSwitchIntent(intent);
  if (!validation.ok) throw providerError('invalid_switch_intent', validation.errors.join('; '));
  return intent;
}

function createProviderControl({ registry = createProviderRegistry(), view = createFreshProviderView() } = {}) {
  const viewValidation = validateProviderRuntimeView(view);
  if (!viewValidation.ok) throw providerError('invalid_runtime_view', viewValidation.errors.join('; '));
  const descriptors = new Map(registry.descriptors.map((descriptor) => [descriptor.profileId, descriptor]));
  const profiles = new Set(registry.profiles.map((profile) => profile.profileId));
  return {
    list() {
      return listProviderProfiles({ registry });
    },
    status() {
      return view;
    },
    proposeSwitch({ profileId, tupleDigest } = {}) {
      const descriptor = descriptors.get(profileId);
      if (!descriptor) return { ok: false, code: 'profile_not_registered', view };
      if (!profiles.has(profileId)) return { ok: false, code: 'profile_not_registered', view };
      if (descriptor.support !== 'supported') return { ok: false, code: 'candidate_unsupported', view };
      const intent = createProviderSwitchIntent({ profileId, tupleDigest, expectedGeneration: view.generation });
      return { ok: true, intent, view };
    },
    authorizeAndRun() {
      throw providerError('owner_authorization_required', 'provider authorization and activation belong to the local owner surface');
    },
    rollback() {
      throw providerError('owner_authorization_required', 'provider rollback belongs to the local owner surface');
    },
  };
}

function deterministicAdapter() {
  return Object.freeze({
    preflight() {
      return { ok: true, status: 'available', providerCalls: 0 };
    },
    invoke(input) {
      const text = typeof input === 'string' ? input : JSON.stringify(input ?? '');
      return { ok: true, text: `deterministic:${canonicalDigest(text)}`, providerCalls: 0 };
    },
    normalizeReceipt() {
      return { providerCalls: 0, status: 'passed', model: 'deterministic-v1' };
    },
  });
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function preserveLegacyProviderProfile(profile, runtimeTuple) {
  const candidate = createProviderProfile({
    ...profile,
    state: 'active',
    qualificationState: 'legacy',
    runtimeTuple: { ...runtimeTuple },
  });
  const validation = validateProviderProfile(candidate);
  if (!validation.ok) throw providerError('invalid_legacy_profile', validation.errors.join('; '));
  return candidate;
}

function providerProfileIdentity(profile) {
  const validation = validateProviderProfile(profile);
  if (!validation.ok) throw providerError('invalid_provider_profile', validation.errors.join('; '));
  return canonicalDigest({
    profileId: profile.profileId,
    provider: profile.provider,
    model: profile.model,
    adapterDistribution: profile.adapterDistribution,
    authMode: profile.authMode,
    promptTransport: profile.promptTransport,
    toolPolicy: profile.toolPolicy,
    egressPolicy: profile.egressPolicy,
  });
}

function qualificationRequiresFreshMatrix(previousProfile, nextProfile) {
  return providerProfileIdentity(previousProfile) !== providerProfileIdentity(nextProfile);
}

module.exports = {
  PROVIDER_PROFILE_SCHEMA_VERSION,
  MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION,
  PROVIDER_HEALTH_SCHEMA_VERSION,
  PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
  PROVIDER_SWITCH_INTENT_SCHEMA_VERSION,
  PROVIDER_REGISTRY_SCHEMA_VERSION,
  PROVIDER_PROFILE_VERSION,
  MANAGED_ADAPTER_DESCRIPTOR_VERSION,
  PROVIDER_HEALTH_VERSION,
  PROVIDER_RUNTIME_VIEW_VERSION,
  PROVIDER_SWITCH_INTENT_VERSION,
  ACTIVE_ASSISTANT_PROVIDER_VIEW_SCHEMA_VERSION: PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
  PROVIDER_LIFECYCLE_VIEW_SCHEMA_VERSION: PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
  PROVIDER_DISCOVERY_STATUSES: PROVIDER_HEALTH_STATUSES,
  PROVIDER_HEALTH_STATUSES,
  PROVIDER_PROFILE_STATES,
  PROVIDER_QUALIFICATION_STATES,
  PROVIDER_AUTH_MODES,
  PROVIDER_PROMPT_TRANSPORTS,
  PROVIDER_ALLOWED_DATA_CLASSES,
  PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR,
  CLAUDE_ADAPTER_DESCRIPTOR: PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR,
  DETERMINISTIC_ADAPTER_DESCRIPTOR,
  DETERMINISTIC_PROVIDER_DESCRIPTOR: DETERMINISTIC_ADAPTER_DESCRIPTOR,
  GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR,
  GROK_ADAPTER_DESCRIPTOR: GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR,
  deterministicAdapter,
  createProviderProfile,
  profileFromDescriptor,
  validateProviderProfile,
  validateManagedAdapterDescriptor,
  validateAdapterDescriptor: validateManagedAdapterDescriptor,
  validateProviderHealth,
  validateRedactedProviderHealth: validateProviderHealth,
  validateProviderRuntimeView,
  validateProviderReadView: validateProviderRuntimeView,
  validateProviderLifecycleView: validateProviderRuntimeView,
  validateLifecycleView: validateProviderRuntimeView,
  validateProviderSwitchIntent,
  getBuiltInAdapterDescriptors,
  createProviderRegistry,
  createManagedAdapterRegistry: createProviderRegistry,
  registerManagedAdapter,
  registerManagedAdapterDescriptor: registerManagedAdapter,
  registerProviderProfile,
  createFreshProviderView,
  createFreshProviderState: createFreshProviderView,
  renderProviderReadView,
  renderProviderRuntimeView: renderProviderReadView,
  renderProviderView: renderProviderReadView,
  canPrepareProviderView,
  canDeliverProviderView,
  isProviderViewPreparationEligible,
  redactedProviderHealth,
  classifyProviderHealth,
  inspectProviderHealth: classifyProviderHealth,
  listProviderProfiles,
  createProviderSwitchIntent,
  createProviderControl,
  preserveLegacyProviderProfile,
  migrateLegacyProviderProfile: preserveLegacyProviderProfile,
  providerProfileIdentity,
  qualificationRequiresFreshMatrix,
};
