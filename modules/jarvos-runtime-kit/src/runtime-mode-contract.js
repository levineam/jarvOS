'use strict';

// This is deliberately a declaration-only contract.  It describes which
// resident harnesses are installed and which one owns a workload; it does not
// start, configure, or otherwise activate either harness.
const RUNTIME_MODE_CONTRACT_VERSION = 'jarvos-runtime-mode/v1';
const RUNTIME_MODES = Object.freeze(['none', 'hermes', 'openclaw', 'multi']);
const RESIDENT_ADAPTERS = Object.freeze(['hermes', 'openclaw']);
const CAPABILITY_TRUTH_STATES = Object.freeze(['available', 'unavailable', 'unknown']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultRuntimeMode() {
  return {
    version: RUNTIME_MODE_CONTRACT_VERSION,
    mode: 'none',
    installedAdapters: [],
    workloadRoutes: [],
    capabilityTruth: [],
  };
}

function validateRuntimeModeContract(contract) {
  const errors = [];
  if (!isObject(contract)) return { ok: false, errors: ['runtimeMode must be an object'] };
  const allowed = new Set(['version', 'mode', 'installedAdapters', 'workloadRoutes', 'capabilityTruth']);
  for (const key of Object.keys(contract)) if (!allowed.has(key)) errors.push(`runtimeMode has unknown field: ${key}`);
  if (contract.version !== RUNTIME_MODE_CONTRACT_VERSION) errors.push(`runtimeMode.version must be ${RUNTIME_MODE_CONTRACT_VERSION}`);
  if (!RUNTIME_MODES.includes(contract.mode)) errors.push(`runtimeMode.mode must be one of: ${RUNTIME_MODES.join(', ')}`);

  const adapters = Array.isArray(contract.installedAdapters) ? contract.installedAdapters : [];
  if (!Array.isArray(contract.installedAdapters)) errors.push('runtimeMode.installedAdapters must be an array');
  const installed = new Set();
  adapters.forEach((adapter, index) => {
    if (!isObject(adapter)) {
      errors.push(`runtimeMode.installedAdapters[${index}] must be an object`);
      return;
    }
    if (Object.keys(adapter).some((key) => key !== 'id')) errors.push(`runtimeMode.installedAdapters[${index}] has unknown field`);
    if (!RESIDENT_ADAPTERS.includes(adapter.id)) errors.push(`runtimeMode.installedAdapters[${index}].id must be a supported resident adapter`);
    if (installed.has(adapter.id)) errors.push(`runtimeMode.installedAdapters has duplicate adapter: ${adapter.id}`);
    installed.add(adapter.id);
  });

  const routes = Array.isArray(contract.workloadRoutes) ? contract.workloadRoutes : [];
  if (!Array.isArray(contract.workloadRoutes)) errors.push('runtimeMode.workloadRoutes must be an array');
  const routedWorkloads = new Set();
  let telegramUpdateConsumers = 0;
  routes.forEach((route, index) => {
    if (!isObject(route)) {
      errors.push(`runtimeMode.workloadRoutes[${index}] must be an object`);
      return;
    }
    for (const key of Object.keys(route)) if (!['workload', 'adapter'].includes(key)) errors.push(`runtimeMode.workloadRoutes[${index}] has unknown field: ${key}`);
    if (typeof route.workload !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(route.workload)) errors.push(`runtimeMode.workloadRoutes[${index}].workload must be a stable workload id`);
    if (!RESIDENT_ADAPTERS.includes(route.adapter)) errors.push(`runtimeMode.workloadRoutes[${index}].adapter must be a supported resident adapter`);
    if (!installed.has(route.adapter)) errors.push(`runtimeMode.workloadRoutes[${index}].adapter must be installed`);
    if (routedWorkloads.has(route.workload)) errors.push(`runtimeMode.workloadRoutes has duplicate workload: ${route.workload}`);
    routedWorkloads.add(route.workload);
    if (route.workload === 'telegram.updates') telegramUpdateConsumers += 1;
  });
  if (telegramUpdateConsumers > 1) errors.push('runtimeMode permits only one Telegram update consumer');

  const truths = Array.isArray(contract.capabilityTruth) ? contract.capabilityTruth : [];
  if (!Array.isArray(contract.capabilityTruth)) errors.push('runtimeMode.capabilityTruth must be an array');
  const truthKeys = new Set();
  truths.forEach((truth, index) => {
    if (!isObject(truth)) {
      errors.push(`runtimeMode.capabilityTruth[${index}] must be an object`);
      return;
    }
    for (const key of Object.keys(truth)) if (!['adapter', 'capability', 'state', 'evidence'].includes(key)) errors.push(`runtimeMode.capabilityTruth[${index}] has unknown field: ${key}`);
    if (!installed.has(truth.adapter)) errors.push(`runtimeMode.capabilityTruth[${index}].adapter must be installed`);
    if (typeof truth.capability !== 'string' || !/^[a-z][a-z0-9._-]*$/.test(truth.capability)) errors.push(`runtimeMode.capabilityTruth[${index}].capability must be a stable capability id`);
    if (!CAPABILITY_TRUTH_STATES.includes(truth.state)) errors.push(`runtimeMode.capabilityTruth[${index}].state must be one of: ${CAPABILITY_TRUTH_STATES.join(', ')}`);
    if (!Array.isArray(truth.evidence) || truth.evidence.length === 0) {
      errors.push(`runtimeMode.capabilityTruth[${index}].evidence must be a non-empty array`);
    } else {
      truth.evidence.forEach((item, evidenceIndex) => {
        if (!isObject(item) || Object.keys(item).some((key) => !['kind', 'detail'].includes(key))
          || typeof item.kind !== 'string' || !item.kind || typeof item.detail !== 'string' || !item.detail) {
          errors.push(`runtimeMode.capabilityTruth[${index}].evidence[${evidenceIndex}] requires kind and detail`);
        }
      });
    }
    const key = `${truth.adapter}:${truth.capability}`;
    if (truthKeys.has(key)) errors.push(`runtimeMode.capabilityTruth has duplicate adapter/capability: ${key}`);
    truthKeys.add(key);
  });

  if (contract.mode === 'none' && (adapters.length || routes.length || truths.length)) errors.push('runtimeMode none must not declare a resident harness, route, or capability truth');
  if (['hermes', 'openclaw'].includes(contract.mode)) {
    if (adapters.length !== 1 || adapters[0]?.id !== contract.mode) errors.push(`runtimeMode ${contract.mode} must install only ${contract.mode}`);
    if (routes.length !== 0) errors.push(`runtimeMode ${contract.mode} must not declare workload routes; multi owns explicit routing`);
  }
  if (contract.mode === 'multi') {
    if (adapters.length < 2) errors.push('runtimeMode multi must install at least two resident adapters');
    if (routes.length === 0) errors.push('runtimeMode multi requires explicit workload routes');
  }
  return { ok: errors.length === 0, errors };
}

// Existing jarvos.config.json files predate this optional block.  Loading one
// is therefore an explicit compatibility path, not a migration or activation.
function loadRuntimeModeConfig(config) {
  if (!isObject(config)) return { ok: false, errors: ['config must be an object'] };
  const source = config.runtimeMode === undefined ? 'legacy-default' : 'configured';
  const runtimeMode = source === 'legacy-default' ? defaultRuntimeMode() : config.runtimeMode;
  const validation = validateRuntimeModeContract(runtimeMode);
  return { ...validation, source, runtimeMode: validation.ok ? runtimeMode : null };
}

module.exports = {
  CAPABILITY_TRUTH_STATES,
  RESIDENT_ADAPTERS,
  RUNTIME_MODE_CONTRACT_VERSION,
  RUNTIME_MODES,
  defaultRuntimeMode,
  loadRuntimeModeConfig,
  validateRuntimeModeContract,
};
