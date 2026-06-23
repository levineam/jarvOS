'use strict';

/**
 * Canonical CaptureEvent schema for the ambient intent layer.
 *
 * CaptureEvent schema version: 2.0
 */

/**
 * CaptureEvent — canonical input to ambient classification and host routing.
 *
 * @typedef {object} CaptureEvent
 * @property {string} [schemaVersion] - CaptureEvent schema version.
 * @property {string} [trigger] - Keyword trigger: "idea" | "note" | etc.
 * @property {string} [salienceClass] - Canonical salience class.
 * @property {number} [confidence] - Salience confidence score from 0.0 to 1.0.
 * @property {string} [title] - Human-readable title.
 * @property {string} [text] - Raw captured text.
 * @property {string} [content] - Body override.
 * @property {string} [rationale] - Why this is significant.
 * @property {object} [frontmatter] - Host-owned metadata.
 * @property {string} [date] - ISO date in YYYY-MM-DD format.
 * @property {string|object} [source] - Source tool or structured source metadata.
 * @property {string|object} [actor] - Actor type or structured actor metadata.
 * @property {string} [captureMode] - How the event was captured.
 * @property {string} [privacyTier] - Public/private handling tier.
 * @property {object[]} [evidence] - Source-backed evidence spans.
 * @property {string|object} [origin] - Origin pointer for the capture.
 */

const CAPTURE_EVENT_SCHEMA_VERSION = '2.0';
const CAPTURE_EVENT_SCHEMA_V1 = '1.0';
const SUPPORTED_CAPTURE_EVENT_SCHEMA_VERSIONS = [
  CAPTURE_EVENT_SCHEMA_V1,
  CAPTURE_EVENT_SCHEMA_VERSION,
];

const SALIENCE_CLASSES = [
  'idea',
  'decision',
  'belief_change',
  'commitment',
  'preference',
  'factual_learning',
  'lesson',
  'nothing',
];

const KEYWORD_TRIGGERS = ['idea', 'note', 'decision', 'preference', 'fact', 'lesson'];

const CODING_TOOL_SOURCE_TOOLS = [
  'openclaw',
  'codex',
  'claude-code',
  'hermes',
];

const SOURCE_TOOLS = [
  ...CODING_TOOL_SOURCE_TOOLS,
  'manual',
  'journal',
  'note',
  'paperclip',
  'discord',
  'telegram',
  'unknown',
  'other',
];

const ACTOR_TYPES = ['human', 'assistant', 'tool', 'system', 'mixed', 'unknown'];

const CAPTURE_MODES = [
  'ambient',
  'prompted',
  'manual',
  'journal',
  'note-write',
  'session-summary',
  'import',
  'unknown',
];

const PRIVACY_TIERS = ['public', 'local-private', 'private', 'sensitive', 'secret'];
const EVIDENCE_TYPES = ['text', 'message', 'file', 'note', 'journal', 'transcript', 'url', 'selection'];
const ORIGIN_KINDS = ['session', 'journal', 'note', 'transcript', 'prompt', 'file', 'url', 'manual'];
const EVIDENCE_REQUIRED_CAPTURE_MODES = ['ambient', 'prompted', 'session-summary', 'import'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCustomSourceTool(value) {
  return /^custom:[a-z0-9][a-z0-9-]*$/i.test(String(value || ''));
}

function pushEnumError(errors, fieldName, value, allowed, suffix = '') {
  const expected = allowed.join(', ');
  errors.push(`Unknown ${fieldName}: "${value}". Expected one of: ${expected}${suffix}`);
}

function validateOptionalStringFields(prefix, value, fields, errors) {
  for (const field of fields) {
    if (value[field] != null && typeof value[field] !== 'string') {
      errors.push(`${prefix}.${field} must be a string`);
    }
  }
}

function validateSource(source, errors) {
  if (source == null) return;

  if (typeof source === 'string') {
    if (!SOURCE_TOOLS.includes(source) && !isCustomSourceTool(source)) {
      pushEnumError(errors, 'source', source, SOURCE_TOOLS, ', or custom:<slug>');
    }
    return;
  }

  if (!isPlainObject(source)) {
    errors.push('source must be a string or object');
    return;
  }

  if (!source.tool) {
    errors.push('source.tool is required when source is an object');
  } else if (typeof source.tool !== 'string') {
    errors.push('source.tool must be a string');
  } else if (!SOURCE_TOOLS.includes(source.tool) && !isCustomSourceTool(source.tool)) {
    pushEnumError(errors, 'source.tool', source.tool, SOURCE_TOOLS, ', or custom:<slug>');
  }

  validateOptionalStringFields('source', source, [
    'sessionId',
    'messageId',
    'threadId',
    'accountId',
    'path',
    'uri',
    'label',
  ], errors);
}

function validateActor(actor, errors) {
  if (actor == null) return;

  if (typeof actor === 'string') {
    if (!ACTOR_TYPES.includes(actor)) {
      pushEnumError(errors, 'actor', actor, ACTOR_TYPES);
    }
    return;
  }

  if (!isPlainObject(actor)) {
    errors.push('actor must be a string or object');
    return;
  }

  if (!actor.type) {
    errors.push('actor.type is required when actor is an object');
  } else if (typeof actor.type !== 'string') {
    errors.push('actor.type must be a string');
  } else if (!ACTOR_TYPES.includes(actor.type)) {
    pushEnumError(errors, 'actor.type', actor.type, ACTOR_TYPES);
  }

  validateOptionalStringFields('actor', actor, ['id', 'name', 'model', 'role'], errors);
}

function validateOrigin(origin, errors) {
  if (origin == null) return;

  if (typeof origin === 'string') {
    if (!origin.trim()) errors.push('origin must not be empty');
    return;
  }

  if (!isPlainObject(origin)) {
    errors.push('origin must be a string or object');
    return;
  }

  if (!origin.kind) {
    errors.push('origin.kind is required when origin is an object');
  } else if (typeof origin.kind !== 'string') {
    errors.push('origin.kind must be a string');
  } else if (!ORIGIN_KINDS.includes(origin.kind)) {
    pushEnumError(errors, 'origin.kind', origin.kind, ORIGIN_KINDS);
  }

  if (!origin.ref && !origin.path && !origin.uri && !origin.id) {
    errors.push('origin must include at least one of: ref, path, uri, id');
  }

  validateOptionalStringFields('origin', origin, ['ref', 'path', 'uri', 'id'], errors);
}

function validateEvidenceEntry(entry, index, errors) {
  const prefix = `evidence[${index}]`;

  if (!isPlainObject(entry)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  if (entry.type != null) {
    if (typeof entry.type !== 'string') {
      errors.push(`${prefix}.type must be a string`);
    } else if (!EVIDENCE_TYPES.includes(entry.type)) {
      pushEnumError(errors, `${prefix}.type`, entry.type, EVIDENCE_TYPES);
    }
  }

  const hasPointer = ['text', 'quote', 'sourceId', 'messageId', 'path', 'uri', 'ref']
    .some((field) => typeof entry[field] === 'string' && entry[field].trim());
  if (!hasPointer) {
    errors.push(`${prefix} must include at least one of: text, quote, sourceId, messageId, path, uri, ref`);
  }

  validateOptionalStringFields(prefix, entry, [
    'text',
    'quote',
    'sourceId',
    'messageId',
    'path',
    'uri',
    'ref',
    'hash',
  ], errors);

  for (const field of ['start', 'end']) {
    if (entry[field] != null && (!Number.isInteger(entry[field]) || entry[field] < 0)) {
      errors.push(`${prefix}.${field} must be a non-negative integer`);
    }
  }
}

function validateEvidence(event, errors) {
  const captureMode = event.captureMode;
  const requiresEvidence = EVIDENCE_REQUIRED_CAPTURE_MODES.includes(captureMode);

  if (event.evidence == null) {
    if (requiresEvidence) {
      errors.push(`evidence is required for captureMode "${captureMode}"`);
    }
    return;
  }

  if (!Array.isArray(event.evidence)) {
    errors.push('evidence must be an array');
    return;
  }

  if (requiresEvidence && event.evidence.length === 0) {
    errors.push(`evidence must contain at least one entry for captureMode "${captureMode}"`);
  }

  event.evidence.forEach((entry, index) => validateEvidenceEntry(entry, index, errors));
}

function validateCaptureEvent(event = {}) {
  const errors = [];

  if (event.schemaVersion != null && !SUPPORTED_CAPTURE_EVENT_SCHEMA_VERSIONS.includes(String(event.schemaVersion))) {
    pushEnumError(
      errors,
      'schemaVersion',
      event.schemaVersion,
      SUPPORTED_CAPTURE_EVENT_SCHEMA_VERSIONS,
    );
  }

  const text = String(event.text || event.content || '').trim();
  if (!text) {
    errors.push('CaptureEvent must have at least one of: text, content');
  }

  if (event.trigger != null && !KEYWORD_TRIGGERS.includes(event.trigger)) {
    errors.push(`Unknown trigger: "${event.trigger}". Expected one of: ${KEYWORD_TRIGGERS.join(', ')}`);
  }

  if (event.salienceClass != null && !SALIENCE_CLASSES.includes(event.salienceClass)) {
    errors.push(`Unknown salienceClass: "${event.salienceClass}". Expected one of: ${SALIENCE_CLASSES.join(', ')}`);
  }

  if (event.confidence != null) {
    const confidence = Number(event.confidence);
    if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
      errors.push('confidence must be a number between 0.0 and 1.0');
    }
  }

  if (event.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date))) {
    errors.push('date must be ISO format YYYY-MM-DD');
  }

  if (String(event.schemaVersion || '') === CAPTURE_EVENT_SCHEMA_VERSION) {
    if (event.source == null) errors.push('source is required for CaptureEvent schemaVersion 2.0');
    if (event.actor == null) errors.push('actor is required for CaptureEvent schemaVersion 2.0');
    if (event.captureMode == null) errors.push('captureMode is required for CaptureEvent schemaVersion 2.0');
    if (event.privacyTier == null) errors.push('privacyTier is required for CaptureEvent schemaVersion 2.0');
    if (event.origin == null) errors.push('origin is required for CaptureEvent schemaVersion 2.0');
  }

  validateSource(event.source, errors);
  validateActor(event.actor, errors);
  validateOrigin(event.origin, errors);

  if (event.captureMode != null && !CAPTURE_MODES.includes(event.captureMode)) {
    pushEnumError(errors, 'captureMode', event.captureMode, CAPTURE_MODES);
  }

  if (event.privacyTier != null && !PRIVACY_TIERS.includes(event.privacyTier)) {
    pushEnumError(errors, 'privacyTier', event.privacyTier, PRIVACY_TIERS);
  }

  validateEvidence(event, errors);

  return errors;
}

module.exports = {
  CAPTURE_EVENT_SCHEMA_VERSION,
  CAPTURE_EVENT_SCHEMA_V1,
  SUPPORTED_CAPTURE_EVENT_SCHEMA_VERSIONS,
  SALIENCE_CLASSES,
  KEYWORD_TRIGGERS,
  CODING_TOOL_SOURCE_TOOLS,
  SOURCE_TOOLS,
  ACTOR_TYPES,
  CAPTURE_MODES,
  PRIVACY_TIERS,
  EVIDENCE_TYPES,
  ORIGIN_KINDS,
  EVIDENCE_REQUIRED_CAPTURE_MODES,
  validateCaptureEvent,
};
