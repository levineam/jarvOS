'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const test = require('node:test');
const { createVaultMutationAdapter, runObsidianEval } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { buildObsidianInvariantProgram, buildObsidianMutationProgram } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry');
const { MAX_CAPTURE_BYTES, createOutputCapture, terminateOwnedTree } = require('../adapters/obsidian/src/obsidian-cli-probe-worker');

const operation = () => ({ schemaVersion: 1, operationId: 'op-20260806-adapter-test', vaultId: 'vault-a', vaultRelativePath: 'Notes/A.md', sequence: 1, operationKind: 'create', content: 'hello' });
const ledgerPath = () => path.join(os.tmpdir(), `jarvos-adapter-${Math.random()}.json`);
const inspectionToken = (code) => JSON.parse(Buffer.from(code.match(/atob\('([^']+)'\)/)[1], 'base64').toString('utf8')).inspectionToken;

test('a queued response without a terminal app token is never committed', () => {
  const states = [{ queued: true, token: 'op-20260806-adapter-test' }, { status: 'pending' }];
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => states.shift(), maxPollAttempts: 1 });
  const result = adapter.execute(operation());
  assert.equal(result.status, 'unknown_after_dispatch');
  assert.equal(result.obsidian, 'unacknowledged');
});

test('only app.vault.read acknowledgement can commit a create', () => {
  const states = [{ queued: true, token: 'op-20260806-adapter-test' }, { status: 'done', invariant: false, readback: 'stale' }];
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => states.shift(), maxPollAttempts: 1 });
  assert.equal(adapter.execute(operation()).status, 'failed');
});

test('serialized payload does not become executable source', () => {
  let program = '';
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: (code) => { program = code; return { queued: true, token: 'op-20260806-adapter-test' }; }, maxPollAttempts: 0 });
  adapter.execute({ ...operation(), content: "x'); globalThis.pwned = true; ('" });
  assert.equal(program.includes('globalThis.pwned = true'), false);
  assert.match(program, /atob/);
});

test('capability failures are explicit and do not dispatch', () => {
  let dispatched = false;
  for (const state of ['cli_missing', 'app_stopped', 'app_busy', 'app_unreachable', 'cli_disabled', 'cli_unsupported', 'wrong_vault', 'api_incompatible']) {
    const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state }), evaluate: () => { dispatched = true; } });
    assert.equal(adapter.execute(operation()).obsidian, state);
  }
  assert.equal(dispatched, false);
});

test('timeouts and ambiguous CLI failures never prove that Obsidian is stopped', () => {
  const timedOut = new Error('operation timed out'); timedOut.code = 'ETIMEDOUT';
  const timeoutAdapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), evaluate: () => { throw timedOut; } });
  assert.equal(timeoutAdapter.capability().state, 'app_busy');
  const unknownAdapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), evaluate: () => { throw new Error('opaque transport failure'); } });
  assert.equal(unknownAdapter.capability().state, 'app_unreachable');
  const stoppedAdapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), evaluate: () => { throw new Error('Obsidian is not running'); } });
  assert.equal(stoppedAdapter.capability().state, 'app_stopped');
});

test('capability probe escalates after its direct child exits and contains a SIGTERM-resistant descendant', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-probe-'));
  const fixture = path.join(root, 'fake-obsidian-cli.js');
  const descendantPid = path.join(root, 'descendant.pid');
  fs.writeFileSync(fixture, `#!${process.execPath}\nconst fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(descendantPid)}, String(child.pid)); setInterval(() => {}, 1000);\n`);
  fs.chmodSync(fixture, 0o755);
  const started = Date.now();
  try {
    assert.throws(() => runObsidianEval('JSON.stringify({ok:true})', { vaultName: 'fake-vault', command: fixture, timeoutMs: 500 }), (error) => error.code === 'ETIMEDOUT');
    assert.ok(Date.now() - started >= 550);
    assert.ok(Date.now() - started < 3_000);
    const pid = Number(fs.readFileSync(descendantPid, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probe output capture caps multibyte chunks by bytes', () => {
  const stream = new EventEmitter();
  const capture = createOutputCapture(stream);
  stream.emit('data', Buffer.from('€'.repeat(MAX_CAPTURE_BYTES)));
  assert.equal(capture.bytes(), MAX_CAPTURE_BYTES);
});

test('Windows taskkill retries process-tree containment and reports success only from taskkill', () => {
  const firstTaskkill = new EventEmitter();
  const secondTaskkill = new EventEmitter();
  const signals = [];
  const results = [];
  const child = { pid: 12345, kill: (signal) => signals.push(signal) };
  let calls = 0;
  terminateOwnedTree(child, { platform: 'win32', spawnProcess: () => [firstTaskkill, secondTaskkill][calls++], onComplete: (result) => results.push(result) });
  firstTaskkill.emit('close', 1);
  secondTaskkill.emit('close', 0);
  assert.equal(calls, 2);
  assert.deepEqual(signals, []);
  assert.deepEqual(results, [{ contained: true }]);
});

test('Windows taskkill double failure reports unconfirmed containment without direct-child fallback', () => {
  const firstTaskkill = new EventEmitter();
  const secondTaskkill = new EventEmitter();
  const signals = [];
  const results = [];
  const child = { pid: 12345, kill: (signal) => signals.push(signal) };
  let calls = 0;
  terminateOwnedTree(child, { platform: 'win32', spawnProcess: () => [firstTaskkill, secondTaskkill][calls++], onComplete: (result) => results.push(result) });
  firstTaskkill.emit('close', 1);
  secondTaskkill.emit('close', 1);
  assert.deepEqual(signals, []);
  assert.deepEqual(results, [{ contained: false, reason: 'taskkill_failed' }]);
});

test('unavailable capability retains planned intent for reconciliation', () => {
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'app_stopped' }) });
  assert.equal(adapter.execute(operation()).status, 'unavailable');
  assert.equal(adapter.ledger.get(operation().operationId).status, 'planned');
});

test('a successful connection performs only a bounded opportunistic drain', () => {
  const drained = [];
  const states = [{ queued: true, token: 'op-20260806-adapter-test' }, { status: 'done', invariant: true, readback: 'hello' }];
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => states.shift(), maxPollAttempts: 1, opportunisticDrain: (budget) => drained.push(budget) });
  assert.equal(adapter.execute(operation()).status, 'committed');
  assert.deepEqual(drained, [{ limit: 2, timeMs: 100, excludeOperationId: 'op-20260806-adapter-test' }]);
});

test('read-only invariant inspection returns only Obsidian-owned status evidence', () => {
  let pendingCalls = 0;
  const pendingAdapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: (code) => pendingCalls++ === 0 ? { queued: true, token: inspectionToken(code) } : { status: 'pending' }, maxPollAttempts: 1 });
  assert.deepEqual(pendingAdapter.inspectInvariant(operation()), { status: 'unavailable' });
  let terminalCalls = 0;
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: (code) => terminalCalls++ === 0 ? { queued: true, token: inspectionToken(code) } : terminalCalls === 2 ? { status: 'satisfied', invariant: true } : true, maxPollAttempts: 1 });
  assert.deepEqual(adapter.inspectInvariant(operation()), { status: 'satisfied', invariant: true });
  assert.deepEqual(adapter.inspectInvariant({ ...operation(), vaultId: 'other-vault' }), { status: 'unavailable' });
  assert.match(buildObsidianInvariantProgram(operation()), /app\.vault\.read/);
  assert.doesNotMatch(buildObsidianInvariantProgram(operation()), /app\.vault\.create|app\.vault\.process/);
});

test('inspection uses an opaque result token and leaves an in-flight mutation token intact', () => {
  const mutation = operation(); const inspection = 'inspection-token';
  const file = { path: mutation.vaultRelativePath, content: 'hello' };
  const context = { app: { vault: { getFileByPath: () => file, read: () => settled('hello') } }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON, __jarvosVaultMutationResults: { [mutation.operationId]: { status: 'pending' } } };
  context.globalThis = context;
  vm.runInNewContext(buildObsidianInvariantProgram(mutation, inspection), context);
  assert.deepEqual(context.__jarvosVaultMutationResults[mutation.operationId], { status: 'pending' });
  assert.equal(context.__jarvosVaultMutationResults[inspection].status, 'satisfied');
  assert.equal(context.__jarvosVaultMutationResults[inspection].invariant, true);
});

test('a cleaned-up inspection token cannot be recreated by a late app read', () => {
  const mutation = operation();
  const inspection = 'late-inspection-token';
  const nonce = 'late-inspection-nonce';
  let finishRead;
  const pendingRead = {
    then(callback) { finishRead = callback; return this; },
    catch() { return this; },
  };
  const context = {
    app: { vault: { getFileByPath: () => ({ path: mutation.vaultRelativePath }), read: () => pendingRead } },
    TextDecoder,
    Uint8Array,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    JSON,
  };
  context.globalThis = context;
  vm.runInNewContext(buildObsidianInvariantProgram(mutation, inspection, nonce), context);
  delete context.__jarvosVaultMutationResults[inspection];
  finishRead('hello');
  assert.equal(context.__jarvosVaultMutationResults[inspection], undefined);
});

test('default durable ledger path follows XDG state and stays outside the vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-xdg-'));
  const previous = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = root;
    const adapter = createVaultMutationAdapter({ vaultRoot: '/configured-vault', vaultId: 'vault-a', probe: () => ({ state: 'app_stopped' }) });
    assert.equal(adapter.ledger.filePath.startsWith(`${root}${path.sep}`), true);
    assert.equal(adapter.ledger.filePath.startsWith('/configured-vault/'), false);
    adapter.execute(operation());
    assert.equal(fs.existsSync(adapter.ledger.filePath), true);
  } finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test('acknowledged operation is returned as satisfied only after a fresh Obsidian read', () => {
  const filePath = ledgerPath(); let calls = 0;
  const first = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: filePath, probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => { calls += 1; return calls === 1 ? { queued: true, token: operation().operationId } : { status: 'done', invariant: true, readback: 'hello' }; }, maxPollAttempts: 1 });
  assert.equal(first.execute(operation()).status, 'committed');
  let inspectionCalls = 0;
  const second = createVaultMutationAdapter({
    vaultRoot: '/vault',
    vaultId: 'vault-a',
    ledgerPath: filePath,
    probe: () => ({ state: 'available', vaultId: 'vault-a' }),
    evaluate: (code) => {
      inspectionCalls += 1;
      if (inspectionCalls === 1) return { queued: true, token: inspectionToken(code) };
      if (inspectionCalls === 2) return { status: 'satisfied', invariant: true };
      return true;
    },
    maxPollAttempts: 1,
  });
  assert.equal(second.execute(operation()).status, 'already_satisfied');
  assert.equal(inspectionCalls, 3);
});

test('an acknowledged ledger record cannot hide stale Obsidian content', () => {
  const filePath = ledgerPath(); let calls = 0;
  const first = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: filePath, probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => { calls += 1; return calls === 1 ? { queued: true, token: operation().operationId } : { status: 'done', invariant: true, readback: 'hello' }; }, maxPollAttempts: 1 });
  assert.equal(first.execute(operation()).status, 'committed');
  let inspectionCalls = 0;
  const second = createVaultMutationAdapter({
    vaultRoot: '/vault',
    vaultId: 'vault-a',
    ledgerPath: filePath,
    probe: () => ({ state: 'available', vaultId: 'vault-a' }),
    evaluate: (code) => {
      inspectionCalls += 1;
      if (inspectionCalls === 1) return { queued: true, token: inspectionToken(code) };
      if (inspectionCalls === 2) return { status: 'unsatisfied', invariant: false };
      return true;
    },
    maxPollAttempts: 1,
  });
  const result = second.execute(operation());
  assert.equal(result.status, 'conflict');
  assert.equal(result.obsidian, 'unacknowledged');
});

test('fixed program uses create, process, and app-owned readback in their respective modes', () => {
  const create = buildObsidianMutationProgram(operation());
  const transform = buildObsidianMutationProgram({ ...operation(), operationKind: 'transform', transformName: 'append-line', transformVersion: 1, replayPayload: { line: '- one' } });
  const replace = buildObsidianMutationProgram({ ...operation(), operationKind: 'replace', expectedHash: 'a'.repeat(64), expectedContent: 'old' });
  assert.match(create, /app\.vault\.create/);
  assert.match(transform, /app\.vault\.process/);
  assert.match(replace, /current === input\.expectedContent/);
  for (const program of [create, transform, replace]) assert.match(program, /app\.vault\.read/);
});

function settled(value) { return { then(fn) { try { fn(value); return this; } catch (error) { this.error = error; return this; } }, catch(fn) { if (this.error) fn(this.error); return this; } }; }
function runInFakeObsidian(operation, { initial, readback } = {}) {
  const files = initial === undefined ? new Map() : new Map([[operation.vaultRelativePath, { path: operation.vaultRelativePath, content: initial }]]);
  const vault = { getFileByPath: (target) => files.get(target) || null, create: (target, content) => { const file = { path: target, content }; files.set(target, file); return settled(file); }, process: (file, transform) => { file.content = transform(file.content); return settled(file); }, delete: (file) => { files.delete(file.path); return settled(); }, read: (file) => settled(readback === undefined ? file.content : readback) };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context; vm.runInNewContext(buildObsidianMutationProgram(operation), context);
  return { result: context.__jarvosVaultMutationResults[operation.operationId], content: files.get(operation.vaultRelativePath)?.content };
}

test('fixed program handles collision identity, latest-content transforms, and stale app readback', () => {
  const create = operation();
  const identical = runInFakeObsidian(create, { initial: 'hello' }).result;
  assert.equal(identical.status, 'done');
  assert.equal(Object.hasOwn(identical, 'readback'), false);
  assert.equal(runInFakeObsidian(create, { initial: 'different' }).result.status, 'error');
  const transform = { ...create, operationKind: 'transform', transformName: 'append-line', transformVersion: 1, replayPayload: { line: '- agent' } };
  const latest = runInFakeObsidian(transform, { initial: 'mobile edit\n' });
  assert.equal(latest.result.status, 'done'); assert.match(latest.content, /mobile edit/); assert.match(latest.content, /- agent/);
  assert.equal(runInFakeObsidian(create, { readback: 'stale tracked content' }).result.status, 'error');
});

test('every registered transform matches the production Obsidian evaluator', () => {
  const transforms = createJarvosVaultTransforms();
  const cases = [
    ['plain\n', 'append-line', { line: '- appended' }],
    ['---\njarvos_note_id: "note-1"\n---\n\n# Note\n\nmobile\n', 'note-append-body', { noteId: 'note-1', body: '# Note\n\nagent' }],
    ['---\njarvos_note_id: "thread-1"\n---\n\n# Thread\n\nmobile\n', 'session-thread-append', { noteId: 'thread-1', entry: '## Checkpoint\n\nagent' }],
    ['## 💡 Ideas\n-\n\n## Scratch\nmobile\n', 'journal-section-line', { heading: '## 💡 Ideas', line: '- New idea' }],
    ['## 📝 Notes\n-\n\n## Scratch\n- [[Notes/One]]\nmobile\n', 'journal-backlink', { linkTarget: 'Notes/One', section: '📝 Notes', noteId: 'note-1' }],
  ];
  for (const [initial, transformName, replayPayload] of cases) {
    const input = { ...operation(), operationKind: 'transform', transformName, transformVersion: 1, replayPayload };
    const expected = transforms.applyNode(initial, input);
    const actual = runInFakeObsidian(input, { initial });
    assert.equal(actual.result.status, 'done', transformName);
    assert.equal(actual.content, expected, transformName);
    assert.equal(transforms.isSatisfied(actual.content, input), true, transformName);
  }
});

test('fixed program preserves quoted note identity for identity-safe note transforms', () => {
  const note = { ...operation(), operationKind: 'transform', transformName: 'note-append-body', transformVersion: 1, replayPayload: { noteId: 'note-1', body: '# Note\n\nagent prose' } };
  const latest = runInFakeObsidian(note, { initial: '---\njarvos_note_id: "note-1"\nstatus: active\n---\n\n# Note\n\nmobile prose\n' });
  assert.equal(latest.result.status, 'done');
  assert.match(latest.content, /status: active/);
  assert.match(latest.content, /mobile prose/);
  assert.match(latest.content, /agent prose/);
  assert.equal(runInFakeObsidian({ ...note, replayPayload: { ...note.replayPayload, noteId: 'other-note' } }, { initial: latest.content }).result.status, 'error');
});

test('fixed program appends when the requested block exists only as a prose substring', () => {
  const note = { ...operation(), operationKind: 'transform', transformName: 'note-append-body', transformVersion: 1, replayPayload: { noteId: 'note-1', body: 'next' } };
  const updated = runInFakeObsidian(note, { initial: '---\njarvos_note_id: "note-1"\n---\n\n# Note\n\nthe next thing\n' });
  assert.equal(updated.result.status, 'done');
  assert.match(updated.content, /the next thing\n\nnext\n$/);
});

test('fixed program appends one session checkpoint without replacing concurrent prose', () => {
  const checkpoint = {
    ...operation(),
    operationKind: 'transform',
    transformName: 'session-thread-append',
    transformVersion: 1,
    replayPayload: { noteId: 'thread-1', entry: '## Agent checkpoint\n\nnext action' },
  };
  const initial = '---\njarvos_note_id: "thread-1"\n---\n\n# Thread\n\nmobile checkpoint\n';
  const first = runInFakeObsidian(checkpoint, { initial });
  assert.equal(first.result.status, 'done');
  assert.match(first.content, /mobile checkpoint/);
  assert.match(first.content, /Agent checkpoint/);
  const second = runInFakeObsidian(checkpoint, { initial: first.content });
  assert.equal((second.content.match(/Agent checkpoint/g) || []).length, 1);
});

test('fixed program canonicalizes one exact backlink while preserving concurrent journal prose', () => {
  const backlink = {
    ...operation(),
    vaultRelativePath: 'Journal/2030-02-03.md',
    operationKind: 'transform',
    transformName: 'journal-backlink',
    transformVersion: 1,
    replayPayload: { linkTarget: 'Notes/C++ (Draft)', section: '📝 Notes', noteId: 'note-special' },
  };
  const initial = '## 📝 Notes\n- [[Notes/C++ (Draft)]]\n\n## Scratch\n- [[Notes/C++ (Draft)]]\n- concurrent mobile prose\n';
  const result = runInFakeObsidian(backlink, { initial });
  assert.equal(result.result.status, 'done');
  assert.equal((result.content.match(/\[\[Notes\/C\+\+ \(Draft\)\]\]/g) || []).length, 1);
  assert.match(result.content, /concurrent mobile prose/);
});

test('fixed program deletes only an exact disposable fixture and confirms absence', () => {
  const content = 'smoke nonce: one';
  const deletion = {
    ...operation(),
    operationKind: 'delete',
    expectedContent: content,
    expectedHash: require('../adapters/obsidian/src/vault-mutation-contract').hashUtf8(content),
  };
  const removed = runInFakeObsidian(deletion, { initial: content });
  assert.equal(removed.result.status, 'done');
  assert.equal(removed.content, undefined);
  const conflict = runInFakeObsidian(deletion, { initial: 'mobile changed it' });
  assert.equal(conflict.result.status, 'error');
  assert.equal(conflict.content, 'mobile changed it');
});

test('delete dispatch is denied unless the host grants narrow delete authority', () => {
  let dispatched = false;
  const adapter = createVaultMutationAdapter({
    vaultRoot: '/vault',
    vaultId: 'vault-a',
    ledgerPath: ledgerPath(),
    probe: () => ({ state: 'available', vaultId: 'vault-a' }),
    evaluate: () => { dispatched = true; },
  });
  const content = 'smoke fixture';
  const deletion = {
    ...operation(),
    operationKind: 'delete',
    expectedContent: content,
    expectedHash: require('../adapters/obsidian/src/vault-mutation-contract').hashUtf8(content),
  };
  assert.equal(adapter.execute(deletion).status, 'failed');
  assert.equal(adapter.inspectInvariant(deletion).status, 'unavailable');
  assert.equal(dispatched, false);
});

test('adapter exposes only a read-only ledger view', () => {
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'app_stopped' }) });
  adapter.execute(operation());
  assert.equal(typeof adapter.ledger.read, 'function');
  assert.equal(typeof adapter.ledger.get, 'function');
  for (const mutator of ['claim', 'ensure', 'nextSequence', 'planNext', 'transition', 'resolve', 'quarantine', 'acknowledgeFromObsidianRead']) {
    assert.equal(adapter.ledger[mutator], undefined, mutator);
  }
});
