'use strict';

const {
  CAPTURE_EVENT_SCHEMA_VERSION,
  validateCaptureEvent,
} = require('../../../packages/jarvos-ambient/src/intent/capture-contract');
const {
  normalizeContentOrigin,
} = require('../../provenance/src/content-origin-contract');
const {
  applyRoutingPlan,
  detectTrigger,
} = require('../../routing/src/keyword-capture-router');
const {
  createStorageAdapter,
} = require('../../../adapters');
const { receiptIsAcknowledged } = require('../../../src/artifact-receipt');

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

function normalizeCaptureEvent(rawInput = {}, options = {}) {
  const raw = rawInput.captureEvent && typeof rawInput.captureEvent === 'object'
    ? { ...rawInput.captureEvent, ...rawInput }
    : { ...rawInput };
  delete raw.captureEvent;

  const text = String(raw.text ?? raw.content ?? raw.body ?? '').trim();
  const source = normalizeSource(raw);
  const hasOriginDeclaration = raw.content_origin != null
    || raw.contentOrigin != null
    || raw.content_origin_basis != null
    || raw.contentOriginBasis != null
    || raw.user_source != null
    || raw.userSource != null;
  const sourceRecord = raw.user_source_record || raw.userSourceRecord;
  const resolveUserSource = options.resolveUserSource || raw.resolveUserSource || (sourceRecord
    ? (captureEventId) => {
      const id = sourceRecord.capture_event_id || sourceRecord.captureEventId || sourceRecord.id;
      return id === captureEventId ? sourceRecord : null;
    }
    : null);
  const captureEventId = raw.captureEventId || raw.capture_event_id || raw.eventId;
  const contentOrigin = normalizeContentOrigin({
    content_origin: raw.content_origin ?? raw.contentOrigin,
    content_origin_basis: raw.content_origin_basis ?? raw.contentOriginBasis,
    user_source: raw.user_source ?? raw.userSource,
  }, {
    content: text,
    resolveUserSource,
    captureEventId,
  });
  if (options.requireDeclaration === true && !hasOriginDeclaration) {
    const error = new Error('invalid CaptureEvent v2: content_origin declaration is required at the canonical writer boundary');
    error.errors = ['content_origin declaration is required at the canonical writer boundary'];
    throw error;
  }
  const event = {
    schemaVersion: String(raw.schemaVersion || CAPTURE_EVENT_SCHEMA_VERSION),
    captureEventId,
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
    content_origin_schema: contentOrigin.schema_version,
    content_origin: contentOrigin.content_origin,
    content_origin_basis: contentOrigin.content_origin_basis,
    user_source: contentOrigin.user_source,
    human_evidence_eligible: contentOrigin.human_evidence_eligible,
    substantive: raw.substantive,
    createNote: raw.createNote,
    createDurableNote: raw.createDurableNote,
    durable: raw.durable,
    durableNote: raw.durableNote,
    standaloneNote: raw.standaloneNote,
  };

  const normalized = compact(event);
  const errors = validateCaptureEvent(normalized, { requireDeclaration: false });
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
    capture_event_id: event.captureEventId,
    content_origin_schema: event.content_origin_schema,
    capture_mode: event.captureMode,
    privacy_tier: event.privacyTier,
    origin_ref: origin,
    evidence_count: Array.isArray(event.evidence) ? event.evidence.length : 0,
    content_origin: event.content_origin,
    content_origin_basis: event.content_origin_basis,
    content_origin_source: event.user_source,
    human_evidence_eligible: event.human_evidence_eligible,
  });
}

function isLikelyProgrammaticCapture(event = {}) {
  const title = String(event.title || '').trim();
  const text = String(event.text || event.content || event.body || '').trim();
  if (!title || !text) return false;
  return event.source && typeof event.source === 'object' && typeof event.source.tool === 'string';
}

function defaultProgrammaticTrigger(event = {}) {
  if (event.trigger || detectTrigger(event)) return event.trigger;
  return isLikelyProgrammaticCapture(event) ? 'note' : event.trigger;
}

function ignoredCaptureMessage() {
  return 'Capture ignored: no explicit trigger or capture intent was detected. Intentional programmatic callers must send trigger: "note" or note-like text such as "note: ...".';
}

function captureWithJarvos(rawInput = {}, options = {}) {
  const captureEvent = normalizeCaptureEvent(rawInput, options);
  const adapter = options.adapter || createStorageAdapter(options);
  const frontmatter = {
    ...(captureEvent.frontmatter || {}),
    ...frontmatterForCaptureEvent(captureEvent),
  };
  const routingInput = {
    ...captureEvent,
    trigger: defaultProgrammaticTrigger(captureEvent),
    frontmatter,
  };
  const routing = applyRoutingPlan(routingInput, { ...options, adapter });

  return {
    // A routed operation is successful only when every artifact it promised
    // is acknowledged by the canonical storage owner.  A locally-pending,
    // deferred, conflict, or failed receipt remains visible but is not a
    // successful write claim.
    ok: !routing.plan.ignored && receiptIsAcknowledged(routing.artifactReceipt),
    captureEvent,
    routing,
    artifactReceipt: routing.artifactReceipt,
    note: routing.note,
    journalEntry: routing.journalEntry,
    noteLink: routing.noteLink,
    knowledge: routing.note?.knowledge || null,
    error: routing.plan.ignored ? ignoredCaptureMessage() : null,
  };
}

async function main() {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const parsed = input.trim() ? JSON.parse(input) : {};
      const result = captureWithJarvos(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.routing?.plan?.ignored) {
        process.stderr.write(`${result.error}\n`);
        process.exitCode = 2;
      }
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
  ignoredCaptureMessage,
  main,
  normalizeCaptureEvent,
};

if (require.main === module) {
  main();
}
