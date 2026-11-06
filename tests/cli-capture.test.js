'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runCaptureCommand, renderHelp } = require('../lib/jarvos-cli');
const { simpleCapture } = require('../modules/jarvos-secondbrain/bridge/capture/src/simple-capture');
const flags = ['--kind', 'idea', '--words', 'user', '--asked', 'explicit'];

async function invoke(args, { input = '', env = {}, raw = { ok: true }, inspect = () => {} } = {}) {
  let stdout = ''; let stderr = '';
  const code = await runCaptureCommand(args, env, {
    stdin: Readable.from([input]),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    capture: (value) => { inspect(value); return simpleCapture(value, { capture: () => raw }); },
  });
  return { code, stdout, stderr };
}

test('capture CLI parses flags and positional text, and honors source precedence', async () => {
  for (const source of ['cli', 'test-env', 'test-flag']) {
    const args = [...flags, '--model=test-model', '--date', '2026-06-22', 'A test thought', 'about tidal gardens'];
    if (source === 'test-flag') args.push('--source', source);
    const result = await invoke(args, { env: source === 'cli' ? {} : { JARVOS_CAPTURE_SOURCE: 'test-env' }, inspect(input) {
      assert.deepEqual(input, { kind: 'idea', words: 'user', asked: 'explicit', model: 'test-model', date: '2026-06-22', source, text: 'A test thought about tidal gardens' });
    } });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'Saved to Ideas for 2026-06-22.\n');
  }
  assert.match(renderHelp(), /jarvos capture --kind/);
});

test('capture CLI reads stdin and emits the full JSON receipt', async () => {
  const result = await invoke([...flags, '--json'], { input: 'A test thought about tidal gardens\n', inspect(input) { assert.equal(input.text, 'A test thought about tidal gardens\n'); } });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).result.ok, true);
  assert.equal(JSON.parse(result.stdout).message, "Saved to today's Ideas.");
});

test('capture CLI reuses capture exit codes and rejects bad flags and input', async () => {
  for (const [code, raw] of [[0, { ok: true }], [2, { ok: false, routing: { plan: { ignored: true } }, error: 'A test rejection' }], [3, { ok: false, artifactReceipt: { artifacts: [{ kind: 'journal', vaultRelativePath: 'Journal/2026-06-22.md', outcome: 'saved_locally_sync_pending' }] } }]]) {
    const result = await invoke([...flags, 'A test thought about tidal gardens'], { raw });
    assert.equal(result.code, code);
    assert.match(result.stdout, { 0: /^Saved/, 2: /^Not saved:/, 3: /^Not confirmed yet:/ }[code]);
  }
  for (const args of [[...flags, '--unexpected'], [...flags, '--title', 'Tidal gardens', 'A test thought'], [...flags], ['--kind', 'unsupported', '--words', 'user', '--asked', 'explicit', 'A test thought']]) {
    const result = await invoke(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^jarvos capture failed:/);
  }
});

test('jarvos executable dispatches capture and reports invalid input without accessing storage', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/jarvos.js'), 'capture', '--kind', 'unsupported', '--words', 'user', '--asked', 'explicit', 'A test thought about tidal gardens'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /kind must be/);
});

test('capture CLI decodes stdin as one UTF-8 stream across chunk boundaries', async () => {
  const bytes = Buffer.from('A test thought about a café garden', 'utf8');
  const split = bytes.indexOf(0xc3) + 1; // inside the two-byte "é"
  let seen = null;
  const code = await runCaptureCommand(flags, {}, {
    stdin: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
    stdout: { write() {} },
    stderr: { write() {} },
    capture: (value) => { seen = value.text; return simpleCapture(value, { capture: () => ({ ok: true }) }); },
  });
  assert.equal(code, 0);
  assert.equal(seen, 'A test thought about a café garden');
});
