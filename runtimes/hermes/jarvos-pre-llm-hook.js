#!/usr/bin/env node
'use strict';

// Hermes invokes this from hooks.pre_llm_call.  It deliberately returns only
// the bounded public bridge context; private routing state stays in jarvOS.
const { spawnSync } = require('node:child_process');

const PUBLIC_TEXT = /(?:[\r\n\u0000-\u001f\u007f]|(?:^|[\s("'`])(?:\/|~\/|[A-Za-z]:[\\/])|https?:\/\/|\b(?:api[ _-]?key|secret|password|token|credential|bearer)\b|\b(?:paperclip|beads|agent mail|transcript)\b|\b(?:issue|ticket)\s*(?:#|:)?\s*\d+\b|\b(?:private[- ]?router|local[- ]?route|route target)\b)/i;
const CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isPublicText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value.trim() === value && /[A-Za-z]/.test(value) && !PUBLIC_TEXT.test(value);
}

function isSafeBridgeResponse(value) {
  const expected = ['available', 'choices', 'correlation', 'default', 'pendingInSessionInput', 'prompt'];
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && value.available === true && value.pendingInSessionInput === true
    && isPublicText(value.prompt, 600)
    && Array.isArray(value.choices) && value.choices.length >= 2 && value.choices.length <= 3
    && value.choices.every((choice) => isPublicText(choice, 160))
    && new Set(value.choices).size === value.choices.length
    && isPublicText(value.default, 160) && value.choices.includes(value.default)
    && typeof value.correlation === 'string' && CORRELATION.test(value.correlation)
    && !PUBLIC_TEXT.test(value.correlation);
}

const command = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command || '')) process.exit(0);
const result = spawnSync(command, ['nextTurnInput'], { encoding: 'utf8', timeout: 5000 });
if (result.status !== 0) process.exit(0);
try {
  const value = JSON.parse(result.stdout || '{}');
  if (!isSafeBridgeResponse(value)) process.exit(0);
  const context = ['jarvOS stewardship preference request:', `Question: ${value.prompt}`, 'Choices:',
    ...value.choices.map((choice, index) => `${index + 1}. ${choice}${choice === value.default ? ' (default)' : ''}`),
    `Correlation: ${value.correlation}`,
    'An exact user reply with a listed choice and this correlation authorizes only recording that preference through the bridge; it does not authorize changing code, merging, publishing, or any other downstream action. After verifying the reply, record only that correlation and listed label with: jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>. Recording the preference is not approval to execute it.'].join('\n');
  process.stdout.write(`${JSON.stringify({ context })}\n`);
} catch (_) { /* Hermes continues without injected context. */ }
