'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

const port = process.env.PORT || '4817';
const base = `http://127.0.0.1:${port}`;

function request(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

async function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('spawned server did not claim the smoke port')), 10_000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      callback(value);
    };
    const onData = (chunk) => {
      output = `${output}${chunk}`.slice(-4_000);
      if (output.includes(`serving on http://127.0.0.1:${port}`)) finish(resolve);
      else if (output.includes('reusing it')) finish(reject, new Error('smoke port is owned by another server'));
    };
    const onExit = (code, signal) => finish(reject, new Error(`spawned server exited before ready (${code ?? signal})`));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await request('/api/chat/models');
      if (res.status === 200) return;
    } catch {
      /* keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server did not start');
}

(async () => {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForChild(child);
    await waitForServer();
    const index = await request('/');
    assert.equal(index.status, 200);
    assert.match(index.body, /#\/chat/);

    const models = await request('/api/chat/models');
    assert.equal(models.status, 200);
    assert.match(models.body, /gpt-6-astra|gpt-5\.6|gpt-5\.5/);

    const apiModels = await request('/api/chat/models?connection=api-key');
    assert.equal(apiModels.status, 200);
    assert.match(apiModels.body, /openai:gpt-5.5/);

    const settings = await request('/api/settings');
    assert.equal(settings.status, 200);
    assert.doesNotMatch(settings.body, /OPENAI_API_KEY|sk-/);
    assert.match(settings.body, /chatgpt-subscription/);

    const projects = await request('/api/projects');
    assert.equal(projects.status, 200);
    assert.match(projects.body, /"status":"(?:ok|unavailable)"/);

    const chatAsset = await request('/chat/chat.js');
    assert.equal(chatAsset.status, 200);
    assert.match(chatAsset.headers['content-type'] || '', /javascript|octet-stream/);
  } finally {
    child.kill('SIGTERM');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
