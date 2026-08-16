'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { DECLARATION_VERSION, lintAdapter, validateDeclaration } = require('../scripts/operator-notification-lint.js');
const { lintOperatorMessage, lintOperatorMessages } = require('../src');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'modules/jarvos-runtime-kit/scripts/operator-notification-lint.js');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'operator-notification-messages.json'), 'utf8'));

test('all public runtime adapters explicitly declare local delivery as unconfigured', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--root=' + ROOT, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.results.map((item) => item.id).sort(), ['claude', 'codex', 'hermes', 'openclaw']);
});

test('the declaration rejects missing fields, delivery claims, and unknown fields', () => {
  const valid = {
    version: DECLARATION_VERSION,
    contract: 'jarvos-operator-notification/v1',
    delivery: { status: 'not-configured', reason: 'Local owner configuration chooses a delivery surface; this public adapter does not configure one.' },
  };
  assert.equal(validateDeclaration(valid, 'codex').ok, true);
  for (const invalid of [
    {},
    { ...valid, extra: true },
    { ...valid, delivery: { ...valid.delivery, status: 'configured' } },
    { ...valid, delivery: { ...valid.delivery, reason: 'Send Telegram directly from this adapter.' } },
  ]) assert.equal(validateDeclaration(invalid, 'codex').ok, false);
});

test('lint reports an invalid adapter without changing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-operator-notification-lint-'));
  try {
    const file = path.join(root, 'adapter.json');
    fs.writeFileSync(file, JSON.stringify({ id: 'codex' }));
    const before = fs.readFileSync(file, 'utf8');
    const result = lintAdapter(file);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /declaration is required/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outbound message lint accepts concise reviewed action and no-action messages', () => {
  assert.equal(typeof lintOperatorMessage, 'function');
  assert.equal(typeof lintOperatorMessages, 'function');
  for (const message of [
    'jarvOS completed a safe repair. No action is needed from you.',
    'jarvOS preserved the existing state. Action required: Choose how jarvOS should proceed. Next: jarvOS will continue monitoring safely.',
  ]) assert.equal(lintOperatorMessage(message).ok, true);
});

test('outbound message lint rejects internal diagnostics and ambiguous attention wording', () => {
  for (const { message, code } of FIXTURES.unsafe) assert.equal(lintOperatorMessage(message).errors.some((error) => error.code === code), true, message);
});

test('outbound message lint preserves release lanes and freshness claims', () => {
  assert.equal(lintOperatorMessage(FIXTURES.approvedRelease).ok, true);
  assert.equal(lintOperatorMessage('jarvOS is published and future work is ready for review.').errors.some((error) => error.code === 'release-lanes-conflated'), true);
  assert.equal(lintOperatorMessage('The future milestone failed to publish.').errors.some((error) => error.code === 'future-publication-failure'), true);
  for (const freshness of ['stale', 'unknown']) assert.equal(lintOperatorMessage({ message: 'jarvOS is currently published and ready for Andrew\'s review.', freshness }).errors.some((error) => error.code === 'stale-release-claim'), true);
});

test('batch message lint keeps failures indexed', () => {
  const result = lintOperatorMessages(['jarvOS completed a safe repair. No action is needed from you.', 'jarvOS needs input.']);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].index, 1);
  assert.equal(result.errors[0].code, 'ambiguous-attention');
});
