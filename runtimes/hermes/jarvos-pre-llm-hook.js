#!/usr/bin/env node
'use strict';

// Hermes invokes this from hooks.pre_llm_call.  It deliberately returns only
// the bounded public bridge context; private routing state stays in jarvOS.
const { spawnSync } = require('node:child_process');
const {
  envelopeHasContent: projectsContextRefreshHasContent,
  validateEnvelope: validateProjectsContextRefreshEnvelope,
} = require('../../modules/jarvos-runtime-kit/src/projects-context-refresh.js');

const command = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
const BRIDGE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS = 250;

function invokeBridge(capability, timeout, options = {}) {
  const selectedCommand = options.bridgeCommand === undefined ? command : options.bridgeCommand;
  if (!BRIDGE_COMMAND.test(selectedCommand || '')) return null;
  const result = (options.spawnSyncImpl || spawnSync)(selectedCommand, [capability], { encoding: 'utf8', timeout });
  if (!result || result.error || result.status !== 0) return null;
  try { return JSON.parse(result.stdout || '{}'); } catch (_) { return null; }
}

function projectsContextRefresh(options) {
  // A single hard-deadline call per native pre-LLM boundary. Invalid,
  // unavailable, or timed-out responses deliberately add no Projects text.
  const envelope = invokeBridge('projectsContextRefresh', PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS, options);
  return validateProjectsContextRefreshEnvelope(envelope).ok ? envelope : null;
}

function stewardshipContext(options) {
  const value = invokeBridge('nextTurnInput', 5000, options);
  if (value?.available !== true || value.pendingInSessionInput !== true || typeof value.prompt !== 'string'
    || !Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 3
    || typeof value.default !== 'string' || typeof value.correlation !== 'string') return '';
  return ['jarvOS stewardship preference request:', `Question: ${value.prompt}`, 'Choices:',
    ...value.choices.map((choice, index) => `${index + 1}. ${choice}${choice === value.default ? ' (default)' : ''}`),
    `Correlation: ${value.correlation}`,
    'An exact user reply with a listed choice and this correlation authorizes only recording that preference through the bridge; it does not authorize changing code, merging, publishing, or any other downstream action. After verifying the reply, record only that correlation and listed label with: jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>. Recording the preference is not approval to execute it.'].join('\n');
}

function nextTurnContext(options) {
  const refresh = projectsContextRefresh(options);
  const judgment = stewardshipContext(options);
  const contexts = [];
  if (projectsContextRefreshHasContent(refresh)) contexts.push(refresh.markdown);
  if (judgment) contexts.push(judgment);
  return contexts.join('\n\n');
}

function main() {
  try {
  const context = nextTurnContext();
  if (context) process.stdout.write(`${JSON.stringify({ context })}\n`);
  } catch (_) { /* Hermes continues without injected context. */ }
}

if (require.main === module) main();

module.exports = { PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS, invokeBridge, projectsContextRefresh, stewardshipContext, nextTurnContext, main };
