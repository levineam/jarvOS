#!/usr/bin/env node
'use strict';

/**
 * Grok Bot policy MCP gateway. Runs on whichever host the existing connector
 * URL points at (Mac mini primary); no target routing happens here.
 *
 * Reuses jarvos-mcp-http.js with a fixed, host-owned tool policy: exactly eight
 * tools with gateway-owned closed schemas, two of which (jarvos_create_note,
 * jarvos_session_thread_write) mutate through the canonical child MCP tools.
 * Only Grok credentials are read. The policy is RPC authorization, and the
 * stripped child environment is configuration hygiene, not an OS sandbox.
 */

const fs = require('node:fs');
const path = require('node:path');
const gateway = require('../../modules/jarvos-agent-context/scripts/jarvos-mcp-http.js');
const muse = require('../muse/gateway.js');

const GROK_TOKEN_ENV = 'JARVOS_GROK_MCP_TOKEN';
const GROK_TOKEN_FILE_ENV = 'JARVOS_GROK_MCP_TOKEN_FILE';
const GROK_HOST_ENV = 'JARVOS_GROK_MCP_HOST';
const GROK_PORT_ENV = 'JARVOS_GROK_MCP_PORT';
const GROK_ALLOW_NON_LOOPBACK_ENV = 'JARVOS_GROK_MCP_ALLOW_NON_LOOPBACK';
const GROK_DEFAULT_HOST = '127.0.0.1';
const GROK_SOURCE_PERSONALITY = 'grok-bot';

function deepFreeze(value) {
  if (value && (typeof value === 'object' || typeof value === 'function') && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const clone = (value) => JSON.parse(JSON.stringify(value));
// Line breaks (including YAML/Unicode separators) are refused where a value
// lands in frontmatter or a single-line field.
const SINGLE_LINE = '^[^\\r\\n\\u0085\\u2028\\u2029]*$';
const singleLine = (minLength, maxLength) => ({ type: 'string', minLength, maxLength, pattern: SINGLE_LINE });
const multiLine = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
// Filename stem: no path separators, control characters or leading dot
// (which also excludes '.', '..' and hidden-file traversal).
const TITLE_ARG = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^(?!\\.)[^/\\\\\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+$',
};
const THREAD_ID_ARG = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const MAX_CHARS_ARG = { type: 'integer', minimum: 1, maximum: 20000 };

function stampNote(args) {
  const frontmatter = { ...(args.frontmatter || {}) };
  if (!Object.prototype.hasOwnProperty.call(frontmatter, 'project')) frontmatter.project = '';
  // Transport attribution stamped after validation; not proof of authorship.
  frontmatter.source_personality = GROK_SOURCE_PERSONALITY;
  return { ...args, frontmatter };
}

function stampThreadWrite(args) {
  return { ...args, host: GROK_SOURCE_PERSONALITY, journalPolicy: 'link' };
}

const GROK_TOOL_POLICY = deepFreeze({
  label: 'grok-bot policy',
  tools: {
    jarvos_hydrate: clone(gateway.READ_ONLY_TOOLS.jarvos_hydrate),
    jarvos_startup_brief: clone(gateway.READ_ONLY_TOOLS.jarvos_startup_brief),
    jarvos_projects_context: clone(gateway.READ_ONLY_TOOLS.jarvos_projects_context),
    jarvos_recall: clone(gateway.READ_ONLY_TOOLS.jarvos_recall),
    jarvos_journal_health: { properties: {} },
    jarvos_create_note: {
      required: ['title', 'content'],
      properties: {
        title: TITLE_ARG,
        content: multiLine(200_000),
        frontmatter: {
          type: 'object',
          properties: {
            project: singleLine(0, 200),
            type: singleLine(1, 64),
            status: singleLine(1, 64),
          },
        },
        section: singleLine(1, 120),
      },
      writes: true,
      transform: stampNote,
    },
    jarvos_session_thread_read: {
      required: ['threadId'],
      properties: { threadId: THREAD_ID_ARG, maxChars: MAX_CHARS_ARG },
    },
    jarvos_session_thread_write: {
      required: ['threadId', 'summary'],
      properties: {
        threadId: THREAD_ID_ARG,
        summary: multiLine(8000),
        actor: singleLine(1, 80),
        event: singleLine(1, 80),
        decision: multiLine(4000),
        nextStep: multiLine(4000),
        project: singleLine(1, 200),
        issueIdentifier: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' },
        artifact: singleLine(1, 1000),
      },
      writes: true,
      transform: stampThreadWrite,
    },
  },
});

// Finite allowlist of configuration names actually consumed by the child's
// config, note-writer and retrieval code. Everything else (credentials, service
// modules, harness/owner bindings, ambient thread ids, NODE_OPTIONS, route
// secrets/generation/caller capability) is dropped. The two JARVOS_REQUIRE_*
// enforcement flags are forwarded unchanged so a host that requires a route
// capability or canonical vault keeps failing closed instead of being bypassed.
const GROK_CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'JARVOS_CONFIG_PATH',
  'JARVOS_CONFIG_FILE',
  // Canonical discoverConfigPath() reads <workspace>/jarvos.config.json from
  // these (PATH_ENV_KEYS.workspace); dropping them would silently fall back to
  // HOME's default vault on a workspace-configured host.
  'JARVOS_WORKSPACE_DIR',
  'JARVOS_CLAWD_DIR',
  'CLAWD_DIR',
  'JARVOS_VAULT_DIR',
  'JARVOS_NOTES_DIR',
  'VAULT_NOTES_DIR',
  'JARVOS_JOURNAL_DIR',
  'JOURNAL_DIR',
  'JARVOS_TIMEZONE',
  'JARVOS_ONTOLOGY_DIR',
  'JARVOS_PROJECTS_CONTEXT_CONFIG',
  'JARVOS_BRAIN_DIR',
  'JARVOS_GBRAIN_DIR',
  'JARVOS_GBRAIN_BIN',
  'JARVOS_QMD_BIN',
  'JARVOS_QMD_MODE',
  'JARVOS_QMD_COLLECTION',
  'JARVOS_QMD_INDEX',
  'JARVOS_RETRIEVAL_TIMEOUT_MS',
  'JARVOS_REQUIRE_ROUTE_CAPABILITY',
  'JARVOS_REQUIRE_CANONICAL_VAULT',
]);

function grokChildEnv(sourceEnv = process.env) {
  const next = {};
  for (const key of GROK_CHILD_ENV_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(sourceEnv, key) && typeof sourceEnv[key] === 'string') next[key] = sourceEnv[key];
  }
  return next;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

// Same file by resolved path (symlink aliases) or by device+inode (hardlinks).
function sameFile(left, right) {
  try {
    if (fs.realpathSync(left) === fs.realpathSync(right)) return true;
  } catch {
    // fall through to inode comparison
  }
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

// Validates Grok-only configuration without binding, writing or exiting.
// Throws on refusal; messages name variables only, never credential values.
function resolveGrokConfig(env = process.env) {
  const tokenFile = nonEmpty(env[GROK_TOKEN_FILE_ENV]);
  let token = null;
  if (tokenFile) {
    token = gateway.trustedTokenFile(tokenFile);
    if (!token) throw new Error(`${GROK_TOKEN_FILE_ENV} is set but is not a trusted owner-only token file`);
  } else if (typeof env[GROK_TOKEN_ENV] === 'string' && env[GROK_TOKEN_ENV].trim().length >= 16) {
    token = env[GROK_TOKEN_ENV].trim();
  }
  if (!token) {
    throw new Error(`refusing to start: set ${GROK_TOKEN_ENV} or ${GROK_TOKEN_FILE_ENV} (fail-closed auth; generic and Muse tokens are never used)`);
  }

  const otherFiles = [gateway.TOKEN_FILE_ENV, muse.MUSE_TOKEN_FILE_ENV]
    .map((name) => nonEmpty(env[name]))
    .filter(Boolean);
  if (tokenFile && otherFiles.some((other) => sameFile(tokenFile, other))) {
    throw new Error('refusing to start: the Grok token file must not be the generic or Muse gateway token file');
  }
  const otherTokens = [gateway.TOKEN_ENV, muse.MUSE_TOKEN_ENV]
    .map((name) => (typeof env[name] === 'string' ? env[name].trim() : ''))
    .filter(Boolean);
  for (const file of otherFiles) {
    const value = gateway.trustedTokenFile(file);
    if (value) otherTokens.push(value);
  }
  if (otherTokens.some((other) => gateway.safeEqual(other, token))) {
    throw new Error('refusing to start: the Grok token must differ from the generic and Muse gateway credentials');
  }

  const rawPort = env[GROK_PORT_ENV];
  const port = typeof rawPort === 'string' && /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${GROK_PORT_ENV} must be set to an explicit integer port 1..65535`);
  }

  const host = nonEmpty(env[GROK_HOST_ENV]) || GROK_DEFAULT_HOST;
  if (!/^[A-Za-z0-9.:_-]{1,253}$/.test(host)) throw new Error(`${GROK_HOST_ENV} is not a valid bind host`);
  if (!gateway.isLoopbackHost(host) && env[GROK_ALLOW_NON_LOOPBACK_ENV] !== '1') {
    throw new Error(`refusing non-loopback bind; set ${GROK_ALLOW_NON_LOOPBACK_ENV}=1 to override`);
  }
  return { token, host, port };
}

async function main(env = process.env) {
  let config;
  try {
    config = resolveGrokConfig(env);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  return gateway.serve({ ...config, env, toolPolicy: GROK_TOOL_POLICY, childEnv: grokChildEnv });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  GROK_TOKEN_ENV,
  GROK_TOKEN_FILE_ENV,
  GROK_HOST_ENV,
  GROK_PORT_ENV,
  GROK_ALLOW_NON_LOOPBACK_ENV,
  GROK_TOOL_POLICY,
  GROK_CHILD_ENV_ALLOWLIST,
  grokChildEnv,
  resolveGrokConfig,
  main,
};
