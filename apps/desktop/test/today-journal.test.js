'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brief, localDate } = require('../server/today');
const { appendBullet } = require('../server/adapters/journal');

for (const heading of ['## 📓 Journal Entry', '## Journal Entry', '## 📋 Journal Entry', '## 📓 Journal', null, 'both']) {
  test(`Today and append accept Journal heading ${heading}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-journal-heading-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, `${localDate()}.md`);
    fs.writeFileSync(file, heading === 'both' ? '## Journal Entry\n- Legacy sample\n\n## 📓 Journal\n- Current sample\n' : heading ? `${heading}  \n- Invented reflection\n` : '## Other\n- Other sample\n');
    appendBullet(root, localDate(), '📓 Journal Entry', 'New invented reflection');
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal((raw.match(/^## (?:📓 Journal(?: Entry)?|Journal Entry|📋 Journal Entry) *$/gm) || []).length, heading === 'both' ? 2 : 1);
    const today = await brief({ vault: { journalDir: root } });
    assert.deepEqual(today.journalEntry, ['New invented reflection', ...(heading === 'both' ? ['Current sample'] : heading ? ['Invented reflection'] : [])]);
  });
}

test('Desktop journal headings mirror the secondbrain section config', () => {
  const { JOURNAL_HEADINGS } = require('../server/journal-headings');
  const { headingsForSection } = require('../../../modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/section-config');
  assert.deepEqual([...JOURNAL_HEADINGS], headingsForSection('journal-entry'));
});

test('an installed copy of apps/desktop loads the journal readers without the repo around it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-installed-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'versions', 'test', 'desktop');
  fs.cpSync(path.join(__dirname, '..'), app, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', "require('./server/today'); require('./server/adapters/journal');"], { cwd: app, encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') } });
  assert.equal(result.status, 0, result.stderr);
});
