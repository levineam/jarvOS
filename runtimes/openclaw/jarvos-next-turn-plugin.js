'use strict';

// OpenClaw's before_prompt_build hook may return prependContext.  Keep this
// adapter dependency-free so the installed private stage can execute it.
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');

function mapping(event, config) {
  const token = typeof event?.sessionKey === 'string' ? event.sessionKey : typeof event?.sessionId === 'string' ? event.sessionId : null;
  if (!token || typeof config?.mappingRoot !== 'string' || !path.isAbsolute(config.mappingRoot)) return null;
  const file = path.join(config.mappingRoot, `${createHash('sha256').update(token).digest('hex')}.json`);
  try {
    const stat = fs.lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.schemaVersion === 1 && typeof value.contextFile === 'string' && typeof value.bridgeExecutable === 'string' ? value : null;
  } catch (_) { return null; }
}
function nextTurnContext(event, config) {
  const entry = mapping(event, config); if (!entry) return null;
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
  const prependContext = nextTurnContext(event, context?.pluginConfig);
  return prependContext ? { prependContext } : {};
}

function register(api) {
  api.on('before_prompt_build', (event, context) => before_prompt_build(event, context), { timeoutMs: 5000 });
}

module.exports = register;
module.exports.before_prompt_build = before_prompt_build;
module.exports.nextTurnContext = nextTurnContext;
module.exports.mapping = mapping;
