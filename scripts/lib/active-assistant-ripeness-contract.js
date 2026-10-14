'use strict';

// Public, content-free contract for the private Ripeness producer. The host
// owns source adapters and persistence; this module only validates the
// versioned envelope and its bounded, non-personal shape.
const crypto = require('node:crypto');

const ACTIVE_ASSISTANT_RIPENESS_CONTRACT_VERSION = 'ripeness-themes/v1';
const DEFAULT_RIPENESS_TIMEZONE = 'America/New_York';
const MAX_THEMES = 12;
const MAX_FRAGMENTS_PER_THEME = 8;
const MAX_SUPPORT_PER_THEME = 8;

function isDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function artifactDigest(doc) {
  const digestInput = JSON.parse(JSON.stringify(doc));
  delete digestInput.outputDigest;
  if (digestInput.provenance) delete digestInput.provenance.producerArtifactDigest;
  return crypto.createHash('sha256').update(stableJson(digestInput)).digest('hex');
}

function localDateInTimezone(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function validTheme(theme) {
  if (!hasOnlyKeys(theme, ['days', 'spanDays', 'firstSeen', 'lastSeen', 'fragments', 'support'])) return false;
  if (!Number.isInteger(theme.days) || theme.days < 1 || theme.days > 366) return false;
  if (!Number.isInteger(theme.spanDays) || theme.spanDays < theme.days || theme.spanDays > 3660) return false;
  if (!isDate(theme.firstSeen) || !isDate(theme.lastSeen) || theme.firstSeen > theme.lastSeen) return false;
  if (!Array.isArray(theme.fragments) || theme.fragments.length > MAX_FRAGMENTS_PER_THEME) return false;
  if (!theme.fragments.every((fragment) => (
    hasOnlyKeys(fragment, ['date', 'text'])
    && isDate(fragment.date)
    && typeof fragment.text === 'string'
    && fragment.text.length > 0
    && fragment.text.length <= 1000
  ))) return false;
  return Array.isArray(theme.support)
    && theme.support.length <= MAX_SUPPORT_PER_THEME
    && theme.support.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 300);
}

/**
 * Validate a producer artifact without inspecting or interpreting its prose.
 * The result is intentionally metadata-only so callers can safely log it.
 */
function validateRipenessArtifact(doc, { now = new Date(), timezone = DEFAULT_RIPENESS_TIMEZONE } = {}) {
  const required = [
    'schemaVersion', 'asOf', 'effectiveAt', 'timezone', 'producerRunId',
    'engine', 'configDigest', 'outputDigest', 'provenance', 'themes',
  ];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.themes)) {
    return { ok: false, reasonCode: 'missing_themes_array' };
  }
  if (!hasOnlyKeys(doc, required) || !required.every((key) => Object.hasOwn(doc, key))) {
    return { ok: false, reasonCode: 'malformed_envelope' };
  }
  if (doc.schemaVersion !== ACTIVE_ASSISTANT_RIPENESS_CONTRACT_VERSION) {
    return { ok: false, reasonCode: 'unsupported_schema_version' };
  }
  if (doc.timezone !== timezone || !isDate(doc.asOf) || doc.asOf !== localDateInTimezone(now, timezone)) {
    return { ok: false, reasonCode: 'as_of_not_current_local_date' };
  }
  if (
    typeof doc.effectiveAt !== 'string'
    || Number.isNaN(Date.parse(doc.effectiveAt))
    || localDateInTimezone(new Date(doc.effectiveAt), timezone) !== doc.asOf
  ) {
    return { ok: false, reasonCode: 'effective_time_mismatch' };
  }
  if (typeof doc.producerRunId !== 'string' || !doc.producerRunId.trim()) {
    return { ok: false, reasonCode: 'missing_producer_run_id' };
  }
  if (
    !hasOnlyKeys(doc.engine, ['name', 'version'])
    || typeof doc.engine.name !== 'string' || !doc.engine.name
    || typeof doc.engine.version !== 'string' || !doc.engine.version
  ) {
    return { ok: false, reasonCode: 'malformed_engine_identity' };
  }
  if (
    !isDigest(doc.configDigest)
    || !isDigest(doc.outputDigest)
    || !hasOnlyKeys(doc.provenance, ['publicationState', 'producerArtifactDigest'])
    || doc.provenance.publicationState !== 'published'
    || !isDigest(doc.provenance.producerArtifactDigest)
  ) {
    return { ok: false, reasonCode: 'malformed_digest_provenance' };
  }
  if (doc.themes.length > MAX_THEMES || !doc.themes.every(validTheme)) {
    return { ok: false, reasonCode: 'unbounded_or_malformed_themes' };
  }
  const actualDigest = artifactDigest(doc);
  if (doc.outputDigest !== actualDigest || doc.provenance.producerArtifactDigest !== actualDigest) {
    return { ok: false, reasonCode: 'digest_mismatch' };
  }
  return { ok: true, value: doc };
}

module.exports = {
  ACTIVE_ASSISTANT_RIPENESS_CONTRACT_VERSION,
  DEFAULT_RIPENESS_TIMEZONE,
  MAX_THEMES,
  MAX_FRAGMENTS_PER_THEME,
  MAX_SUPPORT_PER_THEME,
  artifactDigest,
  isDate,
  isDigest,
  validateRipenessArtifact,
};
