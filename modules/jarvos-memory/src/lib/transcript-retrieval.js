'use strict';

/**
 * Provider-neutral transcript retrieval with an optional, read-only CASS adapter.
 *
 * This boundary deliberately returns evidence packets rather than memory records.
 * Transcript text is untrusted source material; promotion remains a separate,
 * reviewed operation in memory-promotion.js.
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const {
  defaultAsyncRunner,
  defaultMinimalEnv,
  defaultRunner,
} = require('./transcript-command-runner.js');

const TRANSCRIPT_REQUEST_SCHEMA = 'jarvos-transcript-request/v1';
const TRANSCRIPT_PACKET_SCHEMA = 'jarvos-transcript-packet/v1';
const CASS_CONTRACT_VERSION = 1;

const TRANSCRIPT_STATUS = Object.freeze({
  EVIDENCE_FOUND: 'evidence_found',
  NO_EVIDENCE: 'no_evidence',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
});

const DEFAULT_TRANSCRIPT_BUDGET = Object.freeze({
  maxTokens: 3000,
  maxEvidence: 12,
  maxSessions: 6,
  maxExcerptChars: 900,
});

const SUPPORTED_CONNECTORS = Object.freeze(['codex', 'claude_code']);
const CONNECTOR_ALIASES = Object.freeze({
  codex: 'codex',
  'codex-cli': 'codex',
  claude: 'claude_code',
  'claude-code': 'claude_code',
  claude_code: 'claude_code',
  'claude code': 'claude_code',
});

const DESTINATION_CLASSES = new Set(['on_demand_agent', 'nightly_synthesis']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_QUERY_CHARS = 2000;
// The packet envelope itself is part of the aggregate budget. This floor is
// deliberately above the largest normal no-evidence envelope, so every
// accepted request can render a bounded packet after evidence is dropped.
const MIN_TOKEN_BUDGET = 512;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeDiagnostic(value, maxChars = 120) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .slice(0, maxChars);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 16);
}

function safeInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseDate(value, now = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const relative = /^(\d+)d$/i.exec(trimmed);
  if (relative) {
    const days = Number(relative[1]);
    if (Number.isInteger(days) && days >= 0 && days <= 3650) {
      return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    }
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeConnector(value) {
  const key = asTrimmedString(value).toLowerCase().replace(/\s+/g, ' ');
  return CONNECTOR_ALIASES[key] || null;
}

function normalizeConnectorList(value) {
  const values = value === undefined ? SUPPORTED_CONNECTORS : (Array.isArray(value) ? value : [value]);
  const connectors = [];
  const seen = new Set();
  const errors = [];
  for (const item of values) {
    const normalized = normalizeConnector(item);
    if (!normalized) {
      errors.push(`unsupported connector: ${safeDiagnostic(item)}`);
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      connectors.push(normalized);
    }
  }
  if (connectors.length === 0 && errors.length === 0) errors.push('at least one connector is required');
  return { connectors, errors };
}

function normalizeFreshness(value) {
  if (value === 'strict' || (value && value.mode === 'strict')) {
    return {
      mode: 'strict',
      windowSeconds: safeInteger(value && value.windowSeconds, 7 * 24 * 60 * 60, 60, 3650 * 24 * 60 * 60),
    };
  }
  return { mode: 'best_effort', windowSeconds: null };
}

function makeRequestId(value) {
  const candidate = asTrimmedString(value);
  return SAFE_REQUEST_ID.test(candidate) ? candidate : `tr-${Date.now().toString(36)}-${hashText(`${Date.now()}-${Math.random()}`)}`;
}

function createTranscriptRequest(input = {}, options = {}) {
  input = input && typeof input === 'object' ? input : {};
  const errors = [];
  const now = options.now instanceof Date ? options.now : new Date();
  const query = asTrimmedString(input.query);
  if (!query) errors.push('query is required');
  if (query.length > MAX_QUERY_CHARS) errors.push(`query exceeds ${MAX_QUERY_CHARS} characters`);
  if (query.startsWith('-')) errors.push('query cannot begin with a dash');

  const connectorResult = normalizeConnectorList(input.connectors);
  errors.push(...connectorResult.errors);

  if (input.mode !== undefined && input.mode !== 'lexical') errors.push('only lexical retrieval is supported');
  if (input.remote === true || input.allowRemote === true) errors.push('remote retrieval is not supported');
  if (input.semantic === true || input.mode === 'semantic' || input.mode === 'hybrid') errors.push('semantic retrieval is not supported');
  const operation = input.operation || input.command;
  if (operation && !['search', 'retrieve', 'pack'].includes(String(operation))) {
    errors.push(`unsupported operation: ${safeDiagnostic(operation)}`);
  }

  const destinationClass = asTrimmedString(input.destinationClass || input.destination || 'on_demand_agent');
  if (!DESTINATION_CLASSES.has(destinationClass)) errors.push(`unsupported destination class: ${safeDiagnostic(destinationClass)}`);

  const sinceDate = input.since == null ? null : parseDate(input.since, now);
  const untilDate = input.until == null ? null : parseDate(input.until, now);
  if (input.since != null && !sinceDate) errors.push('since must be an ISO timestamp or bounded relative period such as 7d');
  if (input.until != null && !untilDate) errors.push('until must be an ISO timestamp');
  if (sinceDate && untilDate && sinceDate > untilDate) errors.push('since must be before until');
  if (untilDate && untilDate > new Date(now.getTime() + 5 * 60 * 1000)) errors.push('until cannot be in the future');

  const sessionRefs = input.sessionRefs === undefined
    ? []
    : (Array.isArray(input.sessionRefs) ? input.sessionRefs : [input.sessionRefs]);
  if (sessionRefs.length > 50) errors.push('sessionRefs exceeds the limit of 50');
  const normalizedSessionRefs = sessionRefs
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim())
    .filter((item) => item.length <= 1024);
  if (normalizedSessionRefs.length !== sessionRefs.length) errors.push('sessionRefs must be non-empty strings of at most 1024 characters');

  const maxTokens = safeInteger(input.maxTokens, DEFAULT_TRANSCRIPT_BUDGET.maxTokens, MIN_TOKEN_BUDGET, DEFAULT_TRANSCRIPT_BUDGET.maxTokens);
  const maxEvidence = safeInteger(input.maxEvidence, DEFAULT_TRANSCRIPT_BUDGET.maxEvidence, 1, 50);
  const maxSessions = safeInteger(input.maxSessions, DEFAULT_TRANSCRIPT_BUDGET.maxSessions, 1, 20);
  const maxExcerptChars = safeInteger(input.maxExcerptChars, DEFAULT_TRANSCRIPT_BUDGET.maxExcerptChars, 80, 4000);

  const request = {
    schema: TRANSCRIPT_REQUEST_SCHEMA,
    requestId: makeRequestId(input.requestId),
    query,
    queryDigest: hashText(query),
    connectors: connectorResult.connectors,
    mode: 'lexical',
    destinationClass,
    freshness: normalizeFreshness(input.freshness),
    since: sinceDate ? sinceDate.toISOString() : null,
    until: untilDate ? untilDate.toISOString() : null,
    sessionRefs: normalizedSessionRefs,
    maxTokens,
    maxEvidence,
    maxSessions,
    maxExcerptChars,
  };
  if (input.schema && input.schema !== TRANSCRIPT_REQUEST_SCHEMA) {
    errors.push(`invalid request schema: ${safeDiagnostic(input.schema)}`);
  }

  return { valid: errors.length === 0, request, errors };
}

function validateTranscriptRequest(request = {}) {
  const result = createTranscriptRequest(request);
  return { valid: result.valid, request: result.request, errors: result.errors };
}

function estimateTranscriptTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(Buffer.byteLength(text || '', 'utf8') / 4);
}

function redactTranscriptText(value, options = {}) {
  const text = String(value || '');
  if (typeof options.classifier === 'function') {
    try {
      const decision = options.classifier(text);
      if (decision === false || (decision && decision.allowed === false)) {
        return { allowed: false, text: '', redacted: false, reason: 'classifier_denied' };
      }
    } catch (_) {
      return { allowed: false, text: '', redacted: false, reason: 'classifier_error' };
    }
  }

  let redacted = false;
  let safeText = text;
  const replacements = [
    [/-----BEGIN [^-\n]{1,80} PRIVATE KEY-----[\s\S]*?-----END [^-\n]{1,80} PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]'],
    [/\b(?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [REDACTED]'],
    [/\b(?:cookie|set-cookie|x-api-key|api-key)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED_CREDENTIAL]'],
    [/\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH(?:ORIZATION)?|CREDENTIALS?)\b\s*=\s*[^\s,;]+/gi, '[REDACTED_ENV_SECRET]'],
    [/\b(?:sk|xai|sess|key)-[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_TOKEN]'],
    [/\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_TOKEN]'],
  ];
  for (const [pattern, replacement] of replacements) {
    const next = safeText.replace(pattern, replacement);
    if (next !== safeText) redacted = true;
    safeText = next;
  }
  return { allowed: true, text: safeText, redacted };
}

function safePathForProvenance(candidate, sourceRoots) {
  if (!candidate) return { valid: true, path: null };
  if (typeof candidate !== 'string' || candidate.includes('\0') || candidate.includes('://')) {
    return { valid: false, reason: 'path_not_local' };
  }
  const raw = candidate.trim();
  if (!path.isAbsolute(raw)) return { valid: false, reason: 'path_not_absolute' };
  const segments = raw.split(/[\\/]+/);
  if (segments.includes('..')) return { valid: false, reason: 'path_traversal' };
  const resolved = path.resolve(raw);
  if (sourceRoots.length > 0) {
    const allowed = sourceRoots.some((root) => {
      const relative = path.relative(path.resolve(root), resolved);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!allowed) return { valid: false, reason: 'path_outside_configured_source_root' };
  }
  return { valid: true, path: resolved };
}

function validSessionId(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) && !value.includes('..');
}

function jsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function collectStrings(value, output = [], depth = 0) {
  if (depth > 5 || value == null) return output;
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/password|secret|token|key|path|env/i.test(key)) continue;
      collectStrings(child, output, depth + 1);
    }
  }
  return output;
}

function discoverConnectors(capabilities) {
  const candidates = [];
  for (const key of ['connectors', 'agents', 'providers', 'sources']) {
    if (capabilities && capabilities[key] !== undefined) candidates.push(capabilities[key]);
  }
  const values = collectStrings(candidates);
  const result = [];
  for (const value of values) {
    const normalized = normalizeConnector(value);
    if (!normalized || result.some((item) => item.id === normalized)) continue;
    result.push({ id: normalized, cassSlug: asTrimmedString(value) });
  }
  return result.sort((a, b) => SUPPORTED_CONNECTORS.indexOf(a.id) - SUPPORTED_CONNECTORS.indexOf(b.id));
}

function hasCapability(value, wanted) {
  const needle = String(wanted).toLowerCase();
  return collectStrings(value).some((item) => item.toLowerCase() === needle || item.toLowerCase().includes(needle));
}

function outcomeError(result) {
  if (result && result.timedOut) return 'timeout';
  if (result && result.outputTooLarge) return 'output_too_large';
  if (result && result.malformed) return 'malformed_output';
  return 'unavailable';
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['evidence', 'results', 'hits', 'items', 'matches']) {
    if (Array.isArray(payload && payload[key])) return payload[key];
  }
  if (payload && payload.pack && Array.isArray(payload.pack.evidence)) return payload.pack.evidence;
  return [];
}

function nestedValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

function freshnessFromPayload(payload) {
  const freshness = payload && (payload.freshness || payload._meta?.freshness || payload.meta?.freshness);
  const staleCount = Number(freshness && (freshness.stale_evidence_count ?? freshness.staleEvidenceCount));
  const stale = payload?.stale === true
    || freshness?.stale === true
    || (Number.isFinite(staleCount) && staleCount > 0);
  return {
    stale,
    state: stale ? 'stale' : 'fresh',
    staleEvidenceCount: Number.isFinite(staleCount) ? staleCount : 0,
  };
}

function makePacket(request, overrides = {}) {
  return {
    schema: TRANSCRIPT_PACKET_SCHEMA,
    requestId: request.requestId,
    queryDigest: request.queryDigest,
    destinationClass: request.destinationClass,
    mode: request.mode,
    status: TRANSCRIPT_STATUS.UNAVAILABLE,
    requestedConnectors: [...request.connectors],
    searchedConnectors: [],
    connectorOutcomes: [],
    evidence: [],
    truncated: false,
    omissions: [],
    warnings: [],
    renderedTokenCount: 0,
    ...overrides,
  };
}

function makeInvalidRequestPacket(request, errors) {
  const boundedErrors = (errors || []).slice(0, 4).map((error) => `invalid_request:${safeDiagnostic(error, 160)}`);
  if ((errors || []).length > boundedErrors.length) boundedErrors.push(`invalid_request_errors_truncated:${errors.length - boundedErrors.length}`);
  const packet = makePacket(request, { omissions: boundedErrors });
  packet.renderedTokenCount = estimateTranscriptTokens(packet);
  return packet;
}

function makeUnavailablePacket(request, reason) {
  const packet = makePacket(request, {
    warnings: ['CASS transcript retrieval is unavailable'],
    omissions: [`preflight:${safeDiagnostic(reason, 80)}`],
  });
  packet.renderedTokenCount = estimateTranscriptTokens(packet);
  return packet;
}

function normalizeRunnerResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, malformed: true };
  const stdout = result.stdout == null ? '' : String(result.stdout);
  return {
    ...result,
    ok: result.ok === true,
    stdout,
    outputTooLarge: result.outputTooLarge === true,
  };
}

function finalizePreflight(adapter, api, capabilitiesResult) {
  const unavailable = (reason, details = {}) => {
    adapter._preflightResult = {
      ok: false,
      status: TRANSCRIPT_STATUS.UNAVAILABLE,
      reason,
      contractVersion: null,
      cassVersion: null,
      connectors: [],
      capabilities: null,
      ...details,
    };
    return adapter._preflightResult;
  };
  if (!api.ok) return unavailable('api_version_' + api.errorKind);
  const contractRaw = api.payload.contract_version ?? api.payload.contractVersion ?? api.payload.contract?.version;
  const contractVersion = Number(contractRaw);
  if (contractVersion !== CASS_CONTRACT_VERSION) return unavailable('incompatible_contract');
  if (!capabilitiesResult || !capabilitiesResult.ok) {
    return unavailable('capabilities_' + (capabilitiesResult?.errorKind || 'unavailable'), { contractVersion });
  }
  const capabilities = capabilitiesResult.payload;
  if (!hasCapability(capabilities, 'pack')) return unavailable('pack_not_supported', { contractVersion, capabilities });
  const modes = capabilities.modes || capabilities.search_modes || capabilities.searchModes;
  if (modes && !hasCapability(modes, 'lexical')) return unavailable('lexical_not_supported', { contractVersion, capabilities });
  adapter._preflightResult = {
    ok: true,
    status: 'available',
    reason: null,
    contractVersion,
    cassVersion: asTrimmedString(api.payload.version) || null,
    connectors: discoverConnectors(capabilities),
    capabilities,
  };
  return adapter._preflightResult;
}

function redactReason(redaction) {
  return redaction.redacted ? 'redaction_applied' : null;
}

class CassTranscriptAdapter {
  constructor(options = {}) {
    this.cassBin = options.cassBin || process.env.JARVOS_CASS_BIN || process.env.CASS_BIN || 'cass';
    this.dataDir = options.dataDir || process.env.JARVOS_CASS_DATA_DIR || null;
    this.cwd = options.cwd || process.cwd();
    this.timeoutMs = safeInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 120000);
    this.maxOutputBytes = safeInteger(options.maxOutputBytes, MAX_OUTPUT_BYTES, 1024, 20 * 1024 * 1024);
    const configuredRoots = options.sourceRoots || process.env.JARVOS_CASS_SOURCE_ROOTS || '';
    this.sourceRoots = (Array.isArray(configuredRoots) ? configuredRoots : [configuredRoots])
      .flatMap((item) => String(item).split(path.delimiter))
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item === '~' ? os.homedir() : item.startsWith('~/') ? path.join(os.homedir(), item.slice(2)) : item);
    this.env = options.env || {};
    this.runner = options.runner || defaultRunner;
    this.asyncRunner = options.asyncRunner || defaultAsyncRunner;
    this.redactExcerpt = options.redactExcerpt || ((text) => redactTranscriptText(text, { classifier: options.classifier }));
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    this._preflightResult = null;
    this._preflightPromise = null;
  }

  buildArgs(subcommand, args = []) {
    const output = [subcommand, ...args];
    // CASS global introspection commands deliberately do not expose
    // --data-dir. The configured data directory still applies to all
    // stateful retrieval commands, while api-version/capabilities remain
    // portable across CASS contract versions.
    if (this.dataDir && !['api-version', 'capabilities'].includes(subcommand)) {
      output.push('--data-dir', this.dataDir);
    }
    return output;
  }

  run(subcommand, args = [], options = {}) {
    const argv = this.buildArgs(subcommand, args);
    return normalizeRunnerResult(this.runner(this.cassBin, argv, {
      cwd: this.cwd,
      env: defaultMinimalEnv(this.env),
      shell: false,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      input: options.input,
    }));
  }

  runAsync(subcommand, args = [], options = {}) {
    const argv = this.buildArgs(subcommand, args);
    return this.asyncRunner(this.cassBin, argv, {
      cwd: this.cwd,
      env: defaultMinimalEnv(this.env),
      shell: false,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      input: options.input,
    }).then(normalizeRunnerResult);
  }

  parseResponse(result) {
    if (!result.ok || result.timedOut || result.outputTooLarge) {
      return { ok: false, errorKind: outcomeError(result), payload: null };
    }
    const payload = jsonObject(result.stdout);
    if (!payload) return { ok: false, errorKind: 'malformed_output', payload: null };
    return { ok: true, payload };
  }

  preflight() {
    if (this._preflightResult) return this._preflightResult;
    const api = this.parseResponse(this.run('api-version', ['--json']));
    const contractRaw = api.ok && (api.payload.contract_version ?? api.payload.contractVersion ?? api.payload.contract?.version);
    const capabilitiesResult = api.ok && Number(contractRaw) === CASS_CONTRACT_VERSION
      ? this.parseResponse(this.run('capabilities', ['--json']))
      : null;
    return finalizePreflight(this, api, capabilitiesResult);
  }

  async preflightAsync() {
    if (this._preflightResult) return this._preflightResult;
    const pending = this._preflightPromise || (this._preflightPromise = (async () => {
      const api = this.parseResponse(await this.runAsync('api-version', ['--json']));
      const contractRaw = api.ok && (api.payload.contract_version ?? api.payload.contractVersion ?? api.payload.contract?.version);
      const capabilitiesResult = api.ok && Number(contractRaw) === CASS_CONTRACT_VERSION
        ? this.parseResponse(await this.runAsync('capabilities', ['--json']))
        : null;
      return finalizePreflight(this, api, capabilitiesResult);
    })());
    try {
      return await pending;
    } finally {
      if (this._preflightPromise === pending) this._preflightPromise = null;
    }
  }

  listSessions(input = {}) {
    const normalizedInput = input && typeof input === 'object' ? input : {};
    const validation = normalizedInput.schema === TRANSCRIPT_REQUEST_SCHEMA ? validateTranscriptRequest(normalizedInput) : null;
    const requestResult = validation
      ? validation
      : createTranscriptRequest({ ...normalizedInput, query: normalizedInput.query || 'session' });
    if (!requestResult.valid) return { ok: false, status: TRANSCRIPT_STATUS.UNAVAILABLE, errors: requestResult.errors };
    const request = requestResult.request;
    const args = ['--json', '--limit', String(Math.min(request.maxSessions * 10, 100))];
    if (request.since) args.push('--since', request.since);
    if (request.until) args.push('--until', request.until);
    const result = this.parseResponse(this.run('sessions', args));
    if (!result.ok) return { ok: false, status: TRANSCRIPT_STATUS.UNAVAILABLE, errorKind: result.errorKind };
    return { ok: true, status: 'available', sessions: extractRows(result.payload) };
  }

  buildPackArgs(request, cassSlug) {
    const args = [
      request.query,
      '--robot',
      '--mode', 'lexical',
      '--agent', cassSlug,
      '--max-tokens', String(request.maxTokens),
      '--max-evidence', String(request.maxEvidence),
      '--max-sessions', String(request.maxSessions),
      '--max-excerpt-chars', String(request.maxExcerptChars),
      '--robot-meta',
      '--request-id', request.requestId,
    ];
    if (request.freshness.mode === 'strict') {
      args.push('--freshness-policy', 'strict', '--freshness-window-seconds', String(request.freshness.windowSeconds), '--require-evidence');
    }
    return args;
  }

  normalizeRow(row, request, logicalConnector, cassSlug) {
    if (!row || typeof row !== 'object') return { valid: false, reason: 'row_not_object' };
    const reportedConnector = normalizeConnector(nestedValue(row, ['agent', 'connector', 'provider', 'source', 'tool']));
    if (reportedConnector && reportedConnector !== logicalConnector) return { valid: false, reason: 'connector_mismatch' };
    const sessionId = String(nestedValue(row, ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'session', 'id']) || '').trim();
    if (!validSessionId(sessionId)) return { valid: false, reason: 'invalid_session_id' };

    const timestampRaw = nestedValue(row, ['timestamp', 'observed_at', 'observedAt', 'created_at', 'createdAt', 'date', 'time']);
    const timestamp = parseDate(timestampRaw, this.clock());
    if (!timestamp) return { valid: false, reason: 'invalid_timestamp' };
    const now = this.clock();
    if (timestamp.getTime() > now.getTime() + 5 * 60 * 1000) return { valid: false, reason: 'future_timestamp' };
    if (request.since && timestamp < new Date(request.since)) return { valid: false, reason: 'before_requested_window' };
    if (request.until && timestamp > new Date(request.until)) return { valid: false, reason: 'after_requested_window' };

    const pathCandidate = nestedValue(row, ['source_path', 'sourcePath', 'path', 'transcript_path', 'transcriptPath']);
    const provenancePath = safePathForProvenance(pathCandidate, this.sourceRoots);
    if (!provenancePath.valid) return { valid: false, reason: provenancePath.reason };

    const excerptRaw = nestedValue(row, ['excerpt', 'snippet', 'text', 'content', 'body']);
    const excerpt = String(excerptRaw || '').trim();
    if (!excerpt) return { valid: false, reason: 'empty_excerpt' };
    const redaction = this.redactExcerpt(excerpt);
    if (!redaction || redaction.allowed === false || !String(redaction.text || '').trim()) {
      return { valid: false, reason: redaction?.reason || 'redaction_denied' };
    }
    const safeExcerpt = String(redaction.text).trim().slice(0, request.maxExcerptChars);
    const line = nestedValue(row, ['line_number', 'lineNumber', 'line']);
    const citationRaw = nestedValue(row, ['citation', 'locator', 'ref', 'message_id', 'messageId']);
    const citation = String(citationRaw || (line != null ? `line:${line}` : 'excerpt')).trim();
    if (!citation || citation.length > 512 || /[\u0000-\u001f\u007f]/.test(citation)) return { valid: false, reason: 'invalid_citation' };

    return {
      valid: true,
      candidate: {
        id: hashText(`${logicalConnector}|${sessionId}|${citation}|${safeExcerpt}`),
        connector: logicalConnector,
        cassConnector: cassSlug,
        sessionId,
        observedAt: timestamp.toISOString(),
        rank: Number(nestedValue(row, ['rank', 'position'])) || null,
        score: Number(nestedValue(row, ['score', 'relevance'])) || 0,
        citation,
        excerpt: safeExcerpt,
        untrustedContent: true,
        redacted: redaction.redacted === true,
      },
      redactionReason: redactReason(redaction),
      trustedSourcePath: provenancePath.path,
    };
  }

  fitEvidence(evidence, request, packet) {
    const selected = [];
    const sessions = new Set();
    const seen = new Set();
    const citationText = new Map();
    const sorted = [...evidence].sort((a, b) => {
      const rankA = a.rank == null ? Number.MAX_SAFE_INTEGER : a.rank;
      const rankB = b.rank == null ? Number.MAX_SAFE_INTEGER : b.rank;
      if (rankA !== rankB) return rankA - rankB;
      if (b.score !== a.score) return b.score - a.score;
      return a.id.localeCompare(b.id);
    });
    for (const item of sorted) {
      const dedupeKey = `${item.connector}|${item.sessionId}|${item.citation}`;
      if (seen.has(item.id)) continue;
      if (citationText.has(dedupeKey) && citationText.get(dedupeKey) !== item.excerpt) {
        packet.omissions.push('invalid_provenance:conflicting_citation');
        continue;
      }
      citationText.set(dedupeKey, item.excerpt);
      if (selected.length >= request.maxEvidence) {
        packet.omissions.push('evidence_limit');
        continue;
      }
      if (!sessions.has(item.sessionId) && sessions.size >= request.maxSessions) {
        packet.omissions.push('session_limit');
        continue;
      }
      seen.add(item.id);
      sessions.add(item.sessionId);
      selected.push(item);
    }

    if (packet.omissions.length > 8) {
      const omittedCount = packet.omissions.length - 7;
      packet.omissions = [...packet.omissions.slice(0, 7), `omissions_truncated:${omittedCount}`];
    }
    if (packet.warnings.length > 8) {
      const warningCount = packet.warnings.length - 7;
      packet.warnings = [...packet.warnings.slice(0, 7), `warnings_truncated:${warningCount}`];
    }

    const render = (renderedTokenCount = 0) => ({
      ...packet,
      evidence: selected,
      renderedTokenCount,
    });
    const measure = () => {
      let tokenCount = estimateTranscriptTokens(render());
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const next = estimateTranscriptTokens(render(tokenCount));
        if (next === tokenCount) return { tokenCount, rendered: render(tokenCount) };
        tokenCount = next;
      }
      return { tokenCount, rendered: render(tokenCount) };
    };
    let measured = measure();
    let guard = 0;
    while (measured.tokenCount > request.maxTokens && selected.length > 0 && guard < 100) {
      guard += 1;
      const overflowBytes = Math.max(1, (measured.tokenCount - request.maxTokens) * 4);
      const trimEach = Math.max(1, Math.ceil(overflowBytes / selected.length));
      let changed = false;
      for (const item of selected) {
        if (item.excerpt.length <= 40) continue;
        const targetLength = Math.max(40, item.excerpt.length - trimEach);
        if (targetLength < item.excerpt.length) {
          item.excerpt = `${item.excerpt.slice(0, targetLength - 1)}…`;
          changed = true;
        }
      }
      packet.truncated = true;
      if (!changed) selected.pop();
      if (!packet.omissions.includes('aggregate_budget')) packet.omissions.push('aggregate_budget');
      measured = measure();
    }
    measured = measure();
    packet.evidence = selected;
    packet.renderedTokenCount = measured.tokenCount;
    return packet;
  }

  normalizePackResult(parsed, request, logicalConnector, connector) {
    if (!parsed.ok) {
      return {
        connector: logicalConnector,
        cassConnector: connector.cassSlug,
        searched: true,
        successful: 0,
        failed: 1,
        evidence: [],
        omissions: ['connector_failed:' + logicalConnector + ':' + parsed.errorKind],
        warnings: ['connector_failed:' + logicalConnector],
        outcome: {
          connector: logicalConnector,
          cassConnector: connector.cassSlug,
          status: 'failed',
          errorKind: parsed.errorKind,
          evidenceCount: 0,
        },
      };
    }

    const freshness = freshnessFromPayload(parsed.payload);
    const evidence = [];
    const omissions = [];
    const warnings = [];
    let invalidCount = 0;
    for (const row of extractRows(parsed.payload)) {
      const item = this.normalizeRow(row, request, logicalConnector, connector.cassSlug);
      if (!item.valid) {
        invalidCount += 1;
        omissions.push('invalid_provenance:' + item.reason);
        continue;
      }
      evidence.push(item.candidate);
      if (item.redactionReason) warnings.push(logicalConnector + ':' + item.redactionReason);
    }

    const stale = freshness.stale;
    const strictStale = stale && request.freshness.mode === 'strict';
    if (strictStale) {
      omissions.push('stale:' + logicalConnector);
      return {
        connector: logicalConnector,
        cassConnector: connector.cassSlug,
        searched: true,
        successful: 0,
        failed: 1,
        evidence: [],
        omissions,
        warnings,
        outcome: {
          connector: logicalConnector,
          cassConnector: connector.cassSlug,
          status: 'stale',
          evidenceCount: 0,
          invalidCount,
          freshness,
        },
      };
    }

    if (stale) warnings.push('stale:' + logicalConnector);
    return {
      connector: logicalConnector,
      cassConnector: connector.cassSlug,
      searched: true,
      successful: 1,
      failed: 0,
      evidence,
      omissions,
      warnings,
      outcome: {
        connector: logicalConnector,
        cassConnector: connector.cassSlug,
        status: stale ? 'stale_best_effort' : evidence.length ? 'fresh_evidence' : 'fresh_no_evidence',
        evidenceCount: evidence.length,
        invalidCount,
        freshness,
      },
    };
  }

  incompatibleConnectorResult(logicalConnector) {
    return {
      connector: logicalConnector,
      searched: false,
      successful: 0,
      failed: 1,
      evidence: [],
      omissions: ['incompatible_connector:' + logicalConnector],
      warnings: [],
      outcome: { connector: logicalConnector, status: 'incompatible', evidenceCount: 0 },
    };
  }

  packInvocation(request, connector) {
    const args = this.buildPackArgs(request, connector.cassSlug);
    const runOptions = {};
    if (request.sessionRefs.length > 0) {
      args.push('--sessions-from', '-');
      runOptions.input = request.sessionRefs.join('\n') + '\n';
    }
    return { args, runOptions };
  }

  setPacketStatus(packet, successful, failed, evidenceCount, budgetDegraded = false) {
    if (successful === 0) packet.status = TRANSCRIPT_STATUS.UNAVAILABLE;
    else if (
      failed > 0
      || budgetDegraded
      || packet.connectorOutcomes.some((item) => ['incompatible', 'stale', 'stale_best_effort'].includes(item.status))
    ) packet.status = TRANSCRIPT_STATUS.PARTIAL;
    else if (evidenceCount > 0) packet.status = TRANSCRIPT_STATUS.EVIDENCE_FOUND;
    else packet.status = TRANSCRIPT_STATUS.NO_EVIDENCE;
  }

  finalizePacket(request, results) {
    const packet = makePacket(request);
    const evidence = [];
    let successful = 0;
    let failed = 0;
    for (const result of results) {
      if (result.searched) packet.searchedConnectors.push(result.connector);
      packet.connectorOutcomes.push(result.outcome);
      packet.omissions.push(...result.omissions);
      packet.warnings.push(...result.warnings);
      evidence.push(...result.evidence);
      successful += result.successful;
      failed += result.failed;
    }

    this.setPacketStatus(packet, successful, failed, evidence.length);
    const hadEvidence = evidence.length > 0;
    this.fitEvidence(evidence, request, packet);
    for (const outcome of packet.connectorOutcomes) {
      outcome.evidenceCount = packet.evidence.filter((item) => item.connector === outcome.connector).length;
    }
    const budgetDegraded = hadEvidence
      && (packet.truncated || packet.omissions.some((item) => ['aggregate_budget', 'evidence_limit', 'session_limit'].includes(item)));
    this.setPacketStatus(packet, successful, failed, packet.evidence.length, budgetDegraded);
    packet.renderedTokenCount = estimateTranscriptTokens(packet);
    return packet;
  }

  retrieve(input = {}) {
    const requestResult = createTranscriptRequest(input);
    const request = requestResult.request;
    if (!requestResult.valid) return makeInvalidRequestPacket(request, requestResult.errors);

    const preflight = this.preflight();
    if (!preflight.ok) return makeUnavailablePacket(request, preflight.reason);

    const results = [];
    for (const logicalConnector of request.connectors) {
      const connector = preflight.connectors.find((item) => item.id === logicalConnector);
      if (!connector) {
        results.push(this.incompatibleConnectorResult(logicalConnector));
        continue;
      }
      const invocation = this.packInvocation(request, connector);
      const parsed = this.parseResponse(this.run('pack', invocation.args, invocation.runOptions));
      results.push(this.normalizePackResult(parsed, request, logicalConnector, connector));
    }
    return this.finalizePacket(request, results);
  }

  async retrieveAsync(input = {}) {
    const requestResult = createTranscriptRequest(input);
    const request = requestResult.request;
    if (!requestResult.valid) return makeInvalidRequestPacket(request, requestResult.errors);

    const preflight = this._preflightResult || await this.preflightAsync();
    if (!preflight.ok) return makeUnavailablePacket(request, preflight.reason);

    const results = await Promise.all(request.connectors.map(async (logicalConnector) => {
      const connector = preflight.connectors.find((item) => item.id === logicalConnector);
      if (!connector) return this.incompatibleConnectorResult(logicalConnector);
      const invocation = this.packInvocation(request, connector);
      const parsed = this.parseResponse(await this.runAsync('pack', invocation.args, invocation.runOptions));
      return this.normalizePackResult(parsed, request, logicalConnector, connector);
    }));
    return this.finalizePacket(request, results);
  }

}

function createCassTranscriptAdapter(options = {}) {
  return new CassTranscriptAdapter(options);
}

function retrieveTranscripts(request, options = {}) {
  return createCassTranscriptAdapter(options).retrieve(request);
}

module.exports = {
  CASS_CONTRACT_VERSION,
  DEFAULT_TRANSCRIPT_BUDGET,
  SUPPORTED_CONNECTORS,
  TRANSCRIPT_PACKET_SCHEMA,
  TRANSCRIPT_REQUEST_SCHEMA,
  TRANSCRIPT_STATUS,
  CassTranscriptAdapter,
  createCassTranscriptAdapter,
  createTranscriptRequest,
  estimateTranscriptTokens,
  redactTranscriptText,
  retrieveTranscripts,
  validateTranscriptRequest,
};
