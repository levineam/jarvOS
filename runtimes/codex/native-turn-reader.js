'use strict';
const { spawn } = require('node:child_process');
const { trustedExecutable } = require('../../modules/jarvos-runtime-kit/src/trusted-native-command');

const MAX_BYTES = 256 * 1024;
const MAX_PAGES = 8;
const TIMEOUT_MS = 2500;

// Only stored item reads: never start/resume a thread, execute a hook or call a model.
function readNativeTurn({ sessionId, turnId, command, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (!trustedExecutable(command)) { reject(new Error('native-reader-unavailable')); return; }
    const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
      env: { ...env, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = ''; let bytes = 0; let pages = 0; let settled = false;
    const items = []; const cursors = new Set(); let startedAt;
    const timer = setTimeout(() => finish(new Error('native-reader-timeout')), TIMEOUT_MS);
    function finish(error) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error); else resolve({ items, startedAt });
    }
    function send(method, params, id) {
      child.stdin.write(`${JSON.stringify({ method, params, ...(id ? { id } : {}) })}\n`);
    }
    function page(cursor) {
      if (++pages > MAX_PAGES) { finish(new Error('native-reader-page-limit')); return; }
      send('thread/items/list', { threadId: sessionId, turnId, sortDirection: 'asc', limit: 25, ...(cursor ? { cursor } : {}) }, 2);
    }
    child.stdin.on('error', () => finish(new Error('native-reader-unavailable')));
    child.on('error', () => finish(new Error('native-reader-unavailable')));
    child.on('exit', () => { if (!settled) finish(new Error('native-reader-exited')); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) { finish(new Error('native-reader-byte-limit')); return; }
      buffer += chunk.toString('utf8');
      let index;
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error('native-reader-invalid')); return; }
        if (message.error) { finish(new Error('native-reader-unsupported')); return; }
        if (message.id === 1) {
          send('initialized', {});
          send('thread/turns/list', { threadId: sessionId, sortDirection: 'desc', itemsView: 'notLoaded', limit: 1 }, 3);
        } else if (message.id === 3) {
          const turns = message.result?.data;
          if (!Array.isArray(turns) || turns.length !== 1 || turns[0].id !== turnId || !Number.isFinite(turns[0].startedAt)) {
            finish(new Error('native-reader-turn-identity')); return;
          }
          // Identity comes from PreCompact, never this stored status or latest-turn inference.
          startedAt = turns[0].startedAt;
          page();
        }
        else if (message.id === 2) {
          const result = message.result;
          if (!Array.isArray(result?.data) || result.data.length > 25 || result.data.some((entry) => entry.turnId !== turnId || !entry.item || typeof entry.item.id !== 'string')) {
            finish(new Error('native-reader-identity')); return;
          }
          items.push(...result.data);
          if (result.nextCursor == null) finish();
          else if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) finish(new Error('native-reader-invalid-cursor'));
          else { cursors.add(result.nextCursor); page(result.nextCursor); }
        }
      }
    });
    send('initialize', { clientInfo: { name: 'jarvos_assignment_context', version: '1' }, capabilities: { experimentalApi: true } }, 1);
  });
}

module.exports = { readNativeTurn, MAX_BYTES, MAX_PAGES, TIMEOUT_MS };
