'use strict';

const CAPABILITY_DESCRIPTOR_VERSION = 'jarvos-runtime-capability-descriptor.v1';
const CAPABILITY_STATUSES = ['supported', 'manual', 'unsupported'];
const CAPABILITY_VOCABULARY = Object.freeze({
  context: ['currentWork', 'recall', 'startupHydration'],
  notes: ['create', 'read', 'update', 'journalLink'],
  skills: ['discover', 'invoke'],
  toolAuthorization: ['declare', 'enforce'],
  egress: ['declare', 'enforce'],
  session: ['startupHook', 'handoff', 'preCompactHook'],
  inboundDispatch: ['receive', 'validate'],
  lifecycle: ['receipt'],
  scheduledWork: ['participate'],
  codingEntrypoint: ['invoke'],
});

const SHA256 = /^[a-f0-9]{64}$/i;
const DESCRIPTOR_FIELDS = new Set(['version', 'harness', 'capabilities', 'probe']);
const CAPABILITY_FIELDS = new Set(['status', 'transport', 'reason', 'evidence']);
const PROBE_FIELDS = new Set(['version', 'packageDigest', 'attestedAt']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path} has unknown field: ${key}`);
  }
}

function validateProbe(probe, path, errors) {
  if (!isObject(probe)) {
    errors.push(`${path} must be an object`);
    return;
  }
  unknownFields(probe, PROBE_FIELDS, path, errors);
  if (probe.version !== undefined && (typeof probe.version !== 'string' || !probe.version)) errors.push(`${path}.version must be a non-empty string`);
  if (probe.packageDigest !== undefined && (typeof probe.packageDigest !== 'string' || !SHA256.test(probe.packageDigest))) errors.push(`${path}.packageDigest must be a SHA-256 digest`);
  if (probe.attestedAt !== undefined && (typeof probe.attestedAt !== 'string' || Number.isNaN(Date.parse(probe.attestedAt)))) errors.push(`${path}.attestedAt must be an ISO timestamp`);
}

function validateCapability(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  unknownFields(value, CAPABILITY_FIELDS, path, errors);
  if (!CAPABILITY_STATUSES.includes(value.status)) errors.push(`${path}.status must be one of: ${CAPABILITY_STATUSES.join(', ')}`);
  if (['supported', 'manual'].includes(value.status) && (typeof value.transport !== 'string' || !value.transport)) errors.push(`${path}.transport is required when status is ${value.status}`);
  if (value.status === 'supported' && (typeof value.evidence !== 'string' || !value.evidence)) errors.push(`${path}.evidence is required when status is supported`);
  if (['manual', 'unsupported'].includes(value.status) && (typeof value.reason !== 'string' || !value.reason)) errors.push(`${path}.reason is required when status is ${value.status}`);
  if (value.evidence !== undefined && (typeof value.evidence !== 'string' || !value.evidence)) errors.push(`${path}.evidence must be a non-empty string when provided`);
}

function validateCapabilityDescriptor(descriptor) {
  const errors = [];
  if (!isObject(descriptor)) return { ok: false, errors: ['capability descriptor must be an object'] };
  unknownFields(descriptor, DESCRIPTOR_FIELDS, 'capability descriptor', errors);
  if (descriptor.version !== CAPABILITY_DESCRIPTOR_VERSION) errors.push(`capability descriptor.version must be ${CAPABILITY_DESCRIPTOR_VERSION}`);
  if (typeof descriptor.harness !== 'string' || !descriptor.harness) errors.push('capability descriptor.harness must be a non-empty string');
  if (!isObject(descriptor.capabilities)) {
    errors.push('capability descriptor.capabilities must be an object');
  } else {
    for (const [group, values] of Object.entries(descriptor.capabilities)) {
      if (!Object.hasOwn(CAPABILITY_VOCABULARY, group)) {
        errors.push(`capability descriptor.capabilities has unknown group: ${group}`);
        continue;
      }
      if (!isObject(values)) {
        errors.push(`capability descriptor.capabilities.${group} must be an object`);
        continue;
      }
      for (const [name, value] of Object.entries(values)) {
        if (!CAPABILITY_VOCABULARY[group].includes(name)) {
          errors.push(`capability descriptor.capabilities.${group} has unknown capability: ${name}`);
          continue;
        }
        validateCapability(value, `capability descriptor.capabilities.${group}.${name}`, errors);
      }
    }
  }
  if (descriptor.probe !== undefined) validateProbe(descriptor.probe, 'capability descriptor.probe', errors);
  return { ok: errors.length === 0, errors };
}

function probeMismatch(expected, actual, maxAgeMs, now) {
  if (!actual) return null;
  for (const field of ['version', 'packageDigest']) {
    if (expected?.[field] && actual[field] !== expected[field]) return `probe ${field} does not match the public descriptor`;
  }
  if (maxAgeMs !== undefined && actual.attestedAt && Date.parse(actual.attestedAt) + maxAgeMs < now) return 'probe attestation is stale';
  return null;
}

function unsupported(reason) {
  return { status: 'unsupported', reason };
}

function resolveCapabilityDescriptor({ descriptor, installedOverlay, currentProbe, maxProbeAgeMs, now = Date.now() } = {}) {
  const descriptorResult = validateCapabilityDescriptor(descriptor);
  const errors = [...descriptorResult.errors];
  if (installedOverlay !== undefined) errors.push(...validateCapabilityDescriptor(installedOverlay).errors.map((error) => `installed overlay: ${error}`));
  if (currentProbe !== undefined) validateProbe(currentProbe, 'current probe', errors);
  if (installedOverlay && descriptor?.harness !== installedOverlay.harness) errors.push('installed overlay.harness must match descriptor.harness');
  if (errors.length) return { ok: false, errors };

  const mismatch = probeMismatch(descriptor.probe, currentProbe, maxProbeAgeMs, now)
    || probeMismatch(installedOverlay?.probe, currentProbe, maxProbeAgeMs, now);
  const capabilities = {};
  for (const [group, names] of Object.entries(CAPABILITY_VOCABULARY)) {
    capabilities[group] = {};
    for (const name of names) {
      const publicValue = descriptor.capabilities?.[group]?.[name];
      const installedValue = installedOverlay?.capabilities?.[group]?.[name];
      if (!publicValue) {
        capabilities[group][name] = unsupported('Capability is not declared by the public descriptor.');
      } else if (publicValue.status !== 'supported') {
        capabilities[group][name] = { ...publicValue };
      } else if (mismatch) {
        capabilities[group][name] = unsupported(`Capability probe cannot confirm support: ${mismatch}.`);
      } else if (installedOverlay && (!installedValue || installedValue.status !== 'supported')) {
        capabilities[group][name] = installedValue?.status === 'manual'
          ? { ...installedValue }
          : unsupported(installedValue?.reason || 'Capability is not installed or is unsupported by the installed overlay.');
      } else {
        capabilities[group][name] = { ...publicValue, ...(installedValue || {}) };
      }
    }
  }
  return {
    ok: true,
    capabilities,
    descriptor: { version: CAPABILITY_DESCRIPTOR_VERSION, harness: descriptor.harness, capabilities, probe: currentProbe || descriptor.probe },
  };
}

module.exports = {
  CAPABILITY_DESCRIPTOR_VERSION,
  CAPABILITY_STATUSES,
  CAPABILITY_VOCABULARY,
  resolveCapabilityDescriptor,
  validateCapabilityDescriptor,
};
