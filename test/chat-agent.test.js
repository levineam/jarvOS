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
const config = require('../server/config');
const selfTools = require('../server/agent/tools/self');
const { createReadTools } = require('../server/agent/tools/read');
const projectsContext = require('../server/adapters/projects-context');
const { requireLoopbackRequest } = require('../server/http-utils');

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

test('whisper exiting 0 without output is surfaced as an error', async () => {
  const whisper = stubWhisper(tempDir(), '#!/bin/sh\nexit 0\n');
  await assert.rejects(
    () => transcribe.transcribe(Readable.from([Buffer.from('audio bytes')]), { whisper }),
    /produced no output/,
  );
});

test('resolveOnPath resolves a bare command name via PATH', () => {
  const dir = tempDir();
  writeExec(dir, 'fake-on-path', '#!/bin/sh\n');
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  try {
    assert.equal(transcribe.resolveOnPath('fake-on-path'), path.join(dir, 'fake-on-path'));
    assert.equal(transcribe.resolveOnPath('definitely-not-a-real-binary-xyz'), null);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('Chat is first nav item and default route', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
  assert(index.indexOf('data-page="chat"') < index.indexOf('data-page="today"'));
  assert.match(app, /return m && pages\[m\[1\]\] \? m\[1\] : 'chat'/);
});

test('async navigation and connection changes discard stale responses', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '..', 'chat-src', 'main.tsx'), 'utf8');
  assert.match(app, /generation !== renderGeneration/);
  assert.match(chat, /let current = true/);
  assert.match(chat, /if \(!current\) return/);
  assert.match(chat, /setModelId\(''\)/);
});

test('API-key agent exposes canonical Projects context without a registry fallback', async () => {
  const originalRead = projectsContext.read;
  const expected = { status: 'unavailable', code: 'PROJECTS_CONTEXT_STALE', reason: 'Provider data is stale' };
  projectsContext.read = async () => expected;
  try {
    const tools = await createReadTools({ vault: {}, memory: {}, ontologyDir: '', paperclip: {} });
    assert.deepEqual(await tools.read_projects_context.execute({}), expected);
  } finally {
    projectsContext.read = originalRead;
  }
});

test('local control routes require a loopback Host and matching Origin', () => {
  assert.doesNotThrow(() => requireLoopbackRequest({ headers: { host: '127.0.0.1:4807', origin: 'http://127.0.0.1:4807' } }));
  assert.doesNotThrow(() => requireLoopbackRequest({ headers: { host: 'localhost:4807' } }));
  assert.throws(() => requireLoopbackRequest({ headers: { host: 'desktop.example' } }), /loopback host required/);
  assert.throws(() => requireLoopbackRequest({ headers: { host: '127.0.0.1:4807', origin: 'https://evil.example' } }), /same-origin request required/);
});

const REPO_ROOT = path.join(__dirname, '..');

test('config derives appRoot at the app root, distinct from jarvosRepo', () => {
  const cfg = config.loadConfig();
  assert.ok(path.isAbsolute(cfg.appRoot));
  assert.ok(fs.existsSync(path.join(cfg.appRoot, 'package.json')));
  assert.notEqual(cfg.appRoot, cfg.jarvosRepo);
});

test('read_app_source reads app files and confines reads to the app root', () => {
  const h = selfTools.__test.makeHandlers({ appRoot: REPO_ROOT });

  const ok = h.readAppSource({ path: 'server/agent/index.js' });
  assert.equal(ok.found, true);
  assert.match(ok.content, /jarvOS Desktop Chat agent/);

  // Path traversal / absolute escape is blocked.
  assert.throws(() => h.readAppSource({ path: '../../.paperclip/auth.json' }), /outside the app root/);
  assert.throws(() => h.readAppSource({ path: 'server/../../etc/hosts' }), /outside the app root/);
  assert.throws(() => h.readAppSource({ path: '/etc/passwd' }), /outside the app root/);

  // Denylisted directories are rejected even though they sit under the root.
  assert.throws(() => h.readAppSource({ path: '.git/config' }), /not permitted/);
  // Shared worktree dependencies may hit the stricter symlink boundary first.
  assert.throws(() => h.readAppSource({ path: 'node_modules/ai/package.json' }), /not permitted|escapes the app root via a symlink/);

  // Extension allowlist: binary assets and extensionless files are rejected.
  assert.throws(() => h.readAppSource({ path: 'static/fonts/plex-sans-400.woff2' }), /file type is not permitted/);

  // Missing-but-allowed path returns found:false rather than throwing.
  assert.equal(h.readAppSource({ path: 'server/does-not-exist.js' }).found, false);
});

test('self-tools reject symlinks that escape the app root', () => {
  const root = tempDir();
  const outside = tempDir();
  // A secret living outside the app root, reachable only via a symlink placed
  // inside it. The lexical path check passes; realpath resolution must not.
  fs.writeFileSync(path.join(outside, 'secret.md'), 'exfiltrate me');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'link.md'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));

  const h = selfTools.__test.makeHandlers({ appRoot: root });
  assert.throws(() => h.readAppSource({ path: 'link.md' }), /symlink/);
  assert.throws(() => h.readAppSource({ path: 'linkdir/secret.md' }), /symlink/);
  // Listing a symlinked directory must not traverse outside the root either.
  const listed = h.listAppSource({ dir: '.', depth: 2 });
  assert.ok(!listed.entries.some((e) => e.name === 'secret.md'));
});

test('list_app_source lists files without contents and prunes node_modules', () => {
  const h = selfTools.__test.makeHandlers({ appRoot: REPO_ROOT });

  const res = h.listAppSource({ dir: 'server/agent/tools' });
  assert.equal(res.found, true);
  const names = res.entries.map((e) => e.name);
  assert.ok(names.includes('self.js'));
  assert.ok(names.includes('read.js'));
  res.entries.forEach((e) => assert.equal('content' in e, false));

  const root = h.listAppSource({ dir: '.', depth: 1 });
  assert.ok(!root.entries.some((e) => e.name === 'node_modules'));
});

test('read_app_source redacts secrets and caps size', () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, 'leak.md'),
    `key sk-ABCDEFGHIJKLMNOPQRSTUVWX and hash ${'a'.repeat(50)}\n`,
  );
  const h = selfTools.__test.makeHandlers({ appRoot: root });

  const res = h.readAppSource({ path: 'leak.md' });
  assert.doesNotMatch(res.content, /sk-ABCDEFGHIJKLMNOPQRSTUVWX/);
  assert.match(res.content, /sk-\[redacted\]/);
  assert.doesNotMatch(res.content, /a{50}/);

  fs.writeFileSync(path.join(root, 'big.js'), '// line\n'.repeat(40000)); // > MAX_BYTES
  const capped = h.readAppSource({ path: 'big.js' });
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.content) <= selfTools.__test.MAX_BYTES);
  assert.match(capped.content, /\/\/ line/);
});

test('read_app_logs tails a present log and reports absence without throwing', () => {
  const root = tempDir();
  const h = selfTools.__test.makeHandlers({ appRoot: root });

  const absent = h.readAppLogs({ name: 'browse' });
  assert.equal(absent.found, false);
  assert.equal(absent.path, '.gstack/browse-network.log');

  fs.mkdirSync(path.join(root, '.gstack'));
  fs.writeFileSync(path.join(root, '.gstack', 'browse-network.log'), 'GET / 200\n');
  const present = h.readAppLogs({ name: 'browse' });
  assert.equal(present.found, true);
  assert.match(present.content, /GET \/ 200/);
});

test('read_app_health returns the service-status array', async () => {
  const tmp = tempDir();
  const cfg = {
    appRoot: REPO_ROOT,
    vault: { journalDir: tmp, notesDir: tmp },
    ontologyDir: tmp,
    memory: { indexFile: path.join(tmp, 'MEMORY.md'), dailyDir: tmp },
    // Unused port -> ping fails fast instead of touching a live Paperclip.
    paperclip: { url: 'http://127.0.0.1:1', companyId: 'x', authFile: path.join(tmp, 'noauth.json') },
    jarvosRepo: tmp,
  };
  const services = await selfTools.__test.makeHandlers(cfg).readAppHealth();
  assert.ok(Array.isArray(services));
  assert.ok(services.some((s) => s.key === 'paperclip'));
});
