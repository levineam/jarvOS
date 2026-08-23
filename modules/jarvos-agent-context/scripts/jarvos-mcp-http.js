#!/usr/bin/env node
'use strict';

/**
 * Authenticated Streamable HTTP gateway in front of jarvos-mcp.js.
 * Runs on the VAULT HOST. Grok Bot clients send URL + bearer token only.
 * Stdio MCP on the Grok Bot disk hydrates the wrong machine.
 *
 * Transport: MCP Streamable HTTP. Responses return in the POST body.
 * Each initialize issues a Mcp-Session-Id and a dedicated stdio child so
 * clients do not share one MCP session or JSON-RPC id space.
 */

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');

const TOKEN_ENV = 'JARVOS_MCP_HTTP_TOKEN';
const TOKEN_FILE_ENV = 'JARVOS_MCP_HTTP_TOKEN_FILE';
const HOST_ENV = 'JARVOS_MCP_HTTP_HOST';
const PORT_ENV = 'JARVOS_MCP_HTTP_PORT';
const ALLOW_NON_LOOPBACK_ENV = 'JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MCP_PATH = '/mcp';
const TOMBSTONE_TTL_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function failClosed(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function trustedTokenFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    const real = fs.realpathSync(filePath);
    const stat = fs.statSync(real);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isFile() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
    const text = fs.readFileSync(real, 'utf8').trim();
    return text.length >= 16 ? text : null;
  } catch {
    return null;
  }
}

function resolveToken(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, TOKEN_FILE_ENV)
    && env[TOKEN_FILE_ENV]
    && String(env[TOKEN_FILE_ENV]).length > 0) {
    const fromFile = trustedTokenFile(String(env[TOKEN_FILE_ENV]));
    if (!fromFile) failClosed('JARVOS_MCP_HTTP_TOKEN_FILE is set but is not a trusted owner-only token file');
    return fromFile;
  }
  const ambient = env[TOKEN_ENV];
  if (typeof ambient === 'string' && ambient.trim().length >= 16) return ambient.trim();
  return null;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function safeEqual(expected, provided) {
  const left = Buffer.from(String(expected || ''), 'utf8');
  const right = Buffer.from(String(provided || ''), 'utf8');
  const pad = Math.max(left.length, right.length, 1);
  const a = Buffer.concat([left, Buffer.alloc(pad - left.length)]);
  const b = Buffer.concat([right, Buffer.alloc(pad - right.length)]);
  return left.length === right.length && timingSafeEqual(a, b);
}

function extractBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = String(header).match(/^Bearer\s+(\S+)/i);
  if (match) return match[1];
  const alt = req.headers['x-jarvos-mcp-token'];
  return typeof alt === 'string' ? alt : '';
}

function childEnvFrom(env = process.env) {
  const next = { ...env };
  delete next[TOKEN_ENV];
  delete next[TOKEN_FILE_ENV];
  return next;
}

function startStdioBridge(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const serverPath = options.serverPath || path.join(__dirname, 'jarvos-mcp.js');
  const args = options.args || [serverPath];
  const restart = options.restart !== false;
  const backoffMs = options.backoffMs ?? 250;
  const maxRestarts = options.maxRestarts ?? 8;
  const tombstoneTtlMs = options.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;

  let child = null;
  let buffer = '';
  let alive = false;
  let restarts = 0;
  let lastExitCode = null;
  let disposed = false;
  let restartTimer = null;
  const waiters = new Map();
  const tombstones = new Map();
  const sseClients = new Set();

  function pruneTombstones(now = Date.now()) {
    for (const [id, expires] of tombstones) {
      if (expires <= now) tombstones.delete(id);
    }
  }

  function rejectWaiters(error) {
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  }

  function handleChildMessage(message) {
    pruneTombstones();
    const hasId = message && message.id != null;
    if (hasId) {
      const id = String(message.id);
      const waiter = waiters.get(id);
      if (waiter) {
        waiters.delete(id);
        waiter.resolve(message);
        return;
      }
      if (tombstones.has(id)) {
        tombstones.delete(id);
        return;
      }
      return;
    }
    for (const client of sseClients) {
      client.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }
  }

  function attachChild(next) {
    child = next;
    buffer = '';
    alive = true;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        handleChildMessage(message);
      }
    });
    if (child.stdin) {
      child.stdin.on('error', (error) => {
        process.stderr.write(`jarvos-mcp stdin: ${error.message}\n`);
      });
    }
    child.on('exit', (code) => {
      lastExitCode = code;
      alive = false;
      const error = new Error(`jarvos-mcp.js exited with code ${code}`);
      rejectWaiters(error);
      for (const client of sseClients) client.end();
      sseClients.clear();
      if (disposed || !restart || restarts >= maxRestarts) return;
      restarts += 1;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (disposed) return;
        spawnChild();
      }, backoffMs * restarts);
    });
  }

  function spawnChild() {
    const next = spawnImpl(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: childEnvFrom(options.env || process.env),
    });
    attachChild(next);
    return next;
  }

  spawnChild();

  return {
    get child() { return child; },
    sseClients,
    get alive() { return alive; },
    health() {
      return {
        alive,
        pid: child && child.pid ? child.pid : null,
        restarts,
        lastExitCode,
      };
    },
    dispose() {
      disposed = true;
      if (restartTimer) clearTimeout(restartTimer);
      rejectWaiters(new Error('bridge disposed'));
      if (child && !child.killed) child.kill();
      for (const client of sseClients) client.end();
      sseClients.clear();
    },
    send(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (!alive || !child || !child.stdin || child.stdin.destroyed) {
        return Promise.reject(new Error('MCP child is not alive'));
      }
      if (message && message.id == null) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return Promise.resolve(null);
      }
      const id = String(message.id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          tombstones.set(id, Date.now() + tombstoneTtlMs);
          reject(new Error(`MCP request ${id} timed out`));
        }, timeoutMs);
        waiters.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch (error) {
          clearTimeout(timer);
          waiters.delete(id);
          reject(error);
        }
      });
    },
  };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function isJsonRpcObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createServer({ token, host, port, bridge, createBridge, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const sessions = new Map();
  const factory = createBridge || (bridge ? () => bridge : () => startStdioBridge());

  function sessionHeader(req) {
    return req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'] || null;
  }

  function resolveSession(req, message) {
    const existing = sessionHeader(req);
    if (existing) {
      const found = sessions.get(String(existing));
      if (!found) return { errorStatus: 404, error: { error: 'unknown session' } };
      return { id: String(existing), bridge: found, created: false };
    }
    if (message && message.method === 'initialize') {
      const id = randomUUID();
      const next = factory();
      sessions.set(id, next);
      return { id, bridge: next, created: true };
    }
    return { errorStatus: 400, error: { error: 'missing mcp-session-id' } };
  }

  function healthPayload() {
    const list = [...sessions.values()].map((item) => (typeof item.health === 'function'
      ? item.health()
      : { alive: true }));
    const childAlive = list.filter((item) => item.alive !== false).length;
    const childDead = list.length - childAlive;
    return {
      ok: childDead === 0,
      bind: `${host}:${port}`,
      transport: 'streamable-http',
      sessions: list.length,
      childAlive,
      childDead,
      restarts: list.reduce((sum, item) => sum + (item.restarts || 0), 0),
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/health') {
      const payload = healthPayload();
      res.writeHead(payload.ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (!safeEqual(token, extractBearer(req))) {
      unauthorized(res);
      return;
    }

    if (req.method === 'DELETE') {
      const id = sessionHeader(req);
      const found = id ? sessions.get(String(id)) : null;
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown session' }));
        return;
      }
      if (typeof found.dispose === 'function') found.dispose();
      sessions.delete(String(id));
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const resolved = resolveSession(req, { method: 'notifications/sse' });
      if (resolved.errorStatus) {
        res.writeHead(resolved.errorStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(resolved.error));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'mcp-session-id': resolved.id,
      });
      res.write(`: connected\n\n`);
      resolved.bridge.sseClients.add(res);
      req.on('close', () => resolved.bridge.sseClients.delete(res));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST, DELETE', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    let message;
    try {
      const body = await readBody(req);
      message = JSON.parse(body);
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: error.message || 'parse error' } }));
      return;
    }

    if (!isJsonRpcObject(message)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } }));
      return;
    }

    const resolved = resolveSession(req, message);
    if (resolved.errorStatus) {
      res.writeHead(resolved.errorStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resolved.error));
      return;
    }

    try {
      const result = await resolved.bridge.send(message, requestTimeoutMs);
      if (result == null) {
        res.writeHead(202, { 'mcp-session-id': resolved.id });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': resolved.id,
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(504, {
        'content-type': 'application/json',
        'mcp-session-id': resolved.id,
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32000, message: error.message } }));
    }
  });
  server.sessions = sessions;
  server.healthPayload = healthPayload;
  return server;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function main(env = process.env) {
  const token = resolveToken(env);
  if (!token) failClosed('refusing to start: set JARVOS_MCP_HTTP_TOKEN or JARVOS_MCP_HTTP_TOKEN_FILE (fail-closed auth)');
  const host = env[HOST_ENV] || DEFAULT_HOST;
  const port = Number(env[PORT_ENV] || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) failClosed('JARVOS_MCP_HTTP_PORT must be a valid port');
  if (!isLoopbackHost(host) && env[ALLOW_NON_LOOPBACK_ENV] !== '1') {
    failClosed('refusing non-loopback bind; set JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK=1 to override');
  }

  const bridges = [];
  const server = createServer({
    token,
    host,
    port,
    createBridge: () => {
      const next = startStdioBridge({ env });
      bridges.push(next);
      return next;
    },
  });
  await listen(server, host, port);
  process.stderr.write(`jarvos MCP Streamable HTTP listening on http://${host}:${port}${MCP_PATH}\n`);
  if (!isLoopbackHost(host)) {
    process.stderr.write('WARNING: non-loopback bind carries the bearer token in cleartext HTTP unless a TLS terminator sits in front.\n');
  }
  const shutdown = () => {
    server.close();
    for (const item of bridges) item.dispose();
  };
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  return { server, bridges };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  ALLOW_NON_LOOPBACK_ENV,
  resolveToken,
  safeEqual,
  extractBearer,
  isLoopbackHost,
  createServer,
  startStdioBridge,
  main,
};
