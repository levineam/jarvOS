#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKERS = 12;

function fail(label, err) {
  console.error(`  ✗ ${label}: ${err.message || err}`);
  process.exit(1);
}

function runWorker(storeDir, workerId) {
  const script = `
    const path = require('path');
    const agentify = require(path.join(process.env.JARVOS_TEST_ROOT, 'modules/jarvos-agentify/src/index.js'));
    const log = agentify.createActivityLog({ storeDir: process.env.JARVOS_TEST_STORE_DIR });
    const result = log.write('concurrent', 'system.checkpoint', {
      status: 'ok',
      worker: process.env.JARVOS_TEST_WORKER_ID
    }, { source: 'agentify-concurrent-write-test' });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        JARVOS_TEST_ROOT: ROOT,
        JARVOS_TEST_STORE_DIR: storeDir,
        JARVOS_TEST_WORKER_ID: String(workerId),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `worker ${workerId} exited ${code}`));
    });
  });
}

(async () => {
  console.log('\n→ @jarvos/agentify (concurrent write lock)');

  const agentify = require(path.join(ROOT, 'modules/jarvos-agentify/src/index.js'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-agentify-concurrent-'));

  try {
    const staleTenantDir = path.join(tmpDir, 'activity-log', 'concurrent');
    fs.mkdirSync(staleTenantDir, { recursive: true });
    const staleLockPath = path.join(staleTenantDir, '.activity.lock');
    fs.writeFileSync(staleLockPath, JSON.stringify({ pid: 0 }), 'utf8');
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(staleLockPath, staleTime, staleTime);

    await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker(tmpDir, i + 1)));

    const log = agentify.createActivityLog({ storeDir: tmpDir });
    const { events, error } = log.read('concurrent', { after: 0, limit: WORKERS + 1 });
    if (error) fail('read concurrent events', new Error(error));
    if (events.length !== WORKERS) {
      fail('concurrent write count', new Error(`expected ${WORKERS}, got ${events.length}`));
    }

    const seqs = events.map(event => event.seq).sort((a, b) => a - b);
    const expected = Array.from({ length: WORKERS }, (_, i) => i + 1);
    if (JSON.stringify(seqs) !== JSON.stringify(expected)) {
      fail('concurrent seq uniqueness', new Error(`got ${JSON.stringify(seqs)}`));
    }

    console.log(`  ✓ ${WORKERS} concurrent writers produced seq 1..${WORKERS} without duplicates`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(err => fail('concurrent write lock', err));
