'use strict';

const fs = require('fs');
const path = require('path');
const health = require('../../adapters/health');
const today = require('../../today');

// Self-introspection lets the chat agent read its OWN app (source, logs,
// health) so it can explain and debug its behavior. Everything here is
// strictly read-only and confined to the app root. Secrets live outside the
// root by design (OpenAI key in the OS keychain/env, Paperclip token in
// ~/.paperclip/auth.json), so root-confinement already excludes them; the
// denylist + redaction below are defense in depth for anything in-repo.

const MAX_BYTES = 256 * 1024; // per read_app_source response
const DEFAULT_TAIL_KB = 64; // per read_app_logs response

// Directory names that are never read or listed: dependency noise and git internals.
const DENY_SEGMENTS = new Set(['node_modules', '.git']);
// Filenames that may hold secrets even inside the repo.
const DENY_FILE_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key)$/i;
// Only text/source extensions are readable. Extensionless files are rejected.
const ALLOWED_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.css', '.html',
  '.json', '.md', '.txt', '.log', '.yaml', '.yml',
]);
// Logs the agent may read, by friendly name -> repo-relative path.
const LOG_PATHS = { browse: '.gstack/browse-network.log' };

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Resolve `requested` against `root` and refuse anything that escapes it.
// Mirrors the path.normalize + startsWith(STATIC_DIR) guard in server/index.js.
function resolveWithinRoot(root, requested) {
  const normRoot = path.resolve(root);
  const abs = path.resolve(normRoot, requested == null ? '.' : String(requested));
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw badRequest('path is outside the app root');
  }
  // The lexical check above stops `..` traversal but NOT symlinks: a symlink
  // under the root can point outside it, and fs reads follow it. If the target
  // exists, resolve symlinks and require the REAL path to stay within the REAL
  // root. (Non-existent paths can't leak — nothing to read/list.)
  if (fs.existsSync(abs)) {
    const realRoot = fs.realpathSync.native(normRoot);
    const realAbs = fs.realpathSync.native(abs);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
      throw badRequest('path escapes the app root via a symlink');
    }
  }
  return abs;
}

// Enforce the denylist and extension allowlist on an already-confined path.
function assertAllowed(root, absPath) {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  const segments = rel.split('/');
  if (segments.some((s) => DENY_SEGMENTS.has(s))) {
    throw badRequest('path is not permitted');
  }
  if (DENY_FILE_RE.test(rel)) {
    throw badRequest('path is not permitted');
  }
  if (!ALLOWED_EXT.has(path.extname(absPath).toLowerCase())) {
    throw badRequest('file type is not permitted');
  }
}

// Mask anything that looks like a credential. Conservative: mask, never drop,
// and prefer over-masking to leaking. Mirrors the hydration packet's posture.
function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    .replace(
      /((?:api[_-]?key|secret|token|password|authorization|bearer)["'\s:=]{1,4})([A-Za-z0-9._-]{12,})/gi,
      (_m, label) => `${label}[redacted]`,
    )
    .replace(/\b[0-9a-fA-F]{40,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+/]{50,}={0,2}\b/g, '[redacted]');
}

// Read at most MAX_BYTES from the start of a file.
function readCapped(absPath) {
  const { size } = fs.statSync(absPath);
  if (size <= MAX_BYTES) {
    return { content: fs.readFileSync(absPath, 'utf8'), truncated: false };
  }
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(MAX_BYTES);
    const bytes = fs.readSync(fd, buf, 0, MAX_BYTES, 0);
    return { content: buf.subarray(0, bytes).toString('utf8'), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

// Read at most `tailKb` KB from the END of a file (logs grow at the tail).
function readTail(absPath, tailKb) {
  const max = Math.max(1, tailKb) * 1024;
  const { size } = fs.statSync(absPath);
  if (size <= max) {
    return { content: fs.readFileSync(absPath, 'utf8'), truncated: false };
  }
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(max);
    const bytes = fs.readSync(fd, buf, 0, max, size - max);
    return { content: buf.subarray(0, bytes).toString('utf8'), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

// Names-and-sizes tree walk, pruning denied dirs. Never returns file contents.
function listTree(root, dirAbs, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (DENY_SEGMENTS.has(e.name)) continue;
    const abs = path.join(dirAbs, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isDirectory()) {
      out.push({ name: e.name, type: 'dir', path: rel });
      if (depth > 1) out.push(...listTree(root, abs, depth - 1));
    } else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { /* unreadable — report 0 */ }
      out.push({ name: e.name, type: 'file', size, path: rel });
    }
  }
  return out;
}

// Plain async handlers, independent of the ai SDK so they are directly testable.
function makeHandlers(cfg) {
  const root = cfg.appRoot;

  return {
    readAppSource({ path: requested }) {
      const abs = resolveWithinRoot(root, requested);
      assertAllowed(root, abs);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return { found: false, path: rel };
      }
      const { content, truncated } = readCapped(abs);
      return { found: true, path: rel, truncated, content: redactSecrets(content) };
    },

    listAppSource({ dir, depth }) {
      const abs = resolveWithinRoot(root, dir || '.');
      const rel = path.relative(root, abs).split(path.sep).join('/') || '.';
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return { found: false, path: rel };
      }
      return { found: true, path: rel, entries: listTree(root, abs, Math.min(Math.max(1, depth || 1), 3)) };
    },

    readAppLogs({ name, tailKb }) {
      const relConfigured = LOG_PATHS[name] || LOG_PATHS.browse;
      const abs = resolveWithinRoot(root, relConfigured);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return { found: false, path: relConfigured };
      }
      const { content, truncated } = readTail(abs, tailKb || DEFAULT_TAIL_KB);
      return { found: true, path: relConfigured, truncated, content: redactSecrets(content) };
    },

    readAppHealth() {
      return health.services(cfg, today.localDate());
    },
  };
}

async function createSelfTools(cfg) {
  const { tool } = await import('ai');
  const { z } = await import('zod');
  const h = makeHandlers(cfg);

  return {
    read_app_source: tool({
      description:
        'Read one of the jarvOS Desktop app\'s own source or config files (read-only, confined to the app root). Use to explain or debug your own behavior.',
      inputSchema: z.object({ path: z.string().min(1).describe('App-root-relative file path, e.g. server/agent/index.js') }),
      execute: async (args) => h.readAppSource(args),
    }),
    list_app_source: tool({
      description:
        'List files and directories in the jarvOS Desktop app to discover what exists before reading. Names and sizes only, never contents.',
      inputSchema: z.object({
        dir: z.string().default('.').describe('App-root-relative directory, default the repo root'),
        depth: z.number().min(1).max(3).default(1),
      }),
      execute: async (args) => h.listAppSource(args),
    }),
    read_app_logs: tool({
      description:
        'Read the tail of one of the app\'s log files (currently the gstack browser network log). Returns { found: false } when the log is absent.',
      inputSchema: z.object({
        name: z.enum(['browse']).default('browse'),
        tailKb: z.number().min(1).max(512).default(DEFAULT_TAIL_KB),
      }),
      execute: async (args) => h.readAppLogs(args),
    }),
    read_app_health: tool({
      description:
        'Read live app health — the same service-status check the /api/health endpoint returns (Paperclip, journal, notes, ontology, memory, agent-context).',
      inputSchema: z.object({}),
      execute: async () => h.readAppHealth(),
    }),
  };
}

module.exports = {
  createSelfTools,
  __test: {
    makeHandlers,
    resolveWithinRoot,
    assertAllowed,
    redactSecrets,
    readCapped,
    readTail,
    listTree,
    MAX_BYTES,
    ALLOWED_EXT,
    DENY_SEGMENTS,
  },
};
