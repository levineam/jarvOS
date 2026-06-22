const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractLinks,
  extractSpineActivity,
  buildConceptIndex,
  relatedByConcept,
  exploreCandidates,
  synthesize,
} = require('../bridge/synthesis/src/spine-synthesis');

const JOURNALS = [
  { date: '2026-05-20', content: '## 📝 Notes\n- [[A]]\n- [[B]]' },
  { date: '2026-05-19', content: '## 📝 Notes\n- [[C]]' },
];
const NOTES = [
  { title: 'A', concepts: ['newsletter', 'pricing'] },
  { title: 'B', concepts: ['newsletter', 'knowledge-base'] },
  { title: 'C', concepts: ['knowledge-base', 'retrieval'] },
];

test('extractLinks parses wiki-links (alias/heading stripped)', () => {
  assert.deepEqual(extractLinks('- [[A]] and [[B|x]] and [[C#h]]'), ['A', 'B', 'C']);
});

test('extractSpineActivity collects linked notes most-recent-first with their days', () => {
  const act = extractSpineActivity(JOURNALS);
  assert.deepEqual(act.notes, ['A', 'B', 'C']);
  assert.deepEqual([...act.noteDays.get('A')], ['2026-05-20']);
  assert.deepEqual([...act.noteDays.get('C')], ['2026-05-19']);
});

test('relatedByConcept links notes sharing concepts', () => {
  const index = buildConceptIndex(NOTES);
  const edges = relatedByConcept(['A', 'B', 'C'], index);
  // A-B share "newsletter"; B-C share "knowledge-base"; A-C share nothing.
  const pairs = edges.map((e) => `${e.a}-${e.b}:${e.shared}`).sort();
  assert.deepEqual(pairs, ['A-B:1', 'B-C:1']);
});

test('exploreCandidates surfaces bridge concepts, ranked by recency/breadth', () => {
  const act = extractSpineActivity(JOURNALS);
  const index = buildConceptIndex(NOTES);
  const cands = exploreCandidates(act, index, { limit: 5 });
  const concepts = cands.map((c) => c.concept);
  // both "newsletter" (A,B) and "knowledge-base" (B,C) bridge two recent notes;
  // "pricing"/"retrieval" touch only one recent note and are excluded.
  assert.deepEqual(concepts.sort(), ['knowledge-base', 'newsletter']);
  // knowledge-base spans two days (05-19 + 05-20) so it outranks newsletter (one day).
  assert.equal(cands[0].concept, 'knowledge-base');
});

test('synthesize runs end-to-end from journals + concept map', () => {
  const out = synthesize({ journalEntries: JOURNALS, notes: NOTES, limit: 3 });
  assert.deepEqual(out.activeNotes, ['A', 'B', 'C']);
  assert.ok(out.explore.length >= 1);
  assert.ok(out.related.length >= 1);
});
