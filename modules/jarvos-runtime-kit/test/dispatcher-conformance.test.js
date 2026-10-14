'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { checkDispatcher } = require('../src/index.js');
const { STEWARDSHIP_ACTIONS } = require('../src/stewardship-bootstrap.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'modules', 'jarvos-runtime-kit', 'scripts', 'jarvos-runtime-kit.js');

// A single fixture dispatcher, switched by JARVOS_FAKE_DISPATCHER_MODE, so each
// test exercises exactly one axis of conformance at a time. JARVOS_FAKE_DISPATCHER_LOG,
// when set, records the argv of every invocation (one JSON array per line) so tests
// can verify extraArgs are actually forwarded.
function writeFakeDispatcher(dir) {
  const binPath = path.join(dir, 'jarvos-stewardship-dispatcher');
  fs.writeFileSync(binPath, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const logPath = process.env.JARVOS_FAKE_DISPATCHER_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');
const mode = process.env.JARVOS_FAKE_DISPATCHER_MODE || 'conformant';
const ACTIONS = ${JSON.stringify(STEWARDSHIP_ACTIONS)};
function actionOf(argv) {
  const index = argv.indexOf('--action');
  return index >= 0 ? argv[index + 1] : null;
}
function receipt(actions) {
  return JSON.stringify({ actions });
}
const action = actionOf(args);
if (action === 'provenance-probe') {
  if (mode === 'missing-actions') { process.stdout.write(JSON.stringify({ ok: true })); process.exit(0); }
  if (mode === 'superset-actions') { process.stdout.write(receipt([...ACTIONS, 'extra-action'])); process.exit(0); }
  if (mode === 'missing-action') { process.stdout.write(receipt(ACTIONS.filter((a) => a !== 'session-precompact'))); process.exit(0); }
  if (mode === 'wrong-order-actions') { process.stdout.write(receipt([ACTIONS[1], ACTIONS[0], ...ACTIONS.slice(2)])); process.exit(0); }
  if (mode === 'not-parseable') { process.stdout.write('not json'); process.exit(0); }
  process.stdout.write(receipt(ACTIONS));
  process.exit(0);
} else {
  if (mode === 'accepts-unknown') { process.stdout.write(''); process.exit(0); }
  if (mode === 'rejects-with-receipt') { process.stdout.write(receipt(ACTIONS)); process.exit(1); }
  process.stdout.write('');
  process.exit(1);
}
`, { mode: 0o700 });
  fs.chmodSync(binPath, 0o700);
  return binPath;
}

function withTempDir(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-dispatcher-conformance-'));
  try {
    return fn(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('conformant fake dispatcher passes with no errors', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { harness: 'claude', env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'conformant' } });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.receipt.actions, STEWARDSHIP_ACTIONS);
  });
});

test('receipt omitting actions fails and names the missing advertisement', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'missing-actions' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /actions advertisement/i);
  });
});

test('a dispatcher advertising more actions than this contract knows about passes', () => {
  // Forward compatibility, not a defect. The ABI is extended additively and the
  // two halves ship on different schedules, so a dispatcher that already serves a
  // newer action is strictly better than one that does not -- failing it would
  // make the checker unusable during exactly the window it is meant to cover.
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'superset-actions' } });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

test('advertisement order does not matter, unlike a declaration', () => {
  // An adapter *declaring* the ABI must list it in order -- that is a contract
  // statement the bootstrap validator checks. A dispatcher *advertising* what it
  // implements is reporting a set; ordering it carries no meaning.
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'wrong-order-actions' } });
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

test('a dispatcher missing a declared action fails and names what it cannot serve', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'missing-action' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /does not implement/i);
    assert.match(result.errors.join('\n'), /session-precompact/);
  });
});

test('dispatcher that exits 0 for an unknown action fails and names unknown-action acceptance', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'accepts-unknown' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /unknown.action/i);
  });
});

test('dispatcher that rejects an unknown action but still emits a parseable receipt fails', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'rejects-with-receipt' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /rejection must not emit a receipt/i);
  });
});

test('a provenance-probe response that does not parse as JSON fails without throwing', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const result = checkDispatcher(binPath, { env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'not-parseable' } });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /did not parse as a JSON receipt/i);
    assert.equal(result.receipt, null);
  });
});

test('a nonexistent binary path is reported as an error, never a thrown exception', () => {
  withTempDir((temp) => {
    const binPath = path.join(temp, 'does-not-exist');
    let result;
    assert.doesNotThrow(() => {
      result = checkDispatcher(binPath, { harness: 'claude' });
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(result.receipt, null);
  });
});

test('extraArgs are forwarded to both invocations', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const logPath = path.join(temp, 'argv.log');
    const result = checkDispatcher(binPath, {
      harness: 'codex',
      extraArgs: ['--selector', 'live', '--staging-root', '/synthetic/staging'],
      env: {
        ...process.env,
        JARVOS_FAKE_DISPATCHER_MODE: 'conformant',
        JARVOS_FAKE_DISPATCHER_LOG: logPath,
      },
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    for (const argv of lines) {
      assert.deepEqual(argv, ['--harness', 'codex', '--action', argv[3], '--selector', 'live', '--staging-root', '/synthetic/staging']);
    }
    assert.deepEqual(lines.map((argv) => argv[3]).sort(), ['not-a-real-action', 'provenance-probe']);
  });
});

test('CLI check-dispatcher exits 0 and prints PASS for a conformant fake', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    const output = execFileSync(process.execPath, [CLI, 'check-dispatcher', binPath, '--harness', 'claude'], {
      encoding: 'utf8',
      env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'conformant' },
    });
    assert.match(output, /^PASS /);
  });
});

test('CLI check-dispatcher exits 1 and prints FAIL plus the error list for a broken fake', () => {
  withTempDir((temp) => {
    const binPath = writeFakeDispatcher(temp);
    let threw = null;
    let output = '';
    try {
      output = execFileSync(process.execPath, [CLI, 'check-dispatcher', binPath, '--harness', 'claude'], {
        encoding: 'utf8',
        env: { ...process.env, JARVOS_FAKE_DISPATCHER_MODE: 'missing-actions' },
      });
    } catch (error) {
      threw = error;
      output = error.stdout;
    }
    assert.ok(threw, 'CLI must exit non-zero for a non-conformant dispatcher');
    assert.equal(threw.status, 1);
    assert.match(output, /^FAIL /);
    assert.match(output, /- .*actions advertisement/i);
  });
});
