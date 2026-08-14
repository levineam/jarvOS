'use strict';

// Public, data-free contract for the private Ripeness producer. It deliberately
// knows nothing about vault locations, source adapters, calibration, or content
// policy; consumers pass only a parsed artifact and the effective instant.

const crypto = require('crypto');
const { CONTENT_ORIGINS } = require('./content-origin-contract');

const RIPENESS_ARTIFACT_SCHEMA_VERSION = 'jarvos-ripeness-artifact/v2';
const LEGACY_RIPENESS_ARTIFACT_SCHEMA_VERSION = 'jarvos-ripeness-artifact/v1';
const RIPENESS_TIME_ZONE = 'America/New_York';
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_THEMES = 3;
const MAX_FRAGMENTS_PER_THEME = 4;
const MAX_SUPPORT_PER_THEME = 4;
const MAX_FRAGMENT_CHARS = 320;
const HUMAN_ORIGIN_BASES = Object.freeze(['verbatim_user', 'user_derived', 'legacy_author', 'unknown']);
const CONTEXT_ORIGIN_BASES = Object.freeze(['assistant_generated', 'mixed_composition', 'unknown', 'legacy_author']);
const CONTEXT_BASIS_BY_ORIGIN = Object.freeze({
  assistant: 'assistant_generated',
  mixed: 'mixed_composition',
  unknown: 'unknown',
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function artifactWithoutDigest(artifact) {
  const copy = { ...artifact };
  delete copy.outputDigest;
  return copy;
}

function computeRipenessArtifactDigest(artifact) {
  return crypto.createHash('sha256').update(canonicalJson(artifactWithoutDigest(artifact))).digest('hex');
}

function localDateFor(now = new Date(), timeZone = RIPENESS_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function invalid(status, artifact = null) {
  return { ok: false, status, artifact, ...(status === 'legacy_non_qualifying' ? { legacy: true } : {}) };
}

function validOriginCounts(counts) {
  if (!isPlainObject(counts)) return false;
  return CONTENT_ORIGINS.every((origin) => Number.isInteger(counts[origin]) && counts[origin] >= 0);
}

function validHumanSupport(support) {
  return isPlainObject(support)
    && typeof support.id === 'string' && support.id.length > 0 && support.id.length <= 200
    && isIsoDate(support.date)
    && support.content_origin === 'human'
    && HUMAN_ORIGIN_BASES.includes(support.content_origin_basis)
    && support.human_evidence_eligible === true
    && (support.text === undefined || (typeof support.text === 'string'
      && support.text.length > 0
      && support.text.length <= MAX_FRAGMENT_CHARS
      && !/jarvos-content-origin\/v\d+/i.test(support.text)));
}

function validContextSupport(support) {
  return isPlainObject(support)
    && typeof support.id === 'string' && support.id.length > 0 && support.id.length <= 200
    && isIsoDate(support.date)
    && ['assistant', 'mixed', 'unknown'].includes(support.content_origin)
    && CONTEXT_ORIGIN_BASES.includes(support.content_origin_basis)
    && (support.content_origin_basis === 'legacy_author'
      || CONTEXT_BASIS_BY_ORIGIN[support.content_origin] === support.content_origin_basis)
    && support.human_evidence_eligible === false
    && (support.text === undefined || (typeof support.text === 'string'
      && support.text.length > 0
      && support.text.length <= MAX_FRAGMENT_CHARS
      && !/jarvos-content-origin\/v\d+/i.test(support.text)));
}

function validateFragment(fragment) {
  return isPlainObject(fragment)
    && isIsoDate(fragment.date)
    && typeof fragment.text === 'string'
    && fragment.text.length > 0
    && fragment.text.length <= MAX_FRAGMENT_CHARS
    && !/jarvos-content-origin\/v\d+/i.test(fragment.text)
    && fragment.content_origin === 'human'
    && HUMAN_ORIGIN_BASES.includes(fragment.content_origin_basis)
    && fragment.human_evidence_eligible === true;
}

function validateTheme(theme) {
  if (!isPlainObject(theme)
    || !Number.isInteger(theme.days) || theme.days < 1
    || !Number.isInteger(theme.spanDays) || theme.spanDays < 1
    || !isIsoDate(theme.firstSeen) || !isIsoDate(theme.lastSeen)
    || theme.firstSeen > theme.lastSeen
    || !Number.isInteger(theme.qualifyingHumanDays) || theme.qualifyingHumanDays < 1
    || theme.qualifyingHumanDays > theme.days
    || !Array.isArray(theme.fragments) || theme.fragments.length > MAX_FRAGMENTS_PER_THEME
    || !Array.isArray(theme.qualifyingHumanSupport) || theme.qualifyingHumanSupport.length < 1 || theme.qualifyingHumanSupport.length > MAX_SUPPORT_PER_THEME
    || !Array.isArray(theme.contextSupport) || theme.contextSupport.length > MAX_SUPPORT_PER_THEME
    || !Array.isArray(theme.support) || theme.support.length > MAX_SUPPORT_PER_THEME
    || !validOriginCounts(theme.originCounts)
    || theme.originCounts.human < 1) return false;

  return theme.fragments.every(validateFragment)
    && theme.qualifyingHumanSupport.every(validHumanSupport)
    && theme.contextSupport.every(validContextSupport)
    && theme.support.every((support) => typeof support === 'string' && support.length > 0 && support.length <= 200);
}

function validateOmission(omission) {
  if (!isPlainObject(omission)) return false;
  if (omission.id !== undefined && (typeof omission.id !== 'string' || omission.id.length > 200)) return false;
  if (omission.count !== undefined && (!Number.isInteger(omission.count) || omission.count < 1)) return false;
  if (omission.content_origin !== undefined && !CONTENT_ORIGINS.includes(omission.content_origin)) return false;
  if (omission.content_origin_basis !== undefined && typeof omission.content_origin_basis !== 'string') return false;
  return true;
}

function validateRipenessArtifact(artifact, {
  now = new Date(),
  timeZone = RIPENESS_TIME_ZONE,
  requireCurrentDate = true,
} = {}) {
  if (!isPlainObject(artifact)) return invalid('malformed');
  if (artifact.schemaVersion === LEGACY_RIPENESS_ARTIFACT_SCHEMA_VERSION) return invalid('legacy_non_qualifying');
  if (artifact.schemaVersion !== RIPENESS_ARTIFACT_SCHEMA_VERSION) return invalid('unknown_schema');
  if (!isIsoDate(artifact.asOf)) return invalid('malformed');
  if (artifact.timeZone !== timeZone || typeof artifact.effectiveAt !== 'string' || Number.isNaN(Date.parse(artifact.effectiveAt))) return invalid('provenance_incomplete');
  if (!isPlainObject(artifact.producer)
    || typeof artifact.producer.engine !== 'string' || !artifact.producer.engine
    || typeof artifact.producer.version !== 'string' || !artifact.producer.version
    || typeof artifact.producer.runId !== 'string' || !artifact.producer.runId
    || !SHA256_RE.test(String(artifact.producer.configDigest || ''))) return invalid('provenance_incomplete');
  if (!isPlainObject(artifact.publication) || artifact.publication.state !== 'published') return invalid('provenance_incomplete');
  if (artifact.omissions !== undefined && (!Array.isArray(artifact.omissions) || !artifact.omissions.every(validateOmission))) return invalid('malformed');
  if (!SHA256_RE.test(String(artifact.outputDigest || '')) || artifact.outputDigest !== computeRipenessArtifactDigest(artifact)) return invalid('digest_mismatch');
  if (!Array.isArray(artifact.themes) || artifact.themes.length > MAX_THEMES || !artifact.themes.every(validateTheme)) return invalid('non_qualifying_theme');

  const expectedDate = localDateFor(now, timeZone);
  if (requireCurrentDate && artifact.asOf !== expectedDate) return invalid(artifact.asOf > expectedDate ? 'future' : 'stale');
  return { ok: true, status: artifact.themes.length ? 'fresh' : 'fresh_empty', artifact };
}

module.exports = {
  RIPENESS_ARTIFACT_SCHEMA_VERSION,
  LEGACY_RIPENESS_ARTIFACT_SCHEMA_VERSION,
  RIPENESS_TIME_ZONE,
  MAX_THEMES,
  MAX_FRAGMENTS_PER_THEME,
  MAX_SUPPORT_PER_THEME,
  MAX_FRAGMENT_CHARS,
  CONTENT_ORIGINS,
  HUMAN_ORIGIN_BASES,
  CONTEXT_ORIGIN_BASES,
  canonicalJson,
  computeRipenessArtifactDigest,
  localDateFor,
  validateRipenessArtifact,
};
