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

function terminateOwnedTree(child, { platform = process.platform, spawnProcess = spawn, schedule = setTimeout, signalProcess = process.kill, onComplete = () => {} } = {}) {
  if (!child?.pid) { onComplete({ contained: false, reason: 'missing_child_pid' }); return; }
  let completed = false;
  const complete = (result) => { if (!completed) { completed = true; onComplete(result); } };
  if (platform === 'win32') {
    // /t targets the child process tree by PID; it is not a process-name kill.
    const taskkillArgs = ['/pid', String(child.pid), '/t', '/f'];
    const runTaskkill = (attempt) => {
      let killer;
      try { killer = spawnProcess('taskkill', taskkillArgs, { stdio: 'ignore', windowsHide: true }); } catch { complete({ contained: false, reason: 'taskkill_spawn_failed' }); return; }
      if (!killer || typeof killer.once !== 'function') { complete({ contained: false, reason: 'taskkill_unavailable' }); return; }
      killer.once('error', () => complete({ contained: false, reason: 'taskkill_failed' }));
      killer.once('close', (code) => {
        if (code === 0) complete({ contained: true });
        else if (attempt === 0) runTaskkill(1);
        else complete({ contained: false, reason: 'taskkill_failed' });
      });
    };
    runTaskkill(0);
    return;
  }
  try { signalProcess(-child.pid, 'SIGTERM'); }
  catch (error) { complete({ contained: false, reason: error?.code === 'ESRCH' ? 'process_group_absent' : 'process_group_unavailable' }); return; }
  // Keep the worker alive through escalation even if the direct child exits
  // after SIGTERM and leaves no inherited pipes open.
  schedule(() => {
    try { signalProcess(-child.pid, 'SIGKILL'); complete({ contained: true }); }
    catch (error) { complete({ contained: false, reason: error?.code === 'ESRCH' ? 'process_group_absent' : 'process_group_kill_failed' }); }
  }, 100);
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
  const finishTimeout = (containment) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (containment.contained) return finish({ ok: false, code: 'ETIMEDOUT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms`, stdout: stdout.value(), stderr: stderr.value() });
    finish({ ok: false, code: 'ECONTAINMENT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms and owned process-tree containment could not be confirmed (${containment.reason || 'unknown'})`, stdout: stdout.value(), stderr: stderr.value() });
  };
  const timer = schedule(() => {
    timedOut = true;
    terminateOwnedTree(child, { platform, spawnProcess, schedule, onComplete: finishTimeout });
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
    // A timeout has begun owned-tree containment.  The direct child may close
    // before same-group descendants receive the SIGKILL escalation.
    if (timedOut) return;
    settled = true;
    clearTimeout(timer);
    if (code === 0) return finish({ ok: true, stdout: stdout.value(), stderr: stderr.value() });
    finish({ ok: false, code: code == null ? signal : code, message: stderr.value() || stdout.value() || `Obsidian CLI exited with ${code == null ? signal : code}`, stdout: stdout.value(), stderr: stderr.value() });
  });
}

if (require.main === module) {
  const request = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
  runProbe(request);
}

module.exports = { MAX_CAPTURE_BYTES, createOutputCapture, runProbe, terminateOwnedTree };
