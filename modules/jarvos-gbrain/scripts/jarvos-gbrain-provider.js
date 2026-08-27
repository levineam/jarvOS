#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { prepareManagedGbrainProvider } = require('../src/index.js');

const DESCRIPTOR_ENV = 'JARVOS_GBRAIN_RUNTIME_DESCRIPTOR';

function fail(failureClass) {
  process.stderr.write(`jarvos-gbrain-provider: ${failureClass}\n`);
  process.exitCode = 1;
}

function main() {
  const prepared = prepareManagedGbrainProvider(process.env[DESCRIPTOR_ENV]);
  if (!prepared.ok) {
    fail(prepared.failureClass || 'provider-preflight-failed');
    return;
  }

  // This is a provenance-enforcing launcher, not an MCP proxy. GBrain owns
  // tool discovery, Skillify resolution, request handling, and stdio framing.
  const child = spawn(prepared.command, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.on('error', () => fail('provider-spawn-failed'));
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
}

main();
