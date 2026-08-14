'use strict';

const crypto = require('node:crypto');
const {
  CAPTURE_EVENT_SCHEMA_VERSION,
  validateCaptureEvent,
} = require('../../packages/jarvos-ambient/src/intent/capture-contract');
const {
  digestText,
  normalizeContentOrigin,
} = require('../../bridge/provenance/src/content-origin-contract');

const TOOL_SOURCE = {
  openclaw: 'openclaw',
  codex: 'codex',
  'claude-code': 'claude-code',
};

const ROLE_TO_ACTOR = {
  user: 'human',
  human: 'human',
  assistant: 'assistant',
  ai: 'assistant',
  system: 'system',
  tool: 'tool',
};
const PRIVACY_RANK = {
  public: 0,
  'local-private': 1,
  private: 2,
  sensitive: 3,
  secret: 4,
};

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isoDate(value) {
  const source = firstString(value);
  if (!source) return undefined;
  const match = source.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

function messageText(message = {}) {
  if (typeof message === 'string') return message;
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => firstString(part.text, part.content))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function messageId(message = {}, index) {
  return firstString(message.id, message.messageId, message.uuid) || `message-${index + 1}`;
}

function actorForMessage(message = {}) {
  const role = firstString(message.role, message.actor, message.type).toLowerCase();
  return ROLE_TO_ACTOR[role] || 'unknown';
}

function originForMessage({ actorType, text, captureEventId, message = {}, session = {}, options = {} }) {
  const suppliedOrigin = message.content_origin
    ?? message.contentOrigin
    ?? session.content_origin
    ?? session.contentOrigin
    ?? options.content_origin
    ?? options.contentOrigin;
  const suppliedBasis = message.content_origin_basis
    ?? message.contentOriginBasis
    ?? session.content_origin_basis
    ?? session.contentOriginBasis
    ?? options.content_origin_basis
    ?? options.contentOriginBasis;
  const suppliedSource = message.user_source
    ?? message.userSource
    ?? session.user_source
    ?? session.userSource
    ?? options.user_source
    ?? options.userSource;

  let userSourceRecord = message.user_source_record
    ?? message.userSourceRecord
    ?? session.user_source_record
    ?? session.userSourceRecord
    ?? options.user_source_record
    ?? options.userSourceRecord;

  if (suppliedOrigin || suppliedBasis || suppliedSource) {
    const candidate = {
      content_origin: suppliedOrigin || 'unknown',
      content_origin_basis: suppliedBasis || 'unknown',
      ...(suppliedSource ? { user_source: suppliedSource } : {}),
    };
    const normalized = normalizeContentOrigin(candidate, {
      content: text,
      resolveUserSource: options.resolveUserSource || (userSourceRecord
        ? (captureEventIdToResolve) => {
          const id = userSourceRecord.capture_event_id || userSourceRecord.captureEventId || userSourceRecord.id;
          return id === captureEventIdToResolve ? userSourceRecord : null;
        }
        : null),
      captureEventId,
    });
    return {
      ...normalized,
      ...(userSourceRecord ? { user_source_record: userSourceRecord } : {}),
    };
  }

  if (actorType === 'human') {
    const userSource = {
      capture_event_id: captureEventId,
      actor: 'user',
      source_digest: digestText(text),
      content_digest: digestText(text),
    };
    userSourceRecord = {
      capture_event_id: captureEventId,
      actor: 'user',
      text,
    };
    const normalized = normalizeContentOrigin({
      content_origin: 'human',
      content_origin_basis: 'verbatim_user',
      user_source: userSource,
    }, {
      content: text,
      resolveUserSource: () => userSourceRecord,
      captureEventId,
    });
    return {
      ...normalized,
      user_source_record: userSourceRecord,
    };
  }

  if (actorType === 'assistant') {
    return { content_origin: 'assistant', content_origin_basis: 'assistant_generated' };
  }
  if (actorType === 'mixed') {
    return { content_origin: 'mixed', content_origin_basis: 'mixed_composition' };
  }
  return { content_origin: 'unknown', content_origin_basis: 'unknown' };
}

function sessionMessages(session = {}) {
  return [
    ...asArray(session.messages),
    ...asArray(session.turns),
    ...asArray(session.entries),
  ];
}

function privacyTierForSession(session = {}, options = {}) {
  if (options.private === true || session.private === true || session.isPrivate === true) {
    return 'private';
  }
  const candidates = [
    firstString(options.privacyTier),
    firstString(session.privacyTier),
  ].filter(Boolean);
  return candidates.sort((a, b) => (PRIVACY_RANK[b] ?? -1) - (PRIVACY_RANK[a] ?? -1))[0] || 'local-private';
}

function sourcePath(session = {}, options = {}) {
  return firstString(
    options.sourcePath,
    session.sourcePath,
    session.path,
    session.filePath,
    session.transcriptPath,
  );
}

function buildCaptureEvent({ tool, session, message, index, options }) {
  const text = messageText(message).trim();
  if (!text) return null;

  const sourceId = firstString(
    session.id,
    session.sessionId,
    session.conversationId,
    session.threadId,
  ) || `${tool}-${stableHash({ path: sourcePath(session, options), startedAt: session.startedAt, title: session.title })}`;
  const sourceMessageId = messageId(message, index);
  const path = sourcePath(session, options);
  const actorType = actorForMessage(message);
  const captureEventId = `capture:${tool}:${sourceId}:${sourceMessageId}`;
  const contentOrigin = originForMessage({
    actorType,
    text,
    captureEventId,
    message,
    session,
    options,
  });
  const timestamp = firstString(
    message.timestamp,
    message.createdAt,
    message.updatedAt,
    session.updatedAt,
    session.startedAt,
  );
  const actorModel = firstString(message.model, session.model);

  return {
    id: captureEventId,
    captureEventId,
    schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
    text,
    date: isoDate(timestamp),
    source: {
      tool: TOOL_SOURCE[tool] || tool,
      sessionId: sourceId,
      messageId: sourceMessageId,
      ...(path ? { path } : {}),
      ...(firstString(session.title) ? { label: session.title.trim() } : {}),
    },
    actor: {
      type: actorType,
      ...(firstString(message.name) ? { name: message.name.trim() } : {}),
      ...(actorModel ? { model: actorModel } : {}),
      ...(firstString(message.role) ? { role: message.role.trim() } : {}),
    },
    captureMode: options.captureMode || session.captureMode || 'session-summary',
    privacyTier: privacyTierForSession(session, options),
    evidence: [{
      type: 'message',
      messageId: sourceMessageId,
      quote: text,
      sourceId,
      ...(path ? { path } : {}),
      ...(timestamp ? { ref: timestamp } : {}),
    }],
    origin: {
      kind: 'session',
      ref: sourceId,
      ...(path ? { path } : {}),
    },
    content_origin_schema: contentOrigin.schema_version || 'jarvos-content-origin/v1',
    content_origin: contentOrigin.content_origin,
    content_origin_basis: contentOrigin.content_origin_basis,
    ...(contentOrigin.user_source ? { user_source: contentOrigin.user_source } : {}),
    ...(contentOrigin.user_source_record ? { user_source_record: contentOrigin.user_source_record } : {}),
    human_evidence_eligible: contentOrigin.human_evidence_eligible === true,
  };
}

function normalizeSessionToCaptureEvents(tool, session = {}, options = {}) {
  if (!TOOL_SOURCE[tool]) {
    return {
      events: [],
      skipped: [{
        reason: 'unsupported-source-tool',
        sourceTool: tool,
      }],
    };
  }

  const skipped = [];
  const events = [];
  const privateSession = privacyTierForSession(session, options);
  if (privateSession === 'secret') {
    return {
      events,
      skipped: [{
        reason: 'secret-session-not-emitted',
        sourceTool: TOOL_SOURCE[tool],
      }],
    };
  }

  sessionMessages(session).forEach((message, index) => {
    const event = buildCaptureEvent({ tool, session, message, index, options });
    if (!event) {
      skipped.push({
        reason: 'empty-message',
        sourceTool: TOOL_SOURCE[tool],
        messageId: messageId(message, index),
      });
      return;
    }

    const validationErrors = validateCaptureEvent(event);
    if (validationErrors.length > 0) {
      skipped.push({
        reason: 'invalid-capture-event',
        sourceTool: TOOL_SOURCE[tool],
        messageId: messageId(message, index),
        errors: validationErrors,
      });
      return;
    }

    events.push(event);
  });

  return { events, skipped };
}

function createSessionSourceAdapter(tool, defaults = {}) {
  return {
    sourceTool: TOOL_SOURCE[tool] || tool,
    normalizeSession(session, options = {}) {
      return normalizeSessionToCaptureEvents(tool, session, {
        ...defaults,
        ...options,
      });
    },
  };
}

module.exports = {
  createSessionSourceAdapter,
  normalizeSessionToCaptureEvents,
};
