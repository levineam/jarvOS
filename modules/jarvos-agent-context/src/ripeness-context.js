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

// v2 is an assessment-only rendering contract with readable, origin-labelled
// sources. The context tool remains v1-only.
const CONTRACT_V2 = 'jarvos-meaning-projection/v2';
const V2_MAX_CHARS = 12000;
const V2_KEYS = ['contract', 'operation', 'status', 'reason', 'scope', 'analysis', 'findings', 'coverage', 'omissions', 'sources'];
const V2_SOURCE_KEYS = ['ref', 'label', 'sourceClass', 'origin', 'asOf', 'excerpt'];
const V2_FINDING_KEYS = ['kind', 'text', 'sourceRefs'];
const V2_KINDS = new Set(['andrew_words', 'observation', 'inference', 'contribution']);
const ORIGINS = new Set(['andrew_verified', 'external_verified', 'unverified', 'ai_generated']);
const VERIFIED = new Set(['andrew_verified', 'external_verified']);

// Shared detectors. The v1 combination below is identical to the original
// conservative v1 expression; v2 reuses the same pieces and adds more shapes.
const LEGACY_LOCATOR = String.raw`file:\/\/|https?:\/\/|\/(?:Users|home|tmp|private|var|etc)\/|[A-Z]:\\|~\/`;
const SECRET_MARKER = String.raw`-----BEGIN|(?:api[_ -]?key|authorization|bearer)\s*[:=]`;
const INTERNAL_MARKER = String.raw`rawArtifact|sourceRegistry|promptText|stack trace`;
const LEGACY_UNSAFE = new RegExp(`(?:${LEGACY_LOCATOR}|${SECRET_MARKER}|${INTERNAL_MARKER})`, 'i');

// C0/C1 controls, line/paragraph separators, zero-width and bidi overrides.
// ASCII-only source spelling: no literal separator or invisible character may
// appear in this source file (a literal U+2028 would break a regex literal).
// Set: C0 (U+0000-U+001F), DEL and C1 (U+007F-U+009F), zero-width space
// (U+200B), LRM/RLM (U+200E-U+200F), line/paragraph separators
// (U+2028-U+2029), bidi embeddings/overrides (U+202A-U+202E), word joiner and
// invisible operators (U+2060-U+2064), bidi isolates (U+2066-U+2069) and the
// byte-order mark / zero-width no-break space (U+FEFF).
// The pattern text is generated at load time from numeric code points into
// backslash-u escape sequences, so the source file stays pure ASCII.
const V2_CONTROL_RANGES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200b], [0x200e, 0x200f],
  [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
function escapeCodePoint(code) {
  return '\\' + 'u' + code.toString(16).padStart(4, '0');
}
const V2_CONTROL = new RegExp('[' + V2_CONTROL_RANGES.map(([low, high]) => (low === high
  ? escapeCodePoint(low) : escapeCodePoint(low) + '-' + escapeCodePoint(high))).join('') + ']');
const V2_UNSAFE = [
  LEGACY_UNSAFE,
  // Filesystem locators. Ordinary prose slashes such as "and/or" or "10/19"
  // remain readable; anything shaped like a path does not.
  /\\/, // any backslash: Windows paths and UNC shares
  /(?:^|[^\w.~-])\/(?=[\w.~-])/, // absolute POSIX path
  /(?:^|\W)\.{1,2}\//, // ./ and ../ relative locators
  /\.\.\/|\/\.\./, // traversal anywhere
  /~[\w.-]*\//, // home-relative
  /\b[A-Za-z]:\//, // drive letter with forward slash
  /[\w.-]+\/[\w.\/-]*\.[A-Za-z][A-Za-z0-9]{0,7}\b/, // relative file with extension
  /[\w.-]*[A-Za-z_][\w.-]*\/[\w.-]+\//, // multi-segment relative path
  /\b[a-z][a-z0-9+.-]*:\/\//i, // any URI with an authority
  /\b(?:file|obsidian):(?!\s)/i, // locator schemes without an authority
  // Secret, token and key shapes.
  /-----(?:BEGIN|END)|PRIVATE KEY/,
  /\b(?:api[_ -]?key|access[_ -]?key|authorization|bearer|password|passwd|passphrase|secret|token|credential|cookie|session[_ -]?id)s?\s*[:=]/i,
  /\bbearer\s+[A-Za-z0-9._~+\/=-]{12,}/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{12,}|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{12,})/,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./,
  /[A-Za-z0-9+\/=_]{40,}/,
  /\b[a-f0-9]{32,}\b/i,
  // Internal packets and diagnostics.
  /\b(?:synthesisPacket|internalPacket|rawPacket|sourcePath|systemPrompt|toolCall|tool_call|stackTrace|traceback)\b/i,
  /\bsystem prompt\b/i,
  /\bdiagnostics?\s*[:=]/i,
  /\bat\s+[\w.$<>\[\]]+\s+\([^)]*:\d+:\d+\)/,
  /\b(?:Type|Reference|Syntax|Range|Internal)?Error:\s/,
  /\bE(?:NOENT|ACCES|PERM|CONNREFUSED)\b/,
  /<\/?(?:system|tool|assistant|function|instructions)\b/i,
  /jarvos-meaning-projection/i,
];

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
    && !LEGACY_UNSAFE.test(value);
}

// v2 readable content: ordinary prose slashes are allowed, but locators,
// credentials, controls and internal packets/diagnostics fail closed.
function safeContent(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && /\S/.test(value) && !V2_CONTROL.test(value)
    && !V2_UNSAFE.some((pattern) => pattern.test(value));
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST.test(value);
}

function isRef(value) {
  return typeof value === 'string' && REF.test(value);
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

// Structural v2 check without the serialized size bound. With
// `withholdableExcerpts`, an unsafe (but correctly typed and bounded) excerpt is
// tolerated so projectMeaning can withhold it; an excerpt quoted by an
// andrew_words finding must always be safe and present.
function checkV2(value, withholdableExcerpts = false) {
  if (!exactKeys(value, V2_KEYS) || value.contract !== CONTRACT_V2 || value.operation !== 'assessment'
    || !OUTCOMES.has(value.status) || typeof value.reason !== 'string' || !CODE.test(value.reason)) return false;
  if (value.scope !== null && (!exactKeys(value.scope, ['id', 'label', 'destination'])
    || !isDigest(value.scope.id) || !isDigest(value.scope.destination) || !safeText(value.scope.label, 120))) return false;
  if (value.analysis !== null && (!exactKeys(value.analysis, ['id', 'state', 'evaluatedAt'])
    || !isDigest(value.analysis.id) || !STATES.has(value.analysis.state)
    || !timestamp(value.analysis.evaluatedAt))) return false;
  if (!Array.isArray(value.coverage) || value.coverage.length > SOURCES.size
    || !value.coverage.every((row) => exactKeys(row, ['source', 'state', 'asOf', 'reason'])
      && SOURCES.has(row.source) && STATES.has(row.state) && timestamp(row.asOf)
      && typeof row.reason === 'string' && CODE.test(row.reason))
    || new Set(value.coverage.map((row) => row.source)).size !== value.coverage.length) return false;
  if (!Array.isArray(value.omissions) || value.omissions.length > 16
    || !value.omissions.every((reason) => typeof reason === 'string' && CODE.test(reason))) return false;

  if (!Array.isArray(value.sources) || value.sources.length > 8) return false;
  const sources = new Map();
  for (const source of value.sources) {
    if (!exactKeys(source, V2_SOURCE_KEYS) || !isRef(source.ref) || sources.has(source.ref)
      || !safeContent(source.label, 120) || !SOURCES.has(source.sourceClass)
      || !ORIGINS.has(source.origin) || !timestamp(source.asOf)) return false;
    if (source.excerpt !== null && !(withholdableExcerpts
      ? typeof source.excerpt === 'string' && source.excerpt.length > 0 && source.excerpt.length <= 400
      : safeContent(source.excerpt, 400))) return false;
    sources.set(source.ref, source);
  }

  if (!Array.isArray(value.findings) || value.findings.length > 6) return false;
  const cited = new Set();
  let contributions = 0;
  for (const finding of value.findings) {
    if (!exactKeys(finding, V2_FINDING_KEYS) || !V2_KINDS.has(finding.kind) || !safeContent(finding.text, 700)
      || !Array.isArray(finding.sourceRefs) || finding.sourceRefs.length < 1 || finding.sourceRefs.length > 8
      || !finding.sourceRefs.every((ref) => isRef(ref) && sources.has(ref))
      || new Set(finding.sourceRefs).size !== finding.sourceRefs.length) return false;
    const cites = finding.sourceRefs.map((ref) => sources.get(ref));
    for (const source of cites) cited.add(source.ref);
    if (finding.kind === 'andrew_words') {
      // A quotation is exact text from one verified Andrew excerpt, never a
      // paraphrase and never a quote whose excerpt was withheld.
      const quoted = cites[0];
      if (cites.length !== 1 || quoted.origin !== 'andrew_verified'
        || !safeContent(quoted.excerpt, 400) || !quoted.excerpt.includes(finding.text)) return false;
    } else if (finding.kind === 'observation') {
      if (!cites.every((source) => VERIFIED.has(source.origin))) return false;
    } else {
      // inference = accepted proposal claim; contribution = the trusted
      // producer's accepted closing question. Their acceptance is the
      // producer's responsibility; this validator only enforces disclosure.
      if (finding.kind === 'contribution' && ++contributions > 1) return false;
      if (!cites.some((source) => VERIFIED.has(source.origin))
        && !value.omissions.includes('attribution_unverified')) return false;
    }
  }
  if (cited.size !== sources.size) return false;
  if (value.findings.length && (value.status !== 'ok' || value.scope === null || value.analysis === null)) return false;
  return true;
}

function validateProjectionV2(value) {
  return checkV2(value) && JSON.stringify(value).length <= V2_MAX_CHARS;
}

function addOmission(result, reason) {
  if (!result.omissions.includes(reason)) result.omissions.push(reason);
}

function lastIndexOf(findings, predicate) {
  for (let index = findings.length - 1; index >= 0; index--) if (predicate(findings[index])) return index;
  return -1;
}

function projectMeaningV2(value, operation, maxChars) {
  // v2 is never forwarded to the context path.
  if (operation !== 'assessment' || !checkV2(value, true)) return unavailable(operation, 'projection_invalid');
  const result = JSON.parse(JSON.stringify(value));
  for (const source of result.sources) {
    if (source.excerpt !== null && !safeContent(source.excerpt, 400)) {
      source.excerpt = null;
      addOmission(result, 'excerpt_withheld');
    }
  }
  // Validate the whole envelope before truncation so an unsafe claim that
  // would be dropped cannot hide an invalid projection.
  if (!checkV2(result)) return unavailable(operation, 'projection_invalid');
  const budget = Number.isInteger(maxChars) && maxChars >= 2000 ? Math.min(maxChars, V2_MAX_CHARS) : V2_MAX_CHARS;
  // Whole findings are removed (trailing inference first, then other
  // non-contribution findings); text, provenance, coverage, omissions and the
  // contribution are never rewritten or dropped.
  while (JSON.stringify(result).length > budget) {
    let index = lastIndexOf(result.findings, (finding) => finding.kind === 'inference');
    if (index < 0) index = lastIndexOf(result.findings, (finding) => finding.kind !== 'contribution');
    if (index < 0) break;
    result.findings.splice(index, 1);
    addOmission(result, 'findings_truncated');
    const cited = new Set(result.findings.flatMap((finding) => finding.sourceRefs));
    const kept = result.sources.filter((source) => cited.has(source.ref));
    if (kept.length !== result.sources.length) {
      result.sources = kept;
      addOmission(result, 'sources_truncated');
    }
  }
  return JSON.stringify(result).length <= budget && checkV2(result)
    ? result : unavailable(operation, 'projection_over_budget');
}

function projectMeaning(value, { operation = 'context', maxChars } = {}) {
  if (value && typeof value === 'object' && value.contract === CONTRACT_V2) {
    return projectMeaningV2(value, operation, maxChars);
  }
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

module.exports = {
  CONTRACT, CONTRACT_V2, projectMeaning, validateProjection, validateProjectionV2, unavailable, invokeMeaning,
};
