const test = require('node:test');
const assert = require('node:assert/strict');

const { noteMatchesDate } = require('../bridge/provenance/src/journal-note-audit');

// Format a Date to YYYY-MM-DD the way findNotesForDate does (here: simple UTC slice for the test).
const fmt = (d) => new Date(d).toISOString().slice(0, 10);

const TODAY = '2026-05-20';
const EARLIER = new Date('2026-05-10T12:00:00Z');
const TODAY_DATE = new Date('2026-05-20T12:00:00Z');

test('note created today matches', () => {
  assert.equal(noteMatchesDate({ createdAt: TODAY_DATE, updated: null }, TODAY, fmt), true);
});

test('note created earlier but UPDATED today matches (touched, not just new)', () => {
  assert.equal(noteMatchesDate({ createdAt: EARLIER, updated: '2026-05-20' }, TODAY, fmt), true);
});

test('note created earlier and not updated today does NOT match when updated frontmatter is authoritative', () => {
  assert.equal(noteMatchesDate({ createdAt: EARLIER, updated: '2026-05-10' }, TODAY, fmt), false);
});

test('note with no updated frontmatter falls back to mtime for manual edits', () => {
  assert.equal(noteMatchesDate({ createdAt: EARLIER, updated: null, mtime: TODAY_DATE }, TODAY, fmt), true);
  assert.equal(noteMatchesDate({ createdAt: EARLIER, updated: null, mtime: EARLIER }, TODAY, fmt), false);
  assert.equal(noteMatchesDate({ createdAt: TODAY_DATE, updated: null }, TODAY, fmt), true);
});
