'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('portable server shows unavailable sources and refuses another listener', { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, '{}');
  const env = { ...process.env, PORT: String(port), JARVOS_DESKTOP_CONFIG: config };
  delete env.JARVOS_DESKTOP_PROJECTS_CONTEXT_MODULE;
  const server = path.resolve(__dirname, '../server/index.js');
  const first = spawn(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null) first.kill(); });
  let output = '';
  await new Promise((resolve, reject) => {
    first.stdout.on('data', (chunk) => { output += chunk; if (output.includes('serving on')) resolve(); });
    first.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    first.once('error', reject);
  });
  for (const endpoint of ['/api/journal', '/api/notes', '/api/work', '/api/ontology', '/api/memory']) {
    const result = await fetch(`http://127.0.0.1:${port}${endpoint}`);
    assert.equal(result.status, 503, endpoint);
    assert.match((await result.json()).error, /not configured/);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const second = spawn(process.execPath, [server], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (second.exitCode === null) second.kill(); });
  let error = '';
  second.stderr.on('data', (chunk) => { error += chunk; });
  const [code] = await once(second, 'exit');
  assert.equal(code, 1);
  assert.match(error, /already in use/);
  first.kill();
  await once(first, 'exit');
});
