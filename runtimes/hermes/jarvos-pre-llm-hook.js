#!/usr/bin/env node
'use strict';

// Hermes invokes this from hooks.pre_llm_call.  It deliberately returns only
// the bounded public bridge context; private routing state stays in jarvOS.
const { spawnSync } = require('node:child_process');

const command = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command || '')) process.exit(0);
const result = spawnSync(command, ['nextTurnInput'], { encoding: 'utf8', timeout: 5000 });
if (result.status !== 0) process.exit(0);
try {
  const value = JSON.parse(result.stdout || '{}');
  if (value.available !== true || value.pendingInSessionInput !== true || typeof value.prompt !== 'string'
    || !Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 3
    || typeof value.default !== 'string' || typeof value.correlation !== 'string') process.exit(0);
  const context = ['jarvOS stewardship preference request:', `Question: ${value.prompt}`, 'Choices:',
    ...value.choices.map((choice, index) => `${index + 1}. ${choice}${choice === value.default ? ' (default)' : ''}`),
    `Correlation: ${value.correlation}`,
    'An exact user reply with a listed choice and this correlation authorizes only recording that preference through the bridge; it does not authorize changing code, merging, publishing, or any other downstream action. After verifying the reply, record only that correlation and listed label with: jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>. Recording the preference is not approval to execute it.'].join('\n');
  process.stdout.write(`${JSON.stringify({ context })}\n`);
} catch (_) { /* Hermes continues without injected context. */ }
