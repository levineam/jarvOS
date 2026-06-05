'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { processOnce } = require('../packages/jarvos-secondbrain-notes/src/manual-notes-maintenance');

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-manual-notes-'));
  const notesDir = path.join(root, 'Notes');
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  const statePath = path.join(knowledgeDir, 'manual-notes-maintenance-state.json');
  fs.mkdirSync(notesDir, { recursive: true });
  return { root, notesDir, knowledgeDir, statePath };
}

function runFlags(overrides) {
  return {
    apply: false,
    dryRun: true,
    notesDir: overrides.notesDir,
    knowledgeDir: overrides.knowledgeDir,
    statePath: overrides.statePath,
    sinceState: false,
    updateState: false,
    limit: 0,
    onlyPath: null,
    json: true,
    watch: false,
    intervalSec: 300,
    maxRuns: 0,
    ...overrides,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('dry-run audits manual notes without writing frontmatter or artifacts', () => {
  const { root, notesDir, knowledgeDir, statePath } = makeTempVault();
  try {
    const notePath = path.join(notesDir, 'Manual Idea.md');
    fs.writeFileSync(notePath, '# Manual Idea\n\nA useful portable pattern belongs in the stack.\n', 'utf8');

    const before = fs.readFileSync(notePath, 'utf8');
    const report = processOnce(runFlags({ notesDir, knowledgeDir, statePath }));

    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.scanned, 1);
    assert.equal(report.candidates, 1);
    assert.equal(report.frontmatter.filesWithViolations, 1);
    assert.equal(report.optimization.auditOnly, 1);
    assert.equal(fs.readFileSync(notePath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(knowledgeDir, 'optimization-audit.json')), false);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply normalizes frontmatter and writes optimizer artifacts plus QMD pending record', () => {
  const { root, notesDir, knowledgeDir, statePath } = makeTempVault();
  try {
    const notePath = path.join(notesDir, 'Manual Idea.md');
    fs.writeFileSync(notePath, '# Manual Idea\n\nA useful portable pattern belongs in the stack.\n', 'utf8');

    const report = processOnce(runFlags({
      apply: true,
      dryRun: false,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    assert.equal(report.ok, true);
    assert.equal(report.frontmatter.filesChanged, 1);
    assert.equal(report.optimization.artifactsWritten, 1);
    assert.equal(report.optimization.gbrainQueued, 1);
    assert.equal(report.optimization.memoryWikiQueued, 1);
    assert.equal(report.optimization.qmdPending, 1);

    const updated = fs.readFileSync(notePath, 'utf8');
    assert.match(updated, /^---\nstatus: active\n/m);
    assert.match(updated, /author: andrew\n---\n\n# Manual Idea/m);

    const audit = readJson(path.join(knowledgeDir, 'optimization-audit.json'));
    assert.equal(audit.counts.optimized, 1);
    assert.ok(audit.entries['Notes/Manual Idea.md']);

    const qmdPending = readJson(path.join(knowledgeDir, 'qmd-refresh-pending.json'));
    assert.equal(qmdPending.entries['Notes/Manual Idea.md'].status, 'pending-refresh');

    const state = readJson(statePath);
    assert.equal(state.files['Notes/Manual Idea.md'].auditCovered, true);
    assert.ok(state.files['Notes/Manual Idea.md'].contentSha256);
    assert.equal(state.files['Notes/Manual Idea.md'].frontmatterViolations, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply preserves sensitive-note local artifacts but skips automatic graph queues', () => {
  const { root, notesDir, knowledgeDir, statePath } = makeTempVault();
  try {
    const notePath = path.join(notesDir, 'Private Note.md');
    fs.writeFileSync(notePath, [
      '---',
      'status: active',
      'type: reference',
      'project: ""',
      'created: 2026-06-05',
      'updated: 2026-06-05',
      'author: andrew',
      'private: true',
      '---',
      '',
      '# Private Note',
      '',
      'Sensitive local-only material.',
      '',
    ].join('\n'), 'utf8');

    const report = processOnce(runFlags({
      apply: true,
      dryRun: false,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    assert.equal(report.ok, true);
    assert.equal(report.optimization.artifactsWritten, 1);
    assert.equal(report.optimization.sensitiveSkipped, 1);
    assert.equal(report.optimization.gbrainQueued, 0);
    assert.equal(report.optimization.memoryWikiQueued, 0);

    const audit = readJson(path.join(knowledgeDir, 'optimization-audit.json'));
    assert.equal(audit.entries['Notes/Private Note.md'].statuses.gbrain, 'skipped');
    assert.deepEqual(readJson(path.join(knowledgeDir, 'gbrain-import-queue.json')).entries, {});
    assert.deepEqual(readJson(path.join(knowledgeDir, 'memory-wiki-queue.json')).entries, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('since-state catches frontmatter-only privacy changes and cleans queues', () => {
  const { root, notesDir, knowledgeDir, statePath } = makeTempVault();
  try {
    const notePath = path.join(notesDir, 'Manual Idea.md');
    fs.writeFileSync(notePath, '# Manual Idea\n\nA useful portable pattern belongs in the stack.\n', 'utf8');

    processOnce(runFlags({
      apply: true,
      dryRun: false,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    const withPrivateFlag = fs.readFileSync(notePath, 'utf8').replace(
      'author: andrew\n---',
      'author: andrew\nprivate: true\n---',
    );
    fs.writeFileSync(notePath, withPrivateFlag, 'utf8');

    const report = processOnce(runFlags({
      apply: true,
      dryRun: false,
      sinceState: true,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    assert.equal(report.ok, true);
    assert.equal(report.candidates, 1);
    assert.equal(report.optimization.sensitiveSkipped, 1);
    assert.equal(report.optimization.gbrainQueued, 0);
    assert.equal(report.optimization.memoryWikiQueued, 0);
    assert.deepEqual(readJson(path.join(knowledgeDir, 'gbrain-import-queue.json')).entries, {});
    assert.deepEqual(readJson(path.join(knowledgeDir, 'memory-wiki-queue.json')).entries, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('since-state still processes stale audit coverage after dry-run state updates', () => {
  const { root, notesDir, knowledgeDir, statePath } = makeTempVault();
  try {
    const notePath = path.join(notesDir, 'Manual Idea.md');
    fs.writeFileSync(notePath, '# Manual Idea\n\nA useful portable pattern belongs in the stack.\n', 'utf8');

    processOnce(runFlags({
      apply: true,
      dryRun: false,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    fs.appendFileSync(notePath, '\nNew body material that has not been optimized yet.\n', 'utf8');

    const dryRunUpdate = processOnce(runFlags({
      updateState: true,
      sinceState: true,
      notesDir,
      knowledgeDir,
      statePath,
    }));
    assert.equal(dryRunUpdate.candidates, 1);

    const report = processOnce(runFlags({
      sinceState: true,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    assert.equal(report.candidates, 1);
    assert.equal(report.files[0].auditCovered, false);
    assert.equal(report.optimization.auditOnly, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply avoids partial rewrite when unfixable frontmatter drift exists', () => {
  const { root, notesDir, knowledgeDir, statePath } = makeTempVault();
  try {
    const notePath = path.join(notesDir, 'Partial Drift.md');
    fs.writeFileSync(notePath, [
      '---',
      'status: active',
      'type: portfolio',
      'created: 2026-06-05',
      'updated: 2026-06-05',
      'author: michael',
      '---',
      '',
      '# Partial Drift',
      '',
      'Useful but not safe for partial frontmatter normalization.',
      '',
    ].join('\n'), 'utf8');
    const before = fs.readFileSync(notePath, 'utf8');

    const report = processOnce(runFlags({
      apply: true,
      dryRun: false,
      notesDir,
      knowledgeDir,
      statePath,
    }));

    assert.equal(report.ok, true);
    assert.equal(report.frontmatter.filesChanged, 0);
    assert.equal(report.frontmatter.filesSkippedUnfixable, 1);
    assert.equal(fs.readFileSync(notePath, 'utf8'), before);
    assert.equal(report.optimization.artifactsWritten, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
