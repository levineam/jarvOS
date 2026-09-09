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
  const attention = asArray(packet.attention);
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
    omissions: asArray(packet.omissions).map(cleanText).filter(Boolean),
  };
}

async function read(cfg, { adapterFactory, configLoader } = {}) {
  const settings = cfg.projectsContext || {};
  try {
    const adapterModule = require(settings.adapterModule);
    const makeAdapter = adapterFactory || adapterModule.createProjectsContextAdapter;
    const loadConfig = configLoader || adapterModule.loadProjectsContextConfig;
    if (typeof makeAdapter !== 'function' || typeof loadConfig !== 'function') throw new Error('Projects adapter contract is unavailable');
    const hostConfig = loadConfig({ filePath: settings.configFile });
    return normalizeProjectsResult(await makeAdapter({ config: hostConfig }).read({ includeRendered: false }));
  } catch (error) {
    return normalizeProjectsResult({
      status: 'unavailable',
      code: 'PROJECTS_PROVIDER_UNAVAILABLE',
      reason: error?.message || 'Projects provider failed',
    });
  }
}

module.exports = { read, normalizeProjectsResult };
