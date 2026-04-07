'use strict';

/**
 * @jarvos/memory — Agent-state memory module
 *
 * Provides compact recall schema, record creation, and audit helpers
 * for jarvOS agents operating across sessions.
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 'jarvos-memory/v1';

const CORE_MEMORY_CLASSES = {
  fact:           { label: 'Fact',          description: 'Stable fact worth reusing later' },
  preference:     { label: 'Preference',    description: 'Changes future decisions' },
  decision:       { label: 'Decision',      description: 'Durable decision with rationale' },
  lesson:         { label: 'Lesson',        description: 'Correction or lesson learned' },
  'project-state':{ label: 'Project State', description: 'Project snapshot worth carrying across sessions' },
};

/**
 * Return all available memory class names.
 * @returns {string[]}
 */
function getMemoryClasses() {
  return Object.keys(CORE_MEMORY_CLASSES);
}

/**
 * Return metadata for a specific memory class.
 * @param {string} cls
 * @returns {{ label: string, description: string } | null}
 */
function getMemoryClassDef(cls) {
  return CORE_MEMORY_CLASSES[cls] || null;
}

/**
 * Create a compact memory record from a capture event.
 *
 * @param {object} params
 * @param {string} params.class       - Memory class (fact/preference/decision/lesson/project-state)
 * @param {string} params.content     - Compact human-readable statement
 * @param {string} [params.rationale] - Why this matters
 * @param {string} [params.source]    - Source reference (journal date, note path, session)
 * @param {string} [params.noteRef]   - Link to full note if one was created
 * @param {number} [params.confidence]- 0.0-1.0
 * @param {string} [params.supersedes]- ID of prior memory this replaces
 * @returns {{ record: object|null, written: boolean, path: string|null, error: string|null }}
 */
function createMemoryRecord(params = {}) {
  const memoryClass = params.class;
  const classDef = CORE_MEMORY_CLASSES[memoryClass];

  if (!classDef) {
    return {
      record: null,
      written: false,
      path: null,
      error: `Unknown memory class: ${memoryClass}. Valid classes: ${getMemoryClasses().join(', ')}`,
    };
  }

  const content = String(params.content || '').trim();
  if (!content) {
    return {
      record: null,
      written: false,
      path: null,
      error: 'Memory record content is required',
    };
  }

  const now = new Date();
  const id = crypto.createHash('sha256')
    .update(`${memoryClass}:${content}:${now.toISOString()}`)
    .digest('hex')
    .slice(0, 12);

  const record = {
    schema: SCHEMA_VERSION,
    class: memoryClass,
    id,
    content,
    createdAt: now.toISOString(),
  };

  if (params.rationale) record.rationale = String(params.rationale);
  if (params.source)    record.source    = String(params.source);
  if (params.noteRef)   record.noteRef   = String(params.noteRef);
  if (params.supersedes)record.supersedes= String(params.supersedes);
  if (params.confidence != null) {
    const conf = Number(params.confidence);
    if (!isNaN(conf)) record.confidence = Math.max(0, Math.min(1, conf));
  }

  return { record, written: false, path: null, error: null };
}

/**
 * Validate a memory record object against the schema.
 * @param {object} record
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateMemoryRecord(record = {}) {
  const errors = [];
  if (!record.schema)  errors.push('Missing required field: schema');
  if (!record.class)   errors.push('Missing required field: class');
  if (!record.content) errors.push('Missing required field: content');
  if (!record.id)      errors.push('Missing required field: id');
  if (record.class && !CORE_MEMORY_CLASSES[record.class]) {
    errors.push(`Invalid memory class: ${record.class}`);
  }
  if (record.confidence != null) {
    const c = Number(record.confidence);
    if (isNaN(c) || c < 0 || c > 1) {
      errors.push('confidence must be a number between 0 and 1');
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_VERSION,
  CORE_MEMORY_CLASSES,
  getMemoryClasses,
  getMemoryClassDef,
  createMemoryRecord,
  validateMemoryRecord,
};
