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
