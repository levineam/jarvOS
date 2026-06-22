'use strict';

const {
  createAdapterErrorResult,
  createAdapterResult,
  createUnsupportedAdapterResult,
  isAdapterResult,
} = require('./contract');

function normalizeOperation(operation) {
  switch (operation) {
    case 'writeMemoryRecord':
      return 'writeMemoryRecord';
    case 'ensureTrackedWork':
      return 'ensureTrackedWork';
    default:
      return operation;
  }
}

function actionsFromInvocation(invocation = {}) {
  if (Array.isArray(invocation.actionPlan)) return invocation.actionPlan;
  if (invocation.actionPlan) return [invocation.actionPlan];
  return [];
}

function adapterMeta(adapter, operation, action = {}) {
  return {
    adapter: adapter?.kind || 'unknown',
    backend: adapter?.backend || 'unknown',
    operation,
    target: action.kind,
    source: action.input?.source,
  };
}

function normalizeResult(result, meta) {
  if (isAdapterResult(result)) return result;
  return createAdapterResult({
    ...meta,
    result: result === undefined ? null : result,
  });
}

function invokeAdapterAction(adapter, action = {}) {
  const operation = normalizeOperation(action.operation);
  const input = action.input || {};
  const fn = adapter && adapter[operation];
  const meta = adapterMeta(adapter, operation, action);

  if (typeof fn !== 'function') {
    return createUnsupportedAdapterResult(meta);
  }

  try {
    const result = fn.call(adapter, input);
    if (result && typeof result.then === 'function') {
      return result
        .then((resolved) => normalizeResult(resolved, meta))
        .catch((error) => createAdapterErrorResult({
          ...meta,
          error,
        }));
    }
    return normalizeResult(result, meta);
  } catch (error) {
    return createAdapterErrorResult({
      ...meta,
      error,
    });
  }
}

async function dispatchSkillInvocation(invocation = {}, adapter) {
  const results = [];

  for (const action of actionsFromInvocation(invocation)) {
    results.push(await invokeAdapterAction(adapter, action));
  }

  return {
    skillId: invocation.skillId || null,
    ok: results.every((result) => result?.ok !== false),
    results,
  };
}

async function dispatchSkillInvocations(planOrInvocations = {}, adapter) {
  const invocations = Array.isArray(planOrInvocations)
    ? planOrInvocations
    : planOrInvocations.skillInvocations || [];
  const results = [];

  for (const invocation of invocations) {
    results.push(await dispatchSkillInvocation(invocation, adapter));
  }

  return {
    ok: results.every((result) => result.ok),
    results,
  };
}

module.exports = {
  actionsFromInvocation,
  dispatchSkillInvocation,
  dispatchSkillInvocations,
  invokeAdapterAction,
};
