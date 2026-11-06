'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseArgs, removeIdeasOriginMarkers, run } = require('../scripts/remove-ideas-origin-markers');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');
const { renderJournalOriginMarker, digestText } = require('../bridge/provenance/src/content-origin-contract');

const journalPath = 'Journal/2030-02-03.md';
const marker = renderJournalOriginMarker({ cleanText: 'Thought', content_origin: 'assistant', content_origin_basis: 'assistant_generated' });
const original = `---\r\nkind: journal\r\n---\r\n## 📝 Notes\r\n- Note\r\n${marker}\r\n\r\n## 💡 Ideas\r\n- Thought\r\n\r\n  Continuation  \r\n${marker}\r\n\r\n- Other\n${marker}\n\n<!-- ordinary comment -->\n<!-- jarvos-content-origin/v1 keep --> <!-- ordinary -->\n## Ideas extra\n${marker}\n## 📓 Journal Entry\n- Body\n${marker}`;
const cleaned = original.replace(`${marker}\r\n\r\n- Other\n${marker}\n`, '\r\n- Other\n');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideas-marker-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  const filePath = path.join(vaultRoot, journalPath);
  const preimagePath = path.join(root, 'preimage.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, original);
  return { root, vaultRoot, journalPath, filePath, preimagePath };
}

function settled(value) {
  return { then(fn) { try { fn(value); } catch (error) { this.error = error; } return this; }, catch(fn) { if (this.error) fn(this.error); return this; } };
}

function appService(f, { beforeProcess, readback } = {}) {
  const file = { path: journalPath };
  const vault = {
    getFileByPath: target => target === journalPath ? file : null,
    process(target, transform) {
      if (beforeProcess) beforeProcess();
      fs.writeFileSync(f.filePath, transform(fs.readFileSync(f.filePath, 'utf8')));
      return settled(target);
    },
    read: () => settled(readback ?? fs.readFileSync(f.filePath, 'utf8')),
  };
  const context = vm.createContext({ app: { vault }, TextDecoder, Uint8Array, atob, btoa, unescape });
  return createConfiguredVaultMutationService({
    vaultRoot: f.vaultRoot, vaultId: 'synthetic-vault', source: 'journal.remove-ideas-origin-markers',
    adapterOptions: { ledgerPath: path.join(f.root, 'state', 'ledger.json'), probe: () => ({ state: 'available', vaultId: 'synthetic-vault' }), evaluate: code => {
      const result = vm.runInContext(code, context);
      return typeof result === 'string' ? JSON.parse(result) : result;
    }, maxPollAttempts: 2 },
  });
}

test('CLI defaults to a dry run with an exact applicable diff and count', t => {
  const f = fixture(t);
  const options = parseArgs(['--vault', f.vaultRoot, '--journal', journalPath]);
  const result = run(options, { createService() { assert.fail('dry run must not open the ledger'); } });
  assert.equal(result.count, 2);
  assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(original));
  assert.match(result.output, /Markers to remove: 2\n$/);
  assert.equal(result.output.split(`-${marker}`).length - 1, 2);
  const patch = path.join(f.root, 'planned.patch');
  fs.writeFileSync(patch, result.output.replace(/Markers to remove: 2\n$/, ''));
  const applied = spawnSync('patch', ['-p1', '-i', patch], { cwd: f.vaultRoot, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(cleaned));
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../scripts/remove-ideas-origin-markers.js'), '--vault', f.vaultRoot, '--journal', journalPath], { encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.equal(cli.stdout, 'Markers to remove: 0\n');
  assert.equal(fs.existsSync(path.join(f.root, 'state')), false);
});

test('apply saves the preimage first, removes only Ideas markers, acknowledges, and restores exactly', t => {
  const f = fixture(t);
  const service = appService(f, { beforeProcess() { assert.deepEqual(fs.readFileSync(f.preimagePath), Buffer.from(original)); } });
  const result = run({ ...f, mode: '--apply' }, { createService: () => service });
  assert.equal(result.receipt.obsidian, 'acknowledged');
  assert.match(result.output, /Acknowledged readback: Journal\/2030-02-03.md/);
  assert.match(result.output, /Markers removed: 2/);
  assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(cleaned));
  assert.deepEqual(fs.readFileSync(f.preimagePath), Buffer.from(original));
  assert.equal(fs.statSync(f.preimagePath).mode & 0o777, 0o600);
  const restored = run({ ...f, mode: '--restore', restorePath: f.preimagePath }, { createService: () => service });
  assert.equal(restored.receipt.obsidian, 'acknowledged');
  assert.match(restored.output, /Preimage restored/);
  assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(original));
});

test('content changed after read is refused without overwriting the edit', t => {
  const f = fixture(t);
  assert.throws(() => run({ ...f, mode: '--apply' }, { createService() {
    fs.writeFileSync(f.filePath, original + '\nNew edit');
    return { applyMarkdownMutation() { assert.fail('must not submit'); } };
  } }), /changed since read/);
  assert.deepEqual(fs.readFileSync(f.preimagePath), Buffer.from(original));
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), original + '\nNew edit');
});

test('app-side content change conflicts at the guarded mutation service', t => {
  const f = fixture(t);
  const service = appService(f, { beforeProcess() { fs.writeFileSync(f.filePath, 'Concurrent edit'); } });
  assert.throws(() => run({ ...f, mode: '--apply' }, { createService: () => service }), /not acknowledged/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), 'Concurrent edit');
  assert.deepEqual(fs.readFileSync(f.preimagePath), Buffer.from(original));
});

test('restore refuses changes made after cleanup', t => {
  const f = fixture(t);
  fs.writeFileSync(f.preimagePath, original);
  fs.writeFileSync(f.filePath, cleaned + '\nNew edit');
  assert.throws(() => run({ ...f, mode: '--restore', restorePath: f.preimagePath }, { createService() { assert.fail('must not submit'); } }), /changed since cleanup/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), cleaned + '\nNew edit');
});

test('preimages inside the vault, including symlink aliases, are refused', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.vaultRoot, alias);
  for (const preimagePath of [path.join(f.vaultRoot, 'preimage.md'), path.join(alias, 'preimage.md')]) {
    assert.throws(() => run({ ...f, mode: '--apply', preimagePath }), /outside the vault/);
    assert.equal(fs.existsSync(preimagePath), false);
  }
  fs.writeFileSync(path.join(f.vaultRoot, 'old.md'), original);
  assert.throws(() => run({ ...f, mode: '--restore', restorePath: path.join(f.vaultRoot, 'old.md') }), /outside the vault/);
  assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(original));
});

test('arguments, unsafe paths, missing and existing preimages fail closed', t => {
  const f = fixture(t);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /one mode/);
  assert.throws(() => parseArgs(['--restore']), /Invalid arguments/);
  assert.throws(() => run({ ...f, journalPath: '../outside.md' }));
  assert.throws(() => run({ ...f, mode: '--apply', preimagePath: undefined }), /requires --preimage/);
  fs.writeFileSync(f.preimagePath, 'Keep');
  assert.throws(() => run({ ...f, mode: '--apply' }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(f.preimagePath, 'utf8'), 'Keep');
  assert.deepEqual(fs.readFileSync(f.filePath), Buffer.from(original));
});

test('only standalone marker lines in the exact Ideas section are removed', () => {
  for (const heading of ['## Ideas', '## 💡 Ideas extra', '## 📝 Notes']) {
    assert.equal(removeIdeasOriginMarkers(`${heading}\n${marker}\n`).count, 0);
  }
  assert.deepEqual(removeIdeasOriginMarkers(`## 💡 Ideas\n${marker}`), {
    nextContent: '## 💡 Ideas\n', count: 1, lines: ['## 💡 Ideas\n', marker], removed: new Set([1]),
  });
});

test('Ideas retain supplied provenance in acknowledged receipts and the synthetic ledger', t => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, '## 💡 Ideas\n-\n');
  const service = appService(f);
  const text = 'Retained provenance';
  const contentOrigin = { content_origin: 'human', content_origin_basis: 'verbatim_user', human_evidence_eligible: true,
    source_ref: 'synthetic-capture', user_source: { capture_event_id: 'synthetic-capture', actor: 'user', source_digest: digestText(text), content_digest: digestText(text) } };
  const context = service.createWriteContext({ vaultRelativePath: journalPath, intentId: 'synthetic-idea' });
  const result = context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath: journalPath, sequence: context.sequence, source: context.source,
    operationKind: 'transform', transformName: 'journal-section-line', transformVersion: 2, replayPayload: { heading: '## 💡 Ideas', line: '- ' + text, contentOrigin } });
  assert.equal(result.obsidian, 'acknowledged');
  assert.equal(result.operation.replayPayload.contentOrigin.content_origin, 'human');
  assert.deepEqual(result.operation.replayPayload.contentOrigin, contentOrigin);
  assert.deepEqual(service.adapter.ledger.get(context.operationId).operation.replayPayload.contentOrigin, result.operation.replayPayload.contentOrigin);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), '## 💡 Ideas\n- Retained provenance\n');
});


test('invalid UTF-8 refuses byte-changing cleanup', t => {
  const f = fixture(t);
  const bytes = Buffer.concat([Buffer.from(original), Buffer.from([0xff])]);
  fs.writeFileSync(f.filePath, bytes);
  assert.throws(() => run({ ...f, mode: '--apply' }), /Invalid UTF-8/);
  assert.deepEqual(fs.readFileSync(f.filePath), bytes);
  assert.equal(fs.existsSync(f.preimagePath), false);
});

test('stale app readback never reports success', t => {
  const f = fixture(t);
  const service = appService(f, { readback: 'Stale app readback' });
  assert.throws(() => run({ ...f, mode: '--apply' }, { createService: () => service }), /not acknowledged/);
});
