'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROJECTS_CONTEXT_REFRESH_CONTRACT,
  computeStampDigest,
  createStamp,
  envelopeHasContent,
  isMetadataToken,
  stampsEqual,
  validateEnvelope,
  validateStamp,
} = require('../src/projects-context-refresh.js');

const FINGERPRINT = 'f'.repeat(64);
const MARKDOWN = '## Projects Context\n\n- Contract: jarvos.projects-context/v1\n';

function validStamp(overrides = {}) {
  return createStamp({
    providerRevision: 'beads:generation-42',
    profileRevision: 'orientation-v2',
    registryWatermark: 'registry-provider:evidence-revision-7',
    activityWatermark: 'activity-provider:evidence-revision',
    workRevision: `sha256:${'a'.repeat(64)}`,
    focusEpoch: 'focus-epoch:7',
    ...overrides,
  });
}

function envelope(overrides = {}) {
  const stamp = overrides.stamp === undefined ? validStamp() : overrides.stamp;
  const base = {
    contract: PROJECTS_CONTEXT_REFRESH_CONTRACT,
    status: 'refreshed',
    stamp,
    stampDigest: stamp === null ? null : computeStampDigest(stamp),
    fingerprint: FINGERPRINT,
    markdown: MARKDOWN,
  };
  return { ...base, ...overrides };
}

test('accepts real colon-delimited provider/session watermark shapes', () => {
  for (const value of [
    'activity-provider:evidence-revision',
    `sha256:${'a'.repeat(64)}`,
    'focus-epoch:7',
    'registry-provider:evidence-revision-7',
    'beads:generation-42',
    'orientation-v2',
  ]) {
    assert.equal(isMetadataToken(value), true, `${value} should be a valid metadata token`);
  }
  const result = validateStamp(validStamp());
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('rejects path, URL, control, and secret-shaped token values', () => {
  const rejected = [
    '../etc/passwd',
    '/absolute/path',
    'a\\b',
    'https://evil.example.com/x',
    'scheme://value',
    'contains control\u0000char',
    'has space value',
    'sk-abcdefghijklmnopqrstuvwx',
    'xoxb-1111111111-2222222222',
    'AKIAABCDEFGHIJKLMNOP',
    'bearer:abcdefghijklmnop',
    'api_key:abcdefghijklmnop',
    '',
    'a'.repeat(129),
  ];
  for (const value of rejected) {
    assert.equal(isMetadataToken(value), false, `${JSON.stringify(value)} should be rejected`);
  }
  // Regression guard for the rejected transport's over-broad substring
  // check: an ordinary value containing the word "token" must still pass.
  assert.equal(isMetadataToken('session-token-provider:evidence-9'), true);
});

test('stamp validation requires the first, second, third, and sixth fields; nullable fourth/fifth', () => {
  const missingRequired = validateStamp({ ...validStamp(), providerRevision: null });
  assert.equal(missingRequired.ok, false);
  const missingFocus = validateStamp({ ...validStamp(), focusEpoch: null });
  assert.equal(missingFocus.ok, false);
  const nullableOk = validateStamp({ ...validStamp(), activityWatermark: null, workRevision: null });
  assert.equal(nullableOk.ok, true, nullableOk.errors.join('; '));
  const extraField = validateStamp({ ...validStamp(), extra: 'x' });
  assert.equal(extraField.ok, false);
});

test('digest tamper is rejected: stampDigest must equal the recomputed normalized-stamp digest', () => {
  const stamp = validStamp();
  const tampered = envelope({ stamp, stampDigest: computeStampDigest({ ...stamp, focusEpoch: 'focus-epoch:8' }) });
  const result = validateEnvelope(tampered);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /does not match the normalized stamp/);
});

test('envelope contract and status fields are exact and statuses have bounded semantics', () => {
  assert.equal(validateEnvelope(envelope()).ok, true);
  assert.equal(validateEnvelope(envelope({ status: 'partial' })).ok, true);
  assert.equal(validateEnvelope(envelope({ contract: 'other/v1' })).ok, false);
  assert.equal(validateEnvelope(envelope({ status: 'pending' })).ok, false);
  for (const status of ['refreshed', 'partial', 'unchanged']) {
    assert.equal(validateEnvelope(envelope({ status, markdown: status === 'unchanged' ? null : MARKDOWN })).ok, true);
  }
});

test('refreshed/partial envelopes require 1..6000 char markdown beginning with the Projects Context heading', () => {
  assert.equal(validateEnvelope(envelope()).ok, true);
  assert.equal(validateEnvelope(envelope({ status: 'partial' })).ok, true);
  assert.equal(validateEnvelope(envelope({ markdown: null })).ok, false);
  assert.equal(validateEnvelope(envelope({ markdown: 'no heading here' })).ok, false);
  assert.equal(validateEnvelope(envelope({ markdown: '' })).ok, false);
  assert.equal(validateEnvelope(envelope({ markdown: `${MARKDOWN}${'x'.repeat(6001)}` })).ok, false);
  const maxSize = `## Projects Context${'x'.repeat(6000 - '## Projects Context'.length)}`;
  assert.equal(maxSize.length, 6000);
  assert.equal(validateEnvelope(envelope({ markdown: maxSize })).ok, true);
});

test('unchanged status requires a valid stamp/digest/fingerprint and null markdown', () => {
  assert.equal(validateEnvelope(envelope({ status: 'unchanged', markdown: null })).ok, true);
  assert.equal(validateEnvelope(envelope({ status: 'unchanged', markdown: MARKDOWN })).ok, false);
});

test('unavailable status requires every other field to be null and carries no private reason', () => {
  const clean = {
    contract: PROJECTS_CONTEXT_REFRESH_CONTRACT,
    status: 'unavailable',
    stamp: null,
    stampDigest: null,
    fingerprint: null,
    markdown: null,
  };
  assert.equal(validateEnvelope(clean).ok, true);
  assert.equal(validateEnvelope({ ...clean, stamp: validStamp() }).ok, false);
  assert.equal(validateEnvelope({ ...clean, fingerprint: FINGERPRINT }).ok, false);
  assert.equal(validateEnvelope({ ...clean, markdown: MARKDOWN }).ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(clean, 'reason'), false);
});

test('extra envelope fields are rejected', () => {
  const withExtra = { ...envelope(), reason: 'internal diagnostic' };
  const result = validateEnvelope(withExtra);
  assert.equal(result.ok, false);
});

test('fingerprint must be a lowercase 64-hex digest', () => {
  assert.equal(validateEnvelope(envelope({ fingerprint: 'not-hex' })).ok, false);
  assert.equal(validateEnvelope(envelope({ fingerprint: FINGERPRINT.toUpperCase() })).ok, false);
  assert.equal(validateEnvelope(envelope({ fingerprint: FINGERPRINT.slice(0, 63) })).ok, false);
});

test('envelopeHasContent is true only for refreshed/partial', () => {
  assert.equal(envelopeHasContent(envelope({ status: 'refreshed' })), true);
  assert.equal(envelopeHasContent(envelope({ status: 'partial' })), true);
  assert.equal(envelopeHasContent(envelope({ status: 'unchanged', markdown: null })), false);
  assert.equal(envelopeHasContent({ status: 'unavailable' }), false);
});

test('stampsEqual compares normalized stamp fields, treating undefined as null', () => {
  const stamp = validStamp();
  assert.equal(stampsEqual(stamp, { ...stamp }), true);
  assert.equal(stampsEqual(stamp, { ...stamp, focusEpoch: 'focus-epoch:8' }), false);
  assert.equal(stampsEqual(null, null), true);
});

test('createStamp throws for an invalid field and normalizes omitted nullable fields', () => {
  assert.throws(() => createStamp({ providerRevision: 'x/y' }));
  const stamp = createStamp({
    providerRevision: 'beads:generation-1',
    profileRevision: 'orientation-v2',
    registryWatermark: 'registry:1',
    focusEpoch: 'focus-epoch:1',
  });
  assert.equal(stamp.activityWatermark, null);
  assert.equal(stamp.workRevision, null);
});
