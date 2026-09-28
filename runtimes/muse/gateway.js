#!/usr/bin/env node
'use strict';

/**
 * Muse read-only MCP gateway. Runs on the VAULT HOST.
 *
 * Reuses jarvos-mcp-http.js with fixed options: read-only mode is always on
 * (no environment variable disables it), only Muse credentials are read, and
 * the default port is 8766 so the general gateway keeps 8765. Read-only is RPC
 * authorization, not an OS sandbox or per-note access control.
 */

const fs = require('node:fs');
const path = require('node:path');
const gateway = require('../../modules/jarvos-agent-context/scripts/jarvos-mcp-http.js');

const MUSE_TOKEN_ENV = 'JARVOS_MUSE_MCP_TOKEN';
const MUSE_TOKEN_FILE_ENV = 'JARVOS_MUSE_MCP_TOKEN_FILE';
const MUSE_HOST_ENV = 'JARVOS_MUSE_MCP_HOST';
const MUSE_PORT_ENV = 'JARVOS_MUSE_MCP_PORT';
const MUSE_ALLOW_NON_LOOPBACK_ENV = 'JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK';
const MUSE_DEFAULT_HOST = '127.0.0.1';
const MUSE_DEFAULT_PORT = 8766;

// Stripped from the jarvos-mcp.js child independently of the RPC allowlist,
// so denied tools also lose their credentials and service bindings.
const CHILD_ENV_DENYLIST = Object.freeze([
  MUSE_TOKEN_ENV,
  MUSE_TOKEN_FILE_ENV,
  gateway.TOKEN_ENV,
  gateway.TOKEN_FILE_ENV,
  'JARVOS_CONTROL_PLANE_CREDENTIAL',
  'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE',
  'JARVOS_CONTROL_PLANE_SERVICE_MODULE',
  'JARVOS_WORK_ACTION_SERVICE_MODULE',
  'JARVOS_COMMON_WORK_SERVICE_MODULE',
  'JARVOS_COMMON_WORK_HARNESS',
  'JARVOS_SHARED_SKILLS_CONFIG_PATH',
  'JARVOS_MEANING_PROVIDER_MODULE',
]);

function museChildEnv(env = process.env) {
  const next = { ...env };
  for (const key of CHILD_ENV_DENYLIST) delete next[key];
  return next;
}

function sameFile(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

// Validates Muse-only configuration without binding anything. Throws on
// refusal; messages never include credential values.
function resolveMuseConfig(env = process.env) {
  const tokenFile = env[MUSE_TOKEN_FILE_ENV] ? String(env[MUSE_TOKEN_FILE_ENV]) : '';
  let token = null;
  if (tokenFile) {
    token = gateway.trustedTokenFile(tokenFile);
    if (!token) throw new Error(`${MUSE_TOKEN_FILE_ENV} is set but is not a trusted owner-only token file`);
  } else if (typeof env[MUSE_TOKEN_ENV] === 'string' && env[MUSE_TOKEN_ENV].trim().length >= 16) {
    token = env[MUSE_TOKEN_ENV].trim();
  }
  if (!token) {
    throw new Error(`refusing to start: set ${MUSE_TOKEN_ENV} or ${MUSE_TOKEN_FILE_ENV} (fail-closed auth; the generic gateway token is never used)`);
  }

  const genericFile = env[gateway.TOKEN_FILE_ENV] ? String(env[gateway.TOKEN_FILE_ENV]) : '';
  if (tokenFile && genericFile && sameFile(tokenFile, genericFile)) {
    throw new Error('refusing to start: the Muse token file must not be the generic gateway token file');
  }
  const genericTokens = [];
  if (typeof env[gateway.TOKEN_ENV] === 'string' && env[gateway.TOKEN_ENV].trim()) genericTokens.push(env[gateway.TOKEN_ENV].trim());
  const genericFromFile = genericFile ? gateway.trustedTokenFile(genericFile) : null;
  if (genericFromFile) genericTokens.push(genericFromFile);
  if (genericTokens.some((generic) => gateway.safeEqual(generic, token))) {
    throw new Error('refusing to start: the Muse token must differ from the generic gateway credential');
  }

  const host = env[MUSE_HOST_ENV] || MUSE_DEFAULT_HOST;
  const port = Number(env[MUSE_PORT_ENV] || MUSE_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${MUSE_PORT_ENV} must be a valid port`);
  if (port === gateway.DEFAULT_PORT) throw new Error(`refusing to start: port ${port} belongs to the general gateway`);
  if (!gateway.isLoopbackHost(host) && env[MUSE_ALLOW_NON_LOOPBACK_ENV] !== '1') {
    throw new Error(`refusing non-loopback bind; set ${MUSE_ALLOW_NON_LOOPBACK_ENV}=1 to override`);
  }
  return { token, host, port };
}

async function main(env = process.env) {
  let config;
  try {
    config = resolveMuseConfig(env);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  return gateway.serve({ ...config, env, readOnly: true, childEnv: museChildEnv });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  MUSE_TOKEN_ENV,
  MUSE_TOKEN_FILE_ENV,
  MUSE_HOST_ENV,
  MUSE_PORT_ENV,
  MUSE_ALLOW_NON_LOOPBACK_ENV,
  MUSE_DEFAULT_PORT,
  CHILD_ENV_DENYLIST,
  museChildEnv,
  resolveMuseConfig,
  main,
};
