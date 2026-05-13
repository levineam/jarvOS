#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const repoRoot = process.argv[2];
const hookScript = process.argv[3];

if (!repoRoot || !hookScript) {
  console.error('usage: trust-session-start-hook.js <repo-root> <hook-script>');
  process.exit(1);
}

const appServer = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let completed = false;

function send(message) {
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(code, message) {
  if (completed) return;
  completed = true;
  if (message) {
    const stream = code === 0 ? process.stdout : process.stderr;
    stream.write(`${message}\n`);
  }
  appServer.kill();
  setTimeout(() => process.exit(code), 50);
}

function findJarvosHook(response) {
  const entries = response?.result?.data || [];
  for (const entry of entries) {
    for (const hook of entry.hooks || []) {
      if (hook.command && hook.command.includes(hookScript)) {
        return hook;
      }
    }
  }
  return null;
}

appServer.stderr.on('data', () => {
  // Keep setup output quiet; the script reports a concise failure below.
});

appServer.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.error) {
      finish(1, `app-server error: ${message.error.message || 'unknown error'}`);
      return;
    }

    if (message.id === 1) {
      send({ method: 'initialized', params: {} });
      send({ method: 'hooks/list', id: 2, params: { cwds: [repoRoot] } });
      return;
    }

    if (message.id === 2) {
      const hook = findJarvosHook(message);
      if (!hook) {
        finish(1, 'jarvOS SessionStart hook was not discovered');
        return;
      }
      if (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed') {
        finish(0);
        return;
      }
      send({
        method: 'config/batchWrite',
        id: 3,
        params: {
          edits: [
            {
              keyPath: 'hooks.state',
              value: {
                [hook.key]: {
                  trusted_hash: hook.currentHash,
                },
              },
              mergeStrategy: 'upsert',
            },
          ],
          reloadUserConfig: true,
        },
      });
      return;
    }

    if (message.id === 3) {
      send({ method: 'hooks/list', id: 4, params: { cwds: [repoRoot] } });
      return;
    }

    if (message.id === 4) {
      const hook = findJarvosHook(message);
      if (!hook) {
        finish(1, 'jarvOS SessionStart hook disappeared after trust write');
        return;
      }
      if (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed') {
        finish(0);
        return;
      }
      finish(1, hook.trustStatus);
    }
  }
});

appServer.on('exit', (code) => {
  if (!completed) finish(code || 1, `app-server exited early (${code})`);
});

send({
  method: 'initialize',
  id: 1,
  params: {
    clientInfo: {
      name: 'jarvos_setup',
      title: 'jarvOS Codex setup',
      version: '0.1.0',
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
    },
  },
});

setTimeout(() => finish(1, 'timed out waiting for app-server'), 30000);
