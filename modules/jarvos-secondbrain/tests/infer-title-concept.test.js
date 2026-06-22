const test = require('node:test');
const assert = require('node:assert/strict');

const { buildThreePackagePlan } = require('../packages/jarvos-ambient/src/routing');

function noteTitle(text) {
  return buildThreePackagePlan({ trigger: 'note', text }).noteTitle;
}

test('note titles strip the capture trigger phrase', () => {
  assert.equal(noteTitle('take a note that the deploy needs a feature flag'), 'the deploy needs a feature flag');
  assert.equal(noteTitle('Note: Package naming decision'), 'Package naming decision');
});

test('note titles take the first clause, not the whole run-on sentence', () => {
  const t = noteTitle('We picked the stateless architecture. The rest is detail and follows below.');
  assert.equal(t, 'We picked the stateless architecture');
});

test('note titles are capped with an ellipsis when very long', () => {
  const long = 'This is an extremely long single clause that just keeps going well beyond the eighty character limit without any sentence break at all here';
  const t = noteTitle(long);
  assert.ok(t.length <= 81, `title too long: ${t.length}`);
  assert.ok(t.endsWith('…'));
});

test('an explicit title is preserved (minus any leading keyword)', () => {
  assert.equal(buildThreePackagePlan({ trigger: 'note', text: 'whatever', title: 'My Chosen Title' }).noteTitle, 'My Chosen Title');
});
