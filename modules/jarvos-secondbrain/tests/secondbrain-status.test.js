'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSecondbrainStatus,
  renderSecondbrainStatus,
  resolveSecondbrainStatusOptions,
} = require('../bridge/synthesis');
const {
  DEFAULT_WIKI_DIR_NAME,
} = require('../packages/jarvos-secondbrain-wiki/src');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

test('secondbrain status reports healthy generated wiki and eval state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-status-'));
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  const wikiDir = path.join(root, 'Generated Wiki');
  const evalReportPath = path.join(root, 'retrieval-eval.json');

  writeJson(path.join(knowledgeDir, 'artifacts', 'one.json'), { title: 'One' });
  writeJson(path.join(knowledgeDir, 'optimization-audit.json'), {
    entries: {
      one: { sensitivity: { excluded: true } },
      two: { sensitivity: { excluded: false } },
    },
  });
  writeJson(path.join(knowledgeDir, 'qmd-refresh-pending.json'), { entries: {} });
  writeJson(path.join(knowledgeDir, 'gbrain-import-queue.json'), { entries: { one: {} } });
  writeJson(path.join(knowledgeDir, 'memory-wiki-queue.json'), { entries: { one: {} } });
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'index.md'), '# Generated Wiki\n', 'utf8');
  fs.mkdirSync(path.join(wikiDir, 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'concepts', 'one.md'), '# One\n', 'utf8');
  writeJson(evalReportPath, {
    results: [{
      adapters: [
        { adapter: 'qmd-only', passed: true },
        { adapter: 'qmd-plus-llm-wiki', passed: true },
      ],
    }],
  });

  const status = buildSecondbrainStatus({ knowledgeDir, wikiDir, evalReportPath });
  const text = renderSecondbrainStatus(status);

  assert.equal(status.ok, true);
  assert.equal(status.counts.artifacts, 1);
  assert.equal(status.counts.sensitiveSkipped, 1);
  assert.equal(status.generatedWiki.status, 'built');
  assert.equal(status.retrievalEval.status, 'passing');
  assert.match(text, /Secondbrain status: OK/);
  assert.match(text, /Skipped private\/sensitive: 1/);
});

test('secondbrain status fails closed on stale qmd missing wiki and missing evals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-status-stale-'));
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');

  writeJson(path.join(knowledgeDir, 'qmd-refresh-pending.json'), {
    entries: {
      'Notes/Stale.md': { status: 'pending-refresh' },
    },
  });

  const status = buildSecondbrainStatus({ knowledgeDir });
  const text = renderSecondbrainStatus(status);

  assert.equal(status.ok, false);
  assert.deepEqual(status.failures, [
    'qmd-refresh-pending',
    'generated-wiki-missing',
    'retrieval-eval-missing',
  ]);
  assert.match(text, /NEEDS ATTENTION/);
  assert.match(text, /Failures\/stale signals: qmd-refresh-pending, generated-wiki-missing, retrieval-eval-missing/);
});

test('secondbrain status reports empty generated wiki and failing retrieval evals', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-status-failing-eval-'));
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  const wikiDir = path.join(root, 'Generated Wiki');
  const evalReportPath = path.join(root, 'retrieval-eval.json');

  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, 'index.md'), '# Empty Generated Wiki\n', 'utf8');
  writeJson(evalReportPath, {
    results: [{
      adapters: [
        { adapter: 'qmd-only', passed: true },
        { adapter: 'qmd-plus-llm-wiki', passed: false },
      ],
    }],
  });

  const status = buildSecondbrainStatus({ knowledgeDir, wikiDir, evalReportPath });

  assert.equal(status.ok, false);
  assert.deepEqual(status.failures, [
    'generated-wiki-empty',
    'retrieval-eval-failing',
  ]);
  assert.equal(status.generatedWiki.status, 'empty');
  assert.equal(status.retrievalEval.status, 'failing');
});

test('secondbrain status resolves generated wiki path from configured vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-status-config-'));
  const vaultDir = path.join(root, 'Vault');
  const configPath = path.join(root, 'jarvos.config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    paths: {
      vault: vaultDir,
    },
  }));

  const options = resolveSecondbrainStatusOptions({
    configPath,
    homeDir: root,
    env: {},
  });

  assert.equal(options.knowledgeDir, path.join(vaultDir, '.jarvos', 'knowledge'));
  assert.equal(options.wikiDir, path.join(vaultDir, DEFAULT_WIKI_DIR_NAME));
  assert.equal(options.evalReportPath, path.join(vaultDir, '.jarvos', 'knowledge', 'retrieval-eval-report.json'));
});

test('secondbrain status expands tilde path overrides', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-status-home-'));
  const options = resolveSecondbrainStatusOptions({
    homeDir: home,
    env: {
      JARVOS_VAULT_DIR: '~/Vault',
      JARVOS_KNOWLEDGE_DIR: '~/Vault/.jarvos/knowledge',
      JARVOS_GENERATED_WIKI_DIR: '~/Vault/Wiki',
      JARVOS_RETRIEVAL_EVAL_REPORT: '~/Vault/.jarvos/knowledge/eval.json',
    },
  });

  assert.equal(options.knowledgeDir, path.join(home, 'Vault', '.jarvos', 'knowledge'));
  assert.equal(options.wikiDir, path.join(home, 'Vault', 'Wiki'));
  assert.equal(options.evalReportPath, path.join(home, 'Vault', '.jarvos', 'knowledge', 'eval.json'));
});
