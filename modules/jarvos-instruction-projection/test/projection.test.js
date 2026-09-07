'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  normalizeDeclaredTargets,
  planInstructionProjection,
  summarizeProjectionPlan,
  applyInstructionProjection,
  disableInstructionProjection,
  FAULT_STAGES,
  DISABLE_FAULT_STAGES,
} = require('../src/projection');
const { serializeLocalReceipt, normalizeLocalReceipt, receiptRelativePath, LOCAL_RECEIPT_SCHEMA_VERSION } = require('../src/receipts');

function digestOf(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const DIGEST_A = digestOf('a');
const DIGEST_B = digestOf('b');
const DIGEST_C = digestOf('c');

function makeTarget(overrides = {}) {
  const content = overrides.content !== undefined ? overrides.content : 'hello world';
  const contentBuffer = Buffer.isBuffer(content)
    ? content
    : typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.alloc(0);
  return {
    id: 'alpha',
    harness: 'claude',
    relativeTarget: 'foo/bar.md',
    content,
    catalogGeneration: DIGEST_A,
    generationDigest: DIGEST_B,
    renderedDigest: DIGEST_C,
    outputDigest: digestOf(contentBuffer),
    compatibility: 'compatible',
    ...overrides,
  };
}

test('normalizes a single string-content target', () => {
  const [result] = normalizeDeclaredTargets([makeTarget()]);
  assert.equal(result.id, 'alpha');
  assert.equal(result.harness, 'claude');
  assert.equal(result.relativeTarget, 'foo/bar.md');
  assert.ok(Buffer.isBuffer(result.content));
  assert.equal(result.content.toString('utf8'), 'hello world');
  assert.equal(result.compatibility, 'compatible');
});

test('normalizes a Buffer-content target', () => {
  const buf = Buffer.from('buffer content', 'utf8');
  const target = makeTarget({ content: buf, outputDigest: digestOf(buf) });
  const [result] = normalizeDeclaredTargets([target]);
  assert.ok(Buffer.isBuffer(result.content));
  assert.equal(result.content.toString('utf8'), 'buffer content');
});

test('returns descriptors sorted by id regardless of input order', () => {
  const first = makeTarget({ id: 'zeta', relativeTarget: 'a.md' });
  const second = makeTarget({ id: 'alpha', relativeTarget: 'b.md' });
  const result = normalizeDeclaredTargets([first, second]);
  assert.deepEqual(result.map((r) => r.id), ['alpha', 'zeta']);
});

test('produces a fresh Buffer and does not mutate input', () => {
  const originalBuffer = Buffer.from('immutable', 'utf8');
  const target = makeTarget({ content: originalBuffer, outputDigest: digestOf(originalBuffer) });
  const frozenInput = JSON.parse(JSON.stringify({ ...target, content: target.content.toString('utf8') }));
  const [result] = normalizeDeclaredTargets([target]);
  assert.notEqual(result.content, originalBuffer);
  result.content[0] = 0;
  assert.notEqual(originalBuffer[0], 0);
  assert.equal(target.content.toString('utf8'), frozenInput.content);
});

test('rejects non-array input', () => {
  assert.throws(() => normalizeDeclaredTargets({}), /nonempty array/);
});

test('rejects empty array input', () => {
  assert.throws(() => normalizeDeclaredTargets([]), /nonempty array/);
});

test('rejects a target missing a required field', () => {
  const target = makeTarget();
  delete target.compatibility;
  assert.throws(() => normalizeDeclaredTargets([target]), /missing required fields/);
});

test('rejects a target with an extra field', () => {
  const target = makeTarget({ extra: 'nope' });
  assert.throws(() => normalizeDeclaredTargets([target]), /unsupported fields/);
});

test('rejects an invalid id', () => {
  const target = makeTarget({ id: 'Not_Valid' });
  assert.throws(() => normalizeDeclaredTargets([target]), /id must be a canonical id/);
});

test('rejects an invalid harness', () => {
  const target = makeTarget({ harness: 'not-a-harness' });
  assert.throws(() => normalizeDeclaredTargets([target]), /harness is invalid/);
});

test('rejects an invalid relativeTarget path', () => {
  const target = makeTarget({ relativeTarget: '/absolute/path.md' });
  assert.throws(() => normalizeDeclaredTargets([target]), /must not be an absolute path/);
});

test('rejects invalid content type', () => {
  const target = makeTarget({ content: 12345 });
  assert.throws(() => normalizeDeclaredTargets([target]), /must be a string or Buffer/);
});

test('rejects a malformed digest field', () => {
  const target = makeTarget({ catalogGeneration: 'not-a-digest' });
  assert.throws(() => normalizeDeclaredTargets([target]), /must be a lowercase SHA-256 digest/);
});

test('rejects outputDigest mismatch with content', () => {
  const target = makeTarget({ outputDigest: DIGEST_A });
  assert.throws(() => normalizeDeclaredTargets([target]), /outputDigest does not match content/);
});

test('rejects invalid compatibility value', () => {
  const target = makeTarget({ compatibility: 'maybe' });
  assert.throws(() => normalizeDeclaredTargets([target]), /compatibility must be compatible, unsupported, or incompatible/);
});

test('rejects duplicate ids', () => {
  const first = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
  const second = makeTarget({ id: 'alpha', relativeTarget: 'b.md' });
  assert.throws(() => normalizeDeclaredTargets([first, second]), /duplicate id/);
});

test('rejects duplicate normalized relativeTarget values', () => {
  const first = makeTarget({ id: 'alpha', relativeTarget: 'shared.md' });
  const second = makeTarget({ id: 'beta', relativeTarget: 'shared.md' });
  assert.throws(() => normalizeDeclaredTargets([first, second]), /duplicate relativeTarget/);
});

// -- planInstructionProjection / summarizeProjectionPlan -----------------------------------

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-projection-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function rmRoot(dir) {
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeTargetFile(root, relativeTarget, content) {
  const abs = path.join(root, relativeTarget);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, content, { mode: 0o600 });
  return abs;
}

function receiptFieldsFromTarget(target, overrides = {}) {
  return {
    schemaVersion: LOCAL_RECEIPT_SCHEMA_VERSION,
    id: target.id,
    harness: target.harness,
    relativeTarget: target.relativeTarget,
    catalogGeneration: target.catalogGeneration,
    generationDigest: target.generationDigest,
    renderedDigest: target.renderedDigest,
    outputDigest: target.outputDigest,
    ...overrides,
  };
}

function writeReceiptFile(root, id, fields) {
  const relative = receiptRelativePath(id);
  const abs = path.join(root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, serializeLocalReceipt(fields), { mode: 0o600 });
  return abs;
}

function entryFor(plan, id) {
  return plan.entries.find((entry) => entry.id === id);
}

test('creates root when createRoot is true and parent exists, with 0700 mode', () => {
  const parent = mkRoot();
  try {
    const root = path.join(parent, 'root');
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const plan = planInstructionProjection({ root, targets: [target], createRoot: true });
    assert.equal(plan.root, fs.realpathSync(root));
    const stat = fs.lstatSync(root);
    assert.equal(stat.mode & 0o777, 0o700);
    assert.equal(entryFor(plan, 'alpha').status, 'missing');
    assert.equal(entryFor(plan, 'alpha').action, 'create');
    assert.equal(entryFor(plan, 'alpha').blocked, false);
  } finally {
    rmRoot(parent);
  }
});

test('rejects createRoot when the parent directory does not exist', () => {
  const parent = mkRoot();
  try {
    const root = path.join(parent, 'nested', 'root');
    const target = makeTarget();
    assert.throws(
      () => planInstructionProjection({ root, targets: [target], createRoot: true }),
      /root parent directory does not exist/,
    );
  } finally {
    rmRoot(parent);
  }
});

test('rejects createRoot when the parent directory is group/world writable', () => {
  const parent = mkRoot();
  try {
    fs.chmodSync(parent, 0o777);
    const root = path.join(parent, 'root');
    const target = makeTarget();
    assert.throws(
      () => planInstructionProjection({ root, targets: [target], createRoot: true }),
      /group- or world-writable/,
    );
  } finally {
    fs.chmodSync(parent, 0o700);
    rmRoot(parent);
  }
});

test('rejects createRoot when the parent directory is a symlink', () => {
  const grandparent = mkRoot();
  try {
    const realParent = path.join(grandparent, 'real-parent');
    fs.mkdirSync(realParent, { mode: 0o700 });
    const linkedParent = path.join(grandparent, 'linked-parent');
    fs.symlinkSync(realParent, linkedParent);
    const root = path.join(linkedParent, 'root');
    const target = makeTarget();
    assert.throws(
      () => planInstructionProjection({ root, targets: [target], createRoot: true }),
      /symlink/,
    );
  } finally {
    rmRoot(grandparent);
  }
});

test('rejects createRoot when the parent path is a file, not a directory', () => {
  const parent = mkRoot();
  try {
    const parentFile = path.join(parent, 'not-a-dir');
    fs.writeFileSync(parentFile, 'i am a file', { mode: 0o600 });
    const root = path.join(parentFile, 'root');
    const target = makeTarget();
    assert.throws(
      () => planInstructionProjection({ root, targets: [target], createRoot: true }),
      /ENOTDIR|must be a directory/,
    );
  } finally {
    rmRoot(parent);
  }
});

test('throws when root is missing and createRoot is false', () => {
  const parent = mkRoot();
  try {
    const root = path.join(parent, 'missing-root');
    const target = makeTarget();
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /root does not exist/);
  } finally {
    rmRoot(parent);
  }
});

test('missing target and missing receipt -> missing/create/false', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'missing');
    assert.equal(entry.action, 'create');
    assert.equal(entry.blocked, false);
    assert.equal(entry.observedDigest, null);
    assert.equal(entry.receiptDigest, null);
    assert.equal(plan.ok, true);
  } finally {
    rmRoot(root);
  }
});

test('missing target with valid matching receipt (even old generations) -> missing/create/false', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target, {
      catalogGeneration: crypto.createHash('sha256').update('old-catalog').digest('hex'),
    }));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'missing');
    assert.equal(entry.action, 'create');
    assert.equal(entry.blocked, false);
  } finally {
    rmRoot(root);
  }
});

test('missing target with invalid receipt json -> conflict/preserve/true', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const relative = receiptRelativePath('alpha');
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, 'not json', { mode: 0o600 });
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'conflict');
    assert.equal(entry.action, 'preserve');
    assert.equal(entry.blocked, true);
    assert.equal(plan.ok, false);
  } finally {
    rmRoot(root);
  }
});

test('missing target with identity-mismatched receipt -> conflict/preserve/true', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target, { relativeTarget: 'other.md' }));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'conflict');
    assert.equal(entry.action, 'preserve');
    assert.equal(entry.blocked, true);
  } finally {
    rmRoot(root);
  }
});

test('target present, receipt absent -> unknown/preserve/true', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'unknown');
    assert.equal(entry.action, 'preserve');
    assert.equal(entry.blocked, true);
  } finally {
    rmRoot(root);
  }
});

test('target present, invalid receipt -> conflict/preserve/true', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    const abs = path.join(root, receiptRelativePath('alpha'));
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, '{"broken":true}', { mode: 0o600 });
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'conflict');
    assert.equal(entry.blocked, true);
  } finally {
    rmRoot(root);
  }
});

test('target present, identity-mismatched receipt -> conflict/preserve/true', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target, { harness: 'codex' }));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'conflict');
    assert.equal(entry.blocked, true);
  } finally {
    rmRoot(root);
  }
});

test('target digest differs from valid matching receipt outputDigest -> local_modified/preserve/true', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'original' });
    writeTargetFile(root, 'a.md', 'edited by someone');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'local_modified');
    assert.equal(entry.action, 'preserve');
    assert.equal(entry.blocked, true);
  } finally {
    rmRoot(root);
  }
});

test('matching digest and matching receipt fields -> clean/no-op/false', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'clean');
    assert.equal(entry.action, 'no-op');
    assert.equal(entry.blocked, false);
    assert.equal(plan.ok, true);
  } finally {
    rmRoot(root);
  }
});

test('matching digest but outdated desired fields -> outdated/update/false', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({
      id: 'alpha',
      relativeTarget: 'a.md',
      content: 'stable content',
      generationDigest: crypto.createHash('sha256').update('new-generation').digest('hex'),
    });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target, {
      generationDigest: crypto.createHash('sha256').update('old-generation').digest('hex'),
    }));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'outdated');
    assert.equal(entry.action, 'update');
    assert.equal(entry.blocked, false);
  } finally {
    rmRoot(root);
  }
});

test('unsupported compatibility -> same status/preserve/blocked', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', compatibility: 'unsupported' });
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'unsupported');
    assert.equal(entry.action, 'preserve');
    assert.equal(entry.blocked, true);
    assert.equal(plan.ok, false);
  } finally {
    rmRoot(root);
  }
});

test('incompatible compatibility -> same status/preserve/blocked', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', compatibility: 'incompatible' });
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    assert.equal(entry.status, 'incompatible');
    assert.equal(entry.action, 'preserve');
    assert.equal(entry.blocked, true);
  } finally {
    rmRoot(root);
  }
});

test('plan entries are deterministic regardless of input target order', () => {
  const root = mkRoot();
  try {
    const first = makeTarget({ id: 'zeta', relativeTarget: 'z.md' });
    const second = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const planA = planInstructionProjection({ root, targets: [first, second] });
    const planB = planInstructionProjection({ root, targets: [second, first] });
    assert.deepEqual(planA.entries.map((e) => e.id), ['alpha', 'zeta']);
    assert.deepEqual(planB.entries.map((e) => e.id), ['alpha', 'zeta']);
    assert.equal(planA.planGeneration, planB.planGeneration);
  } finally {
    rmRoot(root);
  }
});

test('entries are content-free and never expose absolute paths', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'secret payload' });
    writeTargetFile(root, 'a.md', 'secret payload');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    const plan = planInstructionProjection({ root, targets: [target] });
    const entry = entryFor(plan, 'alpha');
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes('secret payload'));
    assert.ok(!serialized.includes(root));
    assert.deepEqual(Object.keys(entry).sort(), [
      'action', 'blocked', 'catalogGeneration', 'compatibility', 'generationDigest', 'harness',
      'id', 'observedDigest', 'outputDigest', 'raceFence', 'receiptDigest', 'relativeTarget',
      'renderedDigest', 'status',
    ]);
  } finally {
    rmRoot(root);
  }
});

test('raceFence is deterministic given the same content-free fields', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const plan = planInstructionProjection({ root, targets: [target] });
    const plan2 = planInstructionProjection({ root, targets: [target] });
    assert.equal(entryFor(plan, 'alpha').raceFence, entryFor(plan2, 'alpha').raceFence);
    assert.match(entryFor(plan, 'alpha').raceFence, /^[a-f0-9]{64}$/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a root that is a symlink', () => {
  const parent = mkRoot();
  try {
    const realDir = path.join(parent, 'real');
    fs.mkdirSync(realDir, { mode: 0o700 });
    const linkRoot = path.join(parent, 'link');
    fs.symlinkSync(realDir, linkRoot);
    const target = makeTarget();
    assert.throws(() => planInstructionProjection({ root: linkRoot, targets: [target] }), /symlink/);
  } finally {
    rmRoot(parent);
  }
});

test('rejects a root that is group/world writable', () => {
  const root = mkRoot();
  try {
    fs.chmodSync(root, 0o777);
    const target = makeTarget();
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /group- or world-writable/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a symlinked intermediate path component', () => {
  const root = mkRoot();
  try {
    const realDir = path.join(root, 'real-dir');
    fs.mkdirSync(realDir, { mode: 0o700 });
    fs.symlinkSync(realDir, path.join(root, 'sub'));
    const target = makeTarget({ id: 'alpha', relativeTarget: 'sub/a.md' });
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /symlink/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a group/world writable intermediate directory', () => {
  const root = mkRoot();
  try {
    const subDir = path.join(root, 'sub');
    fs.mkdirSync(subDir, { mode: 0o777 });
    fs.chmodSync(subDir, 0o777);
    const target = makeTarget({ id: 'alpha', relativeTarget: 'sub/a.md' });
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /group- or world-writable/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a non-directory intermediate path component', () => {
  const root = mkRoot();
  try {
    writeTargetFile(root, 'sub', 'i am a file not a directory');
    const target = makeTarget({ id: 'alpha', relativeTarget: 'sub/a.md' });
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /must be a directory/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a symlinked target file', () => {
  const root = mkRoot();
  try {
    const realFile = path.join(root, 'real.md');
    fs.writeFileSync(realFile, 'content', { mode: 0o600 });
    fs.symlinkSync(realFile, path.join(root, 'a.md'));
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /symlink/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a symlinked receipt file', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    const realReceipt = path.join(root, 'real-receipt.json');
    fs.writeFileSync(realReceipt, serializeLocalReceipt(receiptFieldsFromTarget(target)), { mode: 0o600 });
    const receiptPath = path.join(root, receiptRelativePath('alpha'));
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(realReceipt, receiptPath);
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /symlink/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a hard-linked target file', () => {
  const root = mkRoot();
  try {
    const original = path.join(root, 'original.md');
    fs.writeFileSync(original, 'content', { mode: 0o600 });
    const linked = path.join(root, 'a.md');
    fs.linkSync(original, linked);
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /hard-linked/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a hard-linked receipt file', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    const receiptPath = path.join(root, receiptRelativePath('alpha'));
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receiptPath, serializeLocalReceipt(receiptFieldsFromTarget(target)), { mode: 0o600 });
    const otherLink = path.join(root, 'receipt-hardlink.json');
    fs.linkSync(receiptPath, otherLink);
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /hard-linked/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a group/world accessible target file', () => {
  const root = mkRoot();
  try {
    const abs = writeTargetFile(root, 'a.md', 'content');
    fs.chmodSync(abs, 0o644);
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /group- or world-accessible/);
  } finally {
    rmRoot(root);
  }
});

test('rejects a group/world accessible receipt file', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    const abs = writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    fs.chmodSync(abs, 0o640);
    assert.throws(() => planInstructionProjection({ root, targets: [target] }), /group- or world-accessible/);
  } finally {
    rmRoot(root);
  }
});

test('summarizeProjectionPlan returns a content-free copy without root', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'secret payload' });
    writeTargetFile(root, 'a.md', 'secret payload');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    const plan = planInstructionProjection({ root, targets: [target] });
    const summary = summarizeProjectionPlan(plan);
    assert.deepEqual(Object.keys(summary).sort(), ['entries', 'ok', 'planGeneration', 'version']);
    assert.equal(summary.version, 1);
    assert.equal(summary.planGeneration, plan.planGeneration);
    assert.equal(summary.ok, plan.ok);
    const serialized = JSON.stringify(summary);
    assert.ok(!serialized.includes('secret payload'));
    assert.ok(!serialized.includes(root));
  } finally {
    rmRoot(root);
  }
});

test('summarizeProjectionPlan rejects a malformed plan', () => {
  assert.throws(() => summarizeProjectionPlan({}), /plan\.version/);
  assert.throws(() => summarizeProjectionPlan(null), /plan must be an object/);
  assert.throws(() => summarizeProjectionPlan({ version: 1, root: '/x', planGeneration: 'a'.repeat(64), entries: [{}], ok: true }),
    /missing required fields/);
});

// -- summarizeProjectionPlan forgery hardening ---------------------------------------------

function realPlan(overrides = {}) {
  const root = mkRoot();
  const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
  const plan = planInstructionProjection({ root, targets: [target] });
  rmRoot(root);
  return { ...plan, ...overrides };
}

test('summarizeProjectionPlan rejects a non-absolute root', () => {
  const plan = realPlan({ root: 'relative/path' });
  assert.throws(() => summarizeProjectionPlan(plan), /root must be a nonempty absolute path/);
});

test('summarizeProjectionPlan rejects a forged raceFence', () => {
  const plan = realPlan();
  const forged = { ...plan, entries: [{ ...plan.entries[0], raceFence: 'f'.repeat(64) }] };
  assert.throws(() => summarizeProjectionPlan(forged), /raceFence does not match its fields/);
});

test('summarizeProjectionPlan rejects a forged planGeneration', () => {
  const plan = realPlan({ planGeneration: 'f'.repeat(64) });
  assert.throws(() => summarizeProjectionPlan(plan), /planGeneration does not match entries/);
});

test('summarizeProjectionPlan rejects a forged ok flag', () => {
  const plan = realPlan({ ok: false });
  assert.throws(() => summarizeProjectionPlan(plan), /ok does not match entries/);
});

function recomputeRaceFence(entry) {
  const fields = {
    id: entry.id, harness: entry.harness, relativeTarget: entry.relativeTarget,
    compatibility: entry.compatibility, status: entry.status, action: entry.action,
    blocked: entry.blocked, catalogGeneration: entry.catalogGeneration,
    generationDigest: entry.generationDigest, renderedDigest: entry.renderedDigest,
    outputDigest: entry.outputDigest, observedDigest: entry.observedDigest,
    receiptDigest: entry.receiptDigest,
  };
  const ordered = Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

test('summarizeProjectionPlan rejects an invalid status/action/blocked pairing', () => {
  const plan = realPlan();
  const badEntry = { ...plan.entries[0], action: 'update' };
  badEntry.raceFence = recomputeRaceFence(badEntry);
  const forged = { ...plan, entries: [badEntry] };
  assert.throws(() => summarizeProjectionPlan(forged), /invalid status\/action\/blocked combination/);
});

test('summarizeProjectionPlan rejects an unsafe relativeTarget', () => {
  const plan = realPlan();
  const forged = { ...plan, entries: [{ ...plan.entries[0], relativeTarget: '../escape.md' }] };
  assert.throws(() => summarizeProjectionPlan(forged), /must not contain empty, dot, or traversal segments/);
});

test('summarizeProjectionPlan rejects unsorted entries', () => {
  const root = mkRoot();
  try {
    const first = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const second = makeTarget({ id: 'zeta', relativeTarget: 'z.md' });
    const plan = planInstructionProjection({ root, targets: [first, second] });
    const reversed = { ...plan, entries: [...plan.entries].reverse() };
    assert.throws(() => summarizeProjectionPlan(reversed), /must be sorted by id/);
  } finally {
    rmRoot(root);
  }
});

test('summarizeProjectionPlan rejects duplicate ids across entries', () => {
  const plan = realPlan();
  const forged = { ...plan, entries: [plan.entries[0], { ...plan.entries[0] }] };
  assert.throws(() => summarizeProjectionPlan(forged), /duplicate id/);
});

test('summarizeProjectionPlan rejects duplicate relativeTarget across entries', () => {
  const root = mkRoot();
  try {
    const first = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const second = makeTarget({ id: 'beta', relativeTarget: 'b.md' });
    const plan = planInstructionProjection({ root, targets: [first, second] });
    const clashingEntry = { ...plan.entries[1], relativeTarget: plan.entries[0].relativeTarget };
    clashingEntry.raceFence = recomputeRaceFence(clashingEntry);
    const forged = { ...plan, entries: [plan.entries[0], clashingEntry] };
    assert.throws(() => summarizeProjectionPlan(forged), /duplicate relativeTarget/);
  } finally {
    rmRoot(root);
  }
});

// -- applyInstructionProjection -------------------------------------------------------------

function readReceiptJson(root, id) {
  const abs = path.join(root, receiptRelativePath(id));
  return normalizeLocalReceipt(JSON.parse(fs.readFileSync(abs, 'utf8')));
}

function modeOf(absPath) {
  return fs.lstatSync(absPath).mode & 0o777;
}

test('missing/create writes exact target and normalized receipt with 0600 modes and a content-free result', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });
    const result = applyInstructionProjection(plan, { targets: [target] });

    const absTarget = path.join(root, 'a.md');
    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'hello world');
    assert.equal(modeOf(absTarget), 0o600);

    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    assert.equal(modeOf(absReceipt), 0o600);
    const receipt = readReceiptJson(root, 'alpha');
    assert.equal(receipt.outputDigest, target.outputDigest);

    assert.deepEqual(Object.keys(result).sort(), ['entries', 'ok', 'planGeneration', 'version']);
    assert.equal(result.version, 1);
    assert.equal(result.ok, true);
    assert.equal(result.planGeneration, plan.planGeneration);
    assert.deepEqual(result.entries, [
      { id: 'alpha', status: 'missing', action: 'create', applied: true, outputDigest: target.outputDigest },
    ]);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(root));
    assert.ok(!serialized.includes('hello world'));
    assert.ok(!/loaded|parity|convergence/i.test(serialized));
  } finally {
    rmRoot(root);
  }
});

test('outdated/update replaces both target and receipt bytes', () => {
  const root = mkRoot();
  try {
    const oldGeneration = digestOf('old-generation');
    const newGeneration = digestOf('new-generation');
    const oldTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: oldGeneration });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(oldTarget));

    const newTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: newGeneration });
    const plan = planInstructionProjection({ root, targets: [newTarget] });
    assert.equal(entryFor(plan, 'alpha').status, 'outdated');

    const result = applyInstructionProjection(plan, { targets: [newTarget] });
    assert.equal(result.entries[0].action, 'update');
    assert.equal(result.entries[0].applied, true);

    const receipt = readReceiptJson(root, 'alpha');
    assert.equal(receipt.generationDigest, newGeneration);
  } finally {
    rmRoot(root);
  }
});

test('clean/no-op does not rewrite the target or receipt (inode unchanged)', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const targetInoBefore = fs.lstatSync(absTarget).ino;
    const receiptInoBefore = fs.lstatSync(absReceipt).ino;

    const plan = planInstructionProjection({ root, targets: [target] });
    assert.equal(entryFor(plan, 'alpha').status, 'clean');
    const result = applyInstructionProjection(plan, { targets: [target] });

    assert.equal(result.entries[0].action, 'no-op');
    assert.equal(result.entries[0].applied, false);
    assert.equal(fs.lstatSync(absTarget).ino, targetInoBefore);
    assert.equal(fs.lstatSync(absReceipt).ino, receiptInoBefore);
  } finally {
    rmRoot(root);
  }
});

test('blocked plan aborts every entry before any mutation', () => {
  const root = mkRoot();
  try {
    const clean = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(clean));

    const conflictTarget = makeTarget({ id: 'beta', relativeTarget: 'b.md', content: 'edited on disk' });
    writeTargetFile(root, 'b.md', 'edited on disk');
    writeReceiptFile(root, 'beta', receiptFieldsFromTarget(makeTarget({ id: 'beta', relativeTarget: 'b.md', content: 'original' })));

    const plan = planInstructionProjection({ root, targets: [clean, conflictTarget] });
    assert.equal(plan.ok, false);

    assert.throws(() => applyInstructionProjection(plan, { targets: [clean, conflictTarget] }), /plan is not ok/);

    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'stable content');
    assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'edited on disk');
  } finally {
    rmRoot(root);
  }
});

test('a race between planning and apply rejects without mutating anything', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });

    // Simulate a concurrent actor writing an unrelated conflicting target after planning.
    writeTargetFile(root, 'a.md', 'someone else wrote this');

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [target] }),
      /raceFence changed since planning|apply aborted before mutation/,
    );

    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'someone else wrote this');
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
  } finally {
    rmRoot(root);
  }
});

test('injected failure after target replacement restores target and receipt exactly, including modes', () => {
  const root = mkRoot();
  try {
    const oldGeneration = digestOf('old-generation');
    const newGeneration = digestOf('new-generation');
    const oldTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: oldGeneration });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(oldTarget));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const targetBytesBefore = fs.readFileSync(absTarget);
    const receiptBytesBefore = fs.readFileSync(absReceipt);
    fs.chmodSync(absTarget, 0o600);
    fs.chmodSync(absReceipt, 0o600);
    const targetModeBefore = modeOf(absTarget);
    const receiptModeBefore = modeOf(absReceipt);

    const newTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: newGeneration });
    const plan = planInstructionProjection({ root, targets: [newTarget] });

    let injected = 0;
    const faultInjector = (stage, ctx) => {
      assert.deepEqual(Object.keys(ctx).sort(), ['id', 'relativeTarget']);
      assert.equal(ctx.id, 'alpha');
      assert.equal(ctx.relativeTarget, 'a.md');
      assert.ok(FAULT_STAGES.includes(stage));
      if (stage === 'after-target-replace') {
        injected += 1;
        throw new Error('injected-after-target-replace-failure');
      }
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [newTarget], faultInjector }),
      /injected-after-target-replace-failure/,
    );
    assert.equal(injected, 1);

    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
    assert.equal(modeOf(absTarget), targetModeBefore);
    assert.equal(modeOf(absReceipt), receiptModeBefore);
  } finally {
    rmRoot(root);
  }
});

test('injected post-target-rename/pre-verification failure restores an ordinary prior target+receipt exactly', () => {
  const root = mkRoot();
  try {
    const oldGeneration = digestOf('old-generation');
    const newGeneration = digestOf('new-generation');
    const oldTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: oldGeneration });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(oldTarget));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const targetBytesBefore = fs.readFileSync(absTarget);
    const receiptBytesBefore = fs.readFileSync(absReceipt);
    fs.chmodSync(absTarget, 0o600);
    fs.chmodSync(absReceipt, 0o600);
    const targetModeBefore = modeOf(absTarget);
    const receiptModeBefore = modeOf(absReceipt);

    const newTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: newGeneration });
    const plan = planInstructionProjection({ root, targets: [newTarget] });

    let injected = 0;
    const faultInjector = (stage, ctx) => {
      assert.deepEqual(Object.keys(ctx).sort(), ['id', 'relativeTarget']);
      assert.equal(ctx.id, 'alpha');
      assert.equal(ctx.relativeTarget, 'a.md');
      assert.ok(FAULT_STAGES.includes(stage));
      if (stage === 'after-target-rename-before-verify') {
        injected += 1;
        throw new Error('injected-post-rename-pre-verify-failure');
      }
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [newTarget], faultInjector }),
      /injected-post-rename-pre-verify-failure/,
    );
    assert.equal(injected, 1);

    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
    assert.equal(modeOf(absTarget), targetModeBefore);
    assert.equal(modeOf(absReceipt), receiptModeBefore);
  } finally {
    rmRoot(root);
  }
});

test('injected post-target-rename/pre-verification failure for a newly created target removes it and cleans temps/created dirs', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'nested/dir/a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });

    let injected = 0;
    const faultInjector = (stage) => {
      if (stage === 'after-target-rename-before-verify') {
        injected += 1;
        throw new Error('injected-post-rename-pre-verify-create-failure');
      }
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [target], faultInjector }),
      /injected-post-rename-pre-verify-create-failure/,
    );
    assert.equal(injected, 1);

    assert.equal(fs.existsSync(path.join(root, 'nested')), false);
    assert.equal(fs.existsSync(path.join(root, 'nested/dir/a.md')), false);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
    const leftover = fs.readdirSync(root).filter((name) => name.startsWith('.jarvos-instruction-projection-tmp-'));
    assert.deepEqual(leftover, []);
  } finally {
    rmRoot(root);
  }
});

test('injected create failure removes new target/receipt/temp files and only directories created by the call', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'nested/dir/a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });

    const faultInjector = (stage) => {
      if (stage === 'before-receipt-replace') throw new Error('injected-create-failure');
    };

    assert.throws(() => applyInstructionProjection(plan, { targets: [target], faultInjector }), /injected-create-failure/);

    assert.equal(fs.existsSync(path.join(root, 'nested')), false);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
    const leftover = fs.readdirSync(root).filter((name) => name.startsWith('.jarvos-instruction-projection-tmp-'));
    assert.deepEqual(leftover, []);
  } finally {
    rmRoot(root);
  }
});

test('a later entry failure rolls back an earlier successfully-applied entry', () => {
  const root = mkRoot();
  try {
    const alpha = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'alpha content' });
    const beta = makeTarget({ id: 'beta', relativeTarget: 'b.md', content: 'beta content' });
    const plan = planInstructionProjection({ root, targets: [alpha, beta] });

    const faultInjector = (stage, ctx) => {
      if (stage === 'before-target-replace' && ctx.id === 'beta') throw new Error('injected-beta-failure');
    };

    assert.throws(() => applyInstructionProjection(plan, { targets: [alpha, beta], faultInjector }), /injected-beta-failure/);

    assert.equal(fs.existsSync(path.join(root, 'a.md')), false);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
    assert.equal(fs.existsSync(path.join(root, 'b.md')), false);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('beta'))), false);
  } finally {
    rmRoot(root);
  }
});

test('an unsafe directory/link race introduced after planning is rejected', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'sub/a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });

    // Simulate a concurrent actor replacing the not-yet-created intermediate directory with a symlink.
    const realDir = path.join(root, 'real-sub');
    fs.mkdirSync(realDir, { mode: 0o700 });
    fs.symlinkSync(realDir, path.join(root, 'sub'));

    assert.throws(() => applyInstructionProjection(plan, { targets: [target] }), /symlink/);
    assert.equal(fs.existsSync(path.join(realDir, 'a.md')), false);
  } finally {
    rmRoot(root);
  }
});

test('repeat apply from a fresh plan is idempotent and makes no loaded/parity/convergence claim', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });
    const firstResult = applyInstructionProjection(plan, { targets: [target] });
    assert.equal(firstResult.entries[0].applied, true);

    const secondPlan = planInstructionProjection({ root, targets: [target] });
    assert.equal(secondPlan.ok, true);
    assert.equal(entryFor(secondPlan, 'alpha').status, 'clean');

    const secondResult = applyInstructionProjection(secondPlan, { targets: [target] });
    assert.equal(secondResult.entries[0].applied, false);
    assert.equal(secondResult.entries[0].action, 'no-op');

    const serialized = JSON.stringify(secondResult);
    assert.ok(!/loaded|parity|convergence/i.test(serialized));
  } finally {
    rmRoot(root);
  }
});

test('rejects a faultInjector that is not a function', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const plan = planInstructionProjection({ root, targets: [target] });
    assert.throws(
      () => applyInstructionProjection(plan, { targets: [target], faultInjector: 'nope' }),
      /faultInjector must be a function/,
    );
  } finally {
    rmRoot(root);
  }
});

test('rejects supplied targets that do not match the plan entries', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    const other = makeTarget({ id: 'beta', relativeTarget: 'b.md' });
    const plan = planInstructionProjection({ root, targets: [target] });
    assert.throws(
      () => applyInstructionProjection(plan, { targets: [other] }),
      /supplied targets do not match plan entries/,
    );
  } finally {
    rmRoot(root);
  }
});

// -- apply-path safety hardening ------------------------------------------------------------

function leftoverTempFiles(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith('.jarvos-instruction-projection-tmp-'));
}

test('a fault before target replacement leaves pre-existing target and receipt inode unchanged', () => {
  const root = mkRoot();
  try {
    const oldGeneration = digestOf('old-generation');
    const newGeneration = digestOf('new-generation');
    const oldTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: oldGeneration });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(oldTarget));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const targetInoBefore = fs.lstatSync(absTarget).ino;
    const receiptInoBefore = fs.lstatSync(absReceipt).ino;
    const targetBytesBefore = fs.readFileSync(absTarget);
    const receiptBytesBefore = fs.readFileSync(absReceipt);

    const newTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: newGeneration });
    const plan = planInstructionProjection({ root, targets: [newTarget] });

    const faultInjector = (stage) => {
      if (stage === 'before-target-replace') throw new Error('injected-before-target-replace-failure');
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [newTarget], faultInjector }),
      /injected-before-target-replace-failure/,
    );

    assert.equal(fs.lstatSync(absTarget).ino, targetInoBefore);
    assert.equal(fs.lstatSync(absReceipt).ino, receiptInoBefore);
    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
    assert.deepEqual(leftoverTempFiles(root), []);
  } finally {
    rmRoot(root);
  }
});

test('a fault before receipt replacement restores target but leaves pre-existing receipt inode unchanged', () => {
  const root = mkRoot();
  try {
    const oldGeneration = digestOf('old-generation');
    const newGeneration = digestOf('new-generation');
    const oldTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: oldGeneration });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(oldTarget));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const receiptInoBefore = fs.lstatSync(absReceipt).ino;
    const targetBytesBefore = fs.readFileSync(absTarget);
    const receiptBytesBefore = fs.readFileSync(absReceipt);
    const targetModeBefore = modeOf(absTarget);
    const receiptModeBefore = modeOf(absReceipt);

    const newTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: newGeneration });
    const plan = planInstructionProjection({ root, targets: [newTarget] });

    const faultInjector = (stage) => {
      if (stage === 'before-receipt-replace') throw new Error('injected-before-receipt-replace-failure');
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [newTarget], faultInjector }),
      /injected-before-receipt-replace-failure/,
    );

    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.equal(modeOf(absTarget), targetModeBefore);
    assert.equal(fs.lstatSync(absReceipt).ino, receiptInoBefore);
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
    assert.equal(modeOf(absReceipt), receiptModeBefore);
    assert.deepEqual(leftoverTempFiles(root), []);
  } finally {
    rmRoot(root);
  }
});

test('a hard-link race on the target introduced before replacement is rejected and does not modify linked bytes', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'hello world' });
    writeTargetFile(root, 'a.md', 'hello world');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    // Reclassify as clean, then force an update via a changed generation digest so apply attempts a replace.
    const updated = makeTarget({
      id: 'alpha', relativeTarget: 'a.md', content: 'hello world', generationDigest: digestOf('new-generation'),
    });
    const plan = planInstructionProjection({ root, targets: [updated] });
    assert.equal(entryFor(plan, 'alpha').status, 'outdated');

    const absTarget = path.join(root, 'a.md');
    const linkPath = path.join(root, 'a-hardlink.md');

    const faultInjector = (stage) => {
      if (stage === 'before-target-replace') fs.linkSync(absTarget, linkPath);
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [updated], faultInjector }),
      /hard-linked/,
    );

    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'hello world');
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'hello world');
    assert.deepEqual(leftoverTempFiles(root), []);
  } finally {
    rmRoot(root);
  }
});

test('an unsafe-permission race on the target introduced before replacement is rejected and preserves user bytes', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'hello world' });
    writeTargetFile(root, 'a.md', 'hello world');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));
    const updated = makeTarget({
      id: 'alpha', relativeTarget: 'a.md', content: 'hello world', generationDigest: digestOf('new-generation'),
    });
    const plan = planInstructionProjection({ root, targets: [updated] });

    const absTarget = path.join(root, 'a.md');
    const faultInjector = (stage) => {
      if (stage === 'before-target-replace') fs.chmodSync(absTarget, 0o644);
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [updated], faultInjector }),
      /group- or world-accessible/,
    );

    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'hello world');
    assert.deepEqual(leftoverTempFiles(root), []);
  } finally {
    rmRoot(root);
  }
});

test('a concurrent target edit made after target replacement is preserved and apply throws a rollback-failed aggregate error', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'hello world' });
    const plan = planInstructionProjection({ root, targets: [target] });

    const absTarget = path.join(root, 'a.md');
    const faultInjector = (stage) => {
      if (stage === 'after-target-replace') {
        // Simulate a concurrent writer editing the file this call just wrote, between the
        // target and receipt replacements.
        fs.writeFileSync(absTarget, 'concurrent edit', { mode: 0o600 });
      }
      if (stage === 'before-receipt-replace') {
        throw new Error('injected-receipt-failure');
      }
    };

    let thrown = null;
    try {
      applyInstructionProjection(plan, { targets: [target], faultInjector });
      assert.fail('expected applyInstructionProjection to throw');
    } catch (err) {
      thrown = err;
    }

    assert.match(thrown.message, /rollback failed/);
    assert.ok(!thrown.message.includes('concurrent edit'));
    assert.ok(thrown.cause);
    assert.equal(thrown.cause.message, 'injected-receipt-failure');

    // The concurrent edit must survive untouched: rollback must not clobber it.
    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'concurrent edit');
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
  } finally {
    rmRoot(root);
  }
});

test('ordinary rollback after a fault during receipt replacement restores exact prior bytes/modes and leaves no temp files', () => {
  const root = mkRoot();
  try {
    const oldGeneration = digestOf('old-generation');
    const newGeneration = digestOf('new-generation');
    const oldTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: oldGeneration });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(oldTarget));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    fs.chmodSync(absTarget, 0o600);
    fs.chmodSync(absReceipt, 0o600);
    const targetBytesBefore = fs.readFileSync(absTarget);
    const receiptBytesBefore = fs.readFileSync(absReceipt);
    const targetModeBefore = modeOf(absTarget);
    const receiptModeBefore = modeOf(absReceipt);

    const newTarget = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content', generationDigest: newGeneration });
    const plan = planInstructionProjection({ root, targets: [newTarget] });

    const faultInjector = (stage) => {
      if (stage === 'after-receipt-replace') throw new Error('injected-after-receipt-replace-failure');
    };

    assert.throws(
      () => applyInstructionProjection(plan, { targets: [newTarget], faultInjector }),
      /injected-after-receipt-replace-failure/,
    );

    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
    assert.equal(modeOf(absTarget), targetModeBefore);
    assert.equal(modeOf(absReceipt), receiptModeBefore);
    assert.deepEqual(leftoverTempFiles(root), []);
  } finally {
    rmRoot(root);
  }
});

// -- disableInstructionProjection ------------------------------------------------------------

function entryOf(result, id) {
  return result.entries.find((entry) => entry.id === id);
}

test('disable: exact receipt-owned target+receipt are removed', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const result = disableInstructionProjection({ root, targets: [target] });

    assert.equal(result.version, 1);
    assert.equal(result.ok, true);
    assert.deepEqual(entryOf(result, 'alpha'), {
      id: 'alpha', status: 'owned', action: 'remove', removedTarget: true, removedReceipt: true,
      receiptOutputDigest: target.outputDigest,
    });
    assert.equal(fs.existsSync(path.join(root, 'a.md')), false);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
  } finally {
    rmRoot(root);
  }
});

test('disable: modified target and its receipt are both preserved with local_modified', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'original' });
    writeTargetFile(root, 'a.md', 'edited by someone');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const result = disableInstructionProjection({ root, targets: [target] });

    assert.equal(result.ok, false);
    assert.deepEqual(entryOf(result, 'alpha'), { id: 'alpha', status: 'local_modified', action: 'preserve' });
    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'edited by someone');
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), true);
  } finally {
    rmRoot(root);
  }
});

test('disable: target without receipt is unknown/preserved', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');

    const result = disableInstructionProjection({ root, targets: [target] });

    assert.equal(result.ok, false);
    assert.deepEqual(entryOf(result, 'alpha'), { id: 'alpha', status: 'unknown', action: 'preserve' });
    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'on disk');
  } finally {
    rmRoot(root);
  }
});

test('disable: invalid/mismatched receipt is conflict/preserved', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'on disk' });
    writeTargetFile(root, 'a.md', 'on disk');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target, { harness: 'codex' }));

    const result = disableInstructionProjection({ root, targets: [target] });

    assert.equal(result.ok, false);
    assert.deepEqual(entryOf(result, 'alpha'), { id: 'alpha', status: 'conflict', action: 'preserve' });
    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'on disk');
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), true);
  } finally {
    rmRoot(root);
  }
});

test('disable: missing target with valid receipt removes receipt only', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const result = disableInstructionProjection({ root, targets: [target] });

    assert.equal(result.ok, true);
    assert.deepEqual(entryOf(result, 'alpha'), {
      id: 'alpha', status: 'missing', action: 'remove-receipt', removedReceipt: true,
      receiptOutputDigest: target.outputDigest,
    });
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), false);
  } finally {
    rmRoot(root);
  }
});

test('disable: selected ids only affect selected entries', () => {
  const root = mkRoot();
  try {
    const alpha = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'alpha content' });
    const beta = makeTarget({ id: 'beta', relativeTarget: 'b.md', content: 'beta content' });
    writeTargetFile(root, 'a.md', 'alpha content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(alpha));
    writeTargetFile(root, 'b.md', 'beta content');
    writeReceiptFile(root, 'beta', receiptFieldsFromTarget(beta));

    const result = disableInstructionProjection({ root, targets: [alpha, beta], ids: ['alpha'] });

    assert.deepEqual(result.entries.map((e) => e.id), ['alpha']);
    assert.equal(fs.existsSync(path.join(root, 'a.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'b.md')), true);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('beta'))), true);
  } finally {
    rmRoot(root);
  }
});

test('disable: rejects ids not present among targets', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], ids: ['ghost'] }),
      /ids contains an id not present in targets/,
    );
  } finally {
    rmRoot(root);
  }
});

test('disable: mixed owned + modified removes owned and preserves modified, result ok false', () => {
  const root = mkRoot();
  try {
    const owned = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'owned content' });
    writeTargetFile(root, 'a.md', 'owned content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(owned));

    const modified = makeTarget({ id: 'beta', relativeTarget: 'b.md', content: 'original' });
    writeTargetFile(root, 'b.md', 'edited by someone');
    writeReceiptFile(root, 'beta', receiptFieldsFromTarget(modified));

    const result = disableInstructionProjection({ root, targets: [owned, modified] });

    assert.equal(result.ok, false);
    assert.equal(entryOf(result, 'alpha').status, 'owned');
    assert.equal(entryOf(result, 'beta').status, 'local_modified');
    assert.equal(fs.existsSync(path.join(root, 'a.md')), false);
    assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'edited by someone');
  } finally {
    rmRoot(root);
  }
});

test('disable: a race on the target before unlink rejects without deleting changed bytes', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const originalContent = fs.readFileSync(absTarget, 'utf8');
    fs.chmodSync(absTarget, 0o644);

    assert.throws(
      () => disableInstructionProjection({ root, targets: [target] }),
      /group- or world-accessible/,
    );

    assert.equal(fs.readFileSync(absTarget, 'utf8'), originalContent);
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), true);
  } finally {
    rmRoot(root);
  }
});

test('disable: a race on the receipt before unlink rejects without deleting changed bytes', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));

    const faultInjector = (stage) => {
      if (stage === 'after-target-remove') {
        fs.writeFileSync(absReceipt, serializeLocalReceipt(receiptFieldsFromTarget(target, {
          relativeTarget: 'other.md',
        })), { mode: 0o600 });
      }
    };

    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], faultInjector }),
      /receipt for alpha changed unexpectedly before removal/,
    );

    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'stable content');
    assert.ok(fs.existsSync(absReceipt));
  } finally {
    rmRoot(root);
  }
});

test('disable: injected failure after target removal restores exact target and leaves untouched receipt inode unchanged', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const targetBytesBefore = fs.readFileSync(absTarget);
    const targetModeBefore = modeOf(absTarget);
    const receiptInoBefore = fs.lstatSync(absReceipt).ino;
    const receiptBytesBefore = fs.readFileSync(absReceipt);

    let injected = 0;
    const faultInjector = (stage, ctx) => {
      assert.deepEqual(Object.keys(ctx).sort(), ['id', 'relativeTarget']);
      assert.ok(DISABLE_FAULT_STAGES.includes(stage));
      if (stage === 'after-target-remove') {
        injected += 1;
        throw new Error('injected-after-target-remove-failure');
      }
    };

    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], faultInjector }),
      /injected-after-target-remove-failure/,
    );
    assert.equal(injected, 1);

    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.equal(modeOf(absTarget), targetModeBefore);
    assert.equal(fs.lstatSync(absReceipt).ino, receiptInoBefore);
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
  } finally {
    rmRoot(root);
  }
});

test('disable: rollback leaves no leftover temp files after restoring a removed target+receipt', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const faultInjector = (stage) => {
      if (stage === 'before-receipt-remove') throw new Error('injected-before-receipt-remove-failure');
    };

    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], faultInjector }),
      /injected-before-receipt-remove-failure/,
    );

    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'stable content');
    assert.ok(fs.existsSync(path.join(root, receiptRelativePath('alpha'))));
    assert.deepEqual(leftoverTempFiles(root), []);
  } finally {
    rmRoot(root);
  }
});

test('disable: a later-entry failure restores an earlier removed target+receipt', () => {
  const root = mkRoot();
  try {
    const alpha = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'alpha content' });
    const beta = makeTarget({ id: 'beta', relativeTarget: 'b.md', content: 'beta content' });
    writeTargetFile(root, 'a.md', 'alpha content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(alpha));
    writeTargetFile(root, 'b.md', 'beta content');
    writeReceiptFile(root, 'beta', receiptFieldsFromTarget(beta));

    const faultInjector = (stage, ctx) => {
      if (stage === 'after-target-remove' && ctx.id === 'beta') throw new Error('injected-beta-failure');
    };

    assert.throws(
      () => disableInstructionProjection({ root, targets: [alpha, beta], faultInjector }),
      /injected-beta-failure/,
    );

    assert.equal(fs.readFileSync(path.join(root, 'a.md'), 'utf8'), 'alpha content');
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), true);
    assert.equal(fs.readFileSync(path.join(root, 'b.md'), 'utf8'), 'beta content');
  } finally {
    rmRoot(root);
  }
});

test('disable: a concurrent file appearing after removal is preserved and causes a sanitized aggregate rollback failure', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const faultInjector = (stage) => {
      if (stage === 'after-target-remove') {
        fs.writeFileSync(absTarget, 'concurrent recreation', { mode: 0o600 });
      }
      if (stage === 'before-receipt-remove') {
        throw new Error('injected-before-receipt-remove-failure');
      }
    };

    let thrown = null;
    try {
      disableInstructionProjection({ root, targets: [target], faultInjector });
      assert.fail('expected disableInstructionProjection to throw');
    } catch (err) {
      thrown = err;
    }

    assert.match(thrown.message, /rollback failed/);
    assert.ok(!thrown.message.includes('concurrent recreation'));
    assert.ok(thrown.cause);
    assert.equal(thrown.cause.message, 'injected-before-receipt-remove-failure');

    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'concurrent recreation');
    assert.equal(fs.existsSync(path.join(root, receiptRelativePath('alpha'))), true);
  } finally {
    rmRoot(root);
  }
});

test('disable: repeat disable after a successful disable is an idempotent missing/no-op', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const first = disableInstructionProjection({ root, targets: [target] });
    assert.equal(first.ok, true);
    assert.equal(entryOf(first, 'alpha').action, 'remove');

    const second = disableInstructionProjection({ root, targets: [target] });
    assert.equal(second.ok, true);
    assert.deepEqual(entryOf(second, 'alpha'), { id: 'alpha', status: 'missing', action: 'no-op' });
  } finally {
    rmRoot(root);
  }
});

test('disable: result is content/path private and has no loaded/parity/convergence claim', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'secret payload' });
    writeTargetFile(root, 'a.md', 'secret payload');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const result = disableInstructionProjection({ root, targets: [target] });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('secret payload'));
    assert.ok(!serialized.includes(root));
    assert.ok(!/loaded|parity|convergence/i.test(serialized));
    assert.deepEqual(Object.keys(result).sort(), ['entries', 'ok', 'version']);
  } finally {
    rmRoot(root);
  }
});

test('disable: a before-target-remove race rewriting the target with different safe bytes is rejected and preserves target and receipt', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const receiptBytesBefore = fs.readFileSync(absReceipt);

    const faultInjector = (stage) => {
      if (stage === 'before-target-remove') {
        fs.writeFileSync(absTarget, 'different safe bytes', { mode: 0o600 });
      }
    };

    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], faultInjector }),
      /target for alpha changed unexpectedly before removal/,
    );

    assert.equal(fs.readFileSync(absTarget, 'utf8'), 'different safe bytes');
    assert.equal(Buffer.compare(fs.readFileSync(absReceipt), receiptBytesBefore), 0);
    assert.ok(fs.existsSync(absTarget));
    assert.ok(fs.existsSync(absReceipt));
  } finally {
    rmRoot(root);
  }
});

test('disable: a before-target-remove race rewriting the receipt with different safe bytes is rejected before deleting the target', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md', content: 'stable content' });
    writeTargetFile(root, 'a.md', 'stable content');
    writeReceiptFile(root, 'alpha', receiptFieldsFromTarget(target));

    const absTarget = path.join(root, 'a.md');
    const absReceipt = path.join(root, receiptRelativePath('alpha'));
    const targetBytesBefore = fs.readFileSync(absTarget);
    const targetStatBefore = fs.lstatSync(absTarget);

    const faultInjector = (stage) => {
      if (stage === 'before-target-remove') {
        fs.writeFileSync(absReceipt, serializeLocalReceipt(receiptFieldsFromTarget(target, {
          relativeTarget: 'other.md',
        })), { mode: 0o600 });
      }
    };

    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], faultInjector }),
      /receipt for alpha changed unexpectedly before removal/,
    );

    assert.equal(Buffer.compare(fs.readFileSync(absTarget), targetBytesBefore), 0);
    assert.ok(fs.existsSync(absTarget));
    assert.ok(fs.existsSync(absReceipt));

    const targetStatAfter = fs.lstatSync(absTarget);
    assert.equal(targetStatAfter.dev, targetStatBefore.dev);
    assert.equal(targetStatAfter.ino, targetStatBefore.ino);
  } finally {
    rmRoot(root);
  }
});

test('disable: rejects a faultInjector that is not a function', () => {
  const root = mkRoot();
  try {
    const target = makeTarget({ id: 'alpha', relativeTarget: 'a.md' });
    assert.throws(
      () => disableInstructionProjection({ root, targets: [target], faultInjector: 'nope' }),
      /faultInjector must be a function/,
    );
  } finally {
    rmRoot(root);
  }
});
