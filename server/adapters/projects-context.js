'use strict';

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() && value.trim() !== '-' ? value.trim() : null;
}

function normalizeProjectsResult(result) {
  if (!result || result.status !== 'ok' || !result.packet) {
    return {
      status: 'unavailable',
      code: result?.code || 'PROJECTS_PROVIDER_UNAVAILABLE',
      reason: cleanText(result?.reason) || 'Projects context is unavailable',
      coverage: 'partial',
      scope: { projectIds: [], outcomeIds: [], includeDescendants: false },
      capturedAt: null,
      expiresAt: null,
      projects: [],
      omissions: [],
    };
  }

  const packet = result.packet;
  const records = asArray(packet.canonical?.records).filter((record) => record && typeof record.id === 'string');
  const scope = packet.query?.scope || {};
  const projectIds = Array.isArray(scope.projectIds) ? scope.projectIds.filter((id) => typeof id === 'string') : [];
  const outcomeIds = Array.isArray(scope.outcomeIds) ? scope.outcomeIds.filter((id) => typeof id === 'string') : [];
  const outcomes = records.filter((record) => record.kind === 'outcome');
  const providers = asArray(packet.providers).filter((p) => p && typeof p === 'object').map((provider) => ({
    name: cleanText(provider.provider) || 'unknown', state: cleanText(provider.state) || 'unknown',
    trust: cleanText(provider.trust) || 'unverified', capturedAt: cleanText(provider.capturedAt),
  }));
  const attention = asArray(packet.attention).filter((item) => {
    const provider = providers.find((p) => p.name === item.source);
    return provider?.state === 'fresh' && provider.trust === 'verified';
  });
  const projects = records.filter((record) => record.kind === 'project').map((record) => {
    const children = outcomes.filter((outcome) => outcome.parentId === record.id);
    const focus = children.find((outcome) => outcomeIds.includes(outcome.id)) || children[0] || null;
    const next = attention.find((item) => item?.canonicalId === focus?.id || item?.canonicalId === record.id);
    return {
      id: record.id,
      title: cleanText(record.title) || record.id,
      lifecycle: cleanText(record.lifecycle) || 'unknown',
      outcome: cleanText(focus?.title) || cleanText(record.goal) || 'Outcome unavailable',
      definitionOfDone: cleanText(focus?.definitionOfDone) || cleanText(record.definitionOfDone),
      completionEvidence: [],
      nextStep: cleanText(next?.title),
      evidenceStatus: 'unavailable',
    };
  });

  return {
    status: 'ok',
    code: null,
    reason: null,
    coverage: 'partial',
    scope: { projectIds, outcomeIds, includeDescendants: scope.includeDescendants === true },
    capturedAt: cleanText(packet.capturedAt) || cleanText(result.capturedAt),
    expiresAt: cleanText(packet.expiresAt) || cleanText(result.expiresAt),
    projects,
    providers,
    generation: packet.canonical?.generation || null,
    truncated: packet.truncation?.truncated === true,
    omissions: [...asArray(packet.omissions).map(cleanText).filter(Boolean),
      ...(attention.length < asArray(packet.attention).length ? ['Next steps withheld because their supporting source is not fresh and verified.'] : [])],
  };
}

async function read(cfg, { contextReader } = {}) {
  const settings = cfg.projectsContext || {};
  try {
    const reader = contextReader || (settings.contextModule && require(settings.contextModule).readProjectsContext);
    if (typeof reader !== 'function') throw new Error('Projects display provider is not configured on this host');
    return normalizeProjectsResult(await reader({ profile: 'orientation' }));
  } catch (error) {
    return normalizeProjectsResult({
      status: 'unavailable',
      code: 'PROJECTS_PROVIDER_UNAVAILABLE',
      reason: 'The host-authorized Projects display provider is unavailable. Check the host provider and projectsContext.contextModule configuration (see README).',
    });
  }
}

module.exports = { read, normalizeProjectsResult };
