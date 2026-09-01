'use strict';

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');

const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const PROBE_CLEANUP_GRACE_MS = 1_000;
const MAX_PROBE_TIMEOUT_MS = 2_147_483_647 - PROBE_CLEANUP_GRACE_MS;
const PROCESS_SCAN_INTERVAL_MS = 25;
const PROCESS_SNAPSHOT_TIMEOUT_MS = 50;
const MAX_PROCESS_SNAPSHOT_CALLS = 512;
const TASKKILL_TIMEOUT_MS = 250;
const TRUNCATION_SEPARATOR = Buffer.from('\n[... output truncated ...]\n', 'utf8');

function normalizeProbeTimeoutMs(value, fallback = DEFAULT_PROBE_TIMEOUT_MS) {
  if (value === undefined || value === null) return fallback;
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric > MAX_PROBE_TIMEOUT_MS) throw new RangeError(`timeoutMs must be a finite number between 1 and ${MAX_PROBE_TIMEOUT_MS}`);
  return Math.max(1, Math.floor(numeric));
}

function readProcessSnapshot() {
  return execFileSync('ps', ['-axo', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: PROCESS_SNAPSHOT_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function descendantPids(rootPid, snapshot) {
  const children = new Map();
  for (const line of String(snapshot || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const result = new Set();
  const pending = [Number(rootPid)];
  while (pending.length) {
    const parent = pending.shift();
    for (const pid of children.get(parent) || []) {
      if (result.has(pid)) continue;
      result.add(pid);
      pending.push(pid);
    }
  }
  return result;
}

function collectDescendantPids(rootPid, {
  platform = process.platform,
  snapshotProcesses = readProcessSnapshot,
} = {}) {
  if (platform === 'win32') return { pids: new Set(), available: true };
  try { return { pids: descendantPids(rootPid, snapshotProcesses()), available: true }; } catch { return { pids: new Set(), available: false }; }
}

function createOutputCapture(stream, limit = MAX_CAPTURE_BYTES) {
  const boundedLimit = Math.max(0, Number(limit) || 0);
  const separatorLength = TRUNCATION_SEPARATOR.length <= boundedLimit ? TRUNCATION_SEPARATOR.length : 0;
  const payloadLimit = boundedLimit - separatorLength;
  const headLimit = Math.ceil(payloadLimit / 2);
  const tailLimit = payloadLimit - headLimit;
  const headChunks = [];
  let headByteLength = 0;
  let tail = Buffer.alloc(0);
  let truncated = false;
  const appendTail = (buffer) => {
    if (!tailLimit || !buffer.length) return;
    if (buffer.length > tailLimit || tail.length + buffer.length > tailLimit) truncated = true;
    const retained = buffer.length > tailLimit ? buffer.subarray(buffer.length - tailLimit) : buffer;
    const combined = Buffer.concat([tail, retained]);
    tail = combined.length > tailLimit
      ? Buffer.from(combined.subarray(combined.length - tailLimit))
      : combined;
  };
  stream?.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    let offset = 0;
    if (headByteLength < headLimit) {
      const retainedLength = Math.min(buffer.length, headLimit - headByteLength);
      if (retainedLength < buffer.length) truncated = true;
      headChunks.push(Buffer.from(buffer.subarray(0, retainedLength)));
      headByteLength += retainedLength;
      offset = retainedLength;
    }
    // Obsidian writes the eval result as a terminal `=> ...` line. Keep a
    // bounded tail as well as the leading diagnostics so verbose output does
    // not hide a valid result and make a healthy CLI look incompatible.
    if (offset < buffer.length) appendTail(buffer.subarray(offset));
  });
  return Object.freeze({
    bytes: () => headByteLength + tail.length + (truncated ? separatorLength : 0),
    value: () => {
      const separator = truncated ? TRUNCATION_SEPARATOR.subarray(0, separatorLength) : Buffer.alloc(0);
      return Buffer.concat([...headChunks, separator, tail], headByteLength + tail.length + separator.length).toString('utf8');
    },
  });
}

function terminateOwnedTree(child, {
  platform = process.platform,
  spawnProcess = spawn,
  schedule = setTimeout,
  signalProcess = process.kill,
  onComplete = () => {},
  taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
  ownedPids = new Set(),
  ownershipScanFailed = false,
} = {}) {
  if (!child?.pid) { onComplete({ contained: false, reason: 'missing_child_pid' }); return; }
  let completed = false;
  const complete = (result) => { if (!completed) { completed = true; onComplete(result); } };
  const closeKnownStreams = () => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream?.destroy?.(); } catch {}
    }
  };
  const stopKnownChild = () => {
    try { child.kill?.('SIGKILL'); } catch {}
    closeKnownStreams();
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
        if (code === 0) { closeKnownStreams(); complete({ contained: true }); }
        else if (attempt === 0) runTaskkill(1);
        else failContainment('taskkill_failed');
      });
    };
    runTaskkill(0);
    return;
  }
  // The dedicated group is the primary containment boundary. A process can
  // deliberately call setsid/detach and escape that group, so the worker also
  // kills the exact descendant PIDs observed while the probe was alive. This
  // is still an owned-process boundary, unlike a process-name kill.
  let groupError;
  try {
    signalProcess(-child.pid, 'SIGKILL');
  }
  catch (error) {
    groupError = error;
  }
  for (const pid of ownedPids) {
    if (!pid || pid === child.pid || pid === process.pid) continue;
    try { signalProcess(pid, 'SIGKILL'); }
    catch (error) {
      if (error?.code !== 'ESRCH') {
        failContainment('owned_process_kill_failed');
        return;
      }
    }
  }
  if (ownershipScanFailed) {
    failContainment('descendant_scan_failed');
    return;
  }
  if (!groupError || (groupError.code === 'ESRCH' && ownedPids.size)) {
    stopKnownChild();
    complete({ contained: true });
  }
  else failContainment(groupError.code === 'ESRCH' ? 'process_group_absent' : 'process_group_kill_failed');
}

function runProbe(request, {
  spawnProcess = spawn,
  platform = process.platform,
  output = process.stdout,
  schedule = setTimeout,
  taskkillTimeoutMs = TASKKILL_TIMEOUT_MS,
  snapshotProcesses = readProcessSnapshot,
} = {}) {
  const timeoutMs = normalizeProbeTimeoutMs(request.timeoutMs);
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
  const ownedPids = new Set();
  let timedOut = false;
  let settled = false;
  let ownershipTimer;
  let ownershipScanFailed = false;
  let ownershipScanCalls = 0;
  const clearOwnershipTimer = () => { if (ownershipTimer) { try { clearTimeout(ownershipTimer); } catch {} ownershipTimer = undefined; } };
  const scanOwnedPids = () => {
    if (platform === 'win32') return;
    if (ownershipScanCalls >= MAX_PROCESS_SNAPSHOT_CALLS) {
      ownershipScanFailed = true;
      return;
    }
    ownershipScanCalls += 1;
    const scan = collectDescendantPids(child.pid, { platform, snapshotProcesses });
    if (!scan.available) {
      ownershipScanFailed = true;
      return;
    }
    for (const pid of scan.pids) ownedPids.add(pid);
  };
  const refreshOwnedPids = () => {
    if (settled || timedOut || platform === 'win32') return;
    scanOwnedPids();
    if (!settled && !timedOut && !ownershipScanFailed) {
      ownershipTimer = schedule(refreshOwnedPids, PROCESS_SCAN_INTERVAL_MS);
      ownershipTimer?.unref?.();
    }
  };
  const finishTimeout = (containment) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearOwnershipTimer();
    if (containment.contained) return finish({ ok: false, code: 'ETIMEDOUT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms`, stdout: stdout.value(), stderr: stderr.value() });
    finish({ ok: false, code: 'ECONTAINMENT', message: `Obsidian CLI probe timed out after ${timeoutMs}ms and dedicated process-group containment could not be confirmed (${containment.reason || 'unknown'})`, stdout: stdout.value(), stderr: stderr.value() });
  };
  const timer = schedule(() => {
    timedOut = true;
    // Take one final bounded snapshot while the direct child is still the
    // ownership root. PIDs observed here or in earlier snapshots are the only
    // exact descendants eligible for POSIX cleanup.
    scanOwnedPids();
    terminateOwnedTree(child, { platform, spawnProcess, schedule, taskkillTimeoutMs, ownedPids, ownershipScanFailed, onComplete: finishTimeout });
  }, timeoutMs);
  ownershipTimer = schedule(refreshOwnedPids, 0);
  ownershipTimer?.unref?.();
  child.on('error', (error) => {
    if (settled) return;
    if (timedOut) return;
    settled = true;
    clearTimeout(timer);
    clearOwnershipTimer();
    finish({ ok: false, code: error.code, message: error.message, stdout: stdout.value(), stderr: stderr.value() });
  });
  child.on('close', (code, signal) => {
    if (settled) return;
    // A timeout has begun group containment.  The direct child may close
    // after the group signal; the timeout callback owns final classification.
    if (timedOut) return;
    settled = true;
    clearTimeout(timer);
    clearOwnershipTimer();
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

module.exports = { MAX_CAPTURE_BYTES, PROBE_CLEANUP_GRACE_MS, createOutputCapture, normalizeProbeTimeoutMs, runProbe, terminateOwnedTree };
