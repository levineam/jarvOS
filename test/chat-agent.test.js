'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const notes = require('../server/adapters/notes');
const journal = require('../server/adapters/journal');
const paperclip = require('../server/adapters/paperclip');
const credentials = require('../server/agent/credentials');
const providers = require('../server/agent/providers');
const transcribe = require('../server/agent/transcribe');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-chat-test-'));
}

test('note creation is additive and blocks path traversal', () => {
  const dir = tempDir();
  const created = notes.create(dir, 'Meeting Notes', '# Meeting\n');
  assert.equal(created.title, 'Meeting Notes');
  assert.equal(fs.readFileSync(path.join(dir, 'Meeting Notes.md'), 'utf8'), '# Meeting\n');
  assert.throws(() => notes.create(dir, '../escape', 'bad'), /path separators/);
  assert.throws(() => notes.create(dir, 'Meeting Notes', 'again'), /already exists/);
});

test('note reads block path traversal', () => {
  const root = tempDir();
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir);
  fs.mkdirSync(journalDir);
  fs.writeFileSync(path.join(notesDir, 'Project.md'), '# Project\n');
  fs.writeFileSync(path.join(journalDir, '2026-06-29.md'), '# private journal\n');

  assert.equal(notes.read(notesDir, 'Project').title, 'Project');
  assert.throws(() => notes.read(notesDir, '../Journal/2026-06-29'), /path separators/);
});

test('journal append only adds bullets and preserves existing content', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, '2026-06-29.md'), '---\ndate: 2026-06-29\n---\n\n## Existing\n- keep me\n');
  journal.appendBullet(dir, '2026-06-29', 'Existing', 'new item');
  const raw = fs.readFileSync(path.join(dir, '2026-06-29.md'), 'utf8');
  assert.match(raw, /- keep me/);
  assert.match(raw, /## Existing\n- new item\n- keep me|## Existing\n- keep me\n- new item/);
});

test('Paperclip writes use company create route and issue update route', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'issue-id', identifier: 'SUP-1', title: 'Created' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const authFile = path.join(tempDir(), 'auth.json');
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(authFile, JSON.stringify({ credentials: { [url]: { token: 'redacted-test-token' } } }));
  const cfg = { url, companyId: 'company-id', authFile };

  await paperclip.createIssue(cfg, { title: 'New issue', status: 'todo' });
  await paperclip.updateIssue(cfg, 'SUP-1', { status: 'done' });
  server.close();

  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, '/api/companies/company-id/issues');
  assert.deepEqual(calls[0].body, { title: 'New issue', status: 'todo' });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, '/api/issues/SUP-1');
  assert.deepEqual(calls[1].body, { status: 'done' });
  assert.equal(calls[0].auth, 'Bearer redacted-test-token');
});

test('credential status never exposes the key and encrypted storage round-trips', () => {
  const dir = tempDir();
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  credentials.setElectronRuntime({
    userDataPath: dir,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`),
      decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
    },
  });
  credentials.saveOpenAIKey('sk-test-secret-value');
  const resolved = credentials.resolveOpenAIKey();
  assert.equal(resolved.key, 'sk-test-secret-value');
  assert.deepEqual(credentials.status(), {
    hasKey: true,
    source: 'keychain',
    canStoreKey: true,
    encryptionAvailable: true,
  });
  assert.doesNotMatch(JSON.stringify(credentials.status()), /sk-test-secret-value/);
  credentials.setElectronRuntime(null);
  if (previous) process.env.OPENAI_API_KEY = previous;
});

test('provider model and reasoning effort mapping are bounded', () => {
  assert.equal(providers.parseModelId('openai:gpt-5.5').model, 'gpt-5.5');
  assert.equal(providers.normalizeReasoningEffort('high'), 'high');
  assert.equal(providers.normalizeReasoningEffort('extreme'), 'medium');
  assert.deepEqual(providers.buildProviderOptions({ reasoningEffort: 'low' }), {
    openai: { reasoningEffort: 'low' },
  });
  assert.throws(() => providers.parseModelId('openai:gpt-4o'), /unknown model/);
});

function writeExec(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}
// Stubs stand in for ffmpeg/whisper-cli so the pipeline is testable without them.
const FAKE_FFMPEG = '#!/bin/sh\nfor a; do out="$a"; done\nprintf wav > "$out"\n';
const FAKE_WHISPER_OK = '#!/bin/sh\nof=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-of" ] && of="$2"; shift; done\nprintf "hello world" > "$of.txt"\n';
const FAKE_WHISPER_FAIL = '#!/bin/sh\necho boom >&2\nexit 2\n';

function stubWhisper(dir, whisperBody) {
  const model = path.join(dir, 'model.bin');
  fs.writeFileSync(model, 'm');
  return {
    binary: writeExec(dir, 'fake-whisper', whisperBody),
    ffmpeg: writeExec(dir, 'fake-ffmpeg', FAKE_FFMPEG),
    model,
    timeoutMs: 5_000,
  };
}

test('voice unavailable when binary/model/ffmpeg missing', async () => {
  const whisper = { binary: '', model: '', ffmpeg: '/nope/ffmpeg' };
  assert.equal(transcribe.voiceStatus({ whisper }).available, false);
  const result = await transcribe.transcribe(Readable.from([Buffer.from('x')]), { whisper });
  assert.equal(result.available, false);
  assert.match(result.reason, /not configured or missing/);
});

test('transcription runs ffmpeg then whisper and returns the .txt text', async () => {
  const whisper = stubWhisper(tempDir(), FAKE_WHISPER_OK);
  assert.equal(transcribe.voiceStatus({ whisper }).available, true);
  const result = await transcribe.transcribe(Readable.from([Buffer.from('audio bytes')]), { whisper });
  assert.equal(result.available, true);
  assert.equal(result.text, 'hello world');
});

test('empty audio upload is rejected', async () => {
  const whisper = stubWhisper(tempDir(), FAKE_WHISPER_OK);
  await assert.rejects(() => transcribe.transcribe(Readable.from([]), { whisper }), /audio body required/);
});

test('failed transcription surfaces the error and removes temp audio', async () => {
  const root = tempDir();
  const targetDir = path.join(root, 'jarvos-voice-fixed');
  const whisper = stubWhisper(root, FAKE_WHISPER_FAIL);

  const originalMkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = (prefix) => {
    assert.match(prefix, /jarvos-voice-/);
    fs.mkdirSync(targetDir);
    return targetDir;
  };
  try {
    await assert.rejects(
      () => transcribe.transcribe(Readable.from([Buffer.from('audio bytes')]), { whisper }),
      /boom|exited 2/,
    );
    assert.equal(fs.existsSync(targetDir), false);
  } finally {
    fs.mkdtempSync = originalMkdtemp;
  }
});

test('Chat is first nav item and default route', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
  assert(index.indexOf('data-page="chat"') < index.indexOf('data-page="today"'));
  assert.match(app, /return m && pages\[m\[1\]\] \? m\[1\] : 'chat'/);
});
