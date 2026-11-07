'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { applyInbox } = require('../bridge/capture/src/inbox-apply');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');
const { CaptureValidationError, simpleCapture } = require('../bridge/capture/src/simple-capture');
const { createVaultMutationLedger } = require('../adapters/obsidian/src/vault-mutation-ledger');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

const device = 'phone-47ba92';
const opId = '0f012026-caf1-4e59-99cd-5db5d4e5097f';
const now = () => new Date('2030-02-03T12:00:00Z');

function request(fields = {}, text = 'An invented first line.\nAn invented second line.', newline = '\n') {
  return ['---', ...Object.entries({ phanos_request: 'capture/v1', op_id: opId, device, kind: 'journal', words: 'user',
    asked: 'explicit', model: 'test-model', created: '2030-02-03T07:00:00-05:00', date: '2030-02-03', ...fields })
    .filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`), '---', text, '', '<!-- phanos:end -->', ''].join('\n').replace(/\n/g, newline);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inbox-'));
  const vaultRoot = path.join(root, 'vault');
  const folder = path.join(vaultRoot, 'phanos/inbox', device);
  const receipts = path.join(vaultRoot, 'phanos/receipts', device);
  fs.mkdirSync(folder, { recursive: true });
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, 'state');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  const mutationService = createAcknowledgedVaultMutationService(vaultRoot);
  const capture = (input, options) => { calls.push({ input, options }); return { ok: true, message: 'Saved an invented request.' }; };
  const put = (source = request(), name = opId) => fs.writeFileSync(path.join(folder, `${name}.md`), source);
  return { root, vaultRoot, folder, receipts, put, calls, mutationService,
    apply: (options = {}) => applyInbox({ vaultRoot, capture, now, mutationService, ...options }),
    receipt: (id = opId) => fs.readFileSync(path.join(receipts, `${id}.md`), 'utf8') };
}

// Each run starts a new host process against the real configured service and ledger.
function runInbox(f, options = {}, env = {}) {
  return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers/capture-lineage-process.js')], {
    input: JSON.stringify({ root: f.root, inbox: true, ...options }), encoding: 'utf8', env: { ...process.env,
      JARVOS_VAULT_DIR: path.join(f.root, 'other-configured-vault'),
      JARVOS_NOTES_DIR: path.join(f.root, 'wrong-notes'), VAULT_NOTES_DIR: path.join(f.root, 'wrong-notes'),
      JARVOS_JOURNAL_DIR: path.join(f.root, 'wrong-journal'), JOURNAL_DIR: path.join(f.root, 'wrong-journal'),
      JARVOS_KNOWLEDGE_DIR: path.join(f.root, 'knowledge'), JARVOS_CONFIG_PATH: path.join(f.root, 'missing-config.json'),
      JARVOS_TIMEZONE: 'UTC', TZ: 'UTC', ...env },
  }));
}

for (const damage of ['invalid JSON', 'malformed record', 'unreadable file']) {
  test(`ledger integrity preflight refuses ${damage} without repair or receipts`, async (t) => {
    const f = fixture(t); f.put();
    const ledgerPath = path.join(f.root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath: ledgerPath });
    if (damage === 'unreadable file') fs.mkdirSync(ledgerPath);
    else fs.writeFileSync(ledgerPath, damage === 'invalid JSON' ? '{invented broken ledger}'
      : JSON.stringify({ schemaVersion: 1, operations: { invented: { status: 'invented' } }, claims: {} }), { mode: 0o600 });
    const before = damage === 'unreadable file' ? null : fs.readFileSync(ledgerPath);
    const service = createConfiguredVaultMutationService({ vaultRoot: f.vaultRoot, proveObsidianAbsent: () => false,
      adapterOptions: { ledger, probe: () => ({ state: 'app_busy' }) } });
    const result = await f.apply({ mutationService: service });
    assert.equal(result.stopped, 'ledger integrity');
    assert.deepEqual(result.requests, []);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(path.dirname(f.receipts)), false);
    assert.equal(fs.existsSync(`${ledgerPath}.quarantine`), false);
    if (before) assert.deepEqual(fs.readFileSync(ledgerPath), before);
    else assert.ok(fs.statSync(ledgerPath).isDirectory());
  });
}

for (const during of ['capture', 'receipt']) {
  test(`ledger permission failure during ${during} stops before receipts or the next request`, async (t) => {
    const f = fixture(t); f.put();
    f.put(request({ op_id: 'invented-next-001' }), 'invented-next-001');
    const ledgerPath = path.join(f.root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath: ledgerPath });
    const reservation = { intentId: `capture:op:${'a'.repeat(64)}`, requestHash: 'b'.repeat(64), vaultId: 'invented-vault', plan: {} };
    ledger.reserveCapture(reservation);
    const before = fs.readFileSync(ledgerPath);
    const configured = createConfiguredVaultMutationService({ vaultRoot: f.vaultRoot, proveObsidianAbsent: () => false,
      adapterOptions: { ledger, probe: () => ({ state: 'app_busy' }) } });
    const damageLedger = () => {
      fs.chmodSync(ledgerPath, 0o644);
      configured.reserveCaptureOperation({ ...reservation, intentId: `capture:op:${'c'.repeat(64)}` });
    };
    const service = during === 'receipt' ? { ...configured, createMarkdownFile: damageLedger } : configured;
    let calls = 0;
    const result = await f.apply({ mutationService: service, capture: () => {
      calls++;
      if (during === 'capture') damageLedger();
      return { ok: true, message: 'Saved an invented capture.' };
    } });
    assert.equal(result.stopped, 'ledger integrity');
    assert.equal(calls, 1);
    assert.equal(result.requests.length, 1);
    assert.ok(Object.values(result.counts).every((count) => count === 0));
    assert.deepEqual(fs.readFileSync(ledgerPath), before);
    assert.equal(fs.existsSync(path.join(f.receipts, `${opId}.md`)), false);
    assert.equal(fs.existsSync(path.join(f.receipts, 'invented-next-001.md')), false);
    assert.equal(fs.existsSync(`${ledgerPath}.quarantine`), false);
  });
}

test('a ledger lock permission error during capture stops without trying a receipt', async (t) => {
  const f = fixture(t); f.put();
  const ledgerPath = path.join(f.root, 'ledger.json');
  let denied = false;
  const ledger = createVaultMutationLedger({ filePath: ledgerPath, fsImpl: { ...fs, openSync(file, ...args) {
    if (denied && file === `${ledgerPath}.lock`) throw Object.assign(new Error('An invented ledger permission denial.'),
      { code: 'EACCES', path: file });
    return fs.openSync(file, ...args);
  } } });
  const reservation = { intentId: `capture:op:${'a'.repeat(64)}`, requestHash: 'b'.repeat(64), vaultId: 'invented-vault', plan: {} };
  ledger.reserveCapture(reservation);
  const before = fs.readFileSync(ledgerPath);
  const service = createConfiguredVaultMutationService({ vaultRoot: f.vaultRoot, proveObsidianAbsent: () => false,
    adapterOptions: { ledger, probe: () => ({ state: 'app_busy' }) } });
  const result = await f.apply({ mutationService: service, capture: () => {
    denied = true;
    return service.reserveCaptureOperation(reservation);
  } });
  assert.equal(result.stopped, 'ledger integrity');
  assert.deepEqual(fs.readFileSync(ledgerPath), before);
  assert.equal(fs.existsSync(path.dirname(f.receipts)), false);
});

test('an offline local_applied capture stays pending on replay and acknowledges once Obsidian returns', (t) => {
  const f = fixture(t);
  f.put(request({ kind: 'note', title: '"An invented offline note"' }));
  const first = runInbox(f, { fault: 'offline_stopped' });
  assert.equal(first.error, null);
  assert.equal(first.result.counts.not_confirmed, 1);
  assert.equal(first.notes.length, 1);
  const note = Object.values(first.ledger.operations).find(({ operation }) => operation.operationId.startsWith('capture:op:')
    && operation.vaultRelativePath.startsWith('Notes/'));
  assert.equal(note.status, 'local_applied');

  const retry = runInbox(f, { fault: 'offline_stopped' });
  assert.equal(retry.error, null);
  assert.equal(retry.ledger.operations[note.operation.operationId].status, 'local_applied');
  assert.equal(retry.result.counts.not_confirmed, 1);
  assert.deepEqual(retry.ledger.operations[note.operation.operationId], note);
  assert.deepEqual(retry.notes, first.notes);
  assert.deepEqual(retry.writes, []);

  const recovered = runInbox(f);
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.counts.saved, 1);
  assert.equal(recovered.ledger.operations[note.operation.operationId].status, 'acknowledged');
  assert.deepEqual(recovered.notes, first.notes);
  assert.equal(recovered.writes.some((name) => name.startsWith('Notes/')), false);
  assert.match(f.receipt(), /status: saved/);
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

test('a capture ledger lock timeout stays not_confirmed and retries once with a saved receipt', (t) => {
  const f = fixture(t); f.put();
  const first = runInbox(f, { fault: 'ledger_lock' });
  assert.equal(first.error, null);
  assert.equal(first.result.counts.not_confirmed, 1, f.receipt());
  assert.equal(first.result.counts.invalid, 0);
  assert.match(f.receipt(), /status: not_confirmed/);
  assert.match(f.receipt(), /Not confirmed yet: saving hit a temporary problem; it will be tried again\./);
  assert.doesNotMatch(f.receipt(), /Timed out|ledger|lock/);
  assert.equal(first.journal, null);
  assert.deepEqual(first.notes, []);
  const recovered = runInbox(f);
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.counts.saved, 1);
  assert.match(f.receipt(), /status: saved/);
  assert.equal(recovered.journal.split('An invented first line.').length - 1, 1);
  assert.ok(Object.values(recovered.ledger.operations).every(({ status }) => status === 'acknowledged'));
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

for (const fault of ['capture_io', 'capture_unexpected']) {
  test(`${fault} after a capture effect stays retryable and does not duplicate it`, (t) => {
    const f = fixture(t); f.put();
    const first = runInbox(f, { fault });
    assert.equal(first.error, null);
    assert.equal(first.result.counts.not_confirmed, 1);
    assert.match(f.receipt(), /status: not_confirmed/);
    assert.match(f.receipt(), /Not confirmed yet: saving hit a temporary problem; it will be tried again\./);
    assert.doesNotMatch(f.receipt(), /invented.*failure/);
    assert.equal(first.journal.split('An invented first line.').length - 1, 1);
    const recovered = runInbox(f);
    assert.equal(recovered.error, null);
    assert.equal(recovered.result.counts.saved, 1);
    assert.equal(recovered.journal, first.journal);
    assert.equal(recovered.writes.some((name) => name.startsWith('Journal/')), false);
    assert.match(f.receipt(), /status: saved/);
    assert.equal(runInbox(f).result.counts.skipped, 1);
  });
}

test('a real persisted operation ID conflict is invalid without changing the captured content', (t) => {
  const f = fixture(t); f.put();
  const first = runInbox(f, { inbox: false, simple: true, capture: { kind: 'journal',
    text: 'An invented first line.\nAn invented second line.', words: 'user', asked: 'explicit',
    model: 'test-model', source: 'phanos-mobile', date: '2030-02-03', opId } });
  assert.equal(first.error, null);
  assert.equal(first.result.ok, true);
  f.put(request({}, 'An invented changed request.'));
  const conflict = runInbox(f);
  assert.equal(conflict.error, null);
  assert.equal(conflict.result.counts.invalid, 1);
  assert.match(f.receipt(), /this operation id was already used for different content/);
  assert.equal(conflict.journal, first.journal);
  assert.deepEqual(conflict.ledger.captures, first.ledger.captures);
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

test('new-device receipts create missing parents before the Obsidian create operation', (t) => {
  const f = fixture(t); f.put();
  assert.equal(fs.existsSync(path.dirname(f.receipts)), false);
  const run = runInbox(f);
  assert.equal(run.error, null);
  assert.equal(run.result.counts.saved, 1);
  assert.equal(run.result.requests[0].receipt, undefined);
  assert.match(f.receipt(), /status: saved/);
  const receipts = Object.values(run.ledger.operations).filter(({ operation }) => operation.vaultRelativePath.startsWith('phanos/receipts/'));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'acknowledged');
});

test('a planned receipt resumes across runs with one operation and no blocked queue', (t) => {
  const f = fixture(t); f.put();
  const first = runInbox(f, { fault: 'before_receipt' });
  assert.equal(first.error, null);
  assert.equal(first.result.counts.saved, 1);
  assert.equal(first.result.requests[0].receipt.obsidian, 'app_busy');
  assert.equal(fs.existsSync(path.join(f.receipts, `${opId}.md`)), false);
  const receiptRecords = (run) => Object.values(run.ledger.operations)
    .filter(({ operation }) => operation.vaultRelativePath.startsWith('phanos/receipts/'));
  const planned = receiptRecords(first);
  assert.equal(planned.length, 1);
  assert.equal(planned[0].status, 'planned');
  const second = runInbox(f, { inboxNow: '2030-02-04T12:00:00Z' });
  assert.equal(second.error, null);
  assert.equal(second.result.counts.saved, 1);
  const completed = receiptRecords(second);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].operation.operationId, planned[0].operation.operationId);
  assert.equal(completed[0].operation.content, planned[0].operation.content);
  assert.equal(completed[0].status, 'acknowledged');
  assert.equal(second.result.requests[0].receipt, undefined);
  assert.deepEqual(second.writes, [`phanos/receipts/${device}/${opId}.md`]);
  assert.equal(Object.values(second.ledger.operations).every(({ status }) => status === 'acknowledged'), true);
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

test('a planned receipt replacement resumes its original payload across runs', (t) => {
  const f = fixture(t); f.put();
  const pending = runInbox(f, { fault: 'after_backlink' });
  assert.equal(pending.result.counts.not_confirmed, 1);
  const priorContent = f.receipt();
  const first = runInbox(f, { fault: 'before_receipt', inboxNow: '2030-02-04T12:00:00Z' });
  assert.equal(first.error, null);
  assert.equal(first.result.counts.saved, 1);
  assert.equal(first.result.requests[0].receipt.obsidian, 'app_busy');
  assert.equal(f.receipt(), priorContent);
  const replacement = Object.values(first.ledger.operations).find(({ operation }) => operation.operationKind === 'replace');
  assert.equal(replacement.status, 'planned');
  const second = runInbox(f, { inboxNow: '2030-02-05T12:00:00Z' });
  assert.equal(second.error, null);
  assert.equal(second.result.requests[0].receipt, undefined);
  const replacements = Object.values(second.ledger.operations).filter(({ operation }) => operation.operationKind === 'replace');
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].operation.operationId, replacement.operation.operationId);
  assert.equal(replacements[0].operation.content, replacement.operation.content);
  assert.equal(replacements[0].status, 'acknowledged');
  assert.equal(f.receipt(), replacement.operation.content);
  assert.equal(Object.values(second.ledger.operations).every(({ status }) => status === 'acknowledged'), true);
});

test('a queued not_confirmed receipt settles before a saved receipt is submitted', (t) => {
  const f = fixture(t); f.put();
  const receiptPath = `phanos/receipts/${device}/${opId}.md`;
  const first = runInbox(f, { fault: 'after_backlink_before_receipt' });
  assert.equal(first.error, null);
  assert.equal(first.result.counts.not_confirmed, 1);
  const queued = Object.values(first.ledger.operations).find(({ operation }) => operation.vaultRelativePath === receiptPath);
  assert.equal(queued.status, 'planned');
  assert.match(queued.operation.content, /status: not_confirmed/);
  assert.equal(fs.existsSync(path.join(f.receipts, `${opId}.md`)), false);

  const recovered = runInbox(f);
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.counts.saved, 1);
  assert.equal(recovered.result.requests[0].receipt, undefined);
  assert.match(f.receipt(), /status: saved/);
  const receipts = Object.values(recovered.ledger.operations).filter(({ operation }) => operation.vaultRelativePath === receiptPath);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].operation.operationId, queued.operation.operationId);
  assert.equal(receipts[1].operation.operationKind, 'replace');
  assert.equal(receipts[1].operation.expectedContent, queued.operation.content);
  assert.ok(Object.values(recovered.ledger.operations).every(({ status }) => status === 'acknowledged'));
  assert.equal(recovered.journal.split('An invented first line.').length - 1, 1);
  assert.equal(runInbox(f).result.counts.skipped, 1);
  assert.deepEqual(fs.readdirSync(f.receipts), [`${opId}.md`]);
});

test('an unresolved earlier receipt reports receipt pending without allocating another operation', (t) => {
  const f = fixture(t); f.put();
  const receiptPath = `phanos/receipts/${device}/${opId}.md`;
  const first = runInbox(f, { fault: 'after_backlink_before_receipt' });
  const queued = Object.values(first.ledger.operations).find(({ operation }) => operation.vaultRelativePath === receiptPath);
  const held = runInbox(f, { fault: 'before_receipt' });
  assert.equal(held.error, null);
  assert.equal(held.result.counts.saved, 1);
  assert.equal(held.result.requests[0].receipt.message, 'receipt pending');
  const receipts = Object.values(held.ledger.operations).filter(({ operation }) => operation.vaultRelativePath === receiptPath);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].operation.operationId, queued.operation.operationId);
  assert.equal(receipts[0].status, 'planned');
  assert.equal(fs.existsSync(path.join(f.receipts, `${opId}.md`)), false);
  const recovered = runInbox(f);
  assert.equal(recovered.result.counts.saved, 1);
  assert.equal(recovered.result.requests[0].receipt, undefined);
  assert.match(f.receipt(), /status: saved/);
  assert.ok(Object.values(recovered.ledger.operations).every(({ status }) => status === 'acknowledged'));
  assert.equal(recovered.journal, held.journal);
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

test('a dispatched capture with an active crashed-writer claim stays not_confirmed until recovery', (t) => {
  const f = fixture(t); f.put();
  assert.throws(() => runInbox(f, { inbox: false, simple: true, fault: 'exit_after_effect', ledgerNow: 100_000,
    capture: { kind: 'journal', text: 'An invented first line.\nAn invented second line.', words: 'user', asked: 'explicit',
      model: 'test-model', source: 'phanos-mobile', date: '2030-02-03', opId } }), (error) => error.status === 73);
  const crashed = JSON.parse(fs.readFileSync(path.join(f.root, 'ledger.json'), 'utf8'));
  const dispatched = Object.values(crashed.operations).find(({ status }) => status === 'dispatched');
  assert.ok(dispatched);
  const claim = crashed.claims[`${dispatched.operation.vaultId}\0${dispatched.operation.vaultRelativePath}`];
  assert.equal(claim.operationId, dispatched.operation.operationId);
  assert.ok(claim.expiresAt > 100_001);
  const held = runInbox(f, { ledgerNow: 100_001 });
  assert.equal(held.error, null);
  assert.equal(held.result.counts.not_confirmed, 1, JSON.stringify(held));
  assert.equal(held.ledger.operations[dispatched.operation.operationId].status, 'dispatched');
  assert.match(f.receipt(), /status: not_confirmed/);
  const recovered = runInbox(f, { ledgerNow: claim.expiresAt + 1 });
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.counts.saved, 1);
  assert.equal(recovered.result.requests[0].receipt, undefined);
  assert.match(f.receipt(), /status: saved/);
  assert.equal(recovered.journal, held.journal);
  assert.equal(recovered.journal.split('An invented first line.').length - 1, 1);
  assert.ok(Object.values(recovered.ledger.operations).every(({ status }) => status === 'acknowledged'));
  assert.equal(runInbox(f).result.counts.skipped, 1);
  assert.deepEqual(fs.readdirSync(f.receipts), [`${opId}.md`]);
});

test('an unavailable planned capture stays not_confirmed and later saves once', (t) => {
  const f = fixture(t); f.put();
  const queued = runInbox(f, { fault: 'before_write' });
  assert.equal(queued.error, null);
  assert.equal(queued.result.counts.not_confirmed, 1);
  assert.ok(Object.values(queued.ledger.operations).every(({ status }) => status === 'planned'));
  const recovered = runInbox(f);
  assert.equal(recovered.error, null);
  assert.equal(recovered.result.counts.saved, 1);
  assert.equal(recovered.result.requests[0].receipt, undefined);
  assert.match(f.receipt(), /status: saved/);
  assert.equal(recovered.journal.split('An invented first line.').length - 1, 1);
  assert.ok(Object.values(recovered.ledger.operations).every(({ status }) => status === 'acknowledged'));
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

test('a terminal capture conflict without unresolved artifacts stays not_saved', (t) => {
  const f = fixture(t); f.put();
  const queued = runInbox(f, { inbox: false, simple: true, fault: 'before_write', ledgerNow: 100_000,
    capture: { kind: 'journal', text: 'An invented first line.\nAn invented second line.', words: 'user', asked: 'explicit',
      model: 'test-model', source: 'phanos-mobile', date: '2030-02-03', opId } });
  assert.equal(queued.error, null);
  const [record] = Object.values(queued.ledger.operations);
  const ledger = createVaultMutationLedger({ filePath: path.join(f.root, 'ledger.json'), now: () => 100_001 });
  const claim = ledger.claim(record.operation, 'invented-conflict-writer');
  assert.equal(claim.granted, true);
  ledger.transition(record.operation.operationId, 'conflict', { ownerId: 'invented-conflict-writer', fence: claim.fence });
  const failed = runInbox(f, { ledgerNow: 100_002 });
  assert.equal(failed.error, null);
  assert.equal(failed.result.counts.not_saved, 1);
  assert.equal(failed.result.counts.not_confirmed, 0);
  assert.match(f.receipt(), /status: not_saved/);
  assert.equal(failed.ledger.operations[record.operation.operationId].status, 'conflict');
  assert.equal(runInbox(f).result.counts.skipped, 1);
});

for (const created of ['2030-02-02T23:59:00-05:00', undefined]) {
  test(`undated not_confirmed request survives midnight (${created ? 'phone date' : 'reserved date'})`, (t) => {
    const f = fixture(t);
    f.put(request({ date: undefined, created }));
    const firstClock = '2030-02-03T23:59:00Z';
    const secondClock = '2030-02-04T00:01:00Z';
    const day = created ? '2030-02-02' : '2030-02-03';
    const first = runInbox(f, { fault: 'after_backlink', inboxNow: firstClock, clockNow: firstClock });
    assert.equal(first.error, null);
    assert.equal(first.result.counts.not_confirmed, 1, JSON.stringify(first));
    assert.match(f.receipt(), /status: not_confirmed/);
    const reservation = Object.values(first.ledger.captures);
    assert.equal(reservation.length, 1);
    assert.equal(reservation[0].plan.date, day);
    const second = runInbox(f, { inboxNow: secondClock, clockNow: secondClock });
    assert.equal(second.error, null);
    assert.equal(second.result.counts.invalid, 0);
    assert.equal(second.result.counts.saved, 1);
    assert.deepEqual(second.ledger.captures, first.ledger.captures);
    const journal = fs.readFileSync(path.join(f.vaultRoot, 'Journal', `${day}.md`), 'utf8');
    assert.equal(journal.split('An invented first line.').length - 1, 1);
    assert.deepEqual(fs.readdirSync(path.join(f.vaultRoot, 'Journal')).filter((name) => name.endsWith('.md')), [`${day}.md`]);
    assert.equal(runInbox(f, { inboxNow: secondClock, clockNow: secondClock }).result.counts.skipped, 1);
    assert.match(f.receipt(), /status: saved/);
  });
}

for (const configured of [true, false]) {
  test(`configured capture folders are ${configured ? 'used for the configured vault' : 'ignored for another vault'}`, (t) => {
    const f = fixture(t);
    f.put(request({ kind: 'note', title: '"An invented configured note"' }));
    const configPath = path.join(f.root, 'jarvos.config.json');
    const configuredVault = configured ? f.vaultRoot : path.join(f.root, 'other-configured-vault');
    const journalFolder = configured ? 'Journal/Configured' : 'Journal';
    const notesFolder = configured ? 'Notes/Configured' : 'Notes';
    fs.writeFileSync(configPath, JSON.stringify({ paths: { vault: configuredVault,
      journal: path.join(configuredVault, 'Journal/Configured'), notes: path.join(configuredVault, 'Notes/Configured') },
      user: { timezone: 'UTC' } }));
    const run = runInbox(f, { journalFolder, notesFolder }, {
      JARVOS_CONFIG_PATH: configPath, JARVOS_VAULT_DIR: '', JARVOS_JOURNAL_DIR: '', JOURNAL_DIR: '',
      JARVOS_NOTES_DIR: '', VAULT_NOTES_DIR: '',
    });
    assert.equal(run.error, null);
    assert.equal(run.result.counts.saved, 1, JSON.stringify(run));
    assert.equal(run.notes.length, 1);
    assert.ok(run.notes[0].content.includes('An invented first line.'));
    assert.match(run.journal, /\[\[An invented configured note\]\]/);
    assert.ok(run.writes.includes(`${notesFolder}/An invented configured note.md`));
    assert.ok(run.writes.includes(`${journalFolder}/2030-02-03.md`));
    assert.equal(Object.values(run.ledger.operations).every(({ status }) => status === 'acknowledged'), true);
    const knowledgeDir = configured ? path.join(f.root, 'knowledge') : path.join(f.vaultRoot, '.jarvos/knowledge');
    assert.equal(fs.existsSync(path.join(knowledgeDir, 'gbrain-import-queue.json')), true);
    if (configured) {
      assert.equal(fs.existsSync(path.join(f.vaultRoot, 'Notes/An invented configured note.md')), false);
      assert.equal(fs.existsSync(path.join(f.vaultRoot, 'Journal/2030-02-03.md')), false);
    } else assert.equal(fs.existsSync(configuredVault), false);
  });
}

test('a second vault capture leaves primary knowledge for the same note path unchanged', (t) => {
  const f = fixture(t);
  const capture = { kind: 'note', title: 'X', text: 'An invented primary garden detail.', words: 'user',
    asked: 'explicit', source: 'codex', date: '2030-02-03', opId };
  const primary = runInbox(f, { inbox: false, simple: true, capture }, {
    JARVOS_VAULT_DIR: f.vaultRoot, JARVOS_NOTES_DIR: path.join(f.vaultRoot, 'Notes'),
    JARVOS_JOURNAL_DIR: path.join(f.vaultRoot, 'Journal'),
  });
  assert.equal(primary.result.ok, true, JSON.stringify(primary));
  const knowledge = primary.result.result.note.knowledge;
  const paths = Object.entries(knowledge).filter(([key]) => key.endsWith('Path')).map(([, value]) => value);
  const derived = paths.map((file) => fs.readFileSync(file, 'utf8'));
  assert.match(JSON.parse(fs.readFileSync(knowledge.queuePath, 'utf8')).entries['Notes/X.md'].summary, /primary garden/);
  const second = { root: path.join(f.root, 'second') };
  const folder = path.join(second.root, 'vault/phanos/inbox', device);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${opId}.md`), request({ kind: 'note', title: '"X"' }, 'An invented second garden detail.'));
  const saved = runInbox(second, {}, { JARVOS_VAULT_DIR: f.vaultRoot, JARVOS_KNOWLEDGE_DIR: path.join(f.root, 'knowledge') });
  assert.equal(saved.result.counts.saved, 1, JSON.stringify(saved));
  assert.deepEqual(paths.map((file) => fs.readFileSync(file, 'utf8')), derived);
  const queue = JSON.parse(fs.readFileSync(path.join(second.root, 'vault/.jarvos/knowledge/gbrain-import-queue.json'), 'utf8'));
  assert.match(queue.entries['Notes/X.md'].summary, /second garden/);
});

for (const newline of ['\n', '\r\n']) {
  test(`phone fixtures pass exact text and declarations (${JSON.stringify(newline)})`, async (t) => {
    const f = fixture(t);
    for (const [index, kind] of ['idea', 'journal', 'note'].entries()) {
      const id = `fixture-operation-${index}`;
      const text = kind === 'journal' ? 'An invented first line.\nAn invented second line.' : 'An invented tidal garden.';
      f.put(request({ kind, op_id: id, ...(kind === 'note' ? { title: '"A test note"', model: undefined } : {}) }, text, newline), id);
    }
    const result = await f.apply();
    assert.equal(result.counts.saved, 3);
    assert.equal(f.calls.length, 3);
    for (const { input, options } of f.calls) {
      assert.equal(input.source, 'phanos-mobile');
      assert.equal(input.words, 'user');
      assert.equal(input.asked, 'explicit');
      assert.equal(input.date, '2030-02-03');
      assert.equal(input.text, input.kind === 'journal' ? `An invented first line.${newline}An invented second line.` : 'An invented tidal garden.');
      assert.deepEqual(options, { vaultRoot: f.vaultRoot, journalDir: path.join(f.vaultRoot, 'Journal'), notesDir: path.join(f.vaultRoot, 'Notes'), knowledgeDir: path.join(f.vaultRoot, '.jarvos/knowledge'), mutationService: f.mutationService });
      if (input.kind === 'note') { assert.equal(input.title, 'A test note'); assert.equal(input.model, undefined); }
      const receipt = f.receipt(input.opId);
      assert.match(receipt, new RegExp(`status: saved\nkind: ${input.kind}\napplied: .*[-+]\\d\\d:\\d\\d\n`));
      assert.ok(!receipt.includes('\r'));
    }
    assert.ok(!JSON.stringify(result).includes('invented'));
    assert.equal((await f.apply()).counts.skipped, 3);
    assert.equal(f.calls.length, 3);
  });
}

test('real capture and persistent mutation ledger save exactly once, including after lost receipts', async (t) => {
  const f = fixture(t);
  for (const [index, kind] of ['idea', 'journal', 'note'].entries()) {
    const id = `fixture-operation-${index}`;
    f.put(request({ kind, op_id: id, ...(kind === 'note' ? { title: '"A test note"' } : {}) },
      kind === 'journal' ? 'An invented first line.\nAn invented second line.' : `An invented ${kind} about tidal gardens.`), id);
  }
  const original = fs.readdirSync(f.folder).map((name) => [name, fs.readFileSync(path.join(f.folder, name), 'utf8'), fs.statSync(path.join(f.folder, name)).mtimeMs]);
  const run = (inboxNow) => runInbox(f, { inboxNow });
  const first = run();
  assert.equal(first.error, null);
  assert.equal(first.result.counts.saved, 3, fs.readdirSync(f.receipts).map((name) => fs.readFileSync(path.join(f.receipts, name), 'utf8')).join('\n'));
  assert.equal(first.notes.length, 1);
  assert.equal(first.journal.split('- An invented idea about tidal gardens.').length - 1, 1);
  assert.equal(first.journal.split('An invented first line.').length - 1, 1);
  assert.equal(first.journal.split('[[A test note]]').length - 1, 1);
  const second = run();
  assert.equal(second.result.counts.skipped, 3);
  assert.deepEqual(second.writes, []);
  fs.rmSync(f.receipts, { recursive: true });
  const replay = run();
  assert.deepEqual(replay.writes, []);
  assert.ok(replay.result.requests.every((request) => request.receipt === undefined));
  assert.deepEqual(fs.readdirSync(f.receipts), []);
  const third = run('2030-02-03T12:00:01Z');
  assert.equal(third.result.counts.saved, 3, JSON.stringify(third));
  assert.deepEqual(third.writes, []);
  assert.ok(third.result.requests.every((request) => request.receipt === undefined));
  assert.deepEqual(fs.readdirSync(f.receipts), []);
  assert.deepEqual(third.notes, first.notes);
  assert.equal(third.journal, first.journal);
  assert.equal(fs.existsSync(path.join(f.root, 'wrong-notes')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'wrong-journal')), false);
  assert.deepEqual(fs.readdirSync(f.folder).map((name) => [name, fs.readFileSync(path.join(f.folder, name), 'utf8'), fs.statSync(path.join(f.folder, name)).mtimeMs]), original);
});

test('not_confirmed is retried with the same opId and receipt rewritten', async (t) => {
  const f = fixture(t); f.put();
  assert.equal((await f.apply({ capture: () => ({ ok: false, message: 'An invented delay.',
    result: { artifactReceipt: { artifacts: [{ kind: 'journal', outcome: 'deferred' }] } } }) })).counts.not_confirmed, 1);
  assert.match(f.receipt(), /status: not_confirmed/);
  assert.equal((await f.apply()).counts.saved, 1);
  assert.equal(f.calls[0].input.opId, opId);
  assert.match(f.receipt(), /status: saved/);
  assert.equal((await f.apply()).counts.skipped, 1);
});

for (const outcome of ['saved_locally_sync_pending', 'deferred', 'failed', 'conflict', 'committed', 'already_satisfied']) {
  test(`saved note with ${outcome} journal link uses structured status`, async (t) => {
    const f = fixture(t); f.put(request({ kind: 'note', title: '"A test note"' }));
    const pending = ['saved_locally_sync_pending', 'deferred'].includes(outcome);
    const ok = ['committed', 'already_satisfied'].includes(outcome);
    let response;
    const capture = (input) => (response = simpleCapture(input, { capture: () => ({ ok, note: { title: 'A test note' },
      artifactReceipt: { artifacts: [{ kind: 'note', outcome: 'committed' }, { kind: 'journal', outcome }] } }) }));
    const status = pending ? 'not_confirmed' : ok ? 'saved' : 'not_saved';
    assert.equal((await f.apply({ capture })).counts[status], 1);
    assert.match(f.receipt(), new RegExp(`status: ${status}`));
    assert.ok(f.receipt().endsWith(`${response.message}\n`));
    assert.equal((await f.apply()).counts[pending ? 'saved' : 'skipped'], 1);
    assert.equal(f.calls.length, pending ? 1 : 0);
    if (pending) assert.equal(f.calls[0].input.opId, opId);
  });
}

test('pending artifact outcomes override ok and message wording does not set status', async (t) => {
  const f = fixture(t); f.put();
  assert.equal((await f.apply({ capture: () => ({ ok: true, message: 'Saved an invented request.',
    result: { artifactReceipt: { artifacts: [{ kind: 'journal', outcome: 'deferred' }] } } }) })).counts.not_confirmed, 1);
  assert.equal((await f.apply({ capture: () => ({ ok: false, message: 'Not confirmed yet: an invented failure.',
    result: { artifactReceipt: { artifacts: [{ kind: 'journal', outcome: 'failed' }] } } }) })).counts.not_saved, 1);
});

test('receipt creates and exact-content replacements use stable mutation intents', async (t) => {
  const f = fixture(t); f.put();
  const creates = [];
  const replacements = [];
  const mutationService = { ...f.mutationService,
    createMarkdownFile(input) { creates.push(input); return f.mutationService.createMarkdownFile(input); },
    applyMarkdownMutation(input) { replacements.push(input); return f.mutationService.applyMarkdownMutation(input); },
  };
  const capture = () => ({ ok: false, message: 'An invented delay.',
    result: { artifactReceipt: { artifacts: [{ kind: 'journal', outcome: 'deferred' }] } } });
  await f.apply({ mutationService, capture });
  const current = f.receipt();
  await f.apply({ mutationService });
  assert.equal(creates.length, 1);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].expectedContent, current);
  assert.equal(replacements[0].nextContent, f.receipt());
  assert.equal(creates[0].vaultRelativePath, `phanos/receipts/${device}/${opId}.md`);
  assert.ok(creates[0].intentId);
  assert.notEqual(creates[0].intentId, replacements[0].intentId);
  fs.unlinkSync(path.join(f.receipts, `${opId}.md`));
  await f.apply({ mutationService, capture });
  assert.deepEqual(creates[1], creates[0]);
});

for (const receipt of [{ status: 'deferred', obsidian: 'unacknowledged' },
  { status: 'saved_locally_sync_pending', obsidian: 'unacknowledged' },
  { status: 'committed', obsidian: 'unacknowledged' }]) {
  test(`unacknowledged receipt write (${receipt.status}) is reported and retried`, async (t) => {
    const f = fixture(t); f.put();
    const writes = [];
    const mutationService = { ...f.mutationService, createMarkdownFile(input) { writes.push(input); return receipt; } };
    const first = await f.apply({ mutationService });
    assert.deepEqual(first.requests[0].receipt, receipt);
    assert.equal(fs.existsSync(path.join(f.receipts, `${opId}.md`)), false);
    await f.apply({ mutationService });
    assert.deepEqual(writes[1], writes[0]);
    assert.equal((await f.apply()).counts.saved, 1);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every(({ input }) => input.opId === opId));
  });
}

test('receipt replacement refuses a concurrent edit after the pending receipt was read', async (t) => {
  const f = fixture(t); f.put();
  await f.apply({ capture: () => ({ ok: false, message: 'An invented delay.',
    result: { artifactReceipt: { artifacts: [{ kind: 'journal', outcome: 'deferred' }] } } }) });
  const changed = f.receipt().replace('An invented delay.', 'An invented concurrent edit.');
  const result = await f.apply({ capture: () => {
    fs.writeFileSync(path.join(f.receipts, `${opId}.md`), changed);
    return { ok: true, message: 'Saved an invented request.' };
  } });
  assert.equal(result.requests[0].receipt.status, 'conflict');
  assert.equal(f.receipt(), changed);
});

test('partial, hidden, temp and non-Markdown files create no receipts', async (t) => {
  const f = fixture(t); f.put(request().replace('<!-- phanos:end -->', ''));
  for (const name of ['.hidden.md', 'unfinished.tmp', 'readme.txt']) fs.writeFileSync(path.join(f.folder, name), request());
  assert.equal((await f.apply()).counts.incomplete, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.receipts), false);
});

const invalid = [
  [{ kind: 'other' }, /kind must be/], [{ words: 'assistant' }, /words must be user/],
  [{ asked: 'accepted_offer' }, /asked must be explicit/], [{ kind: 'idea', title: '"A test note"' }, /only for notes/],
  [{ op_id: 'different-operation' }, /op_id must match/], [{ device: 'phone-invented' }, /device must match/],
  [{ extra: 'invented' }, /unknown frontmatter key/], [{ phanos_request: 'capture/v2' }, /capture\/v1/],
  [{ date: '2030-02-30' }, /valid YYYY-MM-DD/], [{ kind: 'note', title: 'unquoted' }, /JSON double-quoted/],
  ...['".hidden"', '"-hidden"', '"a/b"', '"a\\\\b"', '"a\\nb"', JSON.stringify('a'.repeat(201))].map((title) => [{ kind: 'note', title }, /title must be one line/]),
];
for (const [fields, reason] of invalid) test(`invalid request: ${JSON.stringify(fields)}`, async (t) => {
  const f = fixture(t); f.put(request(fields));
  assert.equal((await f.apply()).counts.invalid, 1);
  assert.match(f.receipt(), /status: invalid/);
  assert.match(f.receipt(), reason);
  assert.equal(f.calls.length, 0);
});

test('oversized requests are invalid and duplicate fields are refused', async (t) => {
  const f = fixture(t);
  f.put(request({}, 'x'.repeat(256 * 1024)));
  assert.equal((await f.apply()).counts.invalid, 1);
  assert.match(f.receipt(), /exceeds 256 KB/);
  fs.unlinkSync(path.join(f.receipts, `${opId}.md`));
  f.put(request().replace('kind: journal', 'kind: journal\nkind: idea'));
  assert.equal((await f.apply()).counts.invalid, 1);
  assert.equal(f.calls.length, 0);
});

test('capture validation exceptions and opId conflicts are invalid; other not-ok is not_saved', async (t) => {
  const f = fixture(t); f.put();
  for (const [capture, status] of [
    [() => { throw new CaptureValidationError('An invented validation error.'); }, 'invalid'],
    [() => { throw Object.assign(new Error('this operation id was already used for different content'), { validation: true }); }, 'invalid'],
    [() => ({ ok: false, message: 'Not saved: an invented failure.' }), 'not_saved'],
  ]) {
    assert.equal((await f.apply({ capture })).counts[status], 1);
    assert.match(f.receipt(), new RegExp(`status: ${status}`));
    fs.unlinkSync(path.join(f.receipts, `${opId}.md`));
  }
});

test('missing dates defer the day to capture reservation and keep body bytes', async (t) => {
  const f = fixture(t);
  const text = '  An invented first line.  \n\nAn invented second line.  \n';
  f.put(request({ date: undefined, created: undefined }, text) + '\n\n');
  await f.apply();
  assert.equal(f.calls[0].input.text, text);
  assert.equal(Object.hasOwn(f.calls[0].input, 'date'), false);
});

test('limit applies oldest eligible requests first and skips terminal receipts without consuming it', async (t) => {
  const f = fixture(t);
  for (const [index, id] of ['fixture-oldest', 'fixture-middle', 'fixture-newest'].entries()) {
    f.put(request({ op_id: id }), id);
    fs.utimesSync(path.join(f.folder, `${id}.md`), index + 1, index + 1);
  }
  assert.equal((await f.apply({ limit: 1 })).counts.saved, 1);
  assert.equal(f.calls[0].input.opId, 'fixture-oldest');
  const second = await f.apply({ limit: 1 });
  assert.equal(second.counts.saved, 1);
  assert.equal(second.counts.skipped, 1);
  assert.equal(f.calls[1].input.opId, 'fixture-middle');
});

test('an older incomplete request does not consume the limit for a complete request', async (t) => {
  const f = fixture(t);
  f.put(request({ op_id: 'fixture-incomplete' }).replace('<!-- phanos:end -->', ''), 'fixture-incomplete');
  fs.utimesSync(path.join(f.folder, 'fixture-incomplete.md'), 1, 1);
  f.put();
  const result = await f.apply({ limit: 1 });
  assert.equal(result.counts.incomplete, 1);
  assert.equal(result.counts.saved, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.opId, opId);
  assert.equal(fs.existsSync(path.join(f.receipts, 'fixture-incomplete.md')), false);
});

for (const target of ['phanos', 'inbox', 'device', 'request', 'receipts', 'receipt-device', 'receipt']) {
  test(`symlinked ${target} is rejected without capture or writes outside the vault`, async (t) => {
    const f = fixture(t); f.put();
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const locations = { phanos: path.join(f.vaultRoot, 'phanos'), inbox: path.dirname(f.folder), device: f.folder,
      request: path.join(f.folder, `${opId}.md`), receipts: path.dirname(f.receipts), 'receipt-device': f.receipts, receipt: path.join(f.receipts, `${opId}.md`) };
    const targetPath = locations[target];
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.rmSync(targetPath, { force: true, recursive: true });
    fs.symlinkSync(outside, targetPath);
    await assert.rejects(f.apply(), /symlink|real directories/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}

for (const segment of ['receipts', 'receipt-device']) {
  for (const kind of ['symlink', 'file']) {
    test(`real receipt writer refuses a ${kind} at ${segment}`, (t) => {
      const f = fixture(t); f.put();
      const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
      const target = segment === 'receipts' ? path.dirname(f.receipts) : f.receipts;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (kind === 'symlink') fs.symlinkSync(outside, target);
      else fs.writeFileSync(target, 'An invented non-directory.');
      const run = runInbox(f);
      assert.match(run.error, /real directories|symlink/);
      assert.deepEqual(run.writes, []);
      assert.deepEqual(run.ledger.operations, {});
      assert.deepEqual(fs.readdirSync(outside), []);
    });
  }
}

test('exclusive per-vault lock blocks overlapping runs and is released afterward', async (t) => {
  const f = fixture(t); f.put();
  let finish;
  const first = f.apply({ capture: () => new Promise((resolve) => { finish = resolve; }) });
  const held = await f.apply();
  assert.equal(held.inProgress, true);
  assert.equal(held.message, 'another run is in progress');
  assert.equal(fs.existsSync(f.receipts), false);
  finish({ ok: true, message: 'Saved an invented request.' });
  assert.equal((await first).counts.saved, 1);
  assert.equal((await f.apply()).inProgress, false);
});

test('abandoned ten-minute lock is reclaimed; lock and state stay outside the vault', async (t) => {
  const f = fixture(t); f.put();
  const folder = path.join(f.root, 'state/jarvos/vault-mutations');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `inbox-${createHash('sha256').update(fs.realpathSync(f.vaultRoot)).digest('hex')}.lock`);
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, new Date(0), new Date(0));
  assert.equal((await f.apply()).counts.saved, 1);
  assert.equal(fs.existsSync(file), false);
  process.env.XDG_STATE_HOME = path.join(f.vaultRoot, 'state');
  await assert.rejects(f.apply(), /outside the vault/);
  assert.equal(fs.existsSync(path.join(f.vaultRoot, 'state')), false);
});

test('a lock held by a live run on this host is kept however old; a dead owner\'s lock is reclaimed at once', async (t) => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const f = fixture(t); f.put();
  const folder = path.join(f.root, 'state/jarvos/vault-mutations');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `inbox-${createHash('sha256').update(fs.realpathSync(f.vaultRoot)).digest('hex')}.lock`);
  // Live owner (this test process), lock file far older than ten minutes.
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }));
  fs.utimesSync(file, new Date(0), new Date(0));
  assert.equal((await f.apply()).inProgress, true);
  assert.equal(fs.existsSync(f.receipts), false);
  // Dead owner: a finished child process's pid, lock just written.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(file, JSON.stringify({ pid: Number(dead.stdout), host: os.hostname() }));
  assert.equal((await f.apply()).counts.saved, 1);
  assert.equal(fs.existsSync(file), false);
});
