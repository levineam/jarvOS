'use strict';

const {
  CAPTURE_EVENT_SCHEMA_VERSION,
  validateCaptureEvent,
} = require('../../../packages/jarvos-ambient/src/intent/capture-contract');
const {
  applyRoutingPlan,
} = require('../../routing/src/keyword-capture-router');
const {
  createStorageAdapter,
} = require('../../../adapters');

function compact(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (entry !== undefined && entry !== null && entry !== '') out[key] = entry;
  }
  return out;
}

function sourceTool(source) {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') return source.tool || source.label || 'unknown';
  return 'unknown';
}

function normalizeSource(raw = {}) {
  if (raw.source && typeof raw.source === 'object') return raw.source;
  const tool = raw.source || raw.sourceTool || raw.agent || raw.personality || raw.runtime || 'unknown';
  return compact({
    tool: String(tool).trim().toLowerCase(),
    sessionId: raw.sessionId,
    messageId: raw.messageId,
    threadId: raw.threadId,
    accountId: raw.accountId,
    path: raw.sourcePath,
    uri: raw.sourceUri,
    label: raw.sourceLabel,
  });
}

function normalizeActor(raw = {}, source = {}) {
  if (raw.actor && typeof raw.actor === 'object') return raw.actor;
  if (typeof raw.actor === 'string') return raw.actor;
  return compact({
    type: raw.actorType || 'assistant',
    name: raw.actorName || source.label || source.tool || raw.personality || raw.agent,
    model: raw.model,
    role: raw.role,
  });
}

function normalizeOrigin(raw = {}, source = {}) {
  if (raw.origin && typeof raw.origin === 'object') return raw.origin;
  if (typeof raw.origin === 'string') return raw.origin;
  return compact({
    kind: raw.originKind || 'prompt',
    ref: raw.originRef || raw.messageId || raw.sessionId || `${source.tool || 'unknown'}:prompt`,
    path: raw.originPath,
    uri: raw.originUri,
    id: raw.originId,
  });
}

function normalizeEvidence(raw = {}, text) {
  if (Array.isArray(raw.evidence)) return raw.evidence;
  return [{
    type: raw.evidenceType || 'text',
    text,
    sourceId: raw.messageId || raw.sessionId || raw.originId,
    ref: raw.originRef,
  }].map(compact);
}

function normalizeCaptureEvent(rawInput = {}) {
  const raw = rawInput.captureEvent && typeof rawInput.captureEvent === 'object'
    ? { ...rawInput.captureEvent, ...rawInput }
    : { ...rawInput };
  delete raw.captureEvent;

  const text = String(raw.text ?? raw.content ?? raw.body ?? '').trim();
  const source = normalizeSource(raw);
  const event = {
    schemaVersion: String(raw.schemaVersion || CAPTURE_EVENT_SCHEMA_VERSION),
    trigger: raw.trigger || raw.keyword || raw.mode || raw.type || raw.route,
    salienceClass: raw.salienceClass,
    confidence: raw.confidence,
    title: raw.title,
    text: raw.text,
    content: raw.content ?? raw.body,
    rationale: raw.rationale,
    frontmatter: raw.frontmatter,
    date: raw.date,
    source,
    actor: normalizeActor(raw, source),
    captureMode: raw.captureMode || 'prompted',
    privacyTier: raw.privacyTier || 'local-private',
    origin: normalizeOrigin(raw, source),
    evidence: normalizeEvidence(raw, text),
    substantive: raw.substantive,
  };

  const normalized = compact(event);
  const errors = validateCaptureEvent(normalized);
  if (errors.length) {
    const error = new Error(`invalid CaptureEvent v2: ${errors.join('; ')}`);
    error.errors = errors;
    error.captureEvent = normalized;
    throw error;
  }
  return normalized;
}

function frontmatterForCaptureEvent(event) {
  const source = sourceTool(event.source);
  const origin = typeof event.origin === 'string' ? event.origin : (event.origin.ref || event.origin.id || event.origin.path || event.origin.uri);
  return compact({
    source,
    source_tool: source,
    source_actor: typeof event.actor === 'string' ? event.actor : event.actor.type,
    source_agent: typeof event.actor === 'string' ? event.actor : event.actor.name,
    capture_event_schema: event.schemaVersion,
    capture_mode: event.captureMode,
    privacy_tier: event.privacyTier,
    origin_ref: origin,
    evidence_count: Array.isArray(event.evidence) ? event.evidence.length : 0,
  });
}

function captureWithJarvos(rawInput = {}, options = {}) {
  const captureEvent = normalizeCaptureEvent(rawInput);
  const adapter = options.adapter || createStorageAdapter(options);
  const frontmatter = {
    ...frontmatterForCaptureEvent(captureEvent),
    ...(captureEvent.frontmatter || {}),
  };
  const routingInput = {
    ...captureEvent,
    frontmatter,
  };
  const routing = applyRoutingPlan(routingInput, { ...options, adapter });

  return {
    ok: !routing.plan.ignored,
    captureEvent,
    routing,
    note: routing.note,
    journalEntry: routing.journalEntry,
    noteLink: routing.noteLink,
    knowledge: routing.note?.knowledge || null,
  };
}

async function main() {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const parsed = input.trim() ? JSON.parse(input) : {};
      process.stdout.write(`${JSON.stringify(captureWithJarvos(parsed), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        error: error.message,
        errors: error.errors || [],
      }, null, 2)}\n`);
      process.exit(1);
    }
  });
}

module.exports = {
  captureWithJarvos,
  frontmatterForCaptureEvent,
  main,
  normalizeCaptureEvent,
};

if (require.main === module) {
  main();
}
