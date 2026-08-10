'use strict';

const crypto = require('node:crypto');

const { resolvePriority } = require('./priority');
const { validateProviderSnapshot } = require('./provider-contracts');
const {
  CONTEXT_CONTRACT,
  REDACTION_CLASSES,
  capabilityDigest,
  verifyCapability,
} = require('./projects-context-capability');

const CONTEXT_PACKET_FIELDS = Object.freeze([
  'contract', 'packetId', 'capturedAt', 'expiresAt', 'query', 'canonical', 'activity', 'currentWork', 'attention',
  'evidence', 'providers', 'omissions', 'truncation', 'redactionClass', 'capability',
]);
const QUERY_FIELDS = Object.freeze(['scope', 'include', 'limits']);
const SCOPE_FIELDS = Object.freeze(['projectIds', 'outcomeIds', 'includeDescendants']);
const LIMIT_FIELDS = Object.freeze(['maxItems', 'maxBytes', 'maxProviderAgeSeconds']);
const INCLUDE_SECTIONS = Object.freeze(['hierarchy', 'activity', 'currentWork', 'attention']);
const KNOWN_PROVIDERS = Object.freeze(['activity', 'beads', 'paperclip', 'release', 'stewardship', 'todo']);
const SUMMARY_FIELDS = Object.freeze(['id', 'canonicalId', 'category', 'status', 'title', 'occurredAt', 'observedAt', 'evidenceRefs', 'source']);
const EVIDENCE_FIELDS = Object.freeze(['source', 'id', 'canonicalId', 'occurredAt', 'observedAt', 'evidenceRefs']);
const RECORD_PACKET_FIELDS = Object.freeze([
  'id', 'kind', 'title', 'aliases', 'parentId', 'lifecycle', 'declaredPriority', 'effectivePriority', 'priority',
  'revision', 'createdAt', 'updatedAt', 'goal', 'definitionOfDone', 'links', 'breadcrumb',
]);
const PRIORITY_FIELDS = Object.freeze(['declared', 'effective', 'source', 'sourceRecordId', 'sourceKind']);

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`); return value.trim(); }
function timestamp(value, field) { requiredString(value, field); if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`); return value; }
function integer(value, field, { min, max }) { if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${field} must be an integer between ${min} and ${max}`); return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function hash(value) { return crypto.createHash('sha256').update(stableStringify(value)).digest('hex'); }
function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function validateIds(value, field, prefix) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.startsWith(prefix) || !/^\w+_[0-9]{6,}$/.test(id))) throw new TypeError(`${field} must contain canonical IDs`);
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must not contain duplicates`);
  return [...value].sort();
}

function validateScope(scope) {
  if (!exactKeys(scope, SCOPE_FIELDS)) throw new TypeError('query scope has unsupported fields');
  if (typeof scope.includeDescendants !== 'boolean') throw new TypeError('scope.includeDescendants must be boolean');
  return {
    projectIds: validateIds(scope.projectIds, 'scope.projectIds', 'prj_'),
    outcomeIds: validateIds(scope.outcomeIds, 'scope.outcomeIds', 'out_'),
    includeDescendants: scope.includeDescendants,
  };
}

function validateLimits(limits) {
  if (!exactKeys(limits, LIMIT_FIELDS)) throw new TypeError('query limits have unsupported fields');
  return {
    maxItems: integer(limits.maxItems, 'limits.maxItems', { min: 1, max: 1000 }),
    maxBytes: integer(limits.maxBytes, 'limits.maxBytes', { min: 512, max: 1_000_000 }),
    maxProviderAgeSeconds: integer(limits.maxProviderAgeSeconds, 'limits.maxProviderAgeSeconds', { min: 1, max: 86_400 }),
  };
}

function validateContextQuery(query) {
  if (!exactKeys(query, QUERY_FIELDS)) throw new TypeError('context query has unsupported fields');
  const scope = validateScope(query.scope);
  if (!Array.isArray(query.include) || !query.include.length || query.include.some((section) => !INCLUDE_SECTIONS.includes(section))) throw new TypeError('query include contains an unsupported section');
  if (new Set(query.include).size !== query.include.length) throw new TypeError('query include must not contain duplicates');
  return { scope, include: [...query.include], limits: validateLimits(query.limits) };
}

function recordIdsForScope(registry, scope) {
  const requested = new Set([...scope.projectIds, ...scope.outcomeIds]);
  for (const id of requested) if (!registry.get(id)) return null;
  if (!requested.size) return new Set(registry.list().map((record) => record.id));
  if (scope.includeDescendants) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of registry.list()) {
        if (record.parentId && requested.has(record.parentId) && !requested.has(record.id)) { requested.add(record.id); changed = true; }
      }
    }
  }
  return requested;
}

function validateProviderScope(scope) {
  if (!exactKeys(scope, ['projectIds', 'outcomeIds'])) throw new TypeError('provider scope has unsupported fields');
  return {
    projectIds: validateIds(scope.projectIds, 'provider scope.projectIds', 'prj_'),
    outcomeIds: validateIds(scope.outcomeIds, 'provider scope.outcomeIds', 'out_'),
  };
}

function serializeRecord(record, registry, redactionClass) {
  const priority = resolvePriority(record.id, Object.fromEntries(registry.list().map((item) => [item.id, item])));
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    aliases: redactionClass === 'public' ? [] : [...record.aliases],
    parentId: record.parentId,
    lifecycle: record.lifecycle,
    declaredPriority: priority.declared,
    effectivePriority: priority.effective,
    priority: {
      declared: priority.declared,
      effective: priority.effective,
      source: priority.source,
      sourceRecordId: priority.sourceRecordId,
      sourceKind: priority.sourceKind,
    },
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    goal: redactionClass === 'public' ? null : (record.goal || null),
    definitionOfDone: redactionClass === 'public' ? null : (record.definitionOfDone || null),
    links: redactionClass === 'public' ? {} : clone(record.links || {}),
    breadcrumb: registry.breadcrumb(record.id),
  };
}

function normalizeSummary(summary, provider, redactionClass) {
  const normalized = {
    id: requiredString(summary.id, 'summary.id'),
    canonicalId: requiredString(summary.canonicalId, 'summary.canonicalId'),
    category: requiredString(summary.category, 'summary.category'),
    status: requiredString(summary.status, 'summary.status'),
    title: redactionClass === 'public' ? null : (summary.title || null),
    occurredAt: summary.occurredAt || null,
    observedAt: requiredString(summary.observedAt, 'summary.observedAt'),
    evidenceRefs: redactionClass === 'public' ? [] : [...summary.evidenceRefs],
    source: provider,
  };
  return normalized;
}

function summarySort(left, right) {
  const leftTime = Date.parse(left.occurredAt || left.observedAt) || 0;
  const rightTime = Date.parse(right.occurredAt || right.observedAt) || 0;
  return rightTime - leftTime || left.id.localeCompare(right.id) || left.source.localeCompare(right.source);
}

function emptyProvider(provider, state = 'omitted', omissions = ['provider-omitted']) {
  return {
    provider, state, trust: 'unverified', capturedAt: null, watermark: null,
    scope: { projectIds: [], outcomeIds: [] }, itemCount: 0, omissions: [...omissions].sort(), errorCode: null,
  };
}

function providerView(provider, snapshot, { now, maxAgeSeconds, selectedIds, redactionClass, authority }) {
  if (!snapshot) return { view: emptyProvider(provider), summaries: [], omissions: [`provider:${provider}:omitted`] };
  let validated;
  try { validated = validateProviderSnapshot(snapshot); } catch (_) {
    return { view: emptyProvider(provider, 'unknown', [`provider:${provider}:invalid-snapshot`]), summaries: [], omissions: [`provider:${provider}:invalid-snapshot`] };
  }
  if (validated.provider !== provider) {
    return { view: emptyProvider(provider, 'unknown', [`provider:${provider}:provider-mismatch`]), summaries: [], omissions: [`provider:${provider}:provider-mismatch`] };
  }
  let trusted = validated.trust === 'verified' && validated.admission && authority && typeof authority.verifyProviderSnapshot === 'function';
  if (validated.trust === 'unverified') {
    return {
      view: { ...emptyProvider(provider, 'unknown', [`provider:${provider}:untrusted`]), capturedAt: validated.capturedAt, watermark: validated.watermark, errorCode: 'UNTRUSTED' },
      summaries: [], omissions: [`provider:${provider}:untrusted`],
    };
  }
  if (trusted) trusted = authority.verifyProviderSnapshot(validated, { now, expectedProvider: provider }).ok;
  if (validated.trust === 'verified' && !trusted) {
    return {
      view: { ...emptyProvider(provider, 'unknown', [`provider:${provider}:untrusted`]), capturedAt: validated.capturedAt, watermark: validated.watermark, errorCode: 'UNVERIFIED' },
      summaries: [], omissions: [`provider:${provider}:untrusted`],
    };
  }
  const omissions = validated.omissions.map((entry) => `provider:${provider}:${entry}`);
  let state = validated.state;
  const providerScope = validated.scope;
  const coveredIds = new Set([...providerScope.projectIds, ...providerScope.outcomeIds]);
  if (coveredIds.size && [...selectedIds].some((id) => !coveredIds.has(id))) {
    state = state === 'healthy-empty' ? 'partial' : state;
    omissions.push(`provider:${provider}:coverage`);
  }
  const captured = validated.capturedAt ? Date.parse(validated.capturedAt) : null;
  const current = Date.parse(now);
  if (captured !== null && captured > current) { state = 'partial'; omissions.push(`provider:${provider}:capture-boundary`); }
  else if (state === 'fresh' && captured !== null && current - captured > maxAgeSeconds * 1000) state = 'stale';
  if (state === 'unavailable' || state === 'unknown') return {
    view: { provider, state, trust: validated.trust, capturedAt: validated.capturedAt, watermark: validated.watermark, scope: validated.scope, itemCount: 0, omissions: [...new Set(omissions)].sort(), errorCode: validated.errorCode },
    summaries: [], omissions,
  };
  const summaries = [];
  for (const summary of validated.summaries) {
    if (!selectedIds.has(summary.canonicalId)) { omissions.push(`provider:${provider}:out-of-scope`); continue; }
    const occurred = summary.occurredAt ? Date.parse(summary.occurredAt) : null;
    const observed = Date.parse(summary.observedAt);
    if ((occurred !== null && occurred > current) || observed > current) { omissions.push(`provider:${provider}:capture-boundary`); continue; }
    summaries.push(normalizeSummary(summary, provider, redactionClass));
  }
  summaries.sort(summarySort);
  const view = {
    provider, state, trust: validated.trust, capturedAt: validated.capturedAt, watermark: validated.watermark,
    scope: {
      projectIds: providerScope.projectIds.filter((id) => selectedIds.has(id)),
      outcomeIds: providerScope.outcomeIds.filter((id) => selectedIds.has(id)),
    }, itemCount: summaries.length, omissions: [...new Set(omissions)].sort(), errorCode: validated.errorCode,
  };
  return { view, summaries, omissions };
}

function classifySummaries(summaries) {
  const activity = summaries.filter((summary) => summary.category === 'activity');
  const currentWork = summaries.filter((summary) => ['intent', 'execution', 'work'].includes(summary.category) || ['active', 'open', 'in_progress', 'tracked', 'claimed'].includes(summary.status));
  const attention = summaries.filter((summary) => summary.category === 'attention' || ['blocked', 'approval_due', 'due', 'overdue'].includes(summary.status));
  return { activity, currentWork, attention };
}

function redactEvidence(summary) {
  return {
    source: summary.source, id: summary.id, canonicalId: summary.canonicalId,
    occurredAt: summary.occurredAt, observedAt: summary.observedAt, evidenceRefs: [...summary.evidenceRefs],
  };
}

function countItems(packet) {
  return packet.canonical.records.length + packet.activity.length + packet.currentWork.length + packet.attention.length + packet.evidence.length;
}

function removeLast(array) { return array.length ? array.pop() : null; }

function enforceBounds(packet, limits) {
  let omittedItems = 0;
  const sections = [];
  const targetFor = (section) => section === 'canonical.records' ? packet.canonical.records : packet[section];
  const trim = (section, predicate = () => true) => {
    while (predicate() && removeLast(targetFor(section))) { omittedItems += 1; if (!sections.includes(section)) sections.push(section); }
  };
  trim('activity', () => countItems(packet) > limits.maxItems);
  trim('currentWork', () => countItems(packet) > limits.maxItems);
  trim('evidence', () => countItems(packet) > limits.maxItems);
  trim('canonical.records', () => countItems(packet) > limits.maxItems);
  trim('attention', () => countItems(packet) > limits.maxItems);
  if (packet.canonical && packet.canonical.records) {
    packet.canonical.revisions = Object.fromEntries(packet.canonical.records.map((record) => [record.id, record.revision]));
  }
  const bytesExceeded = () => byteLength(packet) > limits.maxBytes;
  for (const section of ['activity', 'currentWork', 'evidence', 'attention', 'canonical.records']) {
    const target = section === 'canonical.records' ? packet.canonical.records : packet[section];
    while (bytesExceeded() && target.length) { target.pop(); omittedItems += 1; if (!sections.includes(section)) sections.push(section); }
  }
  packet.truncation = {
    truncated: omittedItems > 0,
    maxItems: limits.maxItems,
    maxBytes: limits.maxBytes,
    omittedItems,
    sections: sections.sort(),
  };
  return packet;
}

function validatePacketRecord(record) {
  if (!exactKeys(record, RECORD_PACKET_FIELDS) || !/^\w+_[0-9]{6,}$/.test(record.id) || !['project', 'outcome'].includes(record.kind)) return false;
  const allowedLifecycle = record.kind === 'project' ? ['active', 'paused', 'archived'] : ['planned', 'active', 'complete', 'archived'];
  if (!Array.isArray(record.aliases) || !allowedLifecycle.includes(record.lifecycle)) return false;
  if (!['high', 'medium', 'low', 'unset'].includes(record.declaredPriority) || !['high', 'medium', 'low', 'unset'].includes(record.effectivePriority)) return false;
  if (!exactKeys(record.priority, PRIORITY_FIELDS) || !['explicit', 'inherited', 'unset'].includes(record.priority.source)) return false;
  return Number.isInteger(record.revision) && record.revision > 0 && typeof record.breadcrumb === 'string';
}

function validatePacketSummary(summary) {
  return exactKeys(summary, SUMMARY_FIELDS)
    && typeof summary.id === 'string'
    && /^\w+_[0-9]{6,}$/.test(summary.canonicalId)
    && typeof summary.category === 'string'
    && typeof summary.status === 'string'
    && (summary.title === null || typeof summary.title === 'string')
    && (summary.occurredAt === null || typeof summary.occurredAt === 'string')
    && typeof summary.observedAt === 'string'
    && Array.isArray(summary.evidenceRefs)
    && typeof summary.source === 'string';
}

function validatePacketEvidence(evidence) {
  return exactKeys(evidence, EVIDENCE_FIELDS)
    && typeof evidence.source === 'string'
    && typeof evidence.id === 'string'
    && /^\w+_[0-9]{6,}$/.test(evidence.canonicalId)
    && (evidence.occurredAt === null || typeof evidence.occurredAt === 'string')
    && typeof evidence.observedAt === 'string'
    && Array.isArray(evidence.evidenceRefs);
}

function validateProviderView(view) {
  if (!exactKeys(view, ['provider', 'state', 'trust', 'capturedAt', 'watermark', 'scope', 'itemCount', 'omissions', 'errorCode'])) return false;
  if (typeof view.provider !== 'string' || !['omitted', 'fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty'].includes(view.state)) return false;
  if (!['verified', 'unverified'].includes(view.trust) || (view.capturedAt !== null && typeof view.capturedAt !== 'string') || (view.watermark !== null && typeof view.watermark !== 'string')) return false;
  try { validateProviderScope(view.scope); } catch (_) { return false; }
  return Number.isInteger(view.itemCount) && view.itemCount >= 0 && Array.isArray(view.omissions) && view.omissions.every((entry) => typeof entry === 'string') && (view.errorCode === null || typeof view.errorCode === 'string');
}

function validateContextPacket(packet) {
  if (!exactKeys(packet, CONTEXT_PACKET_FIELDS) || packet.contract !== CONTEXT_CONTRACT) return { ok: false, reason: 'invalid-contract' };
  if (!/^ctx_[a-f0-9]{32}$/.test(packet.packetId) || Number.isNaN(Date.parse(packet.capturedAt)) || Number.isNaN(Date.parse(packet.expiresAt))) return { ok: false, reason: 'invalid-contract' };
  if (!REDACTION_CLASSES.includes(packet.redactionClass) || !exactKeys(packet.capability, ['receiptId', 'digest']) || !/^cap_[a-f0-9]{32}$/.test(packet.capability.receiptId) || !/^[a-f0-9]{64}$/.test(packet.capability.digest)) return { ok: false, reason: 'invalid-contract' };
  try {
    validateContextQuery(packet.query);
    if (!exactKeys(packet.canonical, ['generation', 'records', 'revisions']) || !Number.isInteger(packet.canonical.generation) || !Array.isArray(packet.canonical.records) || !isPlainObject(packet.canonical.revisions)) return { ok: false, reason: 'invalid-contract' };
    if (packet.canonical.records.some((record) => !validatePacketRecord(record))) return { ok: false, reason: 'invalid-contract' };
    if (!Object.entries(packet.canonical.revisions).every(([id, revision]) => /^\w+_[0-9]{6,}$/.test(id) && Number.isInteger(revision) && revision > 0)) return { ok: false, reason: 'invalid-contract' };
    if ([...packet.activity, ...packet.currentWork, ...packet.attention].some((value) => !validatePacketSummary(value)) || packet.evidence.some((value) => !validatePacketEvidence(value))) return { ok: false, reason: 'invalid-contract' };
    if (!isPlainObject(packet.providers) || Object.values(packet.providers).some((view) => !validateProviderView(view))) return { ok: false, reason: 'invalid-contract' };
    if (!Array.isArray(packet.omissions) || packet.omissions.some((entry) => typeof entry !== 'string')) return { ok: false, reason: 'invalid-contract' };
    if (!exactKeys(packet.truncation, ['truncated', 'maxItems', 'maxBytes', 'omittedItems', 'sections']) || typeof packet.truncation.truncated !== 'boolean' || !Number.isInteger(packet.truncation.maxItems) || !Number.isInteger(packet.truncation.maxBytes) || !Number.isInteger(packet.truncation.omittedItems) || !Array.isArray(packet.truncation.sections)) return { ok: false, reason: 'invalid-contract' };
  } catch (_) {
    return { ok: false, reason: 'invalid-contract' };
  }
  return { ok: true, packet };
}

function buildContextPacket({ registry, query, providers = {}, providerAuthorities = {}, capability, capabilitySecret, subject, hostId, now = new Date().toISOString() } = {}) {
  let normalizedQuery;
  try { normalizedQuery = validateContextQuery(query); } catch (_) { return { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' }; }
  if (typeof hostId !== 'string' || !hostId.trim()) return { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' };
  const verification = verifyCapability(capability, {
    hostSecret: capabilitySecret,
    now,
    expectedSubject: subject,
    expectedHostId: hostId,
    expectedQuery: normalizedQuery,
    expectedRedactionClass: capability && capability.redactionClass,
  });
  if (!verification.ok || !registry || typeof registry.list !== 'function') return { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' };
  const authorized = verification.capability;
  if (stableStringify(authorized.scope) !== stableStringify(normalizedQuery.scope)
    || authorized.limits.maxItems < normalizedQuery.limits.maxItems
    || authorized.limits.maxBytes < normalizedQuery.limits.maxBytes
    || authorized.limits.maxProviderAgeSeconds < normalizedQuery.limits.maxProviderAgeSeconds
    || authorized.freshness.maxAgeSeconds < normalizedQuery.limits.maxProviderAgeSeconds) return { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' };
  const selectedIds = recordIdsForScope(registry, normalizedQuery.scope);
  if (!selectedIds) return { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' };
  const redactionClass = authorized.redactionClass;
  let records;
  try {
    records = registry.list()
      .filter((record) => selectedIds.has(record.id))
      .sort((left, right) => registry.breadcrumb(left.id).localeCompare(registry.breadcrumb(right.id)) || left.id.localeCompare(right.id))
      .map((record) => serializeRecord(record, registry, redactionClass));
  } catch (_) {
    return { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' };
  }
  const canonical = {
    generation: registry.generation,
    records,
    revisions: Object.fromEntries(records.map((record) => [record.id, record.revision])),
  };
  const allProviderNames = [...new Set([...KNOWN_PROVIDERS, ...Object.keys(providers)])].sort();
  const packetOmissions = [];
  const providerResults = {};
  const allSummaries = [];
  for (const provider of allProviderNames) {
    if (!authorized.providerCoverage.includes(provider)) {
      const result = { view: emptyProvider(provider, 'omitted', [`provider:${provider}:not-covered`]), summaries: [], omissions: [`provider:${provider}:not-covered`] };
      providerResults[provider] = result.view;
      packetOmissions.push(...result.omissions);
      continue;
    }
    const result = providerView(provider, providers[provider], {
      now, maxAgeSeconds: normalizedQuery.limits.maxProviderAgeSeconds, selectedIds, redactionClass, authority: providerAuthorities[provider],
    });
    providerResults[provider] = result.view;
    allSummaries.push(...result.summaries);
    packetOmissions.push(...result.omissions);
  }
  allSummaries.sort(summarySort);
  const classified = classifySummaries(allSummaries);
  const evidence = allSummaries.map(redactEvidence).sort(summarySort);
  const expiresAt = authorized.expiresAt;
  const packet = {
    contract: CONTEXT_CONTRACT,
    packetId: '',
    capturedAt: now,
    expiresAt,
    query: normalizedQuery,
    canonical,
    activity: normalizedQuery.include.includes('activity') ? classified.activity : [],
    currentWork: normalizedQuery.include.includes('currentWork') ? classified.currentWork : [],
    attention: normalizedQuery.include.includes('attention') ? classified.attention : [],
    evidence,
    providers: providerResults,
    omissions: [...new Set(packetOmissions)].sort(),
    truncation: { truncated: false, maxItems: normalizedQuery.limits.maxItems, maxBytes: normalizedQuery.limits.maxBytes, omittedItems: 0, sections: [] },
    redactionClass,
    capability: { receiptId: authorized.receiptId, digest: capabilityDigest(authorized) },
  };
  packet.packetId = `ctx_${hash({ ...packet, packetId: undefined }).slice(0, 32)}`;
  enforceBounds(packet, normalizedQuery.limits);
  packet.packetId = `ctx_${hash({ ...packet, packetId: undefined }).slice(0, 32)}`;
  if (byteLength(packet) > normalizedQuery.limits.maxBytes) return { status: 'unavailable', code: 'CONTEXT_BUDGET_TOO_SMALL' };
  return { status: 'ok', packet };
}

module.exports = {
  CONTEXT_CONTRACT,
  CONTEXT_PACKET_FIELDS,
  EVIDENCE_FIELDS,
  INCLUDE_SECTIONS,
  KNOWN_PROVIDERS,
  LIMIT_FIELDS,
  QUERY_FIELDS,
  SUMMARY_FIELDS,
  buildContextPacket,
  validateContextPacket,
  validateContextQuery,
};
