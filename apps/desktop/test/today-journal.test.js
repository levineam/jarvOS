'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brief, localDate } = require('../server/today');

for (const heading of ['## 📓 Journal Entry', '## Journal Entry', '## 📋 Journal Entry', '## 📓 Journal', null, 'both']) {
  test(`Today reads Journal heading ${heading}`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-journal-heading-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, `${localDate()}.md`);
    fs.writeFileSync(file, heading === 'both' ? '## Journal Entry\n- Legacy sample\n\n## 📓 Journal\n- Current sample\n' : heading ? `${heading}  \n- Invented reflection\n` : '## Other\n- Other sample\n');
    const today = await brief({ vault: { journalDir: root } });
    assert.deepEqual(today.journalEntry, heading === 'both' ? ['Current sample'] : heading ? ['Invented reflection'] : []);
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

test('Today reads the real Journal section, not a fenced example heading', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-today-fence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, `${localDate()}.md`), ['## 📝 Notes', '```', '## 📓 Journal', '```', '', '## 📓 Journal Entry', '- A test reflection', ''].join('\n'));
  const { parseSections } = require('../server/adapters/journal');
  const titles = parseSections(fs.readFileSync(path.join(root, `${localDate()}.md`), 'utf8')).map((s) => s.title);
  assert.deepEqual(titles, ['Notes', 'Journal Entry']);
  const result = await brief({ vault: { journalDir: root } });
  assert.deepEqual(result.journalEntry, ['A test reflection']);
});
