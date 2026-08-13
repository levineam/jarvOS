'use strict';

const { normalizeGitObservation, resolveDisposition } = require('../disposition');
const { isSafelyRemovableObservation } = require('../contracts');

function boundedConcurrency(value) {
  const number = Number(value || 1);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 32) : 1;
}

function health(state, reason, extra = {}) { return { state, reason, ...extra }; }

function createLimiter(limit) {
  const queue = [];
  let active = 0;
  const drain = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => { active -= 1; drain(); });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

// Run an injected observation with a bounded lifetime and a child signal. A
// provider that honors AbortSignal can stop promptly; one that does not still
// has its late result observed so it cannot become an unhandled rejection.
async function runWithBudget(task, budgetMs, parentSignal) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = controller ? controller.signal : undefined;
  let onParentAbort;
  if (controller && parentSignal) {
    onParentAbort = () => controller.abort();
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  let timer = null;
  let timedOut = false;
  const work = Promise.resolve().then(() => task(signal));
  const settled = work.then(() => undefined, () => undefined);
  const bounded = Number.isFinite(budgetMs) && budgetMs >= 0;
  const timeoutPromise = bounded ? new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (controller) controller.abort();
      resolve({ timeout: true });
    }, budgetMs);
  }) : null;
  try {
    const result = timeoutPromise ? await Promise.race([work, timeoutPromise]) : await work;
    return timedOut ? { timeout: true, settled } : { value: result, settled };
  } catch (error) {
    return { error, settled };
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && parentSignal && onParentAbort) parentSignal.removeEventListener('abort', onParentAbort);
    work.catch(() => {});
  }
}

function finiteBudget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function observeRoot(root, options, activeRoots) {
  const rootId = root && root.rootId;
  if (typeof rootId !== 'string' || !rootId) return { rootId: rootId || 'unknown-root', inventory: [], health: health('degraded', 'invalid_root') };
  if (activeRoots && activeRoots.has(rootId)) return { rootId, inventory: [], health: health('degraded', 'overlap', { overlap: true }) };
  if (!options.gitObservationPort || typeof options.gitObservationPort.observeRoot !== 'function') return { rootId, inventory: [], health: health('degraded', 'git_observation_port_unavailable') };

  activeRoots && activeRoots.add(rootId);
  const budget = finiteBudget(options.rootBudgetMs);
  const startedAt = Date.now();
  const rootController = typeof AbortController === 'function' ? new AbortController() : null;
  const rootTimer = rootController && budget !== null ? setTimeout(() => rootController.abort(), budget) : null;
  const rootSignal = rootController ? rootController.signal : undefined;
  const remainingBudget = () => budget === null ? null : Math.max(0, budget - (Date.now() - startedAt));
  const pendingSettlements = [];
  const trackSettlement = (result) => {
    if (result && result.settled && typeof result.settled.then === 'function') pendingSettlements.push(result.settled);
    return result;
  };

  try {
    const observationResult = trackSettlement(await runWithBudget(
      (signal) => options.gitObservationPort.observeRoot({ rootId, budgetMs: budget, signal }),
      remainingBudget(),
      rootSignal,
    ));
    if (observationResult.timeout || (rootSignal && rootSignal.aborted && !observationResult.value)) {
      if (rootController) rootController.abort();
      return { rootId, inventory: [], health: health('degraded', 'root_time_budget_exhausted') };
    }
    if (observationResult.error) return { rootId, inventory: [], health: health('degraded', 'git_observation_failed') };
    if (!observationResult.value || !Array.isArray(observationResult.value.observations)) {
      return { rootId, inventory: [], health: health('degraded', 'git_observation_malformed') };
    }

    const entries = [];
    let observationFailed = false;
    const maxObservations = Number.isInteger(options.maxObservationsPerRoot) && options.maxObservationsPerRoot > 0
      ? options.maxObservationsPerRoot : 256;
    const truncated = observationResult.value.observations.length > maxObservations;
    for (const raw of observationResult.value.observations.slice(0, maxObservations)) {
      try {
        const observation = normalizeGitObservation(raw);
        entries.push({ observation, safe: isSafelyRemovableObservation(observation), lifecycleResult: null });
      } catch (_) {
        // An unrepresentable host fact has no safe public identity or complete evidence.
        observationFailed = true;
      }
    }

    let lifecycleFailed = false;
    let releaseClearanceFailed = false;
    const lifecycleCache = new Map();
    const releaseClearanceCache = new Map();
    const resolveLifecycle = (subjectIdentity) => {
      if (lifecycleCache.has(subjectIdentity)) return lifecycleCache.get(subjectIdentity);
      const promise = (async () => {
        if (!options.lifecycleEvidencePort || typeof options.lifecycleEvidencePort.resolve !== 'function') return { available: false };
        const remaining = remainingBudget();
        if (remaining !== null && remaining <= 0) {
          lifecycleFailed = true;
          if (rootController) rootController.abort();
          return { available: false };
        }
        const result = trackSettlement(await options.lifecycleLimiter(async () => {
          if (rootSignal && rootSignal.aborted) return { timeout: true, settled: Promise.resolve() };
          return runWithBudget(
            (signal) => options.lifecycleEvidencePort.resolve({ subjectIdentity, budgetMs: remaining, signal }),
            remaining,
            rootSignal,
          );
        }));
        if (result.timeout || (rootSignal && rootSignal.aborted && !result.value)) {
          lifecycleFailed = true;
          if (rootController) rootController.abort();
          return { available: false };
        }
        if (result.error) {
          lifecycleFailed = true;
          return { available: false };
        }
        return result.value;
      })();
      lifecycleCache.set(subjectIdentity, promise);
      return promise;
    };

    const resolveReleaseClearance = (subjectIdentity) => {
      if (releaseClearanceCache.has(subjectIdentity)) return releaseClearanceCache.get(subjectIdentity);
      const promise = (async () => {
        if (!options.releaseClearancePort || typeof options.releaseClearancePort.resolve !== 'function') {
          releaseClearanceFailed = true;
          return { available: false };
        }
        const remaining = remainingBudget();
        if (remaining !== null && remaining <= 0) {
          releaseClearanceFailed = true;
          if (rootController) rootController.abort();
          return { available: false };
        }
        const result = trackSettlement(await options.releaseClearanceLimiter(async () => {
          if (rootSignal && rootSignal.aborted) return { timeout: true, settled: Promise.resolve() };
          return runWithBudget(
            (signal) => options.releaseClearancePort.resolve({ subjectIdentity, budgetMs: remaining, signal }),
            remaining,
            rootSignal,
          );
        }));
        if (result.timeout || (rootSignal && rootSignal.aborted && !result.value)) {
          releaseClearanceFailed = true;
          if (rootController) rootController.abort();
          return { available: false };
        }
        if (result.error) {
          releaseClearanceFailed = true;
          return { available: false };
        }
        const value = result.value;
        if (value?.status === 'admissible' && value.binding) return value.binding;
        if (value?.status === 'blocked' || value?.available === false) return { available: false, reason: value.reason || 'release_clearance_unavailable' };
        return value;
      })();
      releaseClearanceCache.set(subjectIdentity, promise);
      return promise;
    };

    const eligible = entries.filter((entry) => entry.safe);
    let next = 0;
    const workers = Array.from({ length: Math.min(boundedConcurrency(options.lifecycleConcurrency || 4), eligible.length) }, async () => {
      while (next < eligible.length) {
        const entry = eligible[next++];
        entry.lifecycleResult = await resolveLifecycle(entry.observation.subjectIdentity);
        entry.releaseClearanceResult = await resolveReleaseClearance(entry.observation.subjectIdentity);
      }
    });
    await Promise.all(workers);

    const inventory = entries.map((entry) => ({
      rootId,
      observation: entry.observation,
      disposition: resolveDisposition({ observation: entry.observation, lifecycleResult: entry.safe ? entry.lifecycleResult : null, releaseClearanceResult: entry.safe ? entry.releaseClearanceResult : null, now: options.now }),
    }));
    const degraded = lifecycleFailed || releaseClearanceFailed || observationFailed || truncated;
    return {
      rootId,
      inventory,
      health: health(
        degraded ? 'degraded' : 'healthy',
        lifecycleFailed ? 'lifecycle_evidence_unavailable' : observationFailed ? 'git_observation_malformed' : truncated ? 'observation_limit_exhausted' : releaseClearanceFailed ? 'release_clearance_unavailable' : 'ok',
        truncated ? { truncated: true, omittedObservations: observationResult.value.observations.length - maxObservations } : {},
      ),
    };
  } finally {
    if (rootTimer) clearTimeout(rootTimer);
    if (rootController) rootController.abort();
    // Keep the root fenced until all injected providers settle. A provider
    // that ignores AbortSignal must not overlap a later run and race its late
    // result into the same root.
    Promise.allSettled(pendingSettlements).then(() => activeRoots && activeRoots.delete(rootId));
  }
}

async function discoverWorkspaces(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : [];
  const activeRoots = options.activeRoots || new Set();
  const lifecycleLimit = boundedConcurrency(options.lifecycleConcurrency || 4);
  const lifecycleLimiter = options.lifecycleLimiter || createLimiter(lifecycleLimit);
  const releaseClearanceLimiter = options.releaseClearanceLimiter || createLimiter(boundedConcurrency(options.releaseClearanceConcurrency || lifecycleLimit));
  const pending = roots.slice(); const results = [];
  const workers = Array.from({ length: Math.min(boundedConcurrency(options.concurrency), pending.length) }, async () => {
    while (pending.length) results.push(await observeRoot(pending.shift(), { ...options, lifecycleLimiter, releaseClearanceLimiter }, activeRoots));
  });
  await Promise.all(workers);
  const seen = new Set(); let deduplicated = 0;
  const inventory = [];
  for (const root of results) for (const item of root.inventory) {
    const key = item.observation.candidateId;
    if (seen.has(key)) { deduplicated += 1; continue; }
    seen.add(key); inventory.push(item);
  }
  const degraded = results.some((root) => root.health.state !== 'healthy');
  return { inventory, roots: results, deduplicated, health: health(degraded ? 'degraded' : 'healthy', degraded ? 'partial_discovery' : 'ok') };
}

function createWorkspaceDiscoveryService(options = {}) {
  const activeRoots = new Set(); let activeRun = null;
  return {
    async discover(input = {}) {
      if (activeRun) return { inventory: [], roots: [], deduplicated: 0, health: health('degraded', 'overlap', { overlap: true }) };
      const now = typeof options.now === 'function' ? options.now() : options.now;
      activeRun = discoverWorkspaces({ ...options, ...input, now: input.now || now, activeRoots });
      try { return await activeRun; } finally { activeRun = null; }
    },
  };
}

module.exports = { discoverWorkspaces, createWorkspaceDiscoveryService };
