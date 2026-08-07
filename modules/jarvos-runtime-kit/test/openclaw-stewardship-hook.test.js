'use strict';

const assert = require('assert');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const plugin = require(path.join(ROOT, 'runtimes', 'openclaw', 'jarvos-next-turn-plugin.js'));

function sessionMappingPath(root, sessionKey) {
  return path.join(root, `${createHash('sha256').update(sessionKey).digest('hex')}.json`);
}

test('OpenClaw registers normal-turn stewardship injection through agent_turn_prepare', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-'));
  const mappingRoot = path.join(temp, 'mappings');
  const contextFile = path.join(temp, 'context.json');
  const bridge = path.join(temp, 'jarvos-stewardship-bridge');
  const sessionKey = 'agent:main:stewardship-regression';
  const registrations = [];
  let answerToolFactory = null;

  try {
    fs.mkdirSync(mappingRoot, { recursive: true });
    fs.writeFileSync(contextFile, '{}', { mode: 0o600 });
    fs.writeFileSync(bridge, [
      '#!/bin/sh',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the guarded path.\",\"choices\":[\"Continue\",\"Stop\"],\"default\":\"Continue\",\"correlation\":\"judgment-42\"}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(sessionMappingPath(mappingRoot, sessionKey), JSON.stringify({
      schemaVersion: 1,
      contextFile,
      bridgeExecutable: bridge,
    }), { mode: 0o600 });

    plugin({
      pluginConfig: { mappingRoot },
      on(name, handler, options) { registrations.push({ name, handler, options }); },
      registerTool(factory) { answerToolFactory = factory; },
    });

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].name, 'agent_turn_prepare');
    assert.equal(registrations[0].options.timeoutMs, 5000);
    assert.equal(typeof answerToolFactory, 'function');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'openclaw.plugin.json'), 'utf8')).hooks,
      ['agent_turn_prepare'],
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'adapter.json'), 'utf8')).stewardshipAdapter.capabilities.nextTurnInput.event,
      'agent_turn_prepare',
    );

    const output = registrations[0].handler(
      { prompt: 'Record the displayed preference.', messages: [], queuedInjections: [] },
      { sessionKey },
    );
    assert.match(output.prependContext, /jarvOS stewardship preference request:/);
    assert.match(output.prependContext, /Choose the guarded path\./);
    assert.match(output.prependContext, /Continue \(default\)/);
    assert.match(output.prependContext, /judgment-42/);
    assert.match(output.prependContext, /authorizes only recording that preference/);
    assert.match(output.prependContext, /Recording the preference is not approval to execute it/);
    assert.doesNotMatch(output.prependContext, /display-only/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('OpenClaw stewardship answer tool fails closed without a matching session mapping', async () => {
  const answer = plugin.answerTool({ sessionKey: 'agent:main:missing' }, { mappingRoot: os.tmpdir() });
  const result = await answer.execute('call-42', { correlation: 'judgment-42', choice: 'Continue' });

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'No matching pending stewardship judgment.' }]);
});
