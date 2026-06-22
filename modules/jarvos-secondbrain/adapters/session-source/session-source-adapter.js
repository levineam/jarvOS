'use strict';

const crypto = require('node:crypto');
const {
  CAPTURE_EVENT_SCHEMA_VERSION,
  validateCaptureEvent,
} = require('../../packages/jarvos-ambient/src/intent/capture-contract');

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
  const timestamp = firstString(
    message.timestamp,
    message.createdAt,
    message.updatedAt,
    session.updatedAt,
    session.startedAt,
  );
  const actorModel = firstString(message.model, session.model);

  return {
    id: `capture:${tool}:${sourceId}:${sourceMessageId}`,
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
