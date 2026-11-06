'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWriteTools } = require('../server/agent/tools/write');

function fakeCapture(t, { ok = true, code = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-capture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/jarvos.js'), `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(path.join(root, 'received.json'))}, JSON.stringify({ args: process.argv.slice(2), input, env: { node: process.env.ELECTRON_RUN_AS_NODE, vault: process.env.JARVOS_VAULT_DIR, journal: process.env.JARVOS_JOURNAL_DIR, notes: process.env.JARVOS_NOTES_DIR } }));
  console.log(JSON.stringify({ ok: ${ok}, message: ${JSON.stringify(ok ? 'Saved an invented thought.' : 'Not confirmed yet: check the invented journal.')} }));
  process.exitCode = ${code};
});
`);
  return root;
}

const input = { date: '2030-02-03', section: 'Ideas', bullet: 'An invented café garden thought.', words: 'assistant', asked: 'accepted_offer' };

test('agent sends Ideas and Journal through the configured CLI and reports its one-line receipt', async t => {
  const root = fakeCapture(t);
  const vault = { root: path.join(root, 'selected-vault'), journalDir: path.join(root, 'selected-journal'), notesDir: path.join(root, 'selected-notes') };
  const tool = (await createWriteTools({ jarvosRepo: root, vault })).append_journal;
  for (const [section, kind] of [['Ideas', 'idea'], ['Journal', 'journal']]) {
    assert.deepEqual(await tool.execute({ ...input, section }), { ok: true, message: 'Saved an invented thought.' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'received.json'), 'utf8')), {
      args: ['capture', '--kind', kind, '--date', input.date, '--words', input.words, '--asked', input.asked, '--source', 'jarvos-desktop', '--json'],
      input: input.bullet,
      env: { node: '1', vault: vault.root, journal: vault.journalDir, notes: vault.notesDir },
    });
  }
});

test('unconfigured capture is unavailable even when a journal directory exists', async t => {
  const root = fakeCapture(t);
  const tool = (await createWriteTools({ vault: { journalDir: root } })).append_journal;
  const result = await tool.execute(input);
  assert.equal(result.available, false);
  assert.match(result.reason, /unavailable.*jarvosRepo is not configured/);
  assert.equal(fs.existsSync(path.join(root, `${input.date}.md`)), false);
  assert.equal(fs.existsSync(path.join(root, 'received.json')), false);
});

test('agent refuses other sections, missing provenance and consent before any dispatch', async t => {
  const root = fakeCapture(t);
  const tool = (await createWriteTools({ jarvosRepo: root })).append_journal;
  for (const section of ['Agent Notes', 'Notes', '../escape', 'Journal Entry']) {
    assert.equal(tool.inputSchema.safeParse({ ...input, section }).success, false);
    await assert.rejects(tool.execute({ ...input, section }), /only Ideas or Journal/);
  }
  for (const field of ['words', 'asked']) {
    const missing = { ...input };
    delete missing[field];
    assert.equal(tool.inputSchema.safeParse(missing).success, false);
    await assert.rejects(tool.execute(missing), /words must|asked must/);
  }
  assert.equal(fs.existsSync(path.join(root, 'received.json')), false);
});

test('capture failures preserve the receipt and never report success or fall back to raw writes', async t => {
  const root = fakeCapture(t, { ok: false, code: 3 });
  const tool = (await createWriteTools({ jarvosRepo: root, vault: { journalDir: path.join(root, 'journal') } })).append_journal;
  assert.deepEqual(await tool.execute(input), { ok: false, message: 'Not confirmed yet: check the invented journal.' });
  fs.unlinkSync(path.join(root, 'scripts/jarvos.js'));
  await assert.rejects(tool.execute(input), /outcome uncertain/);
  assert.equal(fs.existsSync(path.join(root, `${input.date}.md`)), false);
});

test('an installed Desktop adapter calls capture without importing repo modules', async t => {
  const root = fakeCapture(t);
  const installed = path.join(root, 'installed-desktop');
  fs.mkdirSync(installed);
  fs.copyFileSync(path.join(__dirname, '../server/adapters/capture.js'), path.join(installed, 'capture.js'));
  const { appendJournal } = require(path.join(installed, 'capture.js'));
  assert.equal((await appendJournal({ jarvosRepo: root, vault: { journalDir: path.join(root, 'journal') } }, input)).ok, true);
});

test('capture is unavailable without a configured journal folder, so it never saves to a default location', async t => {
  const root = fakeCapture(t);
  const tool = (await createWriteTools({ jarvosRepo: root })).append_journal;
  const result = await tool.execute(input);
  assert.equal(result.available, false);
  assert.match(result.reason, /journal folder is not configured/);
  assert.equal(fs.existsSync(path.join(root, 'received.json')), false);
});
