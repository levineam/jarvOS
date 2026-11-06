'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { parseArgs, renameJournalHeading, run } = require('../scripts/rename-journal-heading');
const { hashUtf8 } = require('../adapters/obsidian/src/vault-mutation-contract');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry');

const original = '---\r\njournal: Journal\r\n---\r\n\r\n## 📓 Journal Entry \t\r\n- Invented reflection  \r\n\r\n## Other\n- Keep Journal Entry in body\n';
const renamed = original.replace('## 📓 Journal Entry', '## 📓 Journal');
const journalPath = 'Journal/2030-02-03.md';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heading-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  const journalDir = path.join(vaultRoot, 'Journal');
  const preimagePath = path.join(root, 'preimage.json');
  const filePath = path.join(vaultRoot, journalPath);
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(filePath, original);
  return { root, vaultRoot, journalDir, preimagePath, filePath };
}
function settled(value) {
  return { then(fn) { try { fn(value); } catch (error) { this.error = error; } return this; }, catch(fn) { if (this.error) fn(this.error); return this; } };
}
function appService(f, beforeProcess = () => {}) {
  const vault = {
    getFileByPath: target => fs.existsSync(path.join(f.vaultRoot, target)) ? { path: target } : null,
    process(file, transform) {
      beforeProcess();
      const target = path.join(f.vaultRoot, file.path);
      fs.writeFileSync(target, transform(fs.readFileSync(target, 'utf8')));
      return settled(file);
    },
    read: file => settled(fs.readFileSync(path.join(f.vaultRoot, file.path), 'utf8')),
  };
  const context = vm.createContext({ app: { vault }, TextDecoder, Uint8Array, atob, btoa, unescape });
  return createConfiguredVaultMutationService({
    vaultRoot: f.vaultRoot, vaultId: 'synthetic-heading-vault', source: 'journal.rename-journal-heading',
    adapterOptions: { ledgerPath: path.join(f.root, 'state/ledger.json'), probe: () => ({ state: 'available', vaultId: 'synthetic-heading-vault' }), evaluate: code => {
      const result = vm.runInContext(code, context);
      return typeof result === 'string' ? JSON.parse(result) : result;
    }, maxPollAttempts: 2 },
  });
}

test('dry run lists exact heading lines and totals, scans only dated files, and never opens a service', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.journalDir, '2030-02-04.md'), '## 📓 Journal\n- Canonical sample\n');
  fs.writeFileSync(path.join(f.journalDir, '2030-02-05.md'), '## 📓 Journal\n- Canonical sample\n## Journal Entry\n- Old sample\n');
  fs.writeFileSync(path.join(f.journalDir, '2030-02-06.md'), '## 📝 Notes\n- Other sample\n');
  fs.writeFileSync(path.join(f.journalDir, 'Other.md'), original);
  fs.mkdirSync(path.join(f.journalDir, '2030-02-07.md'));
  const result = run(parseArgs(['--vault', f.vaultRoot, '--journal', f.journalDir]), { createService() { assert.fail('dry run must not open ledger'); } });
  assert.equal(result.count, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.canonical, 1);
  assert.ok(result.output.includes(`${journalPath}:5: ${JSON.stringify('## 📓 Journal Entry \t\r\n')} -> ${JSON.stringify('## 📓 Journal \t\r\n')}`));
  assert.match(result.output, /canonical and legacy headings coexist/);
  assert.match(result.output, /Files to change: 1; skipped: 2; already canonical: 1/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), original);
  assert.equal(fs.existsSync(f.preimagePath), false);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../scripts/rename-journal-heading.js'), '--vault', f.vaultRoot, '--journal', f.journalDir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, result.output);
});

test('apply backs up all preimages before the first guarded write, preserves bytes, is idempotent, and restores', t => {
  const f = fixture(t);
  const second = path.join(f.journalDir, '2030-02-04.md');
  fs.writeFileSync(second, '## 📋 Journal Entry\n- Another invented reflection');
  let service;
  const createService = () => {
    service ||= appService(f, () => {
      const bundle = JSON.parse(fs.readFileSync(f.preimagePath));
      assert.equal(bundle.files.length, 2);
      assert.equal(bundle.files[0].content, original);
      assert.equal(bundle.files[0].hash, hashUtf8(original));
      assert.equal(bundle.files[0].writtenHash, hashUtf8(renamed));
    });
    return service;
  };
  const result = run({ ...f, mode: '--apply' }, { createService });
  assert.equal(result.changed, 2);
  assert.equal(fs.statSync(f.preimagePath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), renamed);
  assert.equal(fs.readFileSync(second, 'utf8'), '## 📓 Journal\n- Another invented reflection');
  const backup = fs.readFileSync(f.preimagePath, 'utf8');
  assert.equal(run({ ...f, mode: '--apply' }, { createService() { assert.fail('no-op must not open ledger'); } }).changed, 0);
  assert.equal(fs.readFileSync(f.preimagePath, 'utf8'), backup);
  assert.equal(run({ ...f, mode: '--restore' }, { createService }).changed, 2);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), original);
  assert.equal(fs.readFileSync(second, 'utf8'), '## 📋 Journal Entry\n- Another invented reflection');
});

test('restore skips edited files and restores unaffected files', t => {
  const f = fixture(t);
  const second = path.join(f.journalDir, '2030-02-04.md');
  fs.writeFileSync(second, '## Journal Entry\n- Other sample\n');
  const service = appService(f);
  run({ ...f, mode: '--apply' }, { createService: () => service });
  fs.appendFileSync(f.filePath, '- Later invented edit\n');
  const result = run({ ...f, mode: '--restore' }, { createService: () => service });
  assert.equal(result.changed, 1);
  assert.equal(result.skipped, 1);
  assert.match(result.output, /changed since rename; restore refused/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), renamed + '- Later invented edit\n');
  assert.equal(fs.readFileSync(second, 'utf8'), '## Journal Entry\n- Other sample\n');
});

test('preimage locations, bundle hashes, daily paths and CLI arguments fail closed', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(f.vaultRoot, alias);
  for (const preimagePath of [path.join(f.vaultRoot, 'backup.json'), path.join(alias, 'backup.json')]) {
    for (const mode of ['--apply', '--restore']) assert.throws(() => run({ ...f, mode, preimagePath }), /outside the vault/);
    assert.equal(fs.existsSync(preimagePath), false);
  }
  assert.throws(() => run({ ...f, mode: '--apply', preimagePath: undefined }), /requires --preimage/);
  fs.writeFileSync(f.preimagePath, 'Keep existing backup');
  assert.throws(() => run({ ...f, mode: '--apply' }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(f.preimagePath, 'utf8'), 'Keep existing backup');
  assert.throws(() => parseArgs(['--apply', '--restore']), /one mode/);
  assert.throws(() => parseArgs(['--preimage']), /Invalid arguments/);
  assert.throws(() => parseArgs(['--vault', 'one', '--vault', 'two']), /Duplicate argument/);
  assert.deepEqual(parseArgs(['--restore', '--preimage', 'saved.json']), { mode: '--restore', preimagePath: 'saved.json' });
  fs.unlinkSync(f.preimagePath);
  run({ ...f, mode: '--apply' }, { createService: () => appService(f) });
  const bundle = JSON.parse(fs.readFileSync(f.preimagePath));
  bundle.files[0].hash = 'wrong';
  fs.writeFileSync(f.preimagePath, JSON.stringify(bundle));
  assert.throws(() => run({ ...f, mode: '--restore' }), /Invalid preimage content/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), renamed);
});

test('concurrent edits are preserved both before submission and inside the app', t => {
  for (const duringProcess of [false, true]) {
    const f = fixture(t);
    const createService = () => {
      if (!duringProcess) fs.writeFileSync(f.filePath, 'Invented concurrent edit');
      return appService(f, () => fs.writeFileSync(f.filePath, 'Invented concurrent edit'));
    };
    if (duringProcess) assert.throws(() => run({ ...f, mode: '--apply' }, { createService }), /not acknowledged/);
    else assert.equal(run({ ...f, mode: '--apply' }, { createService }).skipped, 1);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), 'Invented concurrent edit');
    assert.equal(JSON.parse(fs.readFileSync(f.preimagePath)).files[0].content, original);
  }
});

test('only exact headings change, all legacy forms retain whitespace and line endings, ambiguous sections skip', () => {
  for (const heading of ['## 📓 Journal Entry', '## Journal Entry', '## 📋 Journal Entry']) {
    for (const suffix of ['\n', '\r\n', ' \t\r\n', '']) assert.equal(renameJournalHeading(heading + suffix).nextContent, '## 📓 Journal' + suffix);
  }
  for (const heading of ['### 📓 Journal Entry', ' ## 📓 Journal Entry', '## 📓 Journal Entry extra', '- ## 📓 Journal Entry']) assert.equal(renameJournalHeading(heading).nextContent, heading);
  for (const source of ['## 📓 Journal\n## Journal Entry\n', '## Journal Entry\n## 📋 Journal Entry\n']) {
    assert.equal(renameJournalHeading(source).status, 'skipped');
    assert.equal(renameJournalHeading(source).nextContent, source);
  }
});

test('old and new ledger payloads replay into either heading through Node and app evaluators, v1 and v2', t => {
  const registry = createJarvosVaultTransforms();
  for (const transformVersion of [1, 2]) {
    for (const heading of ['## 📓 Journal Entry', '## Journal Entry', '## 📋 Journal Entry', '## 📓 Journal']) {
      for (const existing of ['## 📓 Journal Entry', '## Journal Entry', '## 📋 Journal Entry', '## 📓 Journal', null, 'both']) {
        const f = fixture(t);
        const source = existing === 'both' ? '## Journal Entry\n- Legacy sample\n\n## 📓 Journal\n- Canonical sample\n' : existing ? `${existing} \t\n- Earlier sample\n` : '## 📝 Notes\n- Other sample\n';
        fs.writeFileSync(f.filePath, source);
        const operation = { transformName: 'journal-section-line', transformVersion, replayPayload: { heading, line: '- Invented replay', ...(transformVersion === 2 ? { contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' } } : {}) } };
        const expected = registry.applyNode(source, operation);
        assert.equal(registry.isSatisfied(expected, operation), true);
        assert.equal(registry.applyNode(expected, operation), expected);
        assert.equal((expected.match(/^## (?:📓 Journal(?: Entry)?|Journal Entry|📋 Journal Entry)[ \t]*$/gm) || []).length, existing === 'both' ? 2 : 1);
        if (existing === 'both') assert.equal(expected.slice(0, expected.indexOf('## 📓 Journal')), source.slice(0, source.indexOf('## 📓 Journal')));
        const service = appService(f);
        const context = service.createWriteContext({ vaultRelativePath: journalPath, intentId: 'synthetic-replay' });
        const receipt = context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath: journalPath, sequence: context.sequence, source: context.source, operationKind: 'transform', ...operation });
        assert.equal(receipt.obsidian, 'acknowledged');
        assert.equal(fs.readFileSync(f.filePath, 'utf8'), expected);
        assert.equal(context.mutationExecutor(receipt.operation).obsidian, 'acknowledged');
      }
    }
  }
});

test('restore reports a missing file and continues restoring other daily files', t => {
  const f = fixture(t);
  const second = path.join(f.journalDir, '2030-02-04.md');
  fs.writeFileSync(second, '## Journal Entry\n- Other sample\n');
  const service = appService(f);
  run({ ...f, mode: '--apply' }, { createService: () => service });
  fs.unlinkSync(f.filePath);
  const result = run({ ...f, mode: '--restore' }, { createService: () => service });
  assert.equal(result.changed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(fs.readFileSync(second, 'utf8'), '## Journal Entry\n- Other sample\n');
});

test('migration leaves heading examples inside frontmatter and fenced code byte-identical', () => {
  const example = '---\n## Journal Entry\n---\n\n```markdown\n## 📓 Journal\n## Journal Entry\n```\n~~~\n## 📋 Journal Entry\n~~~\n\n';
  const source = example + '## 📓 Journal Entry\n- Invented reflection\n';
  assert.equal(renameJournalHeading(source).nextContent, example + '## 📓 Journal\n- Invented reflection\n');
  assert.equal(renameJournalHeading(example).nextContent, example);
});

test('CLI uses the configured journal directory when path flags are omitted', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/rename-journal-heading.js')], {
    encoding: 'utf8', env: { ...process.env, JARVOS_VAULT_DIR: f.vaultRoot, JARVOS_JOURNAL_DIR: f.journalDir, JARVOS_TIMEZONE: 'UTC' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Files to change: 1/);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), original);
});

test('apply, restore, then apply again works with a fresh backup; each run has its own id', t => {
  const f = fixture(t);
  let service;
  const createService = () => (service ||= appService(f));
  assert.equal(run({ ...f, mode: '--apply' }, { createService }).changed, 1);
  const firstRun = JSON.parse(fs.readFileSync(f.preimagePath, 'utf8')).runId;
  assert.equal(run({ ...f, mode: '--restore' }, { createService }).changed, 1);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), original);
  const secondPreimage = path.join(f.root, 'preimage-2.json');
  assert.equal(run({ ...f, preimagePath: secondPreimage, mode: '--apply' }, { createService }).changed, 1);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), renamed);
  const secondRun = JSON.parse(fs.readFileSync(secondPreimage, 'utf8')).runId;
  assert.ok(firstRun && secondRun && firstRun !== secondRun);
  assert.equal(run({ ...f, preimagePath: secondPreimage, mode: '--restore' }, { createService }).changed, 1);
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), original);
});
