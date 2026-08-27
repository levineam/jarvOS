'use strict';

const crypto = require('node:crypto');

// This is a provider-neutral, data-driven public contract. It describes a
// catalog of possible provider choices, an explicit preference/proposal flow,
// and a generation-bound preview outcome. It never reads credentials,
// resolves a host executable, calls a provider, authenticates a profile, or
// admits a paid choice on its own authority. A private host owner supplies
// the actual authenticated, admitted catalog entries.
const CATALOG_ENTRY_SCHEMA_VERSION = 'jarvos-provider-catalog-entry/v1';
const CATALOG_SCHEMA_VERSION = 'jarvos-provider-catalog/v1';
const PREFERENCE_SCHEMA_VERSION = 'jarvos-provider-preference/v1';
const PROPOSAL_SCHEMA_VERSION = 'jarvos-provider-proposal/v1';
const STATUS_SCHEMA_VERSION = 'jarvos-provider-status/v1';

// Closed, non-secret auth category. It lets a user or agent tell a
// subscription-backed (or usage-metered) choice apart from a free one
// without ever exposing profile identity or credentials.
const PROVIDER_AUTH_CATEGORIES = Object.freeze(['none', 'subscription', 'usage_metered']);
const PROVIDER_REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
const PROVIDER_PREVIEW_RESULTS = Object.freeze(['passed', 'failed']);
const PROVIDER_STATUS_STATES = Object.freeze(['unselected', 'selected']);

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i;
const GENERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CATALOG_ENTRY_FIELDS = new Set([
  'schemaVersion',
  'entryId',
  'provider',
  'model',
  'authCategory',
  'reasoningEfforts',
  'defaultReasoningEffort',
]);
const CATALOG_FIELDS = new Set(['schemaVersion', 'entries']);
const PREFERENCE_FIELDS = new Set(['schemaVersion', 'entryId', 'generation', 'lastPreview']);
const PREVIEW_RECORD_FIELDS = new Set(['entryId', 'generation', 'result']);
const PROPOSAL_FIELDS = new Set(['schemaVersion', 'proposalId', 'entryId', 'expectedGeneration']);
const STATUS_FIELDS = new Set(['schemaVersion', 'generation', 'state', 'selected', 'lastPreview']);
const STATUS_SELECTED_FIELDS = new Set(['entryId', 'provider', 'model', 'authCategory', 'reasoningEffort']);

const FORBIDDEN_FIELD = /(?:authorization|credential|secret|token|password|private(?:key|path)?|signature|executable(?:path)?|hostpath|provideroutput|rawoutput|stdout|stderr|argv|environment|capabilitybody|apikey|api_key|accountid|principal)/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeString(value, { identifier = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false;
  if (value.includes('..') || value.startsWith('/') || value.startsWith('~') || value.startsWith('\\') || /^file:/i.test(value)) return false;
  if (identifier && !SAFE_IDENTIFIER.test(value)) return false;
  return true;
}

function isOpaque(value) {
  return typeof value === 'string' && GENERATION_PATTERN.test(value);
}

function addUnknownAndForbidden(value, allowed, path, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && FORBIDDEN_FIELD.test(key)) errors.push(`${path}.${key} is a forbidden authority or private field`);
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

function requireSafe(value, path, errors, { identifier = false } = {}) {
  if (!isSafeString(value, { identifier })) errors.push(`${path} must be a safe non-empty string`);
}

function requireOpaque(value, path, errors) {
  if (!isOpaque(value)) errors.push(`${path} must be an opaque generation or reference`);
}

function requireEnum(value, path, values, errors) {
  if (!values.includes(value)) errors.push(`${path} must be one of: ${values.join(', ')}`);
}

function validatePreviewRecord(value, path, errors) {
  if (!requireObject(value, path, errors)) return;
  addUnknownAndForbidden(value, PREVIEW_RECORD_FIELDS, path, errors);
  requireSafe(value.entryId, `${path}.entryId`, errors, { identifier: true });
  requireOpaque(value.generation, `${path}.generation`, errors);
  requireEnum(value.result, `${path}.result`, PROVIDER_PREVIEW_RESULTS, errors);
}

function validateProviderCatalogEntry(entry) {
  const errors = [];
  if (!requireObject(entry, 'provider catalog entry', errors)) return { ok: false, errors };
  addUnknownAndForbidden(entry, CATALOG_ENTRY_FIELDS, 'provider catalog entry', errors);
  if (entry.schemaVersion !== CATALOG_ENTRY_SCHEMA_VERSION) errors.push(`provider catalog entry.schemaVersion must be ${CATALOG_ENTRY_SCHEMA_VERSION}`);
  requireSafe(entry.entryId, 'provider catalog entry.entryId', errors, { identifier: true });
  requireSafe(entry.provider, 'provider catalog entry.provider', errors, { identifier: true });
  requireSafe(entry.model, 'provider catalog entry.model', errors);
  requireEnum(entry.authCategory, 'provider catalog entry.authCategory', PROVIDER_AUTH_CATEGORIES, errors);
  if (!Array.isArray(entry.reasoningEfforts) || entry.reasoningEfforts.length === 0) {
    errors.push('provider catalog entry.reasoningEfforts must be a non-empty array');
  } else {
    if (new Set(entry.reasoningEfforts).size !== entry.reasoningEfforts.length) errors.push('provider catalog entry.reasoningEfforts must not contain duplicates');
    entry.reasoningEfforts.forEach((effort, index) => requireEnum(effort, `provider catalog entry.reasoningEfforts[${index}]`, PROVIDER_REASONING_EFFORTS, errors));
  }
  requireEnum(entry.defaultReasoningEffort, 'provider catalog entry.defaultReasoningEffort', PROVIDER_REASONING_EFFORTS, errors);
  if (Array.isArray(entry.reasoningEfforts) && !entry.reasoningEfforts.includes(entry.defaultReasoningEffort)) {
    errors.push('provider catalog entry.defaultReasoningEffort must be one of provider catalog entry.reasoningEfforts');
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderCatalog(catalog) {
  const errors = [];
  if (!requireObject(catalog, 'provider catalog', errors)) return { ok: false, errors };
  addUnknownAndForbidden(catalog, CATALOG_FIELDS, 'provider catalog', errors);
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) errors.push(`provider catalog.schemaVersion must be ${CATALOG_SCHEMA_VERSION}`);
  if (!Array.isArray(catalog.entries)) {
    errors.push('provider catalog.entries must be an array');
    return { ok: false, errors };
  }
  catalog.entries.forEach((entry, index) => {
    const result = validateProviderCatalogEntry(entry);
    errors.push(...result.errors.map((error) => `provider catalog.entries[${index}]: ${error}`));
  });
  if (new Set(catalog.entries.map((entry) => entry?.entryId)).size !== catalog.entries.length) {
    errors.push('provider catalog.entries must have unique entryId values');
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderPreference(preference) {
  const errors = [];
  if (!requireObject(preference, 'provider preference', errors)) return { ok: false, errors };
  addUnknownAndForbidden(preference, PREFERENCE_FIELDS, 'provider preference', errors);
  if (preference.schemaVersion !== PREFERENCE_SCHEMA_VERSION) errors.push(`provider preference.schemaVersion must be ${PREFERENCE_SCHEMA_VERSION}`);
  if (preference.entryId !== null) requireSafe(preference.entryId, 'provider preference.entryId', errors, { identifier: true });
  requireOpaque(preference.generation, 'provider preference.generation', errors);
  if (preference.lastPreview !== null && preference.lastPreview !== undefined) {
    validatePreviewRecord(preference.lastPreview, 'provider preference.lastPreview', errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderProposal(proposal) {
  const errors = [];
  if (!requireObject(proposal, 'provider proposal', errors)) return { ok: false, errors };
  addUnknownAndForbidden(proposal, PROPOSAL_FIELDS, 'provider proposal', errors);
  if (proposal.schemaVersion !== PROPOSAL_SCHEMA_VERSION) errors.push(`provider proposal.schemaVersion must be ${PROPOSAL_SCHEMA_VERSION}`);
  requireOpaque(proposal.proposalId, 'provider proposal.proposalId', errors);
  requireSafe(proposal.entryId, 'provider proposal.entryId', errors, { identifier: true });
  requireOpaque(proposal.expectedGeneration, 'provider proposal.expectedGeneration', errors);
  return { ok: errors.length === 0, errors };
}

function validateProviderSafeStatus(status) {
  const errors = [];
  if (!requireObject(status, 'provider safe status', errors)) return { ok: false, errors };
  addUnknownAndForbidden(status, STATUS_FIELDS, 'provider safe status', errors);
  if (status.schemaVersion !== STATUS_SCHEMA_VERSION) errors.push(`provider safe status.schemaVersion must be ${STATUS_SCHEMA_VERSION}`);
  requireOpaque(status.generation, 'provider safe status.generation', errors);
  requireEnum(status.state, 'provider safe status.state', PROVIDER_STATUS_STATES, errors);
  if (status.selected !== null) {
    if (requireObject(status.selected, 'provider safe status.selected', errors)) {
      addUnknownAndForbidden(status.selected, STATUS_SELECTED_FIELDS, 'provider safe status.selected', errors);
      requireSafe(status.selected.entryId, 'provider safe status.selected.entryId', errors, { identifier: true });
      requireSafe(status.selected.provider, 'provider safe status.selected.provider', errors, { identifier: true });
      requireSafe(status.selected.model, 'provider safe status.selected.model', errors);
      requireEnum(status.selected.authCategory, 'provider safe status.selected.authCategory', PROVIDER_AUTH_CATEGORIES, errors);
      requireEnum(status.selected.reasoningEffort, 'provider safe status.selected.reasoningEffort', PROVIDER_REASONING_EFFORTS, errors);
    }
  }
  if (status.state === 'selected' && status.selected === null) errors.push('provider safe status.selected is required when state is selected');
  if (status.state === 'unselected' && status.selected !== null) errors.push('provider safe status.selected must be null when state is unselected');
  if (status.lastPreview !== null && status.lastPreview !== undefined) {
    validatePreviewRecord(status.lastPreview, 'provider safe status.lastPreview', errors);
  }
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

function deepFreeze(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// The only built-in catalog entry is a deterministic, non-paid fixture. A
// fresh public installation never hard-codes or advertises a paid Claude,
// OpenAI, or Grok choice as authenticated or admitted; the private host
// supplies actual authenticated, admitted entries via createProviderCatalog.
const DETERMINISTIC_CATALOG_ENTRY = deepFreeze({
  schemaVersion: CATALOG_ENTRY_SCHEMA_VERSION,
  entryId: 'deterministic-fixture',
  provider: 'deterministic',
  model: 'deterministic-v1',
  authCategory: 'none',
  reasoningEfforts: [...PROVIDER_REASONING_EFFORTS],
  defaultReasoningEffort: 'medium',
});

function getDefaultProviderCatalogEntries() {
  return [DETERMINISTIC_CATALOG_ENTRY];
}

function createProviderCatalog({ entries } = {}) {
  const sourceEntries = entries || getDefaultProviderCatalogEntries();
  const checkedEntries = sourceEntries.map((entry) => {
    const result = validateProviderCatalogEntry(entry);
    if (!result.ok) throw providerError('invalid_catalog_entry', result.errors.join('; '));
    return entry;
  });
  if (new Set(checkedEntries.map((entry) => entry.entryId)).size !== checkedEntries.length) {
    throw providerError('duplicate_catalog_entry', 'provider catalog entryId values must be unique');
  }
  const catalog = deepFreeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    entries: [...checkedEntries],
  });
  const validation = validateProviderCatalog(catalog);
  if (!validation.ok) throw providerError('invalid_provider_catalog', validation.errors.join('; '));
  return catalog;
}

function findProviderCatalogEntry(catalog, entryId) {
  return catalog.entries.find((entry) => entry.entryId === entryId) || null;
}

function createInitialProviderPreference({ generation = 'initial-generation' } = {}) {
  const preference = {
    schemaVersion: PREFERENCE_SCHEMA_VERSION,
    entryId: null,
    generation,
    lastPreview: null,
  };
  const validation = validateProviderPreference(preference);
  if (!validation.ok) throw providerError('invalid_provider_preference', validation.errors.join('; '));
  return preference;
}

function createProviderProposal({ catalog, entryId, expectedGeneration } = {}) {
  if (!catalog || !findProviderCatalogEntry(catalog, entryId)) {
    throw providerError('entry_not_registered', `No catalog entry for ${entryId}`);
  }
  const proposalId = `proposal-${canonicalDigest({ entryId, expectedGeneration }).slice(0, 32)}`;
  const proposal = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId,
    entryId,
    expectedGeneration,
  };
  const validation = validateProviderProposal(proposal);
  if (!validation.ok) throw providerError('invalid_provider_proposal', validation.errors.join('; '));
  return proposal;
}

// Applies a generation-bound preview outcome to an explicit proposal. A
// passed preview advances the preference only when the proposal's
// expectedGeneration exactly matches the incumbent preference generation; it
// then produces a fresh generation, which makes a stale, replayed proposal
// conflict rather than silently re-apply. A failed preview never selects or
// advances the candidate: it preserves the incumbent entryId and generation
// exactly and only records a bounded lastPreview: failed status.
function previewProviderProposal({ catalog, preference, proposal, result } = {}) {
  if (!PROVIDER_PREVIEW_RESULTS.includes(result)) throw providerError('invalid_preview_result', `result must be one of: ${PROVIDER_PREVIEW_RESULTS.join(', ')}`);
  const preferenceValidation = validateProviderPreference(preference);
  if (!preferenceValidation.ok) throw providerError('invalid_provider_preference', preferenceValidation.errors.join('; '));
  const proposalValidation = validateProviderProposal(proposal);
  if (!proposalValidation.ok) throw providerError('invalid_provider_proposal', proposalValidation.errors.join('; '));

  const entry = findProviderCatalogEntry(catalog, proposal.entryId);
  if (!entry) return { ok: false, code: 'entry_not_registered', preference };
  if (proposal.expectedGeneration !== preference.generation) {
    return { ok: false, code: 'stale_generation', preference };
  }

  if (result === 'failed') {
    const next = {
      ...preference,
      lastPreview: { entryId: proposal.entryId, generation: preference.generation, result: 'failed' },
    };
    const validation = validateProviderPreference(next);
    if (!validation.ok) throw providerError('invalid_provider_preference', validation.errors.join('; '));
    return { ok: true, preference: next };
  }

  const nextGeneration = canonicalDigest({ generation: preference.generation, entryId: proposal.entryId, result: 'passed' });
  const next = {
    schemaVersion: PREFERENCE_SCHEMA_VERSION,
    entryId: proposal.entryId,
    generation: nextGeneration,
    lastPreview: { entryId: proposal.entryId, generation: preference.generation, result: 'passed' },
  };
  const validation = validateProviderPreference(next);
  if (!validation.ok) throw providerError('invalid_provider_preference', validation.errors.join('; '));
  return { ok: true, preference: next };
}

// Renders the closed, non-secret safe status: enough for a user or agent to
// tell a subscription-backed (or usage-metered) choice apart from a free
// one, and to see the last preview outcome, without ever exposing profile
// identity or credentials.
function renderProviderSafeStatus({ catalog, preference } = {}) {
  const preferenceValidation = validateProviderPreference(preference);
  if (!preferenceValidation.ok) throw providerError('invalid_provider_preference', preferenceValidation.errors.join('; '));
  const entry = preference.entryId ? findProviderCatalogEntry(catalog, preference.entryId) : null;
  const status = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generation: preference.generation,
    state: entry ? 'selected' : 'unselected',
    selected: entry
      ? {
        entryId: entry.entryId,
        provider: entry.provider,
        model: entry.model,
        authCategory: entry.authCategory,
        reasoningEffort: entry.defaultReasoningEffort,
      }
      : null,
    lastPreview: preference.lastPreview ? { ...preference.lastPreview } : null,
  };
  const validation = validateProviderSafeStatus(status);
  if (!validation.ok) throw providerError('invalid_provider_safe_status', validation.errors.join('; '));
  return status;
}

// A provider-neutral, read-only demonstration surface: it lists a catalog,
// projects safe status, and proposes/previews a switch against an in-memory
// preference. It never persists, authorizes spend, or delivers a message;
// that authority belongs to a private owner-side operator.
function createProviderSelectionControl({
  catalog = createProviderCatalog(),
  preference = createInitialProviderPreference(),
} = {}) {
  return {
    catalog() {
      return catalog;
    },
    status() {
      return renderProviderSafeStatus({ catalog, preference });
    },
    propose({ entryId } = {}) {
      const proposal = createProviderProposal({ catalog, entryId, expectedGeneration: preference.generation });
      return { ok: true, proposal, status: renderProviderSafeStatus({ catalog, preference }) };
    },
    preview({ entryId, result } = {}) {
      const proposal = createProviderProposal({ catalog, entryId, expectedGeneration: preference.generation });
      const outcome = previewProviderProposal({ catalog, preference, proposal, result });
      return {
        ...outcome,
        status: renderProviderSafeStatus({ catalog, preference: outcome.preference }),
      };
    },
  };
}

// Narrow, inert legacy classifier. It never grants rollback authority on its
// own: it only recognizes a small, exact old public-schema shape and a small,
// exact set of old provider identifiers, and returns a classification for a
// private host operator to act on. Anything unrecognized, including a
// missing or unknown provider, returns null.
const LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION = 'jarvos-provider-profile/v1';
const LEGACY_PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION = 'jarvos-provider-runtime-view/v1';
const LEGACY_RECOGNIZED_PROVIDERS = Object.freeze(['claude', 'grok', 'deterministic']);

function isRecognizedLegacyProvider(provider) {
  return typeof provider === 'string' && LEGACY_RECOGNIZED_PROVIDERS.includes(provider);
}

function classifyLegacyProviderRecord(record) {
  if (!isObject(record)) return null;

  if (record.schemaVersion === LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION) {
    if (!isRecognizedLegacyProvider(record.provider)) return null;
    return record.state === 'active' ? 'rollback_only' : 'migration_required';
  }

  if (record.schemaVersion === LEGACY_PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION) {
    const provider = isObject(record.activeProfile) ? record.activeProfile.provider : undefined;
    if (!isRecognizedLegacyProvider(provider)) return null;
    const isActiveIncumbent = record.state === 'active' && record.activeProfile.state === 'active';
    return isActiveIncumbent ? 'rollback_only' : 'migration_required';
  }

  return null;
}

module.exports = {
  CATALOG_ENTRY_SCHEMA_VERSION,
  CATALOG_SCHEMA_VERSION,
  PREFERENCE_SCHEMA_VERSION,
  PROPOSAL_SCHEMA_VERSION,
  STATUS_SCHEMA_VERSION,
  PROVIDER_AUTH_CATEGORIES,
  PROVIDER_REASONING_EFFORTS,
  PROVIDER_PREVIEW_RESULTS,
  PROVIDER_STATUS_STATES,
  DETERMINISTIC_CATALOG_ENTRY,
  LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION,
  LEGACY_PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
  LEGACY_RECOGNIZED_PROVIDERS,
  getDefaultProviderCatalogEntries,
  createProviderCatalog,
  findProviderCatalogEntry,
  validateProviderCatalogEntry,
  validateProviderCatalog,
  validateProviderPreference,
  validateProviderProposal,
  validateProviderSafeStatus,
  createInitialProviderPreference,
  createProviderProposal,
  previewProviderProposal,
  renderProviderSafeStatus,
  createProviderSelectionControl,
  classifyLegacyProviderRecord,
};

