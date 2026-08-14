'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGINS,
  CONTENT_ORIGIN_BASES,
  normalizeContentOrigin,
  validateUserSourceReceipt,
  humanEvidenceEligible,
  resolveLegacyOrigin,
} = require('../bridge/provenance/src/content-origin-contract');
const {
  EVIDENCE_PROJECTION_VERSION,
  projectEvidenceRecord,
  projectEvidenceBatch,
  readEvidenceProjection,
} = require('../bridge/provenance/src/content-origin-evidence');

function digest(value) {
  return crypto.createHash('sha256').update(String(value).trim().replace(/\r\n/g, '\n')).digest('hex');
}

function receipt(sourceText, contentText, captureEventId = 'capture-1') {
  return {
    capture_event_id: captureEventId,
    actor: 'user',
    source_digest: digest(sourceText),
    content_digest: digest(contentText),
  };
}

function resolveSource(sourceText, captureEventId = 'capture-1') {
  return () => ({
    capture_event_id: captureEventId,
    actor: 'user',
    text: sourceText,
  });
}

test('publishes the closed origin and basis vocabulary', () => {
  assert.equal(CONTENT_ORIGIN_SCHEMA_VERSION, 'jarvos-content-origin/v1');
  assert.deepEqual(CONTENT_ORIGINS, ['human', 'assistant', 'mixed', 'unknown']);
  assert.deepEqual(CONTENT_ORIGIN_BASES, [
    'verbatim_user',
    'user_derived',
    'assistant_generated',
    'mixed_composition',
    'unknown',
    'legacy_author',
  ]);
});

test('round-trips valid explicit origin and basis pairs', () => {
  const cases = [
    ['assistant', 'assistant_generated'],
    ['mixed', 'mixed_composition'],
    ['unknown', 'unknown'],
  ];

  for (const [content_origin, content_origin_basis] of cases) {
    const result = normalizeContentOrigin({ content_origin, content_origin_basis });
    assert.equal(result.content_origin, content_origin);
    assert.equal(result.content_origin_basis, content_origin_basis);
    assert.equal(result.schema_version, CONTENT_ORIGIN_SCHEMA_VERSION);
  }
});

test('accepts verbatim and faithful user-derived content with a receipt-bound source', () => {
  const sourceText = 'I want to understand how matrix multiplication shapes complex systems.';
  const verbatim = normalizeContentOrigin({
    content_origin: 'human',
    content_origin_basis: 'verbatim_user',
    user_source: receipt(sourceText, sourceText),
  }, {
    content: sourceText,
    resolveUserSource: resolveSource(sourceText),
  });
  const derivedText = 'Andrew wants to understand how matrix multiplication shapes complex systems.';
  const derived = normalizeContentOrigin({
    content_origin: 'human',
    content_origin_basis: 'user_derived',
    user_source: receipt(sourceText, derivedText),
  }, {
    content: derivedText,
    resolveUserSource: resolveSource(sourceText),
  });

  assert.equal(verbatim.content_origin, 'human');
  assert.equal(derived.content_origin, 'human');
  assert.equal(humanEvidenceEligible(verbatim), true);
  assert.equal(humanEvidenceEligible(derived), true);
});

test('downgrades absent, unresolved, non-user, and digest-mismatched receipts to unknown', () => {
  const content = 'A generated idea should not seed ripeness.';
  const base = { content_origin: 'human', content_origin_basis: 'user_derived' };
  const cases = [
    base,
    { ...base, user_source: receipt('user text', content) },
    { ...base, user_source: { ...receipt('user text', content), actor: 'assistant' } },
    { ...base, user_source: { ...receipt('user text', content), content_digest: digest('different') } },
  ];

  for (const input of cases) {
    const result = normalizeContentOrigin(input, {
      content,
      resolveUserSource: resolveSource('user text', 'different-capture'),
    });
    assert.equal(result.content_origin, 'unknown');
    assert.equal(result.content_origin_basis, 'unknown');
    assert.equal(humanEvidenceEligible(result), false);
  }
});

test('runtime actor identity cannot turn assistant copy into human evidence', () => {
  const result = normalizeContentOrigin({
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
    source_agent: 'jarvis',
    actor: { type: 'assistant', name: 'jarvis' },
  });

  assert.equal(result.content_origin, 'assistant');
  assert.equal(humanEvidenceEligible(result), false);
});

test('resolves constrained legacy author fallback without rewriting the note', () => {
  assert.deepEqual(resolveLegacyOrigin({ author: 'andrew' }), {
    content_origin: 'human',
    content_origin_basis: 'legacy_author',
  });
  assert.deepEqual(resolveLegacyOrigin({ author: 'jarvis' }), {
    content_origin: 'assistant',
    content_origin_basis: 'legacy_author',
  });
  assert.deepEqual(resolveLegacyOrigin({ author: 'both' }), {
    content_origin: 'mixed',
    content_origin_basis: 'legacy_author',
  });
  assert.deepEqual(resolveLegacyOrigin({ author: 'andrew', source_agent: 'codex' }), {
    content_origin: 'unknown',
    content_origin_basis: 'unknown',
  });
});

test('strips deferred adoption state and preserves explicit unknown', () => {
  const result = normalizeContentOrigin({
    content_origin: 'unknown',
    content_origin_basis: 'unknown',
    content_adoption: { state: 'accepted' },
  });

  assert.equal(result.content_origin, 'unknown');
  assert.equal(result.content_origin_basis, 'unknown');
  assert.equal('content_adoption' in result, false);
});

test('projects clean evidence without marker or source-receipt text', () => {
  const content = 'assistant context about the user idea';
  const record = normalizeContentOrigin({
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
    user_source: receipt('private user text', content),
  }, { content });
  const projection = projectEvidenceRecord({
    ...record,
    clean_text: content,
    marker_text: '<!-- jarvos-content-origin secret -->',
  });
  const batch = projectEvidenceBatch([{ ...record, clean_text: content }]);
  const read = readEvidenceProjection(projection);

  assert.equal(projection.projection_version, EVIDENCE_PROJECTION_VERSION);
  assert.equal(projection.clean_text, content);
  assert.equal(projection.human_evidence_eligible, false);
  assert.equal('user_source' in projection, false);
  assert.equal(JSON.stringify(projection).includes('jarvos-content-origin secret'), false);
  assert.equal(batch.length, 1);
  assert.equal(read.ok, true);
  assert.equal(read.record.clean_text, content);
});
