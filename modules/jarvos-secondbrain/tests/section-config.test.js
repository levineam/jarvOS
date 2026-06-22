const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getJournalSections,
  getSectionHeading,
  isSectionEnabled,
  resolveConfiguredHeading,
} = require('../packages/jarvos-secondbrain-journal/src/section-config');

function writeConfig(sections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-secfg-'));
  const f = path.join(dir, 'journal-module.json');
  fs.writeFileSync(f, JSON.stringify({ sections: { required: sections } }));
  return f;
}

test('defaults resolve when no config override is given', () => {
  assert.equal(getSectionHeading('notes'), '## 📝 Notes');
  assert.equal(getSectionHeading('ideas'), '## 💡 Ideas');
  assert.equal(getSectionHeading('nope', { fallback: '## X' }), '## X');
});

test('getSectionHeading follows a renamed heading in config', () => {
  const configFile = writeConfig([{ id: 'notes', heading: '## 📓 Linked Notes' }]);
  assert.equal(getSectionHeading('notes', { configFile }), '## 📓 Linked Notes');
});

test('isSectionEnabled respects enabled:false (e.g. Apple Reminders disabled)', () => {
  const configFile = writeConfig([
    { id: 'notes', heading: '## 📝 Notes' },
    { id: 'apple-reminders', heading: '## 🔔 Apple Reminders', enabled: false },
  ]);
  assert.equal(isSectionEnabled('notes', { configFile }), true);
  assert.equal(isSectionEnabled('apple-reminders', { configFile }), false);
});

test('resolveConfiguredHeading maps a hardcoded default onto the configured heading', () => {
  const configFile = writeConfig([{ id: 'notes', heading: '## 📓 Linked Notes' }]);
  // a writer still holding the default '## 📝 Notes' gets the renamed heading
  assert.equal(resolveConfiguredHeading('## 📝 Notes', { configFile }), '## 📓 Linked Notes');
  // unknown headings pass through unchanged
  assert.equal(resolveConfiguredHeading('## 🤷 Unknown', { configFile }), '## 🤷 Unknown');
});

test('getJournalSections returns the ordered section list', () => {
  const sections = getJournalSections();
  assert.ok(sections.find((s) => s.id === 'notes'));
  assert.ok(sections.every((s) => s.heading && typeof s.enabled === 'boolean'));
});
