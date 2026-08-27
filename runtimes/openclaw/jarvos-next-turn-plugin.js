'use strict';

// OpenClaw's normal-turn agent_turn_prepare hook may return prependContext.
// Keep this adapter dependency-free so the installed private stage can execute it.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');
const {
  envelopeHasContent: projectsContextRefreshHasContent,
  validateEnvelope: validateProjectsContextRefreshEnvelope,
} = require('../../modules/jarvos-runtime-kit/src/projects-context-refresh.js');

const PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS = 250;
const SELECTED_PROJECTS_ENV_KEYS = Object.freeze([
  'JARVOS_STEWARDSHIP_RUNTIME_ROOT',
  'JARVOS_STEWARDSHIP_SELECTED_PRIVATE_COMMIT',
  'JARVOS_STEWARDSHIP_SELECTED_PUBLIC_COMMIT',
  'JARVOS_PROJECTS_CONTEXT_CONFIG',
  'ACTIVE_ASSISTANT_PROJECTS_PROVIDER_MODULE',
  'ACTIVE_ASSISTANT_PUBLIC_RUNTIME_ROOT',
]);
const MAPPING_KEYS = Object.freeze({
  1: ['schemaVersion', 'contextFile', 'bridgeExecutable'],
  2: ['schemaVersion', 'contextFile', 'bridgeExecutable', 'projectsEnvironment'],
});
const COMMIT = /^[a-f0-9]{40}$/;

function deterministicAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
}

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

function selectedProjectsBridgeEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== SELECTED_PROJECTS_ENV_KEYS.length
    || !SELECTED_PROJECTS_ENV_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  if (!deterministicAbsolutePath(value.JARVOS_STEWARDSHIP_RUNTIME_ROOT)
    || !COMMIT.test(value.JARVOS_STEWARDSHIP_SELECTED_PRIVATE_COMMIT)
    || !COMMIT.test(value.JARVOS_STEWARDSHIP_SELECTED_PUBLIC_COMMIT)
    || !deterministicAbsolutePath(value.JARVOS_PROJECTS_CONTEXT_CONFIG)
    || !deterministicAbsolutePath(value.ACTIVE_ASSISTANT_PROJECTS_PROVIDER_MODULE)
    || !deterministicAbsolutePath(value.ACTIVE_ASSISTANT_PUBLIC_RUNTIME_ROOT)) return null;
  const runtimeRoot = value.JARVOS_STEWARDSHIP_RUNTIME_ROOT;
  if (value.JARVOS_PROJECTS_CONTEXT_CONFIG !== path.join(runtimeRoot, 'config', 'jarvos-project-context.json')
    || value.ACTIVE_ASSISTANT_PROJECTS_PROVIDER_MODULE !== path.join(runtimeRoot, 'scripts', 'lib', 'jarvos-projects-local-provider.js')
    || value.ACTIVE_ASSISTANT_PUBLIC_RUNTIME_ROOT !== path.join(runtimeRoot, 'repos', 'jarvOS')) return null;
  return Object.fromEntries(SELECTED_PROJECTS_ENV_KEYS.map((key) => [key, value[key]]));
}

function mapping(event, config, context) {
  const token = sessionToken(event, context);
  if (!token || typeof config?.mappingRoot !== 'string' || !path.isAbsolute(config.mappingRoot)) return null;
  const file = path.join(config.mappingRoot, `${createHash('sha256').update(token).digest('hex')}.json`);
  try {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (![1, 2].includes(value?.schemaVersion)
      || Object.keys(value).length !== MAPPING_KEYS[value.schemaVersion].length
      || !MAPPING_KEYS[value.schemaVersion].every((key) => Object.hasOwn(value, key))
      || !deterministicAbsolutePath(value.contextFile)
      || !deterministicAbsolutePath(value.bridgeExecutable)) return null;
    const contextStat = fs.lstatSync(value.contextFile);
    if (contextStat.isSymbolicLink() || !contextStat.isFile() || (contextStat.mode & 0o777) !== 0o600) return null;
    const projectsEnvironment = value.schemaVersion === 2 ? selectedProjectsBridgeEnvironment(value.projectsEnvironment) : null;
    if (value.schemaVersion === 2 && !projectsEnvironment) return null;
    return { ...value, projectsEnvironment };
  } catch (_) { return null; }
}
function bridgeEnvironment(entry, capability = null) {
  // The native gateway receives only the resolver-selected context file. It
  // must not forward ambient bridge credentials into the plugin child.
  const environment = {
    PATH: process.env.PATH || '',
    JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: entry.contextFile,
  };
  // Only the refresh path needs the selected, attested Projects binding. The
  // ordinary judgment and answer paths retain their narrower context-only
  // environment, and no ambient variables are forwarded.
  if (capability === 'projectsContextRefresh' && entry.projectsEnvironment) {
    Object.assign(environment, entry.projectsEnvironment);
  }
  return environment;
}
function invokeBridge(entry, capability, timeout, options = {}) {
  const result = (options.spawnSyncImpl || spawnSync)(entry.bridgeExecutable, [capability], {
    encoding: 'utf8', timeout, env: bridgeEnvironment(entry, capability),
  });
  if (!result || result.error || result.status !== 0) return null;
  try { return JSON.parse(result.stdout || '{}'); } catch (_) { return null; }
}
function projectsContextRefresh(entry, options) {
  const envelope = invokeBridge(entry, 'projectsContextRefresh', PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS, options);
  return validateProjectsContextRefreshEnvelope(envelope).ok ? envelope : null;
}
function nextTurnContext(event, config, context, options) {
  const entry = mapping(event, config, context); if (!entry) return null;
  const refresh = projectsContextRefresh(entry, options);
  const value = invokeBridge(entry, 'nextTurnInput', 5000, options);
  const contexts = [];
  if (projectsContextRefreshHasContent(refresh)) contexts.push(refresh.markdown);
  if (value?.available === true && value.pendingInSessionInput === true && typeof value.prompt === 'string'
    && Array.isArray(value.choices) && value.choices.length >= 2 && value.choices.length <= 3
    && typeof value.default === 'string' && typeof value.correlation === 'string') {
    contexts.push(['jarvOS stewardship preference request:', `Question: ${value.prompt}`, 'Choices:',
      ...value.choices.map((choice, index) => `${index + 1}. ${choice}${choice === value.default ? ' (default)' : ''}`),
      `Correlation: ${value.correlation}`,
      'An exact user reply with a listed choice and this correlation authorizes only recording that preference through jarvos_stewardship_answer; it does not authorize changing code, merging, publishing, or any other downstream action. After verifying the reply, call jarvos_stewardship_answer with only that correlation and listed label. Recording the preference is not approval to execute it.'].join('\n'));
  }
  return contexts.length > 0 ? contexts.join('\n\n') : null;
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
        encoding: 'utf8', timeout: 5000, env: bridgeEnvironment(entry),
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
module.exports.bridgeEnvironment = bridgeEnvironment;
module.exports.invokeBridge = invokeBridge;
module.exports.projectsContextRefresh = projectsContextRefresh;
module.exports.PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS = PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS;
module.exports.SELECTED_PROJECTS_ENV_KEYS = SELECTED_PROJECTS_ENV_KEYS;
module.exports.selectedProjectsBridgeEnvironment = selectedProjectsBridgeEnvironment;
module.exports.answerTool = answerTool;
