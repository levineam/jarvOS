'use strict';

/**
 * @jarvos/ontology — Worldview layer
 *
 * Provides the structured belief graph, predictions, goals, values,
 * and identity model for jarvOS agents.
 */

const crypto = require('crypto');

const LAYER_NAMES = [
  'higher-order',
  'belief',
  'prediction',
  'core-self',
  'goal',
  'project',
];

const LAYER_DEFS = {
  'higher-order': {
    label: 'Higher-Order Principle',
    description: 'Organizing principle above every specific goal or belief',
    requiredFields: ['statement'],
  },
  belief: {
    label: 'Belief',
    description: 'Foundational assumption held about the world',
    requiredFields: ['statement'],
  },
  prediction: {
    label: 'Prediction',
    description: 'Testable, time-bound expectation',
    requiredFields: ['statement', 'resolveBy'],
  },
  'core-self': {
    label: 'Core Self',
    description: 'Mission statement, values, and key strengths',
    requiredFields: ['statement'],
  },
  goal: {
    label: 'Goal',
    description: 'Time-bound objective tied to core self',
    requiredFields: ['statement', 'targetDate'],
  },
  project: {
    label: 'Project',
    description: 'Organized effort serving one or more goals',
    requiredFields: ['title', 'linkedGoals'],
  },
};

/**
 * Create a typed ontology layer entry.
 *
 * @param {string} layer - One of the LAYER_NAMES values
 * @param {object} fields - Layer-specific fields
 * @returns {object} Typed entry with id and createdAt
 */
function createLayer(layer, fields = {}) {
  const def = LAYER_DEFS[layer];
  if (!def) {
    throw new Error(`Unknown ontology layer: ${layer}. Valid layers: ${LAYER_NAMES.join(', ')}`);
  }

  const now = new Date().toISOString();
  const baseContent = fields.statement || fields.title || JSON.stringify(fields);
  const id = crypto.createHash('sha256')
    .update(`${layer}:${baseContent}:${now}`)
    .digest('hex')
    .slice(0, 12);

  return {
    layer,
    id,
    ...fields,
    createdAt: now,
  };
}

/**
 * Validate an ontology entry against its layer schema.
 *
 * @param {object} entry - Entry to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEntry(entry = {}) {
  const errors = [];

  if (!entry.layer) {
    errors.push('Missing required field: layer');
    return { valid: false, errors };
  }

  const def = LAYER_DEFS[entry.layer];
  if (!def) {
    errors.push(`Unknown ontology layer: ${entry.layer}`);
    return { valid: false, errors };
  }

  for (const field of def.requiredFields) {
    if (!entry[field]) {
      errors.push(`Layer "${entry.layer}" requires field: ${field}`);
    }
  }

  if (!entry.id)        errors.push('Missing required field: id');
  if (!entry.createdAt) errors.push('Missing required field: createdAt');

  if (entry.confidence != null) {
    const c = Number(entry.confidence);
    if (isNaN(c) || c < 0 || c > 1) {
      errors.push('confidence must be a number between 0 and 1');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return the definition for a layer (label, description, required fields).
 * @param {string} layer
 * @returns {object|null}
 */
function getLayerDef(layer) {
  return LAYER_DEFS[layer] || null;
}

module.exports = {
  LAYER_NAMES,
  LAYER_DEFS,
  createLayer,
  validateEntry,
  getLayerDef,
};
