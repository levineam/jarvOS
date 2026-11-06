'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { upsertManagedBlock } = require('../src/managed-block');
const { readCaptureGuideline } = require('../src/capture-guideline');
const ROOT = path.resolve(__dirname, '../../..');
const start = '<!-- jarvos:managed capture-guideline:start -->';
const end = '<!-- jarvos:managed capture-guideline:end -->';

function fixture(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-managed-block-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(file, content);
  return { dir, file };
}

test('insert backs up exact prior bytes, preserves mode, and unchanged is a no-op', t => {
  const prior = '# Custom instructions\nKeep this.\n';
  const { dir, file } = fixture(t, prior);
  fs.chmodSync(file, 0o640);
  const first = upsertManagedBlock(file, 'capture-guideline', '## Keeping things\n\nInvented guidance.');
  assert.equal(fs.readFileSync(first.backup, 'utf8'), prior);
  assert.equal(fs.readFileSync(file, 'utf8'), `${prior}\n${start}\n## Keeping things\n\nInvented guidance.\n${end}\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const stat = fs.statSync(file);
  const entries = fs.readdirSync(dir);
  assert.deepEqual(upsertManagedBlock(file, 'capture-guideline', '## Keeping things\n\nInvented guidance.'), { changed: false });
  assert.deepEqual(fs.readdirSync(dir), entries);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.equal(fs.statSync(file).ino, stat.ino);
});

test('replace changes only the bytes between markers, including mixed line endings outside', t => {
  const prefix = '# Custom café\r\n\tKeep trailing spaces.  \r\n';
  const suffix = '\r\nLocal ending without newline';
  const prior = `${prefix}${start}\nOld guidance\n${end}${suffix}`;
  const { file } = fixture(t, prior);
  const result = upsertManagedBlock(file, 'capture-guideline', 'New guidance');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), prior);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(`${prefix}${start}\nNew guidance\n${end}${suffix}`));
});

test('unbalanced, duplicate and reversed markers refuse without writes or backups', t => {
  for (const prior of [start, end, `${end}\n${start}`, `${start}${end}${start}${end}`, `${start}${start}${end}`, `${start}${end}${end}`]) {
    const { dir, file } = fixture(t, prior);
    const stat = fs.statSync(file);
    assert.throws(() => upsertManagedBlock(file, 'capture-guideline', 'New guidance'), /Unbalanced or duplicated/);
    assert.equal(fs.readFileSync(file, 'utf8'), prior);
    assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md']);
    assert.equal(fs.statSync(file).ino, stat.ino);
  }
});

test('generic ids and missing instruction files work without backing up a nonexistent file', t => {
  const { dir, file } = fixture(t, '');
  fs.unlinkSync(file);
  const result = upsertManagedBlock(file, 'other-rule', 'Invented rule');
  assert.equal(result.backup, undefined);
  assert.match(fs.readFileSync(file, 'utf8'), /jarvos:managed other-rule:start/);
  assert.deepEqual(fs.readdirSync(dir), ['AGENTS.md']);
  assert.throws(() => upsertManagedBlock(file, '../bad', 'x'), /Invalid managed block id/);
});

test('setup helper invocation embeds the canonical guideline and preserves existing instructions', t => {
  const prior = '# Invented workspace rules\nPreserve these bytes.\n';
  const { file } = fixture(t, prior);
  const script = path.join(ROOT, 'scripts/lib/upsert-capture-guideline.js');
  const run = () => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Backup:.*\nUpdated capture guideline:/);
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(content, `${prior}\n${start}\n## Keeping things\n\n${readCaptureGuideline()}\n${end}\n`);
  assert.match(run().stdout, /Unchanged capture guideline:/);
  for (const runtime of ['openclaw', 'hermes']) {
    const setup = fs.readFileSync(path.join(ROOT, `runtimes/${runtime}/setup.sh`), 'utf8');
    assert.ok(setup.includes('node "$REPO_ROOT/scripts/lib/upsert-capture-guideline.js" "$WORKSPACE/AGENTS.md"'));
  }
});

test('a symlinked instruction file is updated at its target and stays a symlink', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { upsertManagedBlock } = require('../src/managed-block');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-block-link-'));
  try {
    const target = path.join(root, 'shared', 'AGENTS.md');
    const link = path.join(root, 'harness', 'AGENTS.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(target, '# Shared test instructions\n');
    fs.symlinkSync(target, link);
    const result = upsertManagedBlock(link, 'capture-guideline', '## Keeping things\n\nA test guideline.');
    assert.equal(result.changed, true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.match(fs.readFileSync(target, 'utf8'), /# Shared test instructions\n\n<!-- jarvos:managed capture-guideline:start -->\n## Keeping things\n\nA test guideline\.\n<!-- jarvos:managed capture-guideline:end -->\n$/);
    assert.equal(path.dirname(result.backup), path.dirname(fs.realpathSync(target)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
