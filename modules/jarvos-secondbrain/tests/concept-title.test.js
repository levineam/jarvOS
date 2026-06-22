const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripTriggers,
  heuristicTitle,
  isChatFragmentTitle,
  cleanModelTitle,
  generateConceptTitle,
} = require('../packages/jarvos-secondbrain-notes/src/concept-title');

test('stripTriggers removes capture trigger prefixes', () => {
  assert.equal(stripTriggers('Note: Package naming decision'), 'Package naming decision');
  assert.equal(stripTriggers('I have an idea: newsletter tiers'), 'newsletter tiers');
  assert.equal(stripTriggers('remember that the deploy needs a flag'), 'the deploy needs a flag');
});

test('heuristicTitle returns a concise first clause, capped', () => {
  const t = heuristicTitle('Note: We should split newsletters into free, industry, and custom tiers. More detail follows.');
  assert.ok(!/^Note:/i.test(t));
  assert.ok(t.length <= 80);
  assert.ok(!/[.]$/.test(t), 'no trailing period');
});

test('isChatFragmentTitle flags conversational openers and sentence-like titles', () => {
  assert.equal(isChatFragmentTitle("Also, I don't know if we should bundle this work"), true);
  assert.equal(isChatFragmentTitle('Actually maybe later'), true);
  assert.equal(isChatFragmentTitle('Package Naming Decision'), false);
});

test('cleanModelTitle strips quotes, preamble, trailing punctuation', () => {
  assert.equal(cleanModelTitle('Title: "Custom Newsletter Tiers."'), 'Custom Newsletter Tiers');
  assert.equal(cleanModelTitle('  Concept-First Titles \n extra'), 'Concept-First Titles');
});

test('generateConceptTitle uses a good LLM title', async () => {
  const llm = async () => 'Package Naming Decision';
  const r = await generateConceptTitle('Note: we decided how to name the packages', { llm });
  assert.equal(r.title, 'Package Naming Decision');
  assert.equal(r.source, 'llm');
});

test('generateConceptTitle falls back to heuristic when the LLM is unavailable', async () => {
  const llm = async () => { throw new Error('ollama down'); };
  const r = await generateConceptTitle('Note: Package naming decision rationale', { llm });
  assert.equal(r.source, 'heuristic');
  assert.ok(/Package naming decision/i.test(r.title));
});

test('generateConceptTitle rejects a chat-fragment LLM title and falls back', async () => {
  const llm = async () => 'Also, I was just thinking about the thing we discussed';
  const r = await generateConceptTitle('We should split newsletters into tiers', { llm });
  assert.equal(r.source, 'heuristic');
  assert.ok(!isChatFragmentTitle(r.title));
});

test('generateConceptTitle handles empty input without throwing', async () => {
  const r = await generateConceptTitle('', { llm: async () => 'x' });
  assert.equal(r.source, 'fallback-empty');
  assert.ok(r.title.startsWith('Captured note'));
});
