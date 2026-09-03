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
    await waitForServer();
    const index = await request('/');
    assert.equal(index.status, 200);
    assert.match(index.body, /#\/chat/);

    const models = await request('/api/chat/models');
    assert.equal(models.status, 200);
    assert.match(models.body, /openai:gpt-5.5/);

    const settings = await request('/api/settings');
    assert.equal(settings.status, 200);
    assert.doesNotMatch(settings.body, /OPENAI_API_KEY|sk-/);

    const chatAsset = await request('/chat/chat.js');
    assert.equal(chatAsset.status, 200);
    assert.match(chatAsset.headers['content-type'] || '', /javascript|octet-stream/);

    const doctor = await request('/api/system-doctor');
    assert.equal(doctor.status, 200);
    const doctorBody = JSON.parse(doctor.body);
    assert.equal(typeof doctorBody.ok, 'boolean');
    assert.ok(doctorBody.receipt);
    assert.equal(doctorBody.receipt.schema, 'jarvos-system-doctor-report/v1');
    assert.ok(Array.isArray(doctorBody.receipt.components));
    assert.ok(doctorBody.receipt.sections);
    assert.ok(Array.isArray(doctorBody.receipt.sections.memory));

    const servicesPage = await request('/');
    assert.match(servicesPage.body, /app\.js/);
    const appJs = await request('/app.js');
    assert.match(appJs.body, /renderSystemDoctorReceipt/);
    assert.match(appJs.body, /fixed ten-row order/);
  } finally {
    child.kill('SIGTERM');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
