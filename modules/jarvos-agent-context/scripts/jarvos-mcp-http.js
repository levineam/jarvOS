#!/usr/bin/env node
'use strict';

/**
 * Authenticated HTTP/SSE gateway in front of jarvos-mcp.js.
 * Runs on the VAULT HOST. Grok Bot clients send URL + bearer token only.
 * Stdio MCP on the Grok Bot disk hydrates the wrong machine.
 */

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

function startStdioBridge() {
  const serverPath = path.join(__dirname, 'jarvos-mcp.js');
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });
  let buffer = '';
  const waiters = new Map();
  const sseClients = new Set();

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
      const waiter = message && message.id != null ? waiters.get(String(message.id)) : null;
      if (waiter) {
        waiters.delete(String(message.id));
        waiter.resolve(message);
      } else {
        for (const client of sseClients) client.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      }
    }
  });

  child.on('exit', (code) => {
    const error = new Error(`jarvos-mcp.js exited with code ${code}`);
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
    for (const client of sseClients) client.end();
    sseClients.clear();
  });

  return {
    child,
    sseClients,
    send(message, timeoutMs = 15000) {
      if (message && message.id == null) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return Promise.resolve(null);
      }
      const id = String(message.id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
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
        child.stdin.write(`${JSON.stringify(message)}\n`);
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

function createServer({ token, host, port, bridge }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, bind: `${host}:${port}` }));
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

    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: endpoint\ndata: ${MCP_PATH}\n\n`);
      bridge.sseClients.add(res);
      req.on('close', () => bridge.sseClients.delete(res));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json' });
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

    try {
      const result = await bridge.send(message);
      if (result == null) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32000, message: error.message } }));
    }
  });
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

  const bridge = startStdioBridge();
  const server = createServer({ token, host, port, bridge });
  await listen(server, host, port);
  process.stderr.write(`jarvos MCP HTTP/SSE listening on http://${host}:${port}${MCP_PATH}\n`);
  const shutdown = () => {
    server.close();
    if (bridge.child && !bridge.child.killed) bridge.child.kill();
  };
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  return { server, bridge };
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
  resolveToken,
  safeEqual,
  extractBearer,
  isLoopbackHost,
  createServer,
  startStdioBridge,
  main,
};
