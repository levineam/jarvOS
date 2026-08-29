'use strict';

const { spawn } = require('node:child_process');

const MAX_CAPTURE_BYTES = 64 * 1024;

function createOutputCapture(stream, limit = MAX_CAPTURE_BYTES) {
  const chunks = [];
  let byteLength = 0;
  stream?.on('data', (chunk) => {
    if (byteLength >= limit) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const retained = buffer.subarray(0, Math.min(buffer.length, limit - byteLength));
    chunks.push(retained);
    byteLength += retained.length;
  });
  return Object.freeze({ bytes: () => byteLength, value: () => Buffer.concat(chunks, byteLength).toString('utf8') });
}

function terminateOwnedTree(child, { platform = process.platform, spawnProcess = spawn, schedule = setTimeout } = {}) {
  if (!child?.pid) return;
  const killDirect = () => { try { child.kill('SIGKILL'); } catch {} };
  if (platform === 'win32') {
    // /t targets the child process tree by PID; it is not a process-name kill.
    let killer;
    try { killer = spawnProcess('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { killDirect(); return; }
    if (!killer || typeof killer.once !== 'function') { killDirect(); return; }
    let fellBack = false;
    const fallback = () => { if (!fellBack) { fellBack = true; killDirect(); } };
    killer.once('error', fallback);
    killer.once('close', (code) => { if (code !== 0) fallback(); });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  schedule(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { killDirect(); } }, 100).unref?.();
}

function runProbe(request, { spawnProcess = spawn, platform = process.platform, output = process.stdout, schedule = setTimeout } = {}) {
  const timeoutMs = Math.max(1, Number(request.timeoutMs) || 10_000);
  const finish = (value) => output.write(JSON.stringify(value));
  let child;
  try {
    child = spawnProcess(request.command, request.args, { detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    finish({ ok: false, code: error.code, message: error.message });
    return;
  }
  const stdout = createOutputCapture(child.stdout);
  const stderr = createOutputCapture(child.stderr);
  let timedOut = false;
  let settled = false;
  const timer = schedule(() => { timedOut = true; terminateOwnedTree(child, { platform, spawnProcess, schedule }); }, timeoutMs);
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish({ ok: false, code: error.code, message: error.message, stdout: stdout.value(), stderr: stderr.value() });
  });
  child.on('close', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut) return finish({ ok: false, code: 'ETIMEDOUT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms`, stdout: stdout.value(), stderr: stderr.value() });
    if (code === 0) return finish({ ok: true, stdout: stdout.value(), stderr: stderr.value() });
    finish({ ok: false, code: code == null ? signal : code, message: stderr.value() || stdout.value() || `Obsidian CLI exited with ${code == null ? signal : code}`, stdout: stdout.value(), stderr: stderr.value() });
  });
}

if (require.main === module) {
  const request = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
  runProbe(request);
}

module.exports = { MAX_CAPTURE_BYTES, createOutputCapture, runProbe, terminateOwnedTree };
