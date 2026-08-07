'use strict';

// OpenClaw's normal-turn agent_turn_prepare hook may return prependContext.
// Keep this adapter dependency-free so the installed private stage can execute it.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');

function sessionToken(event, context) {
  // In OpenClaw 2026.7.1, agent_turn_prepare receives prompt/messages in the
  // event and carries the active session identity on the typed hook context.
  // Preserve the event lookup as a narrow compatibility fallback for direct
  // callers from older runtimes.
  return typeof context?.sessionKey === 'string' ? context.sessionKey
    : typeof context?.sessionId === 'string' ? context.sessionId
      : typeof event?.sessionKey === 'string' ? event.sessionKey
        : typeof event?.sessionId === 'string' ? event.sessionId : null;
}

function mapping(event, config, context) {
  const token = sessionToken(event, context);
  if (!token || typeof config?.mappingRoot !== 'string' || !path.isAbsolute(config.mappingRoot)) return null;
  const file = path.join(config.mappingRoot, `${createHash('sha256').update(token).digest('hex')}.json`);
  try {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.schemaVersion === 1 && typeof value.contextFile === 'string' && typeof value.bridgeExecutable === 'string' ? value : null;
  } catch (_) { return null; }
}
function nextTurnContext(event, config, context) {
  const entry = mapping(event, config, context); if (!entry) return null;
  const result = spawnSync(entry.bridgeExecutable, ['nextTurnInput'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: entry.contextFile } });
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(result.stdout || '{}');
    if (value.available !== true || value.pendingInSessionInput !== true || typeof value.prompt !== 'string'
      || !Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 3
      || typeof value.default !== 'string' || typeof value.correlation !== 'string') return null;
    return ['jarvOS stewardship preference request:', `Question: ${value.prompt}`, 'Choices:',
      ...value.choices.map((choice, index) => `${index + 1}. ${choice}${choice === value.default ? ' (default)' : ''}`),
      `Correlation: ${value.correlation}`,
      'An exact user reply with a listed choice and this correlation authorizes only recording that preference through jarvos_stewardship_answer; it does not authorize changing code, merging, publishing, or any other downstream action. After verifying the reply, call jarvos_stewardship_answer with only that correlation and listed label. Recording the preference is not approval to execute it.'].join('\n');
  } catch (_) { return null; }
}

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function answerTool(context, config) {
  return {
    name: 'jarvos_stewardship_answer',
    label: 'jarvOS Stewardship Answer',
    description: 'Record one exact listed preference for a pending jarvOS stewardship request in this session.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        correlation: { type: 'string', minLength: 1, maxLength: 240 },
        choice: { type: 'string', minLength: 1, maxLength: 160 },
      },
      required: ['correlation', 'choice'],
    },
    execute: async (_toolCallId, input) => {
      if (typeof input?.correlation !== 'string' || typeof input?.choice !== 'string') return toolResult('No matching pending stewardship judgment.', true);
      const entry = mapping({}, config, context); if (!entry) return toolResult('No matching pending stewardship judgment.', true);
      const result = spawnSync(entry.bridgeExecutable, ['answer', '--correlation', input.correlation, '--choice', input.choice], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: entry.contextFile },
      });
      if (result.status !== 0) return toolResult('The stewardship answer was not accepted.', true);
      try {
        return JSON.parse(result.stdout || '{}')?.status === 'answered'
          ? toolResult('Stewardship answer recorded.')
          : toolResult('The stewardship answer was not accepted.', true);
      } catch (_) { return toolResult('The stewardship answer was not accepted.', true); }
    },
  };
}

function agent_turn_prepare(event, context, config = context?.pluginConfig) {
  const prependContext = nextTurnContext(event, config, context);
  return prependContext ? { prependContext } : {};
}

function register(api) {
  // OpenClaw supplies extension configuration on the registration API. Typed
  // hook contexts describe the active turn and do not repeat pluginConfig.
  const config = api.pluginConfig;
  api.on('agent_turn_prepare', (event, context) => agent_turn_prepare(event, context, config), { timeoutMs: 5000 });
  api.registerTool((context) => answerTool(context, config), { name: 'jarvos_stewardship_answer' });
}

module.exports = register;
module.exports.agent_turn_prepare = agent_turn_prepare;
module.exports.before_prompt_build = agent_turn_prepare;
module.exports.nextTurnContext = nextTurnContext;
module.exports.mapping = mapping;
module.exports.answerTool = answerTool;
