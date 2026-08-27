'use strict';

// Pure validator/state-helper for the host-issued Projects context refresh
// envelope. This module performs no I/O and holds no cache: a native hook
// invokes an external bridge, then hands the raw JSON response here before
// ever letting it reach model-visible output.

const PROJECTS_CONTEXT_REFRESH_CONTRACT = 'jarvos.projects-context-refresh/v1';
const REFRESH_STATUSES = Object.freeze(['refreshed', 'partial', 'unchanged', 'unavailable']);
const ENVELOPE_FIELDS = Object.freeze(['contract', 'status', 'stamp', 'stampDigest', 'fingerprint', 'markdown']);
const STAMP_FIELDS = Object.freeze([
  'providerRevision', 'profileRevision', 'registryWatermark', 'activityWatermark', 'workRevision', 'focusEpoch',
]);
const STAMP_REQUIRED_FIELDS = Object.freeze(['providerRevision', 'profileRevision', 'registryWatermark', 'focusEpoch']);
const STAMP_NULLABLE_FIELDS = Object.freeze(['activityWatermark', 'workRevision']);

// Real jarvOS watermarks are colon-delimited (`sha256:<digest>`,
// `activity-provider:evidence-revision`, focus epochs, etc). The charset
// deliberately excludes `/` and `\`, so any path or URL (which always
// contains `/`) already fails this shape -- no separate scheme/path check is
// needed.
const METADATA_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MARKDOWN_CHARS = 6000;
const MARKDOWN_HEADING = '## Projects Context';
const SHA256_HEX = /^[a-f0-9]{64}$/;

// Explicit credential-shaped values are rejected by label prefix or known
// secret-key shape, never by a broad substring match: an ordinary watermark
// like "activity-provider:evidence-revision" must keep validating even
// though a naive substring rule might trip on words like "token".
const CREDENTIAL_LABEL_PREFIX = /^(?:bearer|api[-_]?key|apikey|secret|password|passwd|credential|authorization|auth)s?:/i;
const CREDENTIAL_SHAPE = /^(?:sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,})$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function isMetadataToken(value) {
  return typeof value === 'string'
    && METADATA_TOKEN.test(value)
    && !CREDENTIAL_LABEL_PREFIX.test(value)
    && !CREDENTIAL_SHAPE.test(value);
}

function isSha256Hex(value) {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function validateStamp(stamp) {
  const errors = [];
  if (!isPlainObject(stamp) || !hasExactKeys(stamp, STAMP_FIELDS)) {
    return { ok: false, errors: [`stamp must contain only: ${STAMP_FIELDS.join(', ')}`] };
  }
  for (const field of STAMP_REQUIRED_FIELDS) {
    if (!isMetadataToken(stamp[field])) errors.push(`stamp.${field} must be a bounded opaque metadata token`);
  }
  for (const field of STAMP_NULLABLE_FIELDS) {
    if (stamp[field] !== null && !isMetadataToken(stamp[field])) {
      errors.push(`stamp.${field} must be null or a bounded opaque metadata token`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Stable, cache-free digest of a validated-shape stamp. Field order is fixed
// (sorted) so two callers that build the same logical stamp always agree on
// the digest.
function computeStampDigest(stamp) {
  const ordered = {};
  for (const field of [...STAMP_FIELDS].sort()) ordered[field] = stamp[field] === undefined ? null : stamp[field];
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function createStamp(fields = {}) {
  const stamp = {};
  for (const field of STAMP_FIELDS) stamp[field] = fields[field] === undefined ? null : fields[field];
  const result = validateStamp(stamp);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return stamp;
}

function isValidMarkdown(markdown) {
  return typeof markdown === 'string'
    && markdown.length >= 1
    && markdown.length <= MAX_MARKDOWN_CHARS
    && markdown.startsWith(MARKDOWN_HEADING);
}

function validateEnvelope(envelope) {
  const errors = [];
  if (!isPlainObject(envelope) || !hasExactKeys(envelope, ENVELOPE_FIELDS)) {
    return { ok: false, errors: [`envelope must contain only: ${ENVELOPE_FIELDS.join(', ')}`] };
  }
  if (envelope.contract !== PROJECTS_CONTEXT_REFRESH_CONTRACT) {
    errors.push(`envelope.contract must be ${PROJECTS_CONTEXT_REFRESH_CONTRACT}`);
  }
  if (!REFRESH_STATUSES.includes(envelope.status)) {
    errors.push(`envelope.status must be one of: ${REFRESH_STATUSES.join(', ')}`);
  }

  if (envelope.status === 'unavailable') {
    if (envelope.stamp !== null) errors.push('unavailable envelope stamp must be null');
    if (envelope.stampDigest !== null) errors.push('unavailable envelope stampDigest must be null');
    if (envelope.fingerprint !== null) errors.push('unavailable envelope fingerprint must be null');
    if (envelope.markdown !== null) errors.push('unavailable envelope markdown must be null');
    return { ok: errors.length === 0, errors };
  }

  const stampResult = validateStamp(envelope.stamp);
  if (!stampResult.ok) {
    errors.push(...stampResult.errors);
  } else if (!isSha256Hex(envelope.stampDigest)) {
    errors.push('envelope.stampDigest must be a lowercase 64-hex digest');
  } else if (envelope.stampDigest !== computeStampDigest(envelope.stamp)) {
    errors.push('envelope.stampDigest does not match the normalized stamp');
  }

  if (!isSha256Hex(envelope.fingerprint)) {
    errors.push('envelope.fingerprint must be a lowercase 64-hex digest');
  }

  if (envelope.status === 'unchanged') {
    if (envelope.markdown !== null) errors.push('unchanged envelope markdown must be null');
  } else if (!isValidMarkdown(envelope.markdown)) {
    errors.push(`refreshed/partial envelope markdown must be 1-${MAX_MARKDOWN_CHARS} chars beginning with "${MARKDOWN_HEADING}"`);
  }

  return { ok: errors.length === 0, errors };
}

function stampsEqual(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return a === b;
  return STAMP_FIELDS.every((field) => (a[field] ?? null) === (b[field] ?? null));
}

// Whether a validated envelope carries new Projects markdown to inject.
function envelopeHasContent(envelope) {
  return envelope?.status === 'refreshed' || envelope?.status === 'partial';
}

module.exports = {
  PROJECTS_CONTEXT_REFRESH_CONTRACT,
  REFRESH_STATUSES,
  ENVELOPE_FIELDS,
  STAMP_FIELDS,
  STAMP_REQUIRED_FIELDS,
  STAMP_NULLABLE_FIELDS,
  METADATA_TOKEN,
  MAX_MARKDOWN_CHARS,
  MARKDOWN_HEADING,
  SHA256_HEX,
  isMetadataToken,
  isSha256Hex,
  validateStamp,
  computeStampDigest,
  createStamp,
  validateEnvelope,
  stampsEqual,
  envelopeHasContent,
};
