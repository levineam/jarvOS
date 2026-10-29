'use strict';

const {
  CAPTURE_EVENT_SCHEMA_VERSION,
  validateCaptureEvent,
} = require('../../../packages/jarvos-ambient/src/intent/capture-contract');
const {
  normalizeContentOrigin,
  collectDraftingDeclarations,
  hasAssistantContribution,
  normalizeDraftingList,
} = require('../../provenance/src/content-origin-contract');
const {
  applyRoutingPlan,
  applyParsedStrictCommandPlan,
  parseHardCaptureCommand,
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
  // A serialized source record is not a trusted receipt resolver. The caller
  // must inject the harness-owned event lookup explicitly.
  const resolveUserSource = options.resolveUserSource || raw.resolveUserSource || null;
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
  const declaredOrigin = raw.content_origin ?? raw.contentOrigin;
  const declaredBasis = raw.content_origin_basis ?? raw.contentOriginBasis;
  if (options.requireDeclaration === true
    && (!hasOriginDeclaration || typeof declaredOrigin !== 'string' || typeof declaredBasis !== 'string')) {
    const error = new Error('invalid CaptureEvent v2: content_origin declaration is required at the canonical writer boundary');
    error.errors = ['content_origin declaration is required at the canonical writer boundary'];
    throw error;
  }
  if (options.requireDeclaration === true && declaredOrigin === 'human' && contentOrigin.content_origin !== 'human') {
    const error = new Error('invalid CaptureEvent v2: human content requires a valid user-source receipt');
    error.errors = ['human content requires a valid user-source receipt'];
    throw error;
  }
  // Drafting history is only what the caller declares; actor.model is never a
  // drafting identity, and a served model needs the injected resolver.
  const collected = collectDraftingDeclarations(raw.content_origin_drafting, raw.drafting);
  const drafting = collected.ok
    ? normalizeDraftingList(collected.entries, { fresh: true, resolveServedModel: options.resolveServedModel })
    : collected;
  if (drafting.ok && contentOrigin.content_origin === 'human' && hasAssistantContribution(drafting.entries)) {
    drafting.ok = false;
    drafting.reason = 'human_origin_with_assistant_history';
  }
  if (!drafting.ok) {
    const error = new Error(`invalid CaptureEvent v2: content_origin_drafting rejected: ${drafting.reason}`);
    error.errors = [`content_origin_drafting rejected: ${drafting.reason}`];
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
    content_origin_drafting: drafting.entries.length ? drafting.entries : undefined,
    substantive: raw.substantive,
    createNote: raw.createNote,
    createDurableNote: raw.createDurableNote,
    durable: raw.durable,
    durableNote: raw.durableNote,
    standaloneNote: raw.standaloneNote,
    captureIdentity: raw.captureIdentity,
  };

  const normalized = compact(event);
  // Keep an explicitly supplied null visible to the normal validation/error
  // contract instead of silently dropping it with legacy empty fields.
  if (raw.captureIdentity !== undefined) normalized.captureIdentity = raw.captureIdentity;
  const errors = validateCaptureEvent(normalized, { requireDeclaration: options.requireDeclaration === true });
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
    content_origin_drafting: event.content_origin_drafting,
  });
}

function ignoredCaptureMessage() {
  return 'Capture ignored: no explicit trigger or capture intent was detected. Intentional programmatic callers must send trigger: "note" or note-like text such as "note: ...".';
}

function captureWithJarvos(rawInput = {}, options = {}) {
  const captureEvent = normalizeCaptureEvent(rawInput, options);
  const hardCommand = parseHardCaptureCommand(captureEvent);
  const adapter = options.adapter || createStorageAdapter(options);
  const frontmatter = {
    ...(captureEvent.frontmatter || {}),
    ...frontmatterForCaptureEvent(captureEvent),
  };
  const routingInput = {
    ...captureEvent,
    trigger: hardCommand.matched
      ? hardCommand.route
      : captureEvent.trigger,
    frontmatter,
  };
  const routing = hardCommand.matched
    ? applyParsedStrictCommandPlan(routingInput, hardCommand, { ...options, adapter })
    : applyRoutingPlan(routingInput, { ...options, adapter });
  const ignored = hardCommand.matched ? false : routing.plan.ignored;

  return {
    // A routed operation is successful only when every artifact it promised
    // is acknowledged by the canonical storage owner.  A locally-pending,
    // deferred, conflict, or failed receipt remains visible but is not a
    // successful write claim.
    ok: hardCommand.disposition === 'capture'
      ? receiptIsAcknowledged(routing.artifactReceipt)
      : !ignored && receiptIsAcknowledged(routing.artifactReceipt),
    captureEvent,
    hardCommand,
    routing,
    artifactReceipt: routing.artifactReceipt,
    note: routing.note,
    journalEntry: routing.journalEntry,
    noteLink: routing.noteLink,
    knowledge: routing.note?.knowledge || null,
    error: ignored ? ignoredCaptureMessage() : null,
  };
}

// Process exit codes for the capture CLI. A caller (an agent shell, a hook, a
// script) reads the code, not the JSON, so a capture that was not acknowledged
// must never exit 0.
const EXIT_OK = 0;
const EXIT_ERROR = 1; // unreadable input or an exception
const EXIT_NOT_CAPTURED = 2; // ignored (no capture intent) or a bare command that needs input
const EXIT_NOT_ACKNOWLEDGED = 3; // routed, but a promised artifact was not acknowledged

function captureExitCode(result) {
  if (result?.ok === true) return EXIT_OK;
  if (result?.routing?.plan?.ignored || result?.hardCommand?.disposition === 'needs_input') return EXIT_NOT_CAPTURED;
  return EXIT_NOT_ACKNOWLEDGED;
}

// Stderr line for a non-ok result: the first non-acknowledged artifact plus the
// sanitized adapter failure text, when the mutation adapter recorded one.
function captureFailureMessage(result) {
  if (result?.ok === true) return null;
  if (result?.error) return result.error;
  if (result?.hardCommand?.disposition === 'needs_input') return result.routing?.response || 'Capture needs input.';
  const artifacts = result?.artifactReceipt?.artifacts || [];
  const failed = artifacts.filter((artifact) => !['committed', 'already_satisfied'].includes(artifact.outcome));
  const parts = failed.map((artifact) => `${artifact.kind} ${artifact.vaultRelativePath}: ${artifact.outcome}`);
  const evidence = [result?.journalEntry?.receipt, result?.note?.receipt, result?.noteLink?.receipt]
    .map((receipt) => receipt?.adapterEvidence)
    .find((entry) => entry?.errorClass || entry?.reason);
  const detail = evidence ? ` (${evidence.errorClass || evidence.reason}${evidence.errorMessage ? `: ${evidence.errorMessage}` : ''})` : '';
  return `Capture not acknowledged${parts.length ? `: ${parts.join('; ')}` : ''}${detail}`;
}

function main({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, capture = captureWithJarvos, setExitCode = (code) => { process.exitCode = code; } } = {}) {
  return new Promise((resolve) => {
    let input = '';
    stdin.on('data', (chunk) => { input += chunk; });
    stdin.on('end', () => {
      let code = EXIT_ERROR;
      try {
        const parsed = input.trim() ? JSON.parse(input) : {};
        const result = capture(parsed);
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        code = captureExitCode(result);
        const message = captureFailureMessage(result);
        if (message) stderr.write(`${message}\n`);
      } catch (error) {
        stderr.write(`${JSON.stringify({
          error: error.message,
          errors: error.errors || [],
        }, null, 2)}\n`);
        code = EXIT_ERROR;
      }
      setExitCode(code);
      resolve(code);
    });
  });
}

module.exports = {
  EXIT_ERROR,
  EXIT_NOT_ACKNOWLEDGED,
  EXIT_NOT_CAPTURED,
  EXIT_OK,
  captureExitCode,
  captureFailureMessage,
  captureWithJarvos,
  frontmatterForCaptureEvent,
  ignoredCaptureMessage,
  main,
  normalizeCaptureEvent,
};

if (require.main === module) {
  main();
}
