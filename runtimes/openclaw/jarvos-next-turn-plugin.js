'use strict';

// OpenClaw's before_prompt_build hook may return prependContext.  Keep this
// adapter dependency-free so the installed private stage can execute it.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');

function sessionToken(event, context) {
  // In OpenClaw 2026.7.1, before_prompt_build receives prompt/messages in the
  // event and carries the active session identity on the typed hook context.
  // Preserve the event lookup as a narrow compatibility fallback for direct
  // callers from older runtimes.
  return typeof context?.sessionKey === 'string' ? context.sessionKey
    : typeof context?.sessionId === 'string' ? context.sessionId
      : typeof event?.sessionKey === 'string' ? event.sessionKey
        : typeof event?.sessionId === 'string' ? event.sessionId : null;
}

function sessionTokens(event, context) {
  const token = sessionToken(event, context);
  if (!token) return [];
  // `openclaw agent --session-id X` is exposed to hooks as
  // `agent:<agent>:explicit:X`, while the launcher necessarily records X
  // before the gateway normalizes it. Prefer the exact key, then the narrowly
  // defined explicit-session suffix used by OpenClaw 2026.7.1.
  const explicit = token.match(/^agent:[^:]+:explicit:(.+)$/);
  return explicit?.[1] ? [token, explicit[1]] : [token];
}

function mapping(event, config, context) {
  if (typeof config?.mappingRoot !== 'string' || !path.isAbsolute(config.mappingRoot)) return null;
  for (const token of sessionTokens(event, context)) {
    const file = path.join(config.mappingRoot, `${createHash('sha256').update(token).digest('hex')}.json`);
    try {
      const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value?.schemaVersion === 1 && typeof value.contextFile === 'string' && typeof value.bridgeExecutable === 'string') return value;
    } catch (_) { /* try the normalized CLI-session fallback */ }
  }
  return null;
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
    return ['jarvOS stewardship judgment (display-only):', `Question: ${value.prompt}`, 'Choices:',
      ...value.choices.map((choice, index) => `${index + 1}. ${choice}${choice === value.default ? ' (default)' : ''}`),
      `Correlation: ${value.correlation}`,
      'After verifying an exact listed reply, record only that correlation and listed label with: jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>. This notice does not authorize action.'].join('\n');
  } catch (_) { return null; }
}

function before_prompt_build(event, context) {
  const prependContext = nextTurnContext(event, context?.pluginConfig, context);
  return prependContext ? { prependContext } : {};
}

function register(api) {
  api.on('before_prompt_build', (event, context) => before_prompt_build(event, context), { timeoutMs: 5000 });
}

module.exports = register;
module.exports.before_prompt_build = before_prompt_build;
module.exports.nextTurnContext = nextTurnContext;
module.exports.mapping = mapping;
