const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyJournalHealth,
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

const TEST_DATE = '2026-01-02';

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n— Edited by Jarvis|$)`;
  const match = markdown.match(new RegExp(pattern));
  return match ? match[1].trim() : '';
}

/** A journal entry in the old shape, with real content in the removed sections. */
function legacyEntry() {
  return [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    "## 📅 Today's Calendar",
    '- 9:00 AM Standup',
    '',
    '## 📝 Notes',
    '- [[Existing Note]]',
    '',
    '## 💡 Ideas',
    '- an idea worth keeping',
    '',
    '## 📓 Journal Entry',
    'Today I did things.',
    '',
    '## 🔔 Apple Reminders',
    '- Schedule teeth cleaning — 10:00 AM',
    '',
    '## 📎 Paperclip Inbox',
    '- (Paperclip API unavailable)',
    '',
  ].join('\n');
}

const stubFetchers = { projects: () => '- [[Alpha]]\n- [[Beta]]' };

function render(original, { fetchers = stubFetchers, date = TEST_DATE } = {}) {
  const config = loadConfig();
  const normalized = normalizeSections(original, date, config, { fetchers });
  return renderJournal(date, config, normalized);
}

test('the shipped contract is the simplified journal: Projects, Notes, Ideas, Journal Entry', () => {
  const config = loadConfig();
  assert.deepEqual(
    config.sections.required.map((section) => section.id),
    ['projects', 'notes', 'ideas', 'journal-entry'],
  );
  assert.deepEqual(config.sections.optional, []);
});

test('the removed sections are declared as dropped, not migrated', () => {
  const legacy = loadConfig().migration.legacySections;
  for (const id of ['todays-calendar', 'apple-reminders', 'paperclip-inbox']) {
    assert.equal(legacy[id].action, 'drop', `${id} should be dropped`);
    assert.equal(legacy[id].migrateContentTo, undefined, `${id} must not migrate content`);
  }
});

test('Calendar, Reminders, and Paperclip Inbox are gone from a maintained entry', () => {
  const output = render(legacyEntry());
  assert.ok(!output.includes("## 📅 Today's Calendar"));
  assert.ok(!output.includes('## 🔔 Apple Reminders'));
  assert.ok(!output.includes('## 📎 Paperclip Inbox'));
});

test('dropped content is discarded rather than folded into Notes', () => {
  const notes = sectionBody(render(legacyEntry()), '## 📝 Notes');

  // The user's own note survives untouched.
  assert.match(notes, /\[\[Existing Note\]\]/);

  // None of the dropped snapshots leak in, under any label.
  assert.ok(!notes.includes('Standup'));
  assert.ok(!notes.includes('teeth cleaning'));
  assert.ok(!notes.includes('Paperclip API unavailable'));
  assert.ok(!notes.includes('migrated'));
});

test('content the user actually wrote is preserved', () => {
  const output = render(legacyEntry());
  assert.match(sectionBody(output, '## 💡 Ideas'), /an idea worth keeping/);
  assert.match(sectionBody(output, '## 📓 Journal Entry'), /Today I did things\./);
});

test('the Projects section renders ongoing projects as wiki-links', () => {
  const output = render(legacyEntry());
  assert.match(output, /## 🚀 Projects/);
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- [[Alpha]]\n- [[Beta]]');
});

test('Projects renders first, ahead of Notes', () => {
  const output = render(legacyEntry());
  assert.ok(output.indexOf('## 🚀 Projects') < output.indexOf('## 📝 Notes'));
});

test('Projects is refreshed on a backfilled date, unlike day-scoped sources', () => {
  const older = [
    '---',
    'journal: Journal',
    'journal-date: 2025-12-01',
    '---',
    '',
    '## 🚀 Projects',
    '- [[Stale Project]]',
    '',
    '## 📝 Notes',
    '- [[Note]]',
    '',
  ].join('\n');

  const output = render(older, { date: '2025-12-01' });
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- [[Alpha]]\n- [[Beta]]');
});

test('a failing projects source degrades visibly instead of emptying the section', () => {
  const output = render(legacyEntry(), {
    fetchers: {
      projects: () => {
        throw new Error('vault unavailable');
      },
    },
  });
  // The fetcher itself swallows errors; a thrown fetcher must not take the
  // whole entry down, and the section must still exist.
  assert.match(output, /## 🚀 Projects/);
});

test('the empty-projects line does not read as real content to the blank-journal guard', () => {
  // classifyJournalHealth uses meaningfulBodyChars to spot a wiped journal.
  // A section that always emits text would mask that, so the Projects
  // empty/unavailable lines must be recognised as generated placeholders.
  const config = loadConfig();
  for (const line of ['- No ongoing projects', '- (projects unavailable)']) {
    const rendered = renderJournal(TEST_DATE, config, normalizeSections('', TEST_DATE, config, {
      fetchers: { projects: () => line },
    }));
    const health = classifyJournalHealth({ existed: true, markdown: rendered, knownGood: null });
    assert.equal(health.metrics.meaningfulBodyChars, 0, `${line} should not count as content`);
  }
});

test('a real project list does count as content', () => {
  const config = loadConfig();
  const rendered = renderJournal(TEST_DATE, config, normalizeSections('', TEST_DATE, config, {
    fetchers: { projects: () => '- [[Alpha]]' },
  }));
  const health = classifyJournalHealth({ existed: true, markdown: rendered, knownGood: null });
  assert.ok(health.metrics.meaningfulBodyChars > 0);
});

test('an entry already in the new shape is left alone', () => {
  const current = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[Alpha]]',
    '- [[Beta]]',
    '',
    '## 📝 Notes',
    '- [[Note]]',
    '',
    '## 💡 Ideas',
    '- idea',
    '',
    '## 📓 Journal Entry',
    'entry',
    '',
  ].join('\n');

  const output = render(current);
  assert.match(sectionBody(output, '## 📝 Notes'), /\[\[Note\]\]/);
  assert.equal(sectionBody(output, '## 💡 Ideas'), '- idea');
  assert.ok(!output.includes('migrated'));
});
