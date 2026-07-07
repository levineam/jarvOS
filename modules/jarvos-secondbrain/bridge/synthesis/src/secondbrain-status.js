'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function countEntries(filePath) {
  const data = readJson(filePath, { entries: {} });
  return Object.keys(data.entries || {}).length;
}

function countArtifactFiles(knowledgeDir) {
  const artifactsDir = path.join(knowledgeDir, 'artifacts');
  try {
    return fs.readdirSync(artifactsDir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function countSensitiveSkips(knowledgeDir) {
  const audit = readJson(path.join(knowledgeDir, 'optimization-audit.json'), { entries: {} });
  return Object.values(audit.entries || {})
    .filter((entry) => entry.sensitivity?.excluded)
    .length;
}

function wikiStatus(wikiDir) {
  if (!wikiDir || !fs.existsSync(wikiDir)) {
    return { status: 'missing', pages: 0, contentPages: 0 };
  }
  let pages = 0;
  let contentPages = 0;
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(filePath);
      if (entry.isFile() && entry.name.endsWith('.md')) {
        pages += 1;
        if (path.relative(wikiDir, filePath).replace(/\\/g, '/') !== 'index.md') {
          contentPages += 1;
        }
      }
    }
  }
  walk(wikiDir);
  return { status: contentPages > 0 ? 'built' : 'empty', pages, contentPages };
}

function evalStatus(evalReportPath) {
  const report = evalReportPath ? readJson(evalReportPath) : null;
  if (!report) return { status: 'missing', passed: 0, total: 0 };
  const adapters = (report.results || []).flatMap((result) => result.adapters || []);
  const total = adapters.length;
  const passed = adapters.filter((adapter) => adapter.passed).length;
  return {
    status: total > 0 && passed === total ? 'passing' : 'failing',
    passed,
    total,
  };
}

function buildSecondbrainStatus({
  knowledgeDir,
  wikiDir = null,
  evalReportPath = null,
  gbrainProvider = null,
} = {}) {
  if (!knowledgeDir) throw new Error('knowledgeDir is required');

  const artifactCount = countArtifactFiles(knowledgeDir);
  const qmdPending = countEntries(path.join(knowledgeDir, 'qmd-refresh-pending.json'));
  const gbrainQueued = countEntries(path.join(knowledgeDir, 'gbrain-import-queue.json'));
  const memoryWikiQueued = countEntries(path.join(knowledgeDir, 'memory-wiki-queue.json'));
  const sensitiveSkipped = countSensitiveSkips(knowledgeDir);
  const generatedWiki = wikiStatus(wikiDir);
  const retrievalEval = evalStatus(evalReportPath);
  const failures = [];

  if (qmdPending > 0) failures.push('qmd-refresh-pending');
  if (generatedWiki.status !== 'built') failures.push(`generated-wiki-${generatedWiki.status}`);
  if (retrievalEval.status !== 'passing') failures.push(`retrieval-eval-${retrievalEval.status}`);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      artifacts: artifactCount,
      sensitiveSkipped,
      qmdPending,
      gbrainQueued,
      memoryWikiQueued,
    },
    generatedWiki,
    retrievalEval,
    gbrainProvider: normalizeGbrainProviderStatus(gbrainProvider),
    ok: failures.length === 0,
    failures,
  };
}

function normalizeGbrainProviderStatus(provider) {
  if (!provider) {
    return {
      status: 'unknown',
      version: null,
      advisor: 'unknown',
      runtimeConnections: {},
    };
  }

  return {
    status: provider.status || 'unknown',
    version: provider.version || provider.installedVersion || null,
    minimumVersion: provider.minimumVersion || null,
    advisor: provider.advisor || provider.advisorStatus || 'unknown',
    runtimeConnections: provider.runtimeConnections || {},
  };
}

function renderSecondbrainStatus(status) {
  const lines = [
    `Secondbrain status: ${status.ok ? 'OK' : 'NEEDS ATTENTION'}`,
    `Artifacts: ${status.counts.artifacts}`,
    `Skipped private/sensitive: ${status.counts.sensitiveSkipped}`,
    `QMD pending refresh: ${status.counts.qmdPending}`,
    `GBrain queued: ${status.counts.gbrainQueued}`,
    `GBrain provider: ${status.gbrainProvider.status}${status.gbrainProvider.version ? ` (${status.gbrainProvider.version})` : ''}`,
    `GBrain advisor: ${status.gbrainProvider.advisor}`,
    `Memory-wiki queued: ${status.counts.memoryWikiQueued}`,
    `Generated wiki: ${status.generatedWiki.status} (${status.generatedWiki.pages} pages)`,
    `Retrieval evals: ${status.retrievalEval.status} (${status.retrievalEval.passed}/${status.retrievalEval.total})`,
  ];
  if (status.failures.length > 0) {
    lines.push(`Failures/stale signals: ${status.failures.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildSecondbrainStatus,
  renderSecondbrainStatus,
};
