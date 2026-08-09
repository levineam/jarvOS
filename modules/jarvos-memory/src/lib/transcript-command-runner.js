'use strict';

const { spawn, spawnSync } = require('child_process');

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function defaultMinimalEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTH/i.test(key)) continue;
    if (typeof value === 'string' && value.length <= 1024) env[key] = value;
  }
  return env;
}

function defaultRunner(command, args, options = {}) {
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const spawnOptions = {
    cwd: options.cwd || process.cwd(),
    env: defaultMinimalEnv(options.env),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: maxOutputBytes,
  };
  if (options.input !== undefined) spawnOptions.input = options.input;
  if (options.timeoutMs > 0) {
    spawnOptions.timeout = options.timeoutMs;
    spawnOptions.killSignal = 'SIGKILL';
  }
  const result = spawnSync(command, args, spawnOptions);
  const stdout = result.stdout == null ? '' : String(result.stdout);
  const outputTooLarge = Buffer.byteLength(stdout, 'utf8') > maxOutputBytes
    || (result.error && /ENOBUFS|buffer/i.test(String(result.error.message || result.error)));
  const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT');
  return {
    ok: result.status === 0 && !timedOut && !outputTooLarge,
    status: result.status,
    signal: result.signal || null,
    timedOut,
    outputTooLarge,
    stdout: outputTooLarge ? '' : stdout,
    stderr: '',
    error: result.error ? String(result.error.code || result.error.message || result.error) : null,
  };
}

function defaultAsyncRunner(command, args, options = {}) {
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: defaultMinimalEnv(options.env),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      resolve({ ok: false, status: null, signal: null, timedOut: false, outputTooLarge: false, stdout: '', stderr: '', error: String(error.code || error.message || error) });
      return;
    }

    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let outputBytes = 0;
    const chunks = [];
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: result.status === 0 && !timedOut && !outputTooLarge && !result.error,
        status: result.status,
        signal: result.signal || null,
        timedOut,
        outputTooLarge,
        stdout: outputTooLarge ? '' : Buffer.concat(chunks).toString('utf8'),
        stderr: '',
        error: result.error ? String(result.error.code || result.error.message || result.error) : null,
      });
    };

    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += buffer.length;
      if (outputBytes <= maxOutputBytes) {
        chunks.push(buffer);
        return;
      }
      outputTooLarge = true;
      try { child.kill('SIGKILL'); } catch (_) { /* close/error settles the result */ }
    });
    child.on('error', (error) => finish({ status: null, signal: null, error }));
    child.on('close', (status, signal) => finish({ status, signal, error: null }));
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_) { /* close/error settles the result */ }
      }, options.timeoutMs);
    }
    child.stdin.on('error', (error) => finish({ status: null, signal: null, error }));
    try {
      child.stdin.end(options.input === undefined ? '' : options.input);
    } catch (error) {
      finish({ status: null, signal: null, error });
    }
  });
}

module.exports = { defaultAsyncRunner, defaultMinimalEnv, defaultRunner };
