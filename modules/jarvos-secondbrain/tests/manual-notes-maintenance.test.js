'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  parseArgs,
  privateSafeSummary,
  processOnce,
} = require('../packages/jarvos-secondbrain-notes/src/manual-notes-maintenance');
const { collectViolations } = require('../packages/jarvos-secondbrain-notes/src/lint-frontmatter');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');
const { hashUtf8 } = require('../adapters/obsidian/src/vault-mutation-contract');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-manual-notes-'));
  const notesDir = path.join(root, 'Notes');
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  const statePath = path.join(knowledgeDir, 'manual-notes-maintenance-state.json');
  fs.mkdirSync(notesDir, { recursive: true });
  return { root, notesDir, knowledgeDir, statePath };
}

function writeNote(notesDir, name, body) {
  const filePath = path.join(notesDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function flagsFor({ notesDir, knowledgeDir, statePath, apply = false, sinceState = false }) {
  return parseArgs([
    'node',
    'manual-notes-maintenance.js',
    apply ? '--apply' : '--dry-run',
    '--notes-dir',
    notesDir,
    '--knowledge-dir',
    knowledgeDir,
    '--state',
    statePath,
    ...(sinceState ? ['--since-state'] : []),
  ]);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// This is the test double for the app-owned transport. It deliberately
// compares the latest bytes before applying, matching the real replace guard.
function appOwnedMutationExecutor({ filePath, expectedContent, nextContent }) {
  if (fs.readFileSync(filePath, 'utf8') !== expectedContent) return { status: 'conflict' };
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return { status: 'committed', obsidian: 'acknowledged' };
}

function applyOptions() {
  return { applyMarkdownMutation: appOwnedMutationExecutor };
}

function settled(value) {
  return { then(fn) { try { fn(value); return this; } catch (error) { this.error = error; return this; } }, catch(fn) { if (this.error) fn(this.error); return this; } };
}

function fakeObsidianEvaluator(initialContent) {
  const files = new Map([['Notes/Concurrent.md', { path: 'Notes/Concurrent.md', content: initialContent }]]);
  const vault = {
    getFileByPath: (target) => files.get(target) || null,
    create: (target, content) => { const file = { path: target, content }; files.set(target, file); return settled(file); },
    process: (file, transform) => { file.content = transform(file.content); return settled(file); },
    read: (file) => settled(file.content),
  };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context;
  return { files, evaluate(code) { const raw = vm.runInNewContext(code, context); return typeof raw === 'string' ? JSON.parse(raw) : raw; } };
}

test('manual maintenance apply fails closed without an Obsidian-owned Markdown executor', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  const filePath = writeNote(notesDir, 'No Executor.md', '# No Executor\n');
  const before = fs.readFileSync(filePath, 'utf8');
  assert.throws(() => processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true })), /Obsidian-owned Markdown mutation executor/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('frontmatter lint fixes only through its injected app-owned executor', () => {
  const { notesDir } = fixture();
  const filePath = writeNote(notesDir, 'Lint Me.md', '# Lint Me\n');
  assert.throws(() => collectViolations([filePath], { fix: true }), /Obsidian-owned Markdown mutation executor/);
  let received;
  const result = collectViolations([filePath], {
    fix: true,
    applyMarkdownMutation: (mutation) => {
      received = mutation;
      return appOwnedMutationExecutor(mutation);
    },
  });
  assert.equal(result.filesChanged, 1);
  assert.equal(received.expectedContent, '# Lint Me\n');
  assert.equal(received.source, 'notes.lint-frontmatter');
  assert.match(fs.readFileSync(filePath, 'utf8'), /^---\nstatus: active\n/m);
});

test('exact-hash replacement conflicts without overwriting a concurrent app edit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-maintenance-conflict-'));
  try {
    const fake = fakeObsidianEvaluator('mobile edit');
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-maintenance-conflict',
      source: 'test.manual-maintenance',
      adapterOptions: {
        ledgerPath: path.join(root, '.state', 'ledger.json'),
        probe: () => ({ state: 'available', vaultId: 'vault-maintenance-conflict' }),
        evaluate: fake.evaluate,
        maxPollAttempts: 2,
      },
    });
    const receipt = service.applyMarkdownMutation({
      filePath: path.join(root, 'Notes', 'Concurrent.md'),
      expectedContent: 'old disk content',
      nextContent: 'frontmatter repaired',
      source: 'notes.manual-maintenance.frontmatter',
    });
    assert.equal(receipt.status, 'conflict');
    assert.equal(fake.files.get('Notes/Concurrent.md').content, 'mobile edit');
    const operation = Object.values(service.adapter.ledger.read().operations)[0].operation;
    assert.equal(operation.expectedContent, 'old disk content');
    assert.equal(operation.expectedHash, hashUtf8('old disk content'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a fresh identical replacement is not hidden by an older acknowledged intent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-maintenance-repeat-'));
  try {
    const fake = fakeObsidianEvaluator('old');
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-maintenance-repeat',
      source: 'test.manual-maintenance.repeat',
      adapterOptions: {
        ledgerPath: path.join(root, '.state', 'ledger.json'),
        probe: () => ({ state: 'available', vaultId: 'vault-maintenance-repeat' }),
        evaluate: fake.evaluate,
        maxPollAttempts: 2,
      },
    });
    const mutation = {
      filePath: path.join(root, 'Notes', 'Concurrent.md'),
      expectedContent: 'old',
      nextContent: 'new',
      source: 'notes.manual-maintenance.frontmatter',
    };
    assert.equal(service.applyMarkdownMutation(mutation).status, 'committed');
    fake.files.get('Notes/Concurrent.md').content = 'old';
    assert.equal(service.applyMarkdownMutation(mutation).status, 'committed');
    assert.equal(Object.keys(service.adapter.ledger.read().operations).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual notes dry-run reports stack decisions without writing artifacts or source notes', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  const filePath = writeNote(
    notesDir,
    'Manual Insight.md',
    '# Manual Insight\n\nManually captured ideas should join the secondbrain stack after review.',
  );
  const before = fs.readFileSync(filePath, 'utf8');

  const report = processOnce(flagsFor({ notesDir, knowledgeDir, statePath }));
  const summary = privateSafeSummary(report);

  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.scanned, 1);
  assert.equal(report.candidates, 1);
  assert.equal(report.frontmatter.filesWithViolations, 1);
  assert.equal(report.optimization.auditOnly, 1);
  assert.equal(report.optimization.gbrainQueued, 1);
  assert.equal(report.optimization.memoryWikiQueued, 1);
  assert.equal(report.optimization.qmdPending, 1);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.existsSync(knowledgeDir), false);
  assert.equal(summary.gates.applyAllowed, true);
  assert.equal(summary.gates.qmdRefreshRequired, true);
  assert.equal(summary.cohorts.auditMissing, 1);
});

test('maintenance source has no direct Markdown overwrite branch', () => {
  const notesRoot = path.join(__dirname, '..', 'packages', 'jarvos-secondbrain-notes', 'src');
  const lintSource = fs.readFileSync(path.join(notesRoot, 'lint-frontmatter.js'), 'utf8');
  const maintenanceSource = fs.readFileSync(path.join(notesRoot, 'manual-notes-maintenance.js'), 'utf8');
  assert.doesNotMatch(lintSource, /fs\.writeFileSync\(/);
  assert.doesNotMatch(maintenanceSource, /fs\.writeFileSync\(filePath,\s*frontmatterFix\.updatedText/);
  assert.match(maintenanceSource, /applyMarkdownMutation\(\{/);
});

test('manual notes apply preserves body content and writes sidecars, queues, qmd, and state', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  const body = '# Manual Insight\n\nManually captured ideas should join the secondbrain stack after review.';
  const filePath = writeNote(notesDir, 'Manual Insight.md', body);

  const report = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true }), applyOptions());
  const updated = fs.readFileSync(filePath, 'utf8');
  const qmd = readJson(path.join(knowledgeDir, 'qmd-refresh-pending.json'));
  const gbrain = readJson(path.join(knowledgeDir, 'gbrain-import-queue.json'));
  const memoryWiki = readJson(path.join(knowledgeDir, 'memory-wiki-queue.json'));
  const audit = readJson(path.join(knowledgeDir, 'optimization-audit.json'));
  const state = readJson(statePath);

  assert.equal(report.ok, true);
  assert.equal(report.applied, true);
  assert.equal(report.frontmatter.filesChanged, 1);
  assert.match(updated, /^---\nstatus: active\n/m);
  assert.match(updated, /\n---\n\n# Manual Insight\n\nManually captured ideas should join/m);
  assert.equal(qmd.entries['Notes/Manual Insight.md'].status, 'pending-refresh');
  assert.equal(gbrain.entries['Notes/Manual Insight.md'].status, 'queued');
  assert.equal(memoryWiki.entries['Notes/Manual Insight.md'].status, 'queued');
  assert.equal(audit.entries['Notes/Manual Insight.md'].statuses.qmd, 'pending-refresh');
  assert.equal(state.files['Notes/Manual Insight.md'].auditCovered, true);
});

test('manual notes apply keeps sensitive artifacts local and clears automatic queues', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  writeNote(
    notesDir,
    'Private Strategy.md',
    [
      '---',
      'status: active',
      'type: reference',
      'project: ""',
      'created: 2026-06-22',
      'updated: 2026-06-22',
      'author: andrew',
      'private: true',
      '---',
      '',
      '# Private Strategy',
      '',
      'This private operating note should remain out of automatic queues.',
    ].join('\n'),
  );

  const report = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true }), applyOptions());
  const qmd = readJson(path.join(knowledgeDir, 'qmd-refresh-pending.json'));
  const audit = readJson(path.join(knowledgeDir, 'optimization-audit.json'));
  const gbrainPath = path.join(knowledgeDir, 'gbrain-import-queue.json');
  const memoryWikiPath = path.join(knowledgeDir, 'memory-wiki-queue.json');
  const summary = privateSafeSummary(report);

  assert.equal(report.optimization.sensitiveSkipped, 1);
  assert.equal(report.optimization.gbrainQueued, 0);
  assert.equal(report.optimization.memoryWikiQueued, 0);
  assert.equal(qmd.entries['Notes/Private Strategy.md'].status, 'pending-refresh');
  assert.equal(audit.entries['Notes/Private Strategy.md'].sensitivity.excluded, true);
  assert.equal(readJson(gbrainPath).entries['Notes/Private Strategy.md'], undefined);
  assert.equal(readJson(memoryWikiPath).entries['Notes/Private Strategy.md'], undefined);
  assert.equal(summary.gates.sensitiveNotesExcludedFromAutomaticQueues, true);
});

test('manual notes apply parks unfixable frontmatter without optimizer side effects', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  const original = [
    '---',
    'status: not-a-real-status',
    'project: ""',
    'created: 2026-06-22',
    'updated: 2026-06-22',
    'author: andrew',
    '---',
    '',
    '# Unsafe Metadata',
    '',
    'This note should be parked until a human fixes its frontmatter.',
  ].join('\n');
  const filePath = writeNote(notesDir, 'Unsafe Metadata.md', original);

  const report = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true }), applyOptions());
  const summary = privateSafeSummary(report);
  const state = readJson(statePath);

  assert.equal(report.ok, true);
  assert.equal(report.frontmatter.filesWithViolations, 1);
  assert.equal(report.frontmatter.filesChanged, 0);
  assert.equal(report.frontmatter.filesSkippedUnfixable, 1);
  assert.equal(report.optimization.artifactsWritten, 0);
  assert.equal(report.optimization.gbrainQueued, 0);
  assert.equal(report.optimization.memoryWikiQueued, 0);
  assert.equal(report.optimization.qmdPending, 0);
  assert.equal(report.files[0].optimized, false);
  assert.match(report.files[0].optimizedSkippedReason, /parked for review/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.equal(state.files['Notes/Unsafe Metadata.md'].auditCovered, false);
  assert.equal(state.files['Notes/Unsafe Metadata.md'].frontmatterViolations, 2);
  assert.equal(summary.gates.applyAllowed, false);
  assert.equal(summary.cohorts.frontmatterUnfixable, 1);
  assert.equal(fs.existsSync(path.join(knowledgeDir, 'artifacts')), false);
  assert.equal(fs.existsSync(path.join(knowledgeDir, 'qmd-refresh-pending.json')), false);
  assert.equal(fs.existsSync(path.join(knowledgeDir, 'gbrain-import-queue.json')), false);
  assert.equal(fs.existsSync(path.join(knowledgeDir, 'memory-wiki-queue.json')), false);
});

test('manual notes apply clears stale automatic queues when parking unsafe notes', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  const filePath = writeNote(
    notesDir,
    'Queued Then Parked.md',
    '# Queued Then Parked\n\nThis note starts safe, then becomes unsafe for automatic promotion.',
  );

  const firstReport = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true }), applyOptions());
  const firstUpdated = fs.readFileSync(filePath, 'utf8');
  assert.equal(firstReport.ok, true);
  assert.equal(readJson(path.join(knowledgeDir, 'gbrain-import-queue.json')).entries['Notes/Queued Then Parked.md'].status, 'queued');
  assert.equal(readJson(path.join(knowledgeDir, 'memory-wiki-queue.json')).entries['Notes/Queued Then Parked.md'].status, 'queued');

  const parked = firstUpdated
    .replace('status: active\n', 'status: unreviewed\n')
    .replace('author: andrew\n', 'author: andrew\nprivate: true\n');
  fs.writeFileSync(filePath, parked, 'utf8');

  const secondReport = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true, sinceState: true }), applyOptions());
  const gbrain = readJson(path.join(knowledgeDir, 'gbrain-import-queue.json'));
  const memoryWiki = readJson(path.join(knowledgeDir, 'memory-wiki-queue.json'));
  const state = readJson(statePath);

  assert.equal(secondReport.ok, true);
  assert.equal(secondReport.candidates, 1);
  assert.equal(secondReport.frontmatter.filesSkippedUnfixable, 1);
  assert.equal(secondReport.optimization.gbrainQueued, 0);
  assert.equal(secondReport.optimization.memoryWikiQueued, 0);
  assert.equal(gbrain.entries['Notes/Queued Then Parked.md'], undefined);
  assert.equal(memoryWiki.entries['Notes/Queued Then Parked.md'], undefined);
  assert.equal(state.files['Notes/Queued Then Parked.md'].frontmatterViolations, 1);
});

test('manual notes since-state reprocesses privacy flips and clears automatic queues', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  const filePath = writeNote(
    notesDir,
    'Public Then Private.md',
    '# Public Then Private\n\nThis note should leave automatic queues after a privacy flip.',
  );

  const firstReport = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true }), applyOptions());
  const firstUpdated = fs.readFileSync(filePath, 'utf8');
  assert.equal(firstReport.ok, true);
  assert.equal(readJson(path.join(knowledgeDir, 'gbrain-import-queue.json')).entries['Notes/Public Then Private.md'].status, 'queued');
  assert.equal(readJson(path.join(knowledgeDir, 'memory-wiki-queue.json')).entries['Notes/Public Then Private.md'].status, 'queued');

  const privatized = firstUpdated.replace('author: andrew\n', 'author: andrew\nprivate: true\n');
  fs.writeFileSync(filePath, privatized, 'utf8');

  const secondReport = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true, sinceState: true }), applyOptions());
  const audit = readJson(path.join(knowledgeDir, 'optimization-audit.json'));
  const qmd = readJson(path.join(knowledgeDir, 'qmd-refresh-pending.json'));
  const gbrain = readJson(path.join(knowledgeDir, 'gbrain-import-queue.json'));
  const memoryWiki = readJson(path.join(knowledgeDir, 'memory-wiki-queue.json'));

  assert.equal(secondReport.ok, true);
  assert.equal(secondReport.candidates, 1);
  assert.equal(secondReport.skippedUnchanged, 0);
  assert.equal(secondReport.optimization.sensitiveSkipped, 1);
  assert.equal(secondReport.optimization.gbrainQueued, 0);
  assert.equal(secondReport.optimization.memoryWikiQueued, 0);
  assert.equal(gbrain.entries['Notes/Public Then Private.md'], undefined);
  assert.equal(memoryWiki.entries['Notes/Public Then Private.md'], undefined);
  assert.equal(qmd.entries['Notes/Public Then Private.md'].status, 'pending-refresh');
  assert.equal(audit.entries['Notes/Public Then Private.md'].sensitivity.excluded, true);
  assert.match(fs.readFileSync(filePath, 'utf8'), /\nprivate: true\n/);
});

test('manual notes since-state skips unchanged notes after apply coverage exists', () => {
  const { notesDir, knowledgeDir, statePath } = fixture();
  writeNote(
    notesDir,
    'Manual Insight.md',
    '# Manual Insight\n\nManually captured ideas should join the secondbrain stack after review.',
  );

  const applyReport = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, apply: true }), applyOptions());
  const dryRunReport = processOnce(flagsFor({ notesDir, knowledgeDir, statePath, sinceState: true }));

  assert.equal(applyReport.ok, true);
  assert.equal(dryRunReport.ok, true);
  assert.equal(dryRunReport.scanned, 1);
  assert.equal(dryRunReport.candidates, 0);
  assert.equal(dryRunReport.skippedUnchanged, 1);
});
