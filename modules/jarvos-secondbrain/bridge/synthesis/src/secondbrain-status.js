'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandTilde, resolveConfig } = require('../../config');
const { DEFAULT_WIKI_DIR_NAME } = require('../../../packages/jarvos-secondbrain-wiki/src');

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

function asAbsolutePath(value, { baseDir = process.cwd(), homeDir = process.env.HOME } = {}) {
  if (!value) return value;
  const expanded = expandTilde(String(value), homeDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function resolveSecondbrainStatusOptions(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || env.HOME || os.homedir();
  const config = resolveConfig({
    configPath: options.configPath,
    env,
    homeDir,
    workspaceRoot: options.workspaceRoot,
  });
  const vaultDir = asAbsolutePath(
    options.vaultDir
    || env.JARVOS_VAULT_DIR
    || config.paths.vault,
    { homeDir },
  );
  const knowledgeDir = asAbsolutePath(
    options.knowledgeDir
    || env.JARVOS_KNOWLEDGE_DIR
    || path.join(vaultDir, '.jarvos', 'knowledge'),
    { homeDir },
  );
  const wikiDir = asAbsolutePath(
    options.wikiDir
    || env.JARVOS_GENERATED_WIKI_DIR
    || path.join(vaultDir, DEFAULT_WIKI_DIR_NAME),
    { homeDir },
  );
  const evalReportPath = asAbsolutePath(
    options.evalReportPath
    || env.JARVOS_RETRIEVAL_EVAL_REPORT
    || path.join(knowledgeDir, 'retrieval-eval-report.json'),
    { homeDir },
  );
  return { knowledgeDir, wikiDir, evalReportPath };
}

function buildSecondbrainStatus({
  knowledgeDir,
  wikiDir = null,
  evalReportPath = null,
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
    ok: failures.length === 0,
    failures,
  };
}

function renderSecondbrainStatus(status) {
  const lines = [
    `Secondbrain status: ${status.ok ? 'OK' : 'NEEDS ATTENTION'}`,
    `Artifacts: ${status.counts.artifacts}`,
    `Skipped private/sensitive: ${status.counts.sensitiveSkipped}`,
    `QMD pending refresh: ${status.counts.qmdPending}`,
    `GBrain queued: ${status.counts.gbrainQueued}`,
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
  resolveSecondbrainStatusOptions,
};
