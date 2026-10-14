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
 *
 * createServer({ readOnly: true }) is opt-in and only enabled by the Muse
 * launcher (runtimes/muse/gateway.js). The default forwards everything.
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
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_SESSION_IDLE_MS = 15 * 60_000;
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([DEFAULT_PROTOCOL_VERSION]);

// Read-only mode (opt-in, used only by runtimes/muse/gateway.js). These rules
// are the gateway-owned closed schemas; the child's inputSchema is never
// trusted. Every property here is validated before anything reaches the child.
const MAX_CHARS_ARG = { type: 'integer', minimum: 1, maximum: 20000 };
const QUERY_ARG = { type: 'string', minLength: 1, maxLength: 2000 };
const UTC_INSTANT_ARG = { type: 'string', maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$' };
const READ_ONLY_TOOLS = Object.freeze({
  jarvos_hydrate: { properties: { maxChars: MAX_CHARS_ARG } },
  jarvos_projects_context: {
    properties: {
      profile: { type: 'string', enum: ['orientation', 'recent-activity'] },
      date: { type: 'string', maxLength: 10, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      timeZone: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9_+/-]+$' },
      from: UTC_INSTANT_ARG,
      to: UTC_INSTANT_ARG,
    },
  },
  jarvos_recall: {
    required: ['query'],
    properties: { query: QUERY_ARG, includeQmd: { type: 'boolean' }, autoGraph: { type: 'boolean' } },
  },
  jarvos_startup_brief: { properties: { query: QUERY_ARG, maxChars: MAX_CHARS_ARG } },
});
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_CLIENT_INFO = /^[\x20-\x7e]{1,128}$/;

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

function isTrustedOrigin(origin, host, port) {
  if (origin == null || origin === '') return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const trustedHost = url.hostname === host
      || (isLoopbackHost(host) && isLoopbackHost(url.hostname));
    if (!trustedHost) return false;
    if (port == null) return true;
    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return Number(originPort) === Number(port);
  } catch {
    return false;
  }
}

function hasSafeHostHeader(hostHeader) {
  if (hostHeader == null || hostHeader === '') return true;
  try {
    const url = new URL(`http://${hostHeader}`);
    return Boolean(url.hostname);
  } catch {
    return false;
  }
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
  let inactiveChild = null;
  const bridgeId = randomUUID();
  let outboundRequestSequence = 0;
  const waiters = new Map();
  const tombstones = new Map();
  const tombstoneTimers = new Map();
  const sseClients = new Set();
  let onSseActivity = null;

  function pruneTombstones(now = Date.now()) {
    for (const [id, expires] of tombstones) {
      if (expires <= now) removeTombstone(id);
    }
  }

  function removeTombstone(id) {
    tombstones.delete(id);
    const timer = tombstoneTimers.get(id);
    if (timer) clearTimeout(timer);
    tombstoneTimers.delete(id);
  }

  function addTombstone(id) {
    removeTombstone(id);
    tombstones.set(id, Date.now() + tombstoneTtlMs);
    const timer = setTimeout(() => removeTombstone(id), tombstoneTtlMs);
    timer.unref?.();
    tombstoneTimers.set(id, timer);
  }

  function rejectWaiters(error) {
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  }

  function closeSseClients() {
    for (const client of sseClients) {
      if (typeof client.end === 'function') client.end();
    }
    sseClients.clear();
  }

  function writeSse(message) {
    const clients = [...sseClients];
    for (let index = clients.length - 1; index >= 0; index -= 1) {
      const client = clients[index];
      if (client.destroyed || client.writableEnded || typeof client.write !== 'function') {
        sseClients.delete(client);
        continue;
      }
      const accepted = client.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      if (accepted === false) {
        sseClients.delete(client);
        if (typeof client.destroy === 'function') client.destroy();
        else if (typeof client.end === 'function') client.end();
        return;
      }
      if (onSseActivity) onSseActivity();
      return;
    }
  }

  function writeChildMessage(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error(`MCP child write timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          finish(error || null);
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  function isChildResponse(message) {
    return message && message.id != null
      && !Object.prototype.hasOwnProperty.call(message, 'method')
      && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
  }

  function handleChildMessage(message) {
    pruneTombstones();
    if (isChildResponse(message)) {
      const id = String(message.id);
      const waiter = waiters.get(id);
      if (waiter) {
        waiters.delete(id);
        waiter.resolve({ ...message, id: waiter.clientId });
        return;
      }
      if (tombstones.has(id)) {
        removeTombstone(id);
        return;
      }
      return;
    }
    writeSse(message);
  }

  function markChildInactive(source, error, code = null) {
    if (child !== source || inactiveChild === source) return;
    inactiveChild = source;
    lastExitCode = code;
    alive = false;
    rejectWaiters(error);
    closeSseClients();
    if (disposed || !restart || restarts >= maxRestarts) return;
    restarts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (disposed) return;
      spawnChild();
    }, backoffMs * restarts);
    restartTimer.unref?.();
  }

  function attachChild(next) {
    child = next;
    inactiveChild = null;
    buffer = '';
    alive = true;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (child !== next || inactiveChild === next) return;
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
    child.on('error', (error) => {
      process.stderr.write(`jarvos-mcp child: ${error.message}\n`);
      markChildInactive(next, error);
    });
    child.on('exit', (code) => {
      markChildInactive(next, new Error(`jarvos-mcp.js exited with code ${code}`), code);
    });
  }

  function spawnChild() {
    const next = spawnImpl(process.execPath, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: (options.childEnv || childEnvFrom)(options.env || process.env),
    });
    attachChild(next);
    return next;
  }

  spawnChild();

  return {
    get child() { return child; },
    sseClients,
    setSseActivityHandler(handler) {
      onSseActivity = typeof handler === 'function' ? handler : null;
    },
    get alive() { return alive; },
    health() {
      return {
        alive,
        pid: child && child.pid ? child.pid : null,
        restarts,
        lastExitCode,
        tombstones: tombstones.size,
      };
    },
    dispose() {
      disposed = true;
      if (restartTimer) clearTimeout(restartTimer);
      rejectWaiters(new Error('bridge disposed'));
      if (child && !child.killed) child.kill();
      for (const id of [...tombstoneTimers.keys()]) removeTombstone(id);
      closeSseClients();
    },
    post(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (!alive || !child || !child.stdin || child.stdin.destroyed) {
        return Promise.reject(new Error('MCP child is not alive'));
      }
      return writeChildMessage(message, timeoutMs);
    },
    send(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (!alive || !child || !child.stdin || child.stdin.destroyed) {
        return Promise.reject(new Error('MCP child is not alive'));
      }
      if (message && message.id == null) {
        return writeChildMessage(message, timeoutMs).then(() => null);
      }
      const clientId = message.id;
      const internalId = `jarvos-gateway-${bridgeId}-${++outboundRequestSequence}`;
      const outbound = { ...message, id: internalId };
      pruneTombstones();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(internalId);
          addTombstone(internalId);
          reject(new Error(`MCP request ${clientId} timed out`));
        }, timeoutMs);
        waiters.set(internalId, {
          clientId,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        writeChildMessage(outbound, timeoutMs).catch((error) => {
          if (!waiters.has(internalId)) return;
          clearTimeout(timer);
          waiters.delete(internalId);
          addTombstone(internalId);
          reject(error);
        });
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return isJsonRpcObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isEmptyParams(message) {
  return !hasOwn(message, 'params') || (isPlainObject(message.params) && Object.keys(message.params).length === 0);
}

function isValidRequestId(id) {
  return Number.isSafeInteger(id)
    || (typeof id === 'string' && id.length > 0 && id.length <= 128 && !UNSAFE_TEXT.test(id));
}

function safeClientInfo(value) {
  return typeof value === 'string' && SAFE_CLIENT_INFO.test(value) ? value : 'unknown';
}

function matchesRule(rule, value) {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'integer') return Number.isSafeInteger(value) && value >= rule.minimum && value <= rule.maximum;
  if (rule.type !== 'string' || typeof value !== 'string') return false;
  if (rule.enum) return rule.enum.includes(value);
  if (value.length < (rule.minLength || 1) || value.length > rule.maxLength || UNSAFE_TEXT.test(value)) return false;
  return !rule.pattern || new RegExp(rule.pattern).test(value);
}

// Rebuilds allowlisted arguments into a fresh null-prototype object, or null.
function readOnlyToolArguments(name, args) {
  const spec = READ_ONLY_TOOLS[name];
  if (!isPlainObject(args)) return null;
  const clean = Object.create(null);
  for (const key of Object.keys(args)) {
    if (!hasOwn(spec.properties, key) || !matchesRule(spec.properties[key], args[key])) return null;
    clean[key] = args[key];
  }
  for (const key of spec.required || []) if (!hasOwn(clean, key)) return null;
  return clean;
}

function readOnlyToolSchema(name) {
  const spec = READ_ONLY_TOOLS[name];
  const schema = { type: 'object', additionalProperties: false, properties: spec.properties };
  if (spec.required) schema.required = spec.required;
  return JSON.parse(JSON.stringify(schema));
}

function rpcReject(status, id, code, message) {
  return { reject: { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } } };
}

// Read-only gate for one client message: { reject }, { local } or { forward }.
// Runs before session creation, so nothing denied ever reaches a child.
function readOnlyDecision(message) {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string'
    || Object.keys(message).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))) {
    return rpcReject(400, null, -32600, 'Invalid Request');
  }
  const { method } = message;
  if (!hasOwn(message, 'id')) {
    if (method === 'notifications/initialized' && isEmptyParams(message)) return { forward: { jsonrpc: '2.0', method } };
    return rpcReject(400, null, -32601, 'notification not allowed by read-only gateway');
  }
  if (!isValidRequestId(message.id)) return rpcReject(400, null, -32600, 'Invalid Request');
  const { id } = message;
  if (method === 'initialize') {
    const params = message.params;
    if (!isPlainObject(params) || (hasOwn(params, 'protocolVersion') && typeof params.protocolVersion !== 'string')) {
      return rpcReject(200, id, -32602, 'Invalid params');
    }
    const info = isPlainObject(params.clientInfo) ? params.clientInfo : {};
    return {
      forward: {
        jsonrpc: '2.0',
        id,
        method,
        params: {
          protocolVersion: params.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: safeClientInfo(info.name), version: safeClientInfo(info.version) },
        },
      },
    };
  }
  if (method === 'ping') return isEmptyParams(message) ? { local: {} } : rpcReject(200, id, -32602, 'Invalid params');
  if (method === 'tools/list') {
    return isEmptyParams(message) ? { forward: { jsonrpc: '2.0', id, method } } : rpcReject(200, id, -32602, 'Invalid params');
  }
  if (method === 'tools/call') {
    const params = message.params;
    if (!isPlainObject(params) || Object.keys(params).some((key) => key !== 'name' && key !== 'arguments')
      || typeof params.name !== 'string' || !hasOwn(READ_ONLY_TOOLS, params.name)) {
      return rpcReject(200, id, -32602, 'tool not allowed by read-only gateway');
    }
    const args = readOnlyToolArguments(params.name, hasOwn(params, 'arguments') ? params.arguments : {});
    if (!args) return rpcReject(200, id, -32602, 'invalid arguments for read-only tool');
    return { forward: { jsonrpc: '2.0', id, method, params: { name: params.name, arguments: args } } };
  }
  return rpcReject(200, id, -32601, 'Method not found');
}

// Narrows child responses: tools-only capabilities, allowlisted tools with
// gateway-owned closed schemas, and errors without child-supplied data.
function shapeReadOnlyResponse(method, response) {
  if (!isJsonRpcObject(response)) return response;
  if (hasOwn(response, 'error')) {
    const error = isJsonRpcObject(response.error) ? response.error : {};
    return {
      jsonrpc: '2.0',
      id: response.id,
      error: {
        code: Number.isInteger(error.code) ? error.code : -32000,
        message: typeof error.message === 'string' ? error.message : 'MCP child error',
      },
    };
  }
  const result = isJsonRpcObject(response.result) ? response.result : {};
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: response.id,
      result: { protocolVersion: result.protocolVersion, capabilities: { tools: {} }, serverInfo: result.serverInfo },
    };
  }
  if (method === 'tools/list') {
    const tools = [];
    for (const tool of Array.isArray(result.tools) ? result.tools : []) {
      if (!isJsonRpcObject(tool) || typeof tool.name !== 'string' || !hasOwn(READ_ONLY_TOOLS, tool.name)) continue;
      if (tools.some((item) => item.name === tool.name)) continue;
      tools.push({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: readOnlyToolSchema(tool.name),
      });
    }
    return { jsonrpc: '2.0', id: response.id, result: { tools } };
  }
  return response;
}

function createServer({
  token,
  host,
  port,
  bridge,
  createBridge,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  idleSessionMs = DEFAULT_SESSION_IDLE_MS,
  supportedProtocolVersions = SUPPORTED_PROTOCOL_VERSIONS,
  readOnly = false,
}) {
  const sessions = new Map();
  const sessionState = new Map();
  const factory = createBridge || (bridge ? () => bridge : () => startStdioBridge());

  const allowedVersions = new Set(supportedProtocolVersions);

  function currentPort() {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : port;
  }

  function disposeSession(id) {
    const found = sessions.get(id);
    if (found && typeof found.dispose === 'function') found.dispose();
    sessions.delete(id);
    sessionState.delete(id);
  }

  function reapIdleSessions(now = Date.now()) {
    for (const [id, state] of sessionState) {
      if (now - state.lastActivity >= idleSessionMs) disposeSession(id);
    }
  }

  function reapDeadSessions() {
    for (const [id, item] of sessions) {
      if (typeof item.health === 'function' && item.health().alive === false) disposeSession(id);
    }
  }

  const idleReaper = setInterval(reapIdleSessions, Math.max(10, Math.min(idleSessionMs, 60_000)));
  idleReaper.unref?.();

  function sessionHeader(req) {
    return req.headers['mcp-session-id'] || req.headers['Mcp-Session-Id'] || null;
  }

  function resolveSession(req, message) {
    reapIdleSessions();
    const existing = sessionHeader(req);
    if (existing) {
      const id = String(existing);
      const found = sessions.get(id);
      if (!found) return { errorStatus: 404, error: { error: 'unknown session' } };
      const state = sessionState.get(id);
      state.lastActivity = Date.now();
      return { id, bridge: found, created: false, state };
    }
    if (message && message.method === 'initialize') {
      reapDeadSessions();
      if (sessions.size >= maxSessions) return { errorStatus: 429, error: { error: 'session capacity reached' } };
      const id = randomUUID();
      let next;
      try {
        next = factory();
      } catch {
        return { errorStatus: 503, error: { error: 'unable to start MCP session' } };
      }
      if (!next || (typeof next.health === 'function' && next.health().alive === false)) {
        if (next && typeof next.dispose === 'function') next.dispose();
        return { errorStatus: 503, error: { error: 'unable to start MCP session' } };
      }
      sessions.set(id, next);
      const state = {
        lastActivity: Date.now(),
        protocolVersion: message?.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
      };
      sessionState.set(id, state);
      if (typeof next.setSseActivityHandler === 'function') {
        next.setSseActivityHandler(() => {
          const current = sessionState.get(id);
          if (current) current.lastActivity = Date.now();
        });
      }
      return { id, bridge: next, created: true, state };
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
    if (!hasSafeHostHeader(req.headers.host)) {
      res.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'invalid host' }));
      return;
    }
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid request target' }));
      return;
    }
    if (!isTrustedOrigin(req.headers.origin, host, currentPort())) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'untrusted origin' }));
      return;
    }
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
    const protocolVersion = req.headers['mcp-protocol-version'];
    if (protocolVersion && !allowedVersions.has(String(protocolVersion))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported MCP-Protocol-Version' }));
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
      disposeSession(String(id));
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && readOnly) {
      // No SSE stream in read-only mode, so child-originated messages have no
      // delivery path and are dropped by the bridge.
      res.writeHead(405, { allow: 'POST, DELETE', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
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
      for (const client of resolved.bridge.sseClients) {
        if (typeof client.end === 'function') client.end();
      }
      resolved.bridge.sseClients.clear();
      resolved.bridge.sseClients.add(res);
      req.on('close', () => resolved.bridge.sseClients.delete(res));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: readOnly ? 'POST, DELETE' : 'GET, POST, DELETE', 'content-type': 'application/json' });
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

    const decision = readOnly ? readOnlyDecision(message) : null;
    if (decision && decision.reject) {
      res.writeHead(decision.reject.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(decision.reject.body));
      return;
    }

    const requestedInitializeVersion = message.method === 'initialize' && message.params?.protocolVersion;
    if (requestedInitializeVersion && !allowedVersions.has(String(requestedInitializeVersion))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported initialize protocol version' }));
      return;
    }

    const resolved = resolveSession(req, message);
    if (resolved.errorStatus) {
      res.writeHead(resolved.errorStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resolved.error));
      return;
    }

    if (protocolVersion && resolved.state?.protocolVersion && String(protocolVersion) !== resolved.state.protocolVersion) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'MCP-Protocol-Version does not match session' }));
      return;
    }

    if (decision && decision.local) {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': resolved.id });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: decision.local }));
      return;
    }

    const isClientResponse = message.id != null
      && !Object.prototype.hasOwnProperty.call(message, 'method')
      && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error'));
    if (isClientResponse) {
      try {
        if (typeof resolved.bridge.post !== 'function') throw new Error('MCP child cannot accept client responses');
        await resolved.bridge.post(message, requestTimeoutMs);
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json', 'mcp-session-id': resolved.id });
        res.end(JSON.stringify({ error: error.message || 'unable to forward client response' }));
        return;
      }
      res.writeHead(202, { 'mcp-session-id': resolved.id });
      res.end();
      return;
    }

    try {
      let forwardedMessage = message.method === 'initialize' && !message.params?.protocolVersion
        ? { ...message, params: { ...(message.params || {}), protocolVersion: DEFAULT_PROTOCOL_VERSION } }
        : message;
      if (decision) forwardedMessage = decision.forward;
      let result = await resolved.bridge.send(forwardedMessage, requestTimeoutMs);
      if (decision) result = shapeReadOnlyResponse(message.method, result);
      const negotiatedVersion = result?.result?.protocolVersion;
      if (resolved.created && result && result.error) {
        disposeSession(resolved.id);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      if (resolved.created && typeof negotiatedVersion === 'string') {
        if (!allowedVersions.has(negotiatedVersion)) {
          disposeSession(resolved.id);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32000, message: 'MCP child negotiated an unsupported protocol version' },
          }));
          return;
        }
        resolved.state.protocolVersion = negotiatedVersion;
      }
      if (result == null) {
        if (resolved.created) disposeSession(resolved.id);
        res.writeHead(202, resolved.created ? {} : { 'mcp-session-id': resolved.id });
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': resolved.id,
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      if (resolved.created) disposeSession(resolved.id);
      const headers = { 'content-type': 'application/json' };
      if (!resolved.created) headers['mcp-session-id'] = resolved.id;
      res.writeHead(504, headers);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32000, message: error.message } }));
    }
  });
  server.sessions = sessions;
  server.healthPayload = healthPayload;
  const closeServer = server.close.bind(server);
  server.close = (...args) => {
    for (const id of [...sessions.keys()]) disposeSession(id);
    return closeServer(...args);
  };
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => {
    clearInterval(idleReaper);
    for (const id of [...sessions.keys()]) disposeSession(id);
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
  return serve({ token, host, port, env });
}

async function serve({ token, host, port, env = process.env, readOnly = false, childEnv }) {
  const server = createServer({
    token,
    host,
    port,
    readOnly,
    createBridge: () => startStdioBridge({ env, childEnv }),
  });
  await listen(server, host, port);
  process.stderr.write(`jarvos MCP Streamable HTTP ${readOnly ? '(read-only) ' : ''}listening on http://${host}:${port}${MCP_PATH}\n`);
  if (!isLoopbackHost(host)) {
    process.stderr.write('WARNING: non-loopback bind carries the bearer token in cleartext HTTP unless a TLS terminator sits in front.\n');
  }
  const shutdown = () => server.close();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return {
    server,
    get bridges() { return [...server.sessions.values()]; },
  };
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
  DEFAULT_PORT,
  READ_ONLY_TOOLS,
  resolveToken,
  trustedTokenFile,
  childEnvFrom,
  readOnlyDecision,
  shapeReadOnlyResponse,
  serve,
  safeEqual,
  extractBearer,
  isLoopbackHost,
  isTrustedOrigin,
  hasSafeHostHeader,
  createServer,
  startStdioBridge,
  main,
};
