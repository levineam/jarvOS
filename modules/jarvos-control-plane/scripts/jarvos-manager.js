#!/usr/bin/env node
'use strict';

// Public transports are deliberately thin.  Installed hosts supply the
// authenticated application-service instance; this adapter never persists
// requests, resolves credentials, or advances command lifecycle state itself.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const OPERATION_ALIASES = Object.freeze({ request: 'createRequest' });
const PUBLIC_OPERATIONS = new Set(['list', 'inspect', 'evidence', 'approval-state', 'createRequest', 'approve']);
// CLI flags whose values are compared strictly (===) against numbers by the
// application service. Argv always yields strings, so they must be coerced.
const NUMERIC_CLI_FLAGS = new Set(['fence']);
const CREDENTIAL_ENV = 'JARVOS_CONTROL_PLANE_CREDENTIAL';

function normalizeOperation(operation) {
  const normalized = OPERATION_ALIASES[operation] || operation;
  if (!PUBLIC_OPERATIONS.has(normalized)) throw new Error(`unsupported public control-plane operation: ${operation}`);
  return normalized;
}

// Reject group/other-writable files or directories so a lower-privileged actor
// cannot substitute the host-service module we require(). Sticky directories
// (shared temp roots) restrict deletion to owners and are allowed.
function assertNotOtherWritable(target, stat) {
  const groupOrOtherWritable = stat.mode & 0o022;
  const sticky = stat.mode & 0o1000;
  if (groupOrOtherWritable && !(stat.isDirectory() && sticky)) {
    throw new Error('control-plane host service module is in a writable location');
  }
}

// Reject a module (or an ancestor directory) owned by a different, unprivileged
// user. Permission bits alone are insufficient: a 0644 file an attacker owns in a
// shared temp root passes the writability check yet can be rewritten at will by
// its owner. Trusting only files owned by us or by root closes that path.
function assertTrustedOwnership(target, stat) {
  const owner = stat.uid;
  if (owner === 0) return;
  if (typeof process.getuid === 'function' && owner === process.getuid()) return;
  throw new Error('control-plane host service module is owned by an untrusted user');
}

// Validate every directory from the module up to the filesystem root. Checking
// only the immediate parent leaves higher, attacker-controlled ancestors free to
// be renamed or swapped out from under us: a hostile non-sticky ancestor lets an
// attacker relocate the validated subtree and point require() at planted code.
function assertTrustedAncestry(startDir) {
  let dir = startDir;
  while (true) {
    const dirStat = fs.statSync(dir);
    assertNotOtherWritable(dir, dirStat);
    assertTrustedOwnership(dir, dirStat);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// The host-service module path is an env/config-supplied require() target. Pin
// it to a validated absolute realpath in a non-writable location before loading
// so config/env substitution cannot point us at an attacker-planted module.
function resolveTrustedServiceModule(modulePath) {
  if (!modulePath) throw new Error('control-plane host service is not configured');
  if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath)) {
    throw new Error('control-plane host service module must be an absolute path');
  }
  let realPath;
  try {
    realPath = fs.realpathSync(modulePath);
  } catch {
    throw new Error('control-plane host service module does not exist');
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) throw new Error('control-plane host service module must be a file');
  assertNotOtherWritable(realPath, stat);
  assertTrustedOwnership(realPath, stat);
  assertTrustedAncestry(path.dirname(realPath));
  return realPath;
}

function loadHostService(modulePath) {
  const resolved = resolveTrustedServiceModule(modulePath);
  // This module path is an installed-host configuration boundary. It must
  // export either the service itself or a zero-argument factory for it.
  const configured = require(resolved);
  const service = typeof configured === 'function'
    ? configured()
    : typeof configured.createApplicationService === 'function'
      ? configured.createApplicationService()
      : configured.applicationService || configured;
  if (!service || typeof service.execute !== 'function') throw new Error('configured control-plane host service must expose execute');
  return service;
}

// A ready host must both expose execute AND enforce the authentication boundary:
// an unresolvable credential must be rejected with the structured AUTH_REQUIRED
// code rather than served. A bare { execute } that returns data for any
// credential — or one that merely throws a generic error whose text happens to
// mention "auth" — is NOT a ready control plane.
function probeReadiness(service) {
  if (!service || typeof service.execute !== 'function') return false;
  const sentinel = `jarvos-readiness-probe:${crypto.randomBytes(18).toString('hex')}`;
  try {
    service.execute('list', { credential: sentinel });
    return false;
  } catch (error) {
    return Boolean(error) && error.code === 'AUTH_REQUIRED';
  }
}

function verifyHostService(modulePath) {
  try {
    const service = loadHostService(modulePath);
    // Do not return, print, or otherwise expose the configured module path.
    return { ok: probeReadiness(service) };
  } catch {
    return { ok: false };
  }
}

// Resolve the caller credential without exposing it on argv. Precedence:
// stdin, credential file, then environment. A raw --credential value on argv is
// rejected by default because it is visible in process listings and shell
// history; it is only honored when the caller also passes the explicit
// --allow-insecure-credential development override.
function resolveCliCredential(input) {
  // Reject a raw --credential the moment it is present, before any precedence
  // resolution. Otherwise a higher-precedence source (env/file) would silently
  // consume the request and let the argv secret slip through unexamined, still
  // exposed in process listings and shell history.
  if (typeof input.credential === 'string' && !input.allowInsecureCredential) {
    throw new Error(`--credential is visible in process listings and shell history and is rejected by default; use ${CREDENTIAL_ENV}, --credential-file <path>, or --credential-stdin (or pass --allow-insecure-credential to override)`);
  }
  if (input.credentialStdin) {
    const value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    if (!value) throw new Error('no credential received on stdin');
    return value;
  }
  if (input.credentialFile) {
    if (typeof input.credentialFile !== 'string') throw new Error('--credential-file requires a path');
    const value = fs.readFileSync(input.credentialFile, 'utf8').replace(/\r?\n$/, '');
    if (!value) throw new Error('credential file is empty');
    return value;
  }
  if (process.env[CREDENTIAL_ENV]) return process.env[CREDENTIAL_ENV];
  if (typeof input.credential === 'string') {
    process.stderr.write(`warning: --credential is visible in process listings and shell history; prefer ${CREDENTIAL_ENV}, --credential-file <path>, or --credential-stdin\n`);
    return input.credential;
  }
  throw new Error(`control-plane credential required: set ${CREDENTIAL_ENV}, or pass --credential-file <path> / --credential-stdin`);
}

function createControlPlaneService(options = {}) {
  const applicationService = options.applicationService || loadHostService(
    options.serviceModule || process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE,
  );
  if (typeof applicationService.execute !== 'function') throw new Error('applicationService must expose execute');

  return {
    execute(operation, input = {}) {
      const { service: _service, applicationService: _applicationService, serviceModule: _serviceModule, ...request } = input;
      return applicationService.execute(normalizeOperation(operation), request);
    },
  };
}

function coerceNumericFlags(input) {
  for (const key of NUMERIC_CLI_FLAGS) {
    const value = input[key];
    if (value === undefined || value === true) continue;
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error(`--${key} must be an integer`);
      continue;
    }
    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) throw new Error(`--${key} must be an integer`);
    input[key] = Number.parseInt(text, 10);
  }
  return input;
}

function parseCli(argv) {
  const [operation = 'help', ...rest] = argv;
  const input = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    input[name] = rest[index + 1] && !rest[index + 1].startsWith('--') ? rest[++index] : true;
  }
  if (input.input) Object.assign(input, JSON.parse(input.input));
  coerceNumericFlags(input);
  return { operation, input };
}

function usage() {
  return 'Usage: jarvos-manager <list|inspect|evidence|approval-state|request|approve> [--request-id <id>] [--fence <n>] [--input <json>]\n'
    + `       Credential (never on argv): set ${CREDENTIAL_ENV}, or pass --credential-file <path> or --credential-stdin.\n`
    + '       jarvos-manager verify-host-service --service-module <absolute-path>';
}

function main() {
  const { operation, input } = parseCli(process.argv.slice(2));
  if (operation === 'help' || input.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (operation === 'verify-host-service') {
    // verifyHostService returns { ok: boolean }; the object itself is always
    // truthy, so inspect the ok flag or a non-ready host always "passes".
    if (!verifyHostService(input.serviceModule).ok) {
      process.stderr.write('Configured control-plane host service is not ready\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('{"ok":true}\n');
    return;
  }
  const request = { ...input };
  request.credential = resolveCliCredential(input);
  delete request.credentialFile;
  delete request.credentialStdin;
  delete request.allowInsecureCredential;
  const result = createControlPlaneService().execute(operation, request);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  PUBLIC_OPERATIONS,
  createControlPlaneService,
  loadHostService,
  normalizeOperation,
  parseCli,
  probeReadiness,
  resolveCliCredential,
  resolveTrustedServiceModule,
  verifyHostService,
};
