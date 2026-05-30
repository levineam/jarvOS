'use strict';

const REVIEW_ENGINE_SCHEMA_VERSION = 'jarvos-coding-review-engine/v1';
const DEFAULT_CLAWPATCH_COMMAND = Object.freeze(['clawpatch']);
const DEFAULT_AUTOREVIEW_COMMAND = Object.freeze(['autoreview']);

function normalizeCommand(command, fallback) {
  if (Array.isArray(command) && command.length > 0) {
    return command.map((part) => String(part)).filter(Boolean);
  }
  if (typeof command === 'string' && command.trim()) return [command.trim()];
  return [...fallback];
}

function requireRunner(runner) {
  if (typeof runner !== 'function') {
    throw new Error('review engine runner is required');
  }
  return runner;
}

async function runReviewCommand(runner, payload) {
  const result = await requireRunner(runner)(payload);
  return {
    schemaVersion: REVIEW_ENGINE_SCHEMA_VERSION,
    engine: payload.engine,
    stage: payload.stage,
    tool: payload.tool,
    command: payload.command,
    status: result?.status || (result?.ok === false ? 'failed' : 'passed'),
    artifact: result?.artifact || result?.artifactPath || null,
    summary: result?.summary || '',
    raw: result || null,
  };
}

function createClawpatchAutoreviewAdapter(options = {}) {
  const runner = options.runner;
  const clawpatchCommand = normalizeCommand(options.clawpatchCommand, DEFAULT_CLAWPATCH_COMMAND);
  const autoreviewCommand = normalizeCommand(options.autoreviewCommand, DEFAULT_AUTOREVIEW_COMMAND);
  const engine = options.name || 'clawpatch-autoreview';

  return {
    schemaVersion: REVIEW_ENGINE_SCHEMA_VERSION,
    name: engine,
    tools: Object.freeze(['clawpatch', 'autoreview']),

    async sliceReview(input = {}) {
      const command = [
        ...clawpatchCommand,
        'review',
        ...(input.since || input.baseRef ? ['--since', input.since || input.baseRef] : []),
      ];

      return runReviewCommand(runner, {
        engine,
        stage: 'sliceReview',
        tool: 'clawpatch',
        command,
        input,
      });
    },

    async holisticReview(input = {}) {
      const command = [
        ...autoreviewCommand,
        '--mode',
        'branch',
        ...(input.baseRef || input.base ? ['--base', input.baseRef || input.base] : []),
      ];

      return runReviewCommand(runner, {
        engine,
        stage: 'holisticReview',
        tool: 'autoreview',
        command,
        input,
      });
    },
  };
}

function assertReviewEngineAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('review engine adapter is required');
  }
  if (typeof adapter.sliceReview !== 'function') {
    throw new Error('review engine adapter must implement sliceReview(input)');
  }
  if (typeof adapter.holisticReview !== 'function') {
    throw new Error('review engine adapter must implement holisticReview(input)');
  }
  return adapter;
}

module.exports = {
  REVIEW_ENGINE_SCHEMA_VERSION,
  assertReviewEngineAdapter,
  createClawpatchAutoreviewAdapter,
};
