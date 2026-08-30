'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const MAX_CAPTURE_BYTES = 64 * 1024;
const TASKKILL_TIMEOUT_MS = 250;

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

function terminateOwnedTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  schedule = setTimeout,
  signalProcess = process.kill,
  onComplete = () => {},
  taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
} = {}) {
  if (!child?.pid) { onComplete({ contained: false, reason: 'missing_child_pid' }); return; }
  let completed = false;
  const complete = (result) => { if (!completed) { completed = true; onComplete(result); } };
  const stopKnownChild = () => {
    try { child.kill?.('SIGKILL'); } catch {}
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy?.(); } catch {}
    }
  };
  const failContainment = (reason) => { stopKnownChild(); complete({ contained: false, reason }); };
  if (platform === 'win32') {
    // /t targets the child process tree by PID; it is not a process-name kill.
    const taskkillArgs = ['/pid', String(child.pid), '/t', '/f'];
    const runTaskkill = (attempt) => {
      let killer;
      let watchdog;
      let attemptSettled = false;
      const clearWatchdog = () => { if (watchdog) { try { clearTimeout(watchdog); } catch {} watchdog = undefined; } };
      const stopKiller = () => { try { killer?.kill?.('SIGKILL'); } catch {} };
      const settleAttempt = () => { if (attemptSettled) return false; attemptSettled = true; clearWatchdog(); return true; };
      try { killer = spawnProcess('taskkill', taskkillArgs, { stdio: 'ignore', windowsHide: true }); } catch { failContainment('taskkill_spawn_failed'); return; }
      if (!killer || typeof killer.once !== 'function') { failContainment('taskkill_unavailable'); return; }
      watchdog = schedule(() => { if (!settleAttempt()) return; stopKiller(); failContainment('taskkill_timeout'); }, Math.max(1, Number(taskkillTimeoutMs) || TASKKILL_TIMEOUT_MS));
      watchdog?.unref?.();
      killer.once('error', () => { if (!settleAttempt()) return; failContainment('taskkill_failed'); });
      killer.once('close', (code) => {
        if (!settleAttempt()) return;
        if (code === 0) complete({ contained: true });
        else if (attempt === 0) runTaskkill(1);
        else failContainment('taskkill_failed');
      });
    };
    runTaskkill(0);
    return;
  }
  // The dedicated group is the containment boundary.  A direct SIGKILL avoids
  // graceful handlers and the fork window they can open; success means only
  // that the owned process group accepted the signal, not that arbitrary
  // processes which detached before the timeout were in that group.
  try {
    signalProcess(-child.pid, 'SIGKILL');
    complete({ contained: true });
  }
  catch (error) {
    failContainment(error?.code === 'ESRCH' ? 'process_group_absent' : 'process_group_kill_failed');
  }
}

function runProbe(request, {
  spawnProcess = spawn,
  platform = process.platform,
  output = process.stdout,
  schedule = setTimeout,
  taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
} = {}) {
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
  const finishTimeout = (containment) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (containment.contained) return finish({ ok: false, code: 'ETIMEDOUT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms`, stdout: stdout.value(), stderr: stderr.value() });
    finish({ ok: false, code: 'ECONTAINMENT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms and dedicated process-group containment could not be confirmed (${containment.reason || 'unknown'})`, stdout: stdout.value(), stderr: stderr.value() });
  };
  const timer = schedule(() => {
    timedOut = true;
    terminateOwnedTree(child, { platform, spawnProcess, schedule, taskkillTimeoutMs, onComplete: finishTimeout });
  }, timeoutMs);
  child.on('error', (error) => {
    if (settled) return;
    if (timedOut) return;
    settled = true;
    clearTimeout(timer);
    finish({ ok: false, code: error.code, message: error.message, stdout: stdout.value(), stderr: stderr.value() });
  });
  child.on('close', (code, signal) => {
    if (settled) return;
    // A timeout has begun group containment.  The direct child may close
    // after the group signal; the timeout callback owns final classification.
    if (timedOut) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) return finish({ ok: true, stdout: stdout.value(), stderr: stderr.value() });
    finish({ ok: false, code: code == null ? signal : code, message: stderr.value() || stdout.value() || `Obsidian CLI exited with ${code == null ? signal : code}`, stdout: stdout.value(), stderr: stderr.value() });
  });
}

if (require.main === module) {
  // The legacy base64url argument remains accepted for direct invocations.
  // The adapter uses stdin so large CLI programs are not copied into a second
  // oversized argument merely to reach this worker.
  const encoded = process.argv[2];
  const request = encoded
    ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    : JSON.parse(fs.readFileSync(0, 'utf8'));
  runProbe(request);
}

module.exports = { MAX_CAPTURE_BYTES, createOutputCapture, runProbe, terminateOwnedTree };
