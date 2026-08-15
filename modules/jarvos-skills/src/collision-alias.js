'use strict';

/**
 * Catalog-level collision alias selection.
 *
 * The reviewer is untrusted and tool-less. It may choose only one name from a
 * precomputed cross-harness-safe candidate set. On timeout/invalid output the
 * first deterministic candidate is used and reported once.
 */

const crypto = require('node:crypto');

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_SUMMARY_BYTES = 2048;
const MAX_RESPONSE_BYTES = 2048;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundedSummary(value) {
  if (value === undefined || value === null) return '[omitted]';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '[omitted]';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_SUMMARY_BYTES) return text;
  return `${bytes.subarray(0, MAX_SUMMARY_BYTES - 14).toString('utf8')}\n[truncated]`;
}

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/**
 * Build a finite cross-harness-safe candidate set.
 * Occupied names from any enrolled harness are excluded.
 */
function safeAliasCandidates(canonicalId, { occupiedNames = [], reservedNames = [] } = {}) {
  if (!isValidName(canonicalId)) throw new Error('canonical id is invalid');
  const occupied = new Set([...(occupiedNames || []), ...(reservedNames || [])].filter(isValidName));
  const candidates = [];
  const push = (name) => {
    if (!isValidName(name) || occupied.has(name) || candidates.includes(name)) return;
    candidates.push(name);
  };
  push(`jarvos-${canonicalId}`);
  push(`${canonicalId}-jarvos`);
  push(`${canonicalId}-managed`);
  push(`${canonicalId}-catalog`);
  for (let index = 2; index <= 20 && candidates.length < 12; index += 1) {
    push(`jarvos-${canonicalId}-${index}`);
    push(`${canonicalId}-managed-${index}`);
  }
  return candidates;
}

function strictChoice(value, candidates) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).length !== 1 || typeof parsed.name !== 'string') return null;
  if (!candidates.includes(parsed.name)) return null;
  return parsed.name;
}

/**
 * Resolve one durable catalog-level alias.
 * @returns {{ effectiveName: string, source: 'canonical'|'reviewer'|'fallback', candidates: string[], requestDigest?: string, notice?: string }}
 */
function resolveCollisionAlias({
  canonicalId,
  occupiedNames = [],
  reservedNames = [],
  reviewer = null,
  untrustedSummary = null,
  forceAlias = false,
} = {}) {
  if (!isValidName(canonicalId)) throw new Error('canonical id is invalid');
  const occupied = new Set([...(occupiedNames || []), ...(reservedNames || [])]);
  if (!forceAlias && !occupied.has(canonicalId)) {
    return {
      effectiveName: canonicalId,
      source: 'canonical',
      candidates: [],
    };
  }

  const candidates = safeAliasCandidates(canonicalId, { occupiedNames: [...occupied], reservedNames });
  if (candidates.length === 0) {
    return {
      effectiveName: null,
      source: 'conflict',
      candidates: [],
      notice: `no safe cross-harness alias exists for ${canonicalId}`,
    };
  }

  const request = {
    version: 'jarvos-collision-name-review.v1',
    logicalName: canonicalId,
    candidates: [...candidates],
    collisionDigest: digest(JSON.stringify({
      canonicalId,
      candidates,
      occupied: [...occupied].sort(),
    })),
    untrustedSkillSummary: boundedSummary(untrustedSummary),
  };

  if (typeof reviewer === 'function') {
    let response;
    try {
      response = reviewer(request);
    } catch {
      response = null;
    }
    const chosen = strictChoice(response, candidates);
    if (chosen) {
      return {
        effectiveName: chosen,
        source: 'reviewer',
        candidates,
        requestDigest: digest(JSON.stringify(request)),
        notice: `assigned durable alias ${chosen} for ${canonicalId}`,
      };
    }
  }

  return {
    effectiveName: candidates[0],
    source: 'fallback',
    candidates,
    requestDigest: digest(JSON.stringify(request)),
    notice: `assigned deterministic fallback alias ${candidates[0]} for ${canonicalId}`,
  };
}

module.exports = {
  NAME_RE,
  safeAliasCandidates,
  strictChoice,
  boundedSummary,
  resolveCollisionAlias,
};
