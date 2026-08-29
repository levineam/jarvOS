'use strict';

// This helper owns the process group used by a synchronous capability probe.
// Keeping the CLI's stdio inside this process prevents a timed-out descendant
// that inherited its parent's pipes from holding the caller open.
const { spawn } = require('node:child_process');

const MAX_CAPTURE_BYTES = 64 * 1024;
const request = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
const timeoutMs = Math.max(1, Number(request.timeoutMs) || 10_000);

function capture(stream) {
  let value = '';
  stream?.on('data', (chunk) => {
    if (Buffer.byteLength(value) >= MAX_CAPTURE_BYTES) return;
    value += String(chunk).slice(0, MAX_CAPTURE_BYTES - Buffer.byteLength(value));
  });
  return () => value;
}

function finish(value) {
  process.stdout.write(JSON.stringify(value));
}

let child;
try {
  child = spawn(request.command, request.args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
} catch (error) {
  finish({ ok: false, code: error.code, message: error.message });
  return;
}

const stdout = capture(child.stdout);
const stderr = capture(child.stderr);
let timedOut = false;
let settled = false;

function terminateOwnedTree() {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    // /t targets the child process tree by PID; it is not a process-name kill.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 100).unref();
}

const timer = setTimeout(() => {
  timedOut = true;
  terminateOwnedTree();
}, timeoutMs);

child.on('error', (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  finish({ ok: false, code: error.code, message: error.message, stdout: stdout(), stderr: stderr() });
});

child.on('close', (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (timedOut) {
    finish({ ok: false, code: 'ETIMEDOUT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms`, stdout: stdout(), stderr: stderr() });
    return;
  }
  if (code === 0) return finish({ ok: true, stdout: stdout(), stderr: stderr() });
  finish({ ok: false, code: code == null ? signal : code, message: stderr() || stdout() || `Obsidian CLI exited with ${code == null ? signal : code}`, stdout: stdout(), stderr: stderr() });
});
