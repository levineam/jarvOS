'use strict';

// Content-bearing application response. Never reuse the metadata-only service
// receipt for findings, and never forward an internal synthesis packet.
const CONTRACT = 'jarvos-meaning-projection/v1';
const STATES = new Set(['current', 'healthy_empty', 'historical', 'missing', 'malformed', 'digest_mismatch', 'future_dated', 'stale', 'omitted']);
const OUTCOMES = new Set(['ok', 'abstained', 'context_incomplete', 'unavailable', 'denied', 'failed', 'timed_out', 'cancelled']);
const SOURCES = new Set(['ripeness', 'projects', 'journal', 'notes', 'conversations', 'intent', 'ontology', 'activity']);
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REF = /^source:[a-f0-9]{64}$/;

function keys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function exactKeys(value, allowed) {
  return keys(value, allowed) && allowed.every((key) => Object.hasOwn(value, key));
}

function safeText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value)
    // Findings never expose filesystem locators, including relative paths or
    // platform-specific roots. Conservative slash rejection is intentional.
    && !/[\/\\]/.test(value)
    && !/(?:file:\/\/|https?:\/\/|\/(?:Users|home|tmp|private|var|etc)\/|[A-Z]:\\|~\/|-----BEGIN|(?:api[_ -]?key|authorization|bearer)\s*[:=]|rawArtifact|sourceRegistry|promptText|stack trace)/i.test(value);
}

function timestamp(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value);
}

function unavailable(operation, reason = 'binding_unavailable') {
  return {
    contract: CONTRACT, operation, status: 'unavailable', reason,
    scope: null, analysis: null, findings: [], coverage: [], omissions: [reason],
  };
}

function validateProjection(value) {
  if (!exactKeys(value, ['contract', 'operation', 'status', 'reason', 'scope', 'analysis', 'findings', 'coverage', 'omissions'])
    || value.contract !== CONTRACT || !['context', 'assessment'].includes(value.operation)
    || !OUTCOMES.has(value.status) || typeof value.reason !== 'string' || !CODE.test(value.reason)) return false;
  if (value.scope !== null && (!exactKeys(value.scope, ['id', 'label', 'destination'])
    || !DIGEST.test(value.scope.id) || !DIGEST.test(value.scope.destination) || !safeText(value.scope.label, 120))) return false;
  if (value.analysis !== null && (!exactKeys(value.analysis, ['id', 'state', 'evaluatedAt'])
    || !DIGEST.test(value.analysis.id) || !STATES.has(value.analysis.state)
    || !timestamp(value.analysis.evaluatedAt))) return false;
  if (!Array.isArray(value.findings) || value.findings.length > 6
    || !Array.isArray(value.coverage) || value.coverage.length > SOURCES.size
    || !Array.isArray(value.omissions) || value.omissions.length > 16
    || !value.omissions.every((reason) => typeof reason === 'string' && CODE.test(reason))) return false;
  if (new Set(value.coverage.map((row) => row.source)).size !== value.coverage.length) return false;
  if (!value.coverage.every((row) => exactKeys(row, ['source', 'state', 'asOf', 'reason'])
    && SOURCES.has(row.source) && STATES.has(row.state) && timestamp(row.asOf) && typeof row.reason === 'string' && CODE.test(row.reason))) return false;
  if (!value.findings.every((row) => exactKeys(row, ['kind', 'text', 'sourceRefs'])
    && ['observation', 'inference'].includes(row.kind) && safeText(row.text, 700)
    && Array.isArray(row.sourceRefs) && row.sourceRefs.length > 0 && row.sourceRefs.length <= 8
    && row.sourceRefs.every((ref) => typeof ref === 'string' && REF.test(ref)))) return false;
  if (value.findings.length && (value.status !== 'ok' || value.scope === null || value.analysis === null)) return false;
  return JSON.stringify(value).length <= 8000;
}

function projectMeaning(value, { operation = 'context', maxChars = 8000 } = {}) {
  if (!validateProjection(value) || value.operation !== operation) return unavailable(operation, 'projection_invalid');
  const result = JSON.parse(JSON.stringify(value));
  const budget = Number.isInteger(maxChars) && maxChars >= 2000 ? Math.min(maxChars, 8000) : 8000;
  // Coverage and omissions survive truncation; findings are the expendable part.
  while (JSON.stringify(result).length > budget && result.findings.length) {
    result.findings.pop();
    if (!result.omissions.includes('findings_truncated')) result.omissions.push('findings_truncated');
  }
  return JSON.stringify(result).length <= budget ? result : unavailable(operation, 'projection_over_budget');
}

async function invokeMeaning(operation, args, provider, lifecycle = {}) {
  if (!['context', 'assessment'].includes(operation)) return unavailable('context', 'invalid_operation');
  const allowed = operation === 'context' ? ['maxChars'] : [];
  if (!keys(args, allowed) || (args.maxChars !== undefined
    && (!Number.isInteger(args.maxChars) || args.maxChars < 2000 || args.maxChars > 8000))) {
    return unavailable(operation, 'invalid_arguments');
  }
  const method = operation === 'context' ? 'readContext' : 'assess';
  if (!provider || typeof provider[method] !== 'function') return unavailable(operation);
  try {
    // Assessment intent and request identity must come from the host binding,
    // not a model-supplied question, boolean, request id, or provider override.
    const response = await provider[method]({ signal: lifecycle.signal });
    return projectMeaning(response, { operation, maxChars: args.maxChars });
  } catch {
    return unavailable(operation, lifecycle.signal?.aborted ? 'request_cancelled' : 'provider_unavailable');
  }
}

module.exports = { CONTRACT, projectMeaning, validateProjection, unavailable, invokeMeaning };
