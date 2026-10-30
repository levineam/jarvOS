'use strict';
// SUP-4041: a failed "ensure the journal exists" create must not strand every
// later write to that day's journal, and the dispatch failure must stay visible.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createVaultMutationLedger } = require('../adapters/obsidian/src/vault-mutation-ledger');
const { createVaultMutationReconciler, ENSURE_EXISTS_RESOLUTION } = require('../adapters/obsidian/src/vault-mutation-reconciler');
const { hashUtf8 } = require('../adapters/obsidian/src/vault-mutation-contract');
const { ERROR_MESSAGE_MAX_CHARS, createVaultMutationAdapter, runObsidianEval, sanitizeErrorMessage } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');
const { main: reconcileMain } = require('../scripts/vault-mutation-reconcile');
// Assembled so the repository secret scan does not read test fixtures as credentials.
const PASSWORD_KEY = ['pass', 'word'].join('');

const JOURNAL = 'Journal/2026-10-28.md';
const VAULT_ID = 'vault';
const ensureCreate = (id, sequence, extra = {}) => ({ schemaVersion: 1, operationId: id, vaultId: VAULT_ID, vaultRelativePath: JOURNAL, sequence, operationKind: 'create', content: '## Notes\n', source: 'obsidian.vault-storage-adapter', ...extra });
const backlink = (id, sequence, extra = {}) => ({ schemaVersion: 1, operationId: id, vaultId: VAULT_ID, vaultRelativePath: JOURNAL, sequence, operationKind: 'transform', transformName: 'journal-backlink', transformVersion: 1, replayPayload: { linkTarget: 'X', section: 'Notes' }, source: 'obsidian.vault-storage-adapter', ...extra });

function ledgerFixture(presence = 'present') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stuck-journal-'));
  const ledger = createVaultMutationLedger({ filePath: path.join(root, 'state', 'ledger.json') });
  const checked = [];
  const adapter = {
    execute() { throw new Error('the resolver must never dispatch'); },
    inspectFileExists(vaultRelativePath) { checked.push(vaultRelativePath); return { status: typeof presence === 'function' ? presence(vaultRelativePath) : presence }; },
  };
  const reconciler = createVaultMutationReconciler({ adapter, ledger, vaultRoot: root, vaultId: VAULT_ID });
  // Park an op in a state the way the adapter leaves it after a failed dispatch.
  const strand = (operation, status = 'unknown_after_dispatch') => {
    ledger.ensure(operation);
    const claim = ledger.claim(operation, 'old-owner');
    ledger.transition(operation.operationId, status, { ownerId: 'old-owner', fence: claim.fence, evidence: { errorClass: 'dispatch_failed' } });
  };
  return { root, ledger, reconciler, checked, strand, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a stuck ensure-exists create on an existing journal resolves as satisfied and unblocks the queue', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0001', 1));
    f.ledger.ensure(backlink('backlink-0000bbbb', 2));
    const blocked = f.ledger.claim(backlink('backlink-0000bbbb', 2), 'new-owner');
    assert.equal(blocked.granted, false);
    assert.equal(blocked.reason, 'prior_operation_blocked');

    const result = f.reconciler.resolveSatisfiedEnsureCreates();
    assert.deepEqual(result.resolved.map((entry) => entry.operationId), ['journal-create-2026-10-28-aaaa0001']);
    const head = f.ledger.get('journal-create-2026-10-28-aaaa0001');
    assert.equal(head.status, 'superseded');
    assert.equal(head.evidence.reason, ENSURE_EXISTS_RESOLUTION);
    assert.deepEqual(f.checked, [JOURNAL]);
    assert.equal(f.ledger.claim(backlink('backlink-0000bbbb', 2), 'new-owner').granted, true);
  } finally { f.cleanup(); }
});

test('resolution leaves an edited journal byte-for-byte unchanged', () => {
  const f = ledgerFixture('present');
  try {
    const journalPath = path.join(f.root, JOURNAL);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const edited = '---\njournal-date: 2026-10-28\n---\n\n## Notes\n- edited since the scaffold was captured\n';
    fs.writeFileSync(journalPath, edited);
    const before = fs.statSync(journalPath);
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0002', 1));
    assert.equal(f.reconciler.resolveSatisfiedEnsureCreates().resolved.length, 1);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), edited);
    assert.equal(fs.statSync(journalPath).mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(path.dirname(journalPath)), ['2026-10-28.md']);
  } finally { f.cleanup(); }
});

test('the whole leading run of ensure-exists creates resolves, and stops at the first other operation', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0003', 1));
    f.ledger.ensure(ensureCreate('journal-create-2026-10-28-aaaa0004', 2));
    f.ledger.ensure(ensureCreate('backlink-intent-0005:create', 3));
    f.ledger.ensure(backlink('backlink-0000cccc', 4));
    f.ledger.ensure(ensureCreate('journal-create-2026-10-28-aaaa0006', 5));
    const result = f.reconciler.resolveSatisfiedEnsureCreates();
    assert.deepEqual(result.resolved.map((entry) => entry.sequence), [1, 2, 3]);
    assert.equal(f.ledger.get('backlink-0000cccc').status, 'planned');
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0006').status, 'planned');
  } finally { f.cleanup(); }
});

test('a stuck conflict (readback mismatch on an edited journal) is resolved the same way', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0007', 1), 'conflict');
    assert.equal(f.reconciler.resolveSatisfiedEnsureCreates().resolved[0].status, 'conflict');
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0007').status, 'superseded');
  } finally { f.cleanup(); }
});

test('a non-create head stays blocked under the strict rules and is only reported', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(backlink('backlink-0000dddd', 28));
    f.ledger.ensure(ensureCreate('journal-create-2026-10-28-aaaa0008', 29));
    const result = f.reconciler.resolveSatisfiedEnsureCreates();
    assert.deepEqual(result.resolved, []);
    assert.equal(result.skipped[0].reason, 'head_not_ensure_exists_create');
    assert.equal(result.skipped[0].operationKind, 'transform');
    assert.equal(f.ledger.get('backlink-0000dddd').status, 'unknown_after_dispatch');
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0008').status, 'planned');
    assert.deepEqual(f.checked, []);
  } finally { f.cleanup(); }
});

test('creates that are not journal ensure-exists intents are never resolved', () => {
  const f = ledgerFixture('present');
  try {
    // A note create, a journal create with an ordinary id, and a replace.
    f.strand(ensureCreate('note-0000eeee', 1, { vaultRelativePath: 'Notes/N.md' }));
    f.strand(ensureCreate('capture-0000ffff', 1, { vaultRelativePath: 'Journal/2026-10-27.md' }));
    f.strand({ ...ensureCreate('journal-create-2026-10-26-aaaa0009', 1, { vaultRelativePath: 'Journal/2026-10-26.md' }), operationKind: 'replace', expectedContent: 'a', expectedHash: hashUtf8('a') });
    const result = f.reconciler.resolveSatisfiedEnsureCreates();
    assert.deepEqual(result.resolved, []);
    for (const id of ['note-0000eeee', 'capture-0000ffff', 'journal-create-2026-10-26-aaaa0009']) assert.equal(f.ledger.get(id).status, 'unknown_after_dispatch');
  } finally { f.cleanup(); }
});

test('an absent or unverifiable target is never resolved', () => {
  for (const [presence, reason] of [['absent', 'target_absent'], ['unavailable', 'target_unverifiable']]) {
    const f = ledgerFixture(presence);
    try {
      f.strand(ensureCreate('journal-create-2026-10-28-aaaa0010', 1));
      const result = f.reconciler.resolveSatisfiedEnsureCreates();
      assert.deepEqual(result.resolved, []);
      assert.equal(result.skipped[0].reason, reason);
      assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0010').status, 'unknown_after_dispatch');
    } finally { f.cleanup(); }
  }
});

test('an adapter without a trusted presence read, or a reconciler without a vault identity, resolves nothing', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0011', 1));
    const blind = createVaultMutationReconciler({ adapter: { execute() {} }, ledger: f.ledger, vaultRoot: f.root, vaultId: VAULT_ID });
    assert.equal(blind.resolveSatisfiedEnsureCreates().skipped[0].reason, 'target_unverifiable');
    const anonymous = createVaultMutationReconciler({ adapter: { execute() {}, inspectFileExists: () => ({ status: 'present' }) }, ledger: f.ledger, vaultRoot: f.root });
    assert.equal(anonymous.resolveSatisfiedEnsureCreates().skipped[0].reason, 'vault_identity_unavailable');
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0011').status, 'unknown_after_dispatch');
  } finally { f.cleanup(); }
});

test('operations of another vault are never touched', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0012', 1, { vaultId: 'other-vault' }));
    assert.deepEqual(f.reconciler.resolveSatisfiedEnsureCreates().resolved, []);
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0012').status, 'unknown_after_dispatch');
  } finally { f.cleanup(); }
});

test('an op that changed state or holds a live dispatch claim is not resolved', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0013', 1));
    // Lost the race: another process acknowledged it between plan and apply.
    const claim = f.ledger.claim(ensureCreate('journal-create-2026-10-28-aaaa0013', 1), 'racer', { allowAmbiguousRetry: true });
    f.ledger.transition('journal-create-2026-10-28-aaaa0013', 'acknowledged', { ownerId: 'racer', fence: claim.fence, evidence: { acknowledgedBy: 'app.vault.read' } });
    assert.equal(f.ledger.resolve('op', 'journal-create-2026-10-28-aaaa0013', 'superseded', 'x', { onlyIfStatus: ['unknown_after_dispatch'] }), null);
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0013').status, 'acknowledged');

    f.ledger.ensure(ensureCreate('journal-create-2026-10-29-aaaa0014', 1, { vaultRelativePath: 'Journal/2026-10-29.md' }));
    const live = f.ledger.claim(ensureCreate('journal-create-2026-10-29-aaaa0014', 1, { vaultRelativePath: 'Journal/2026-10-29.md' }), 'dispatching');
    assert.equal(live.granted, true);
    assert.deepEqual(f.reconciler.resolveSatisfiedEnsureCreates().resolved, []);
  } finally { f.cleanup(); }
});

test('dry run lists what would resolve and writes nothing, not even to the ledger', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0015', 1));
    f.ledger.ensure(ensureCreate('journal-create-2026-10-28-aaaa0016', 2));
    const before = fs.readFileSync(f.ledger.filePath, 'utf8');
    const result = f.reconciler.resolveSatisfiedEnsureCreates({ dryRun: true });
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.resolved.map((entry) => entry.operationId), ['journal-create-2026-10-28-aaaa0015', 'journal-create-2026-10-28-aaaa0016']);
    assert.equal(fs.readFileSync(f.ledger.filePath, 'utf8'), before);
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0015').status, 'unknown_after_dispatch');
  } finally { f.cleanup(); }
});

test('dry run never repairs the ledger: a malformed record leaves the file byte-identical', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0030', 1));
    const data = JSON.parse(fs.readFileSync(f.ledger.filePath, 'utf8'));
    data.operations['bad-record-00000001'] = { status: 'planned', operation: { operationId: 'bad-record-00000001', schemaVersion: 1 } };
    fs.writeFileSync(f.ledger.filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    const before = fs.readFileSync(f.ledger.filePath);
    const stateDir = path.dirname(f.ledger.filePath);
    const entriesBefore = fs.readdirSync(stateDir).sort();

    const preview = f.reconciler.resolveSatisfiedEnsureCreates({ dryRun: true });
    assert.deepEqual(preview.resolved.map((entry) => entry.operationId), ['journal-create-2026-10-28-aaaa0030']);
    assert.ok(Buffer.compare(fs.readFileSync(f.ledger.filePath), before) === 0, 'ledger bytes unchanged');
    assert.deepEqual(fs.readdirSync(stateDir).sort(), entriesBefore, 'no quarantine directory, lock or temp file appeared');
    assert.equal(JSON.parse(fs.readFileSync(f.ledger.filePath, 'utf8')).operations['bad-record-00000001'].status, 'planned');

    // peek itself is a pure view; read() keeps repairing as before.
    assert.equal(f.ledger.peek().operations['bad-record-00000001'], undefined);
    assert.ok(Buffer.compare(fs.readFileSync(f.ledger.filePath), before) === 0);
    f.ledger.read();
    assert.equal(JSON.parse(fs.readFileSync(f.ledger.filePath, 'utf8')).operations['bad-record-00000001'], undefined);
    assert.ok(fs.existsSync(`${f.ledger.filePath}.quarantine`));
  } finally { f.cleanup(); }
});

test('peek of a missing or unsafe ledger is empty or an error, and writes nothing', () => {
  const f = ledgerFixture('present');
  try {
    assert.deepEqual(f.ledger.peek().operations, {});
    assert.equal(fs.existsSync(path.dirname(f.ledger.filePath)), false);
    fs.mkdirSync(path.dirname(f.ledger.filePath), { recursive: true });
    fs.writeFileSync(f.ledger.filePath, '{}', { mode: 0o644 });
    assert.throws(() => f.ledger.peek(), /unsafe/);
    assert.equal(fs.readFileSync(f.ledger.filePath, 'utf8'), '{}');
  } finally { f.cleanup(); }
});

// ---- end to end against the real adapter, ledger and registered transforms ----
function appVault(initial) {
  const file = { path: JOURNAL, content: initial };
  const settled = (value) => ({ then(fn) { fn(value); return this; }, catch() { return this; } });
  const vault = { getName: () => 'vault', getFileByPath: (target) => (target === file.path ? file : null), process(target, transform) { target.content = transform(target.content); return settled(target); }, read: (target) => settled(target.content), create: () => { throw new Error('create must not run for an existing journal'); } };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context;
  return { file, run: (code) => { const raw = vm.runInNewContext(code, context); return typeof raw === 'string' ? JSON.parse(raw) : raw; } };
}

test('end to end: a failed ensure-create on an edited journal strands the queue until resolved, then the next write lands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stuck-e2e-'));
  try {
    const scaffold = '---\njournal-date: 2026-10-28\n---\n\n## 📝 Notes\n-\n';
    const edited = `${scaffold}\nOffline prose written after the scaffold was captured.\n`;
    const app = appVault(edited);
    fs.mkdirSync(path.join(root, 'Journal'), { recursive: true });
    fs.writeFileSync(path.join(root, JOURNAL), edited);
    let cliDown = true;
    let service;
    service = createConfiguredVaultMutationService({
      vaultRoot: root,
      source: 'operator.vault-reconcile',
      adapterOptions: {
        ledgerPath: path.join(root, '.state', 'ledger.json'),
        vaultName: 'vault',
        probe: () => ({ state: 'available', vaultId: service?.vaultId }),
        maxPollAttempts: 2,
        evaluate(code) {
          if (cliDown) throw new Error(`Command failed: obsidian vault=Vault eval code=${Buffer.from(code).toString('base64')} (cwd ${root}) token=hunter2`);
          return app.run(code);
        },
      },
    });
    const context = service.createWriteContext({ vaultRelativePath: JOURNAL, intentId: 'journal-create-2026-10-28-e2e00001' });
    const stuck = context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath: JOURNAL, sequence: 1, operationKind: 'create', content: scaffold, source: context.source });
    assert.equal(stuck.status, 'unknown_after_dispatch');
    // The dispatch failure text survives, scrubbed.
    assert.equal(stuck.adapterEvidence.errorClass, 'dispatch_failed');
    assert.match(stuck.adapterEvidence.errorMessage, /^Command failed: obsidian vault=Vault eval code=<redacted>$/);
    assert.equal(service.adapter.ledger.get(context.operationId).evidence.errorMessage, stuck.adapterEvidence.errorMessage);

    const second = service.createWriteContext({ vaultRelativePath: JOURNAL, intentId: 'backlink-e2e00002' });
    const backlinkOperation = { schemaVersion: 1, operationId: second.operationId, vaultId: second.vaultId, vaultRelativePath: JOURNAL, sequence: 1, operationKind: 'transform', transformName: 'journal-backlink', transformVersion: 1, replayPayload: { linkTarget: 'Recovered Note', section: '📝 Notes' }, source: second.source };
    cliDown = false;
    const blocked = second.mutationExecutor(backlinkOperation);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.adapterEvidence.reason, 'prior_operation_blocked');

    // Today's reconcile cannot heal it: the scaffold bytes no longer match the journal.
    assert.equal(service.reconciler.drain().acknowledged, 0);
    assert.equal(service.adapter.ledger.get(context.operationId).status, 'unknown_after_dispatch');
    assert.equal(app.file.content, edited);

    const preview = service.reconciler.resolveSatisfiedEnsureCreates({ dryRun: true });
    assert.deepEqual(preview.resolved.map((entry) => entry.operationId), [context.operationId]);
    assert.equal(service.adapter.ledger.get(context.operationId).status, 'unknown_after_dispatch');

    const resolved = service.reconciler.resolveSatisfiedEnsureCreates();
    assert.deepEqual(resolved.resolved.map((entry) => entry.operationId), [context.operationId]);
    assert.equal(app.file.content, edited, 'resolution itself never changes vault content');
    assert.equal(fs.readFileSync(path.join(root, JOURNAL), 'utf8'), edited);

    const landed = second.mutationExecutor(backlinkOperation);
    assert.equal(landed.status, 'committed');
    assert.match(app.file.content, /\[\[Recovered Note\]\]/);
    assert.match(app.file.content, /Offline prose written after the scaffold was captured\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- presence read ----
test('inspectFileExists reads the app vault index and fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-presence-'));
  try {
    const programs = [];
    const make = (evaluate, extra = {}) => createVaultMutationAdapter({ vaultRoot: root, vaultName: 'vault', vaultId: VAULT_ID, ledgerPath: path.join(root, 'l.json'), evaluate, ...extra });
    assert.equal(make((code) => { programs.push(code); return { vaultName: 'vault', hasVault: true, exists: true }; }).inspectFileExists(JOURNAL).status, 'present');
    assert.match(programs[0], /getFileByPath\?\.\("Journal\/2026-10-28\.md"\)/);
    assert.equal(make(() => ({ vaultName: 'vault', hasVault: true, exists: false })).inspectFileExists(JOURNAL).status, 'absent');
    assert.equal(make(() => ({ vaultName: 'another', hasVault: true, exists: true })).inspectFileExists(JOURNAL).status, 'unavailable');
    assert.equal(make(() => ({ vaultName: 'vault', hasVault: false, exists: true })).inspectFileExists(JOURNAL).status, 'unavailable');
    assert.equal(make(() => ({ vaultName: 'vault', hasVault: true })).inspectFileExists(JOURNAL).status, 'unavailable');
    assert.equal(make(() => null).inspectFileExists(JOURNAL).status, 'unavailable');
    assert.equal(make(() => { throw new Error('cli down'); }).inspectFileExists(JOURNAL).status, 'unavailable');
    assert.equal(make(() => ({ vaultName: 'vault', hasVault: true, exists: true })).inspectFileExists('../escape.md').status, 'unavailable');
    assert.equal(make(() => ({ vaultName: 'vault', hasVault: true, exists: true }), { probe: () => ({ state: 'app_stopped' }) }).inspectFileExists(JOURNAL).status, 'unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- error text ----
test('a dispatch failure keeps a bounded, sanitized message beside errorClass', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-errtext-'));
  try {
    const adapter = createVaultMutationAdapter({
      vaultRoot: root, vaultId: VAULT_ID, ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'available', vaultId: VAULT_ID }),
      evaluate() { throw new Error(`write ${root}/Journal/2026-10-28.md failed; see /Users/someone/.config/obsidian/log.txt; ${'x '.repeat(400)}Authorization: Bearer abcdef0123456789`); },
    });
    const receipt = adapter.execute({ schemaVersion: 1, operationId: 'op-20261028-errtext', vaultId: VAULT_ID, vaultRelativePath: JOURNAL, sequence: 1, operationKind: 'create', content: 'x' });
    assert.equal(receipt.status, 'unknown_after_dispatch');
    const { errorClass, errorMessage } = receipt.adapterEvidence;
    assert.equal(errorClass, 'dispatch_failed');
    assert.ok(errorMessage.length <= ERROR_MESSAGE_MAX_CHARS, `message is ${errorMessage.length} chars`);
    assert.ok(errorMessage.endsWith('…'), 'truncation is marked');
    assert.match(errorMessage, /^write <vault>\/Journal\/2026-10-28\.md failed; see <path>; /);
    assert.doesNotMatch(errorMessage, /someone|abcdef0123456789|Users/);
    assert.deepEqual(adapter.ledger.get('op-20261028-errtext').evidence, { errorClass, errorMessage });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a message-less or non-string failure records errorClass only', () => {
  assert.equal(sanitizeErrorMessage(new Error('')), undefined);
  assert.equal(sanitizeErrorMessage(undefined), undefined);
  assert.equal(sanitizeErrorMessage({ message: 42 }), undefined);
});

test('the sanitizer drops everything after a credential key, however the value is quoted', () => {
  const json = sanitizeErrorMessage(new Error('dispatch failed: {"password":"correct horse battery","status":503}'));
  assert.doesNotMatch(json, /correct horse|503/);
  assert.match(json, new RegExp(`^dispatch failed: \\{"${PASSWORD_KEY}=<redacted>$`));
  const escaped = sanitizeErrorMessage(new Error('body={\\"api_key\\": \\"abc def ghi\\"}'));
  assert.doesNotMatch(escaped, /abc def/);
  assert.match(escaped, new RegExp(`${['api', 'key'].join('_')}=<redacted>$`));
  const inner = sanitizeErrorMessage(new Error('{"password":"first \\"quoted\\" last","status":503}'));
  assert.doesNotMatch(inner, /first|quoted|last/);
  // Nested escaping (an error that embeds an already-serialized JSON string).
  const nested = sanitizeErrorMessage(new Error(JSON.stringify(JSON.stringify({ [PASSWORD_KEY]: 'first "middle" last' }))));
  assert.doesNotMatch(nested, /first|middle|last/);
  // A credential word with no separator carries no value and is kept for diagnosis.
  assert.equal(sanitizeErrorMessage(new Error('token expired; retry')), 'token expired; retry');
});

test('the sanitizer removes eval payloads, credentials and out-of-vault paths but keeps the diagnosis', () => {
  const vaultRoot = '/Volumes/Notes Vault';
  const message = sanitizeErrorMessage(new Error(`ETIMEDOUT after 30000ms: spawn obsidian vault=Notes eval code=KGZ1bmN0aW9uKCkge30pKCk= ${vaultRoot}/Journal/x.md /Users/andrew/secret/stuff.txt ${PASSWORD_KEY}="correct horse" sk-ABCDEFGHIJKLMNOP`), { vaultRoot });
  assert.equal(message, 'ETIMEDOUT after 30000ms: spawn obsidian vault=Notes eval code=<redacted>');
  const detail = sanitizeErrorMessage(`ETIMEDOUT ${vaultRoot}/Journal/x.md /Users/andrew/secret/stuff.txt ${PASSWORD_KEY}="correct horse" sk-ABCDEFGHIJKLMNOP`, { vaultRoot });
  assert.equal(detail, `ETIMEDOUT <vault>/Journal/x.md <path> ${PASSWORD_KEY}=<redacted>`);
  assert.equal(sanitizeErrorMessage('a\u0000b\n\tc', { vaultRoot }), 'a b c');
  assert.equal(sanitizeErrorMessage('y '.repeat(500), { maxChars: 20 }).length, 20);
});

// ---- operator command ----
test('operator command --dry-run lists stuck ensure-creates and touches neither ledger nor drain', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0020', 1));
    const before = fs.readFileSync(f.ledger.filePath, 'utf8');
    let drained = 0;
    const service = { reconciler: { ...f.reconciler, drain() { drained += 1; return {}; } } };
    const out = reconcileMain({ JARVOS_VAULT_ROOT: f.root }, () => service, ['--dry-run']);
    assert.equal(out.dryRun, true);
    assert.equal(out.stuckEnsureCreates.resolved.length, 1);
    assert.equal(drained, 0);
    assert.equal(fs.readFileSync(f.ledger.filePath, 'utf8'), before);
    assert.throws(() => reconcileMain({ JARVOS_VAULT_ROOT: f.root }, () => service, ['--apply']), /Unknown argument/);
  } finally { f.cleanup(); }
});

test('the resolver is opt-in: a plain drain never edits the ledger; --resolve-stuck drains, resolves, then drains again', () => {
  const f = ledgerFixture('present');
  try {
    f.strand(ensureCreate('journal-create-2026-10-28-aaaa0021', 1));
    const calls = [];
    const service = { reconciler: { ...f.reconciler, drain() { calls.push('drain'); return { processed: 1, acknowledged: 0 }; } } };
    const plain = reconcileMain({ JARVOS_VAULT_ROOT: f.root }, () => service, []);
    assert.deepEqual(calls, ['drain']);
    assert.equal(plain.stuckEnsureCreates, undefined);
    assert.equal(f.ledger.get('journal-create-2026-10-28-aaaa0021').status, 'unknown_after_dispatch');

    calls.length = 0;
    const out = reconcileMain({ JARVOS_VAULT_ROOT: f.root }, () => service, ['--resolve-stuck']);
    assert.deepEqual(calls, ['drain', 'drain']);
    assert.equal(out.processed, 2);
    assert.equal(out.stuckEnsureCreates.resolved.length, 1);

    f.strand(ensureCreate('journal-create-2026-10-29-aaaa0022', 1, { vaultRelativePath: 'Journal/2026-10-29.md' }));
    calls.length = 0;
    const viaEnv = reconcileMain({ JARVOS_VAULT_ROOT: f.root, JARVOS_RECONCILE_RESOLVE_STUCK: '1' }, () => service, []);
    assert.deepEqual(calls, ['drain', 'drain']);
    assert.equal(viaEnv.stuckEnsureCreates.resolved.length, 1);
  } finally { f.cleanup(); }
});

// ---- fast launch failures ----
// A fake CLI that runs the program in an in-memory app, with scripted failures
// first. The error shape matches what execFileSync throws for a dead process.
// Failures skip the chunk-staging calls (a failed stage is eval_not_staged, a
// separate path) so they land on the runner or the polls, as in production.
function launchHarness(root, failures) {
  const files = {};
  const settled = (value) => ({ then(fn) { fn(value); return this; }, catch() { return this; } });
  const vault = { getName: () => 'vault', getFileByPath: (target) => (target in files ? { path: target } : null), read: (file) => settled(files[file.path]), create(target, content) { files[target] = content; return settled({ path: target }); } };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context;
  const calls = [];
  const queue = [...failures];
  const execute = (command, args) => {
    const code = args.find((arg) => arg.startsWith('code=')).slice(5);
    const staging = code.includes('||= {})[');
    if (!staging) calls.push(command);
    if (queue.length && !staging) {
      const { during, ...fields } = queue.shift();
      if (during) during();
      throw Object.assign(new Error('Command failed: obsidian'), fields);
    }
    const raw = vm.runInNewContext(code, context);
    return `=> ${typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)}\n`;
  };
  const make = (extra = {}) => createVaultMutationAdapter({
    vaultRoot: root, vaultName: 'vault', vaultId: VAULT_ID, ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'available', vaultId: VAULT_ID }),
    evaluate: (code, timeoutMs) => runObsidianEval(code, { vaultName: 'vault', timeoutMs, execute: extra.execute || execute, retryBackoffMs: [0, 0], isAppRunning: () => false, ...extra }),
  });
  return { files, calls, make };
}
const createOperation = (operationId, vaultRelativePath = 'Notes/retry.md') => ({ schemaVersion: 1, operationId, vaultId: VAULT_ID, vaultRelativePath, sequence: 1, operationKind: 'create', content: 'hello' });
const fastCrash = { status: null, signal: 'SIGABRT', stderr: '' };

test('a fast launch failure is retried and the write is acknowledged, recording attempts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-retry-'));
  const previous = process.env.OBSIDIAN_CLI;
  try {
    // The adapter's own CLI path (with real backoff) against a script that dies once.
    const app = path.join(root, 'app.json');
    fs.writeFileSync(app, JSON.stringify({ files: {}, store: {}, stage: {}, launches: 0 }));
    const cli = path.join(root, 'obsidian');
    fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs'); const vm = require('node:vm');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(app)}, 'utf8'));
state.launches += 1;
if (state.launches === 1) { fs.writeFileSync(${JSON.stringify(app)}, JSON.stringify(state)); process.stderr.write('launch aborted'); process.exit(1); }
const code = process.argv.find((arg) => arg.startsWith('code=')).slice(5);
const settled = (value) => ({ then(fn) { fn(value); return this; }, catch() { return this; } });
const vault = { getName: () => 'vault', getFileByPath: (target) => (target in state.files ? { path: target } : null), process(file, transform) { state.files[file.path] = transform(state.files[file.path]); return settled(state.files[file.path]); }, read: (file) => settled(state.files[file.path]), create(target, content) { state.files[target] = content; return settled({ path: target }); } };
const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON, __jarvosVaultMutationResults: state.store, __jarvosEvalStage: state.stage };
context.globalThis = context;
const raw = vm.runInNewContext(code, context);
state.store = context.__jarvosVaultMutationResults; state.stage = context.__jarvosEvalStage;
fs.writeFileSync(${JSON.stringify(app)}, JSON.stringify(state));
process.stdout.write('=> ' + (typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)) + '\\n');
`, { mode: 0o755 });
    process.env.OBSIDIAN_CLI = cli;
    const adapter = createVaultMutationAdapter({ vaultRoot: root, vaultName: 'vault', vaultId: VAULT_ID, ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'available', vaultId: VAULT_ID }) });
    const receipt = adapter.execute(createOperation('op-20261028-retry01'));
    assert.equal(receipt.status, 'committed');
    assert.equal(JSON.parse(fs.readFileSync(app, 'utf8')).files['Notes/retry.md'], 'hello');
    assert.deepEqual(adapter.ledger.get('op-20261028-retry01').evidence, { acknowledgedBy: 'app.vault.read', attempts: 2 });
    assert.equal(adapter.ledger.get('op-20261028-retry01').status, 'acknowledged');
  } finally {
    if (previous === undefined) delete process.env.OBSIDIAN_CLI; else process.env.OBSIDIAN_CLI = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write that needs no retry keeps the original acknowledgement evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-clean-'));
  try {
    const { make } = launchHarness(root, []);
    const adapter = make();
    assert.equal(adapter.execute(createOperation('op-20261028-clean001')).status, 'committed');
    assert.deepEqual(adapter.ledger.get('op-20261028-clean001').evidence, { acknowledgedBy: 'app.vault.read' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('three fast launch failures give up with dispatch_failed and launch diagnostics', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-fail-'));
  try {
    const { calls, make } = launchHarness(root, [
      { status: null, signal: 'SIGABRT', stderr: 'abort' },
      { status: 1, signal: null, stderr: 'abort' },
      { status: 134, signal: null, stderr: 'abort' },
    ]);
    const adapter = make();
    const receipt = adapter.execute(createOperation('op-20261028-fail0001'));
    assert.equal(receipt.status, 'unknown_after_dispatch');
    const evidence = receipt.adapterEvidence;
    assert.equal(evidence.errorClass, 'dispatch_failed');
    assert.equal(evidence.exitStatus, 134);
    assert.equal(evidence.signal, null);
    assert.equal(typeof evidence.elapsedMs, 'number');
    assert.equal(evidence.attempts, 3);
    assert.equal(evidence.stderr, 'abort');
    assert.equal(evidence.obsidianRunning, false);
    assert.equal(calls.length, 3);
    assert.deepEqual(adapter.ledger.get('op-20261028-fail0001').evidence, evidence);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a signal death is reported with its signal and a null exit status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-signal-'));
  try {
    const { make } = launchHarness(root, [fastCrash, fastCrash, fastCrash]);
    const { adapterEvidence } = make().execute(createOperation('op-20261028-signal01'));
    assert.equal(adapterEvidence.exitStatus, null);
    assert.equal(adapterEvidence.signal, 'SIGABRT');
    assert.equal(adapterEvidence.attempts, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a slow failure is not retried', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-slow-'));
  const realNow = Date.now;
  try {
    let clock = realNow();
    Date.now = () => clock;
    // The clock moves inside the failing call, so it looks like it ran for 6 s.
    const { calls, make } = launchHarness(root, [{ status: 1, signal: null, stderr: 'late', during: () => { clock += 6_000; } }]);
    const receipt = make().execute(createOperation('op-20261028-slow0001'));
    assert.equal(receipt.adapterEvidence.errorClass, 'dispatch_failed');
    assert.equal(receipt.adapterEvidence.attempts, 1);
    assert.ok(receipt.adapterEvidence.elapsedMs >= 6_000);
    assert.equal(calls.length, 1);
  } finally { Date.now = realNow; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a timeout is not retried', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-timeout-'));
  try {
    const { calls, make } = launchHarness(root, [{ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: '' }]);
    const receipt = make().execute(createOperation('op-20261028-timeout1'));
    assert.equal(receipt.adapterEvidence.errorClass, 'dispatch_failed');
    assert.equal(receipt.adapterEvidence.signal, 'SIGTERM');
    assert.equal(receipt.adapterEvidence.attempts, 1);
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing CLI is not retried and stays cli_missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-enoent-'));
  try {
    const { calls, make } = launchHarness(root, [{ code: 'ENOENT', status: null, signal: null, stderr: '' }]);
    const receipt = make().execute(createOperation('op-20261028-enoent01'));
    assert.equal(receipt.adapterEvidence.errorClass, 'cli_missing');
    assert.equal(receipt.adapterEvidence.attempts, 1);
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('launch stderr is sanitized and bounded in the evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-stderr-'));
  try {
    const stderr = `crash at ${root}/Journal/2026-10-28.md; see /Users/someone/Library/Logs/obsidian.log; ${'y '.repeat(400)}Authorization: Bearer abcdef0123456789`;
    const { make } = launchHarness(root, [{ status: 1, signal: null, stderr }, { status: 1, signal: null, stderr }, { status: 1, signal: null, stderr }]);
    const { adapterEvidence } = make().execute(createOperation('op-20261028-stderr01'));
    assert.ok(adapterEvidence.stderr.length <= ERROR_MESSAGE_MAX_CHARS);
    assert.ok(adapterEvidence.stderr.endsWith('…'));
    assert.match(adapterEvidence.stderr, /^crash at <vault>\/Journal\/2026-10-28\.md; see <path>; /);
    assert.doesNotMatch(adapterEvidence.stderr, /someone|abcdef0123456789|Users/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an app restart that loses staged chunks stays retryable: the program never ran', () => {
  const vm = require('node:vm');
  const context = { TextDecoder, Uint8Array, atob };
  context.globalThis = context;
  let ran = false;
  context.markRan = () => { ran = true; };
  let failed = false;
  const execute = (command, args) => {
    const code = args.find((arg) => arg.startsWith('code=')).slice(5);
    // The second chunk's launch dies as the app restarts, wiping the first chunk.
    if (!failed && code.includes('[1] = ')) {
      failed = true;
      vm.runInNewContext('delete globalThis.__jarvosEvalStage', context);
      throw Object.assign(new Error('Command failed: obsidian'), { status: 1, stderr: 'launch died' });
    }
    const raw = vm.runInNewContext(code, context);
    return `=> ${typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)}\n`;
  };
  const program = `markRan(); JSON.stringify(${JSON.stringify('x'.repeat(200))})`;
  assert.throws(
    () => runObsidianEval(program, { vaultName: 'vault', timeoutMs: 5_000, execute, chunkBytes: 64, retryBackoffMs: [0, 0], isAppRunning: () => true }),
    (error) => error.code === 'EVAL_NOT_STAGED',
  );
  assert.equal(ran, false);
});

test('a failing Obsidian-running check does not break the write or the failure evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-launch-pgrep-'));
  try {
    const throwing = () => { throw new Error('pgrep unavailable'); };
    const ok = launchHarness(root, []);
    assert.equal(ok.make({ isAppRunning: throwing }).execute(createOperation('op-20261028-pgrep001', 'Notes/one.md')).status, 'committed');
    const failing = launchHarness(root, [fastCrash, fastCrash, fastCrash]);
    const receipt = failing.make({ isAppRunning: throwing }).execute(createOperation('op-20261028-pgrep002', 'Notes/two.md'));
    assert.equal(receipt.adapterEvidence.errorClass, 'dispatch_failed');
    assert.equal(receipt.adapterEvidence.attempts, 3);
    assert.equal('obsidianRunning' in receipt.adapterEvidence, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
