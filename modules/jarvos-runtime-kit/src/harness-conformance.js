'use strict';

// Conformance is declarative. These facts never inspect, start, or activate a
// harness; an owner-local proof source may register verified facts later.
const HARNESS_CONFORMANCE_VERSION = 'jarvos-harness-conformance/v1';
const HARNESS_CONFORMANCE_TIERS = Object.freeze([
  'baseline-context',
  'conversational',
  'mutation-capable',
  'proactive-authority',
]);
const HARNESS_CONFORMANCE_STATES = Object.freeze(['claimed-unverified', 'verified']);
const HARNESS_CONFORMANCE_HARNESSES = Object.freeze(['hermes', 'openclaw']);
const PROACTIVE_TELEGRAM_WORKLOAD = 'telegram.proactive-delivery';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validateInstalledTuple(tuple, harness, path, errors) {
  if (!isObject(tuple)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const key of Object.keys(tuple)) {
    if (!['harness', 'runtimeVersion', 'assetDigest'].includes(key)) errors.push(`${path} has unknown field: ${key}`);
  }
  if (tuple.harness !== harness) errors.push(`${path}.harness must match fact.harness`);
  if (typeof tuple.runtimeVersion !== 'string' || !tuple.runtimeVersion) errors.push(`${path}.runtimeVersion is required`);
  if (!isDigest(tuple.assetDigest)) errors.push(`${path}.assetDigest must be a SHA-256 digest`);
}

function validateHarnessConformanceFact(fact, path = 'conformanceFacts.facts[0]') {
  const errors = [];
  if (!isObject(fact)) return { ok: false, errors: [`${path} must be an object`] };
  for (const key of Object.keys(fact)) {
    if (!['harness', 'tier', 'state', 'evidence', 'installedTuple'].includes(key)) errors.push(`${path} has unknown field: ${key}`);
  }
  if (!HARNESS_CONFORMANCE_HARNESSES.includes(fact.harness)) errors.push(`${path}.harness must be one of: ${HARNESS_CONFORMANCE_HARNESSES.join(', ')}`);
  if (!HARNESS_CONFORMANCE_TIERS.includes(fact.tier)) errors.push(`${path}.tier must be one of: ${HARNESS_CONFORMANCE_TIERS.join(', ')}`);
  if (!HARNESS_CONFORMANCE_STATES.includes(fact.state)) errors.push(`${path}.state must be one of: ${HARNESS_CONFORMANCE_STATES.join(', ')}`);
  if (!Array.isArray(fact.evidence) || fact.evidence.length === 0) {
    errors.push(`${path}.evidence must be a non-empty array`);
  } else {
    fact.evidence.forEach((item, index) => {
      if (!isObject(item) || Object.keys(item).some((key) => !['kind', 'detail'].includes(key))
        || typeof item.kind !== 'string' || !item.kind || typeof item.detail !== 'string' || !item.detail) {
        errors.push(`${path}.evidence[${index}] requires kind and detail`);
      }
    });
  }
  // A hook can describe a claim, but it is never enough to admit proactive
  // delivery. The exact installed tuple binds a verified top-tier fact.
  if (fact.tier === 'proactive-authority' && fact.state === 'verified') {
    validateInstalledTuple(fact.installedTuple, fact.harness, `${path}.installedTuple`, errors);
  } else if (fact.installedTuple !== undefined) {
    validateInstalledTuple(fact.installedTuple, fact.harness, `${path}.installedTuple`, errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateHarnessConformanceRegistry(registry, { harness, requireCanonicalTiers = false } = {}) {
  const errors = [];
  if (!isObject(registry)) return { ok: false, errors: ['conformanceFacts must be an object'] };
  for (const key of Object.keys(registry)) if (!['version', 'facts'].includes(key)) errors.push(`conformanceFacts has unknown field: ${key}`);
  if (registry.version !== HARNESS_CONFORMANCE_VERSION) errors.push(`conformanceFacts.version must be ${HARNESS_CONFORMANCE_VERSION}`);
  if (!Array.isArray(registry.facts)) {
    errors.push('conformanceFacts.facts must be an array');
  } else {
    const factKeys = new Set();
    registry.facts.forEach((fact, index) => {
      const result = validateHarnessConformanceFact(fact, `conformanceFacts.facts[${index}]`);
      errors.push(...result.errors);
      if (harness && fact?.harness !== harness) errors.push(`conformanceFacts.facts[${index}].harness must match manifest id ${harness}`);
      const key = `${fact?.harness}:${fact?.tier}`;
      if (factKeys.has(key)) errors.push(`conformanceFacts.facts has duplicate harness/tier: ${key}`);
      factKeys.add(key);
    });
    if (requireCanonicalTiers) {
      if (registry.facts.length !== HARNESS_CONFORMANCE_TIERS.length) {
        errors.push(`conformanceFacts.facts must declare exactly ${HARNESS_CONFORMANCE_TIERS.length} canonical tiers`);
      }
      HARNESS_CONFORMANCE_TIERS.forEach((tier, index) => {
        if (registry.facts[index]?.tier !== tier) errors.push(`conformanceFacts.facts[${index}] must be canonical tier ${tier}`);
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function createHarnessConformanceRegistry(registry) {
  const validation = validateHarnessConformanceRegistry(registry);
  if (!validation.ok) return { ...validation, registry: null };
  const facts = registry.facts.map((fact) => Object.freeze({
    ...fact,
    evidence: Object.freeze(fact.evidence.map((item) => Object.freeze({ ...item }))),
    ...(fact.installedTuple ? { installedTuple: Object.freeze({ ...fact.installedTuple }) } : {}),
  }));
  return { ok: true, errors: [], registry: Object.freeze({ version: registry.version, facts: Object.freeze(facts) }) };
}

function admitRuntimeProfileRoute({ route, registry }) {
  if (!route || route.workload !== PROACTIVE_TELEGRAM_WORKLOAD) return { ok: true, errors: [] };
  const checked = createHarnessConformanceRegistry(registry);
  if (!checked.ok) return { ok: false, errors: checked.errors.map((error) => `proactive route requires valid conformance facts: ${error}`) };
  const fact = checked.registry.facts.find((item) => item.harness === route.adapter && item.tier === 'proactive-authority');
  if (!fact || fact.state !== 'verified') {
    return { ok: false, errors: [`proactive route ${PROACTIVE_TELEGRAM_WORKLOAD} requires verified proactive-authority conformance for ${route.adapter}`] };
  }
  if (!fact.installedTuple) {
    return { ok: false, errors: [`proactive route ${PROACTIVE_TELEGRAM_WORKLOAD} requires exact installed-tuple evidence for ${route.adapter}`] };
  }
  return { ok: true, errors: [] };
}

module.exports = {
  HARNESS_CONFORMANCE_STATES,
  HARNESS_CONFORMANCE_HARNESSES,
  HARNESS_CONFORMANCE_TIERS,
  HARNESS_CONFORMANCE_VERSION,
  PROACTIVE_TELEGRAM_WORKLOAD,
  admitRuntimeProfileRoute,
  createHarnessConformanceRegistry,
  validateHarnessConformanceFact,
  validateHarnessConformanceRegistry,
};
