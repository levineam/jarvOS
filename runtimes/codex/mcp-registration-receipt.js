'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'jarvos-codex-mcp-receipt/v1';
const STATES = new Set(['pending', 'active']);
const RECEIPT_KEYS = [
  'schemaVersion',
  'registration',
  'profileDigest',
  'desiredFingerprint',
  'state',
];

function fail(message) {
  const error = new Error(message);
  error.code = 'JARVOS_CODEX_MCP_RECEIPT_INVALID';
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertProfileDirectory(profilePath, { create = false } = {}) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) fail('CODEX_HOME must be absolute');
  const absolute = path.resolve(profilePath);
  if (!fs.existsSync(absolute)) {
    if (!create) fail('CODEX_HOME does not exist');
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(absolute);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('CODEX_HOME must be a real directory');
  if (uid !== null && stat.uid !== uid) fail('CODEX_HOME must be owned by the current user');
  if ((stat.mode & 0o022) !== 0) fail('CODEX_HOME must not be group- or world-writable');
  const real = fs.realpathSync(absolute);
  const allowedSystemAlias = (absolute === '/tmp' || absolute.startsWith('/tmp/'))
    ? `/private${absolute}`
    : (absolute === '/var' || absolute.startsWith('/var/')) ? `/private${absolute}` : null;
  if (real !== absolute && real !== allowedSystemAlias) fail('CODEX_HOME must not use a symbolic-link path');
  return absolute;
}

function receiptContext(receiptPath, profilePath, options = {}) {
  const profile = assertProfileDirectory(profilePath, options);
  const receipt = path.resolve(receiptPath);
  if (path.dirname(receipt) !== profile) fail('MCP receipt must be directly inside CODEX_HOME');
  return { profile, receipt, profileDigest: digest(fs.realpathSync(profile)) };
}

function assertReceiptFile(receiptPath) {
  const stat = fs.lstatSync(receiptPath);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('MCP receipt must be a regular file');
  if (uid !== null && stat.uid !== uid) fail('MCP receipt must be owned by the current user');
  if ((stat.mode & 0o777) !== 0o600) fail('MCP receipt must have mode 0600');
}

function validateReceipt(value, expectedProfileDigest) {
  if (!isObject(value) || Object.keys(value).sort().join('\0') !== [...RECEIPT_KEYS].sort().join('\0')) {
    fail('MCP receipt has an unsupported shape');
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.registration !== 'jarvos'
    || value.profileDigest !== expectedProfileDigest
    || !/^sha256:[a-f0-9]{64}$/.test(value.desiredFingerprint || '')
    || !STATES.has(value.state)) {
    fail('MCP receipt is not a recognized jarvOS ownership record');
  }
  return value;
}

function readReceipt(receiptPath, profilePath) {
  const context = receiptContext(receiptPath, profilePath);
  try { fs.lstatSync(context.receipt); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assertReceiptFile(context.receipt);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(context.receipt, 'utf8'));
  } catch (_) {
    fail('MCP receipt is not valid JSON');
  }
  return validateReceipt(value, context.profileDigest);
}

function renderReceipt(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function claimReceipt(receiptPath, profilePath, desiredFingerprint) {
  if (!/^sha256:[a-f0-9]{64}$/.test(desiredFingerprint || '')) fail('desired MCP fingerprint is invalid');
  const context = receiptContext(receiptPath, profilePath, { create: true });
  const existing = readReceipt(context.receipt, context.profile);
  if (existing) {
    const current = existing;
    if (current.desiredFingerprint !== desiredFingerprint) fail('existing MCP receipt describes a different registration');
    return current;
  }
  const value = {
    schemaVersion: SCHEMA_VERSION,
    registration: 'jarvos',
    profileDigest: context.profileDigest,
    desiredFingerprint,
    state: 'pending',
  };
  let fd;
  try {
    fd = fs.openSync(context.receipt, 'wx', 0o600);
    fs.writeFileSync(fd, renderReceipt(value), 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return value;
}

function updateReceiptState(receiptPath, profilePath, desiredFingerprint, state) {
  if (!STATES.has(state)) fail('MCP receipt state is invalid');
  const context = receiptContext(receiptPath, profilePath);
  const current = readReceipt(context.receipt, context.profile);
  if (!current || current.desiredFingerprint !== desiredFingerprint) fail('MCP receipt does not match the intended registration');
  const next = { ...current, state };
  const temporary = path.join(context.profile, `.${path.basename(context.receipt)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, renderReceipt(next), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, context.receipt);
    fs.chmodSync(context.receipt, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return next;
}

function clearReceipt(receiptPath, profilePath, desiredFingerprint) {
  const context = receiptContext(receiptPath, profilePath);
  const current = readReceipt(context.receipt, context.profile);
  if (!current) return false;
  if (current.desiredFingerprint !== desiredFingerprint) fail('MCP receipt does not match the intended registration');
  fs.unlinkSync(context.receipt);
  return true;
}

function normalizeEnvironment(value) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail('MCP environment must be an object');
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value[key] !== 'string') fail('MCP environment is invalid');
    normalized[key] = value[key];
  }
  return normalized;
}

function normalizeStringSet(value, label, { defaultValue = null } = {}) {
  if (value === undefined || value === null) return defaultValue;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) fail(`${label} must be a string array`);
  return [...new Set(value)].sort();
}

function normalizeTimeout(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number`);
  return value;
}

function normalizeRegistration(value) {
  if (!isObject(value)) fail('MCP registration is invalid');
  const transport = isObject(value.transport) ? value.transport : value;
  const type = transport.type || transport.transport || value.transport_type || 'stdio';
  if (type !== 'stdio') fail('jarvOS MCP registration must use stdio');
  const command = transport.command;
  const args = transport.args === undefined ? [] : transport.args;
  const cwd = transport.cwd === undefined ? null : transport.cwd;
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof command !== 'string' || command.length === 0
    || !Array.isArray(args) || args.some((entry) => typeof entry !== 'string')
    || (cwd !== null && typeof cwd !== 'string') || typeof enabled !== 'boolean') {
    fail('MCP stdio command is invalid');
  }
  return {
    transport: 'stdio',
    command,
    args,
    cwd,
    env: normalizeEnvironment(transport.env),
    envVars: normalizeStringSet(transport.env_vars ?? value.env_vars, 'MCP environment passthrough', { defaultValue: [] }),
    enabled,
    startupTimeoutSeconds: normalizeTimeout(value.startup_timeout_sec ?? transport.startup_timeout_sec, 'MCP startup timeout'),
    toolTimeoutSeconds: normalizeTimeout(value.tool_timeout_sec ?? transport.tool_timeout_sec, 'MCP tool timeout'),
    enabledTools: normalizeStringSet(value.enabled_tools ?? transport.enabled_tools, 'MCP enabled tools'),
    disabledTools: normalizeStringSet(value.disabled_tools ?? transport.disabled_tools, 'MCP disabled tools'),
  };
}

function fingerprintRegistration(value) {
  return digest(JSON.stringify(normalizeRegistration(value)));
}

function desiredRegistration(command, args, env) {
  return normalizeRegistration({ command, args, env });
}

function parseJsonArgument(value, label) {
  try { return JSON.parse(value); } catch (_) { fail(`${label} is invalid JSON`); }
}

function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (action === 'profile') {
    process.stdout.write(assertProfileDirectory(args[0], { create: args[1] === 'create' }));
    return;
  }
  if (action === 'desired-cli') {
    const separator = args.indexOf('--');
    if (separator < 0 || separator === args.length - 1) fail('desired MCP command is missing');
    const options = args.slice(0, separator);
    const command = args[separator + 1];
    const commandArgs = args.slice(separator + 2);
    const env = {};
    for (let index = 0; index < options.length; index += 2) {
      if (options[index] !== '--env' || typeof options[index + 1] !== 'string') fail('desired MCP options are invalid');
      const equals = options[index + 1].indexOf('=');
      if (equals <= 0) fail('desired MCP environment is invalid');
      env[options[index + 1].slice(0, equals)] = options[index + 1].slice(equals + 1);
    }
    process.stdout.write(fingerprintRegistration(desiredRegistration(command, commandArgs, env)));
    return;
  }
  if (action === 'desired') {
    const [command, argsJson, envJson] = args;
    process.stdout.write(fingerprintRegistration(desiredRegistration(
      command,
      parseJsonArgument(argsJson, 'MCP args'),
      parseJsonArgument(envJson, 'MCP environment'),
    )));
    return;
  }
  if (action === 'observe') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try { process.stdout.write(fingerprintRegistration(parseJsonArgument(input, 'observed MCP registration'))); }
      catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
    });
    return;
  }
  if (action === 'list-state') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      try {
        const value = parseJsonArgument(input, 'Codex MCP list');
        const entries = Array.isArray(value) ? value : value?.servers;
        if (!Array.isArray(entries) || entries.some((entry) => !isObject(entry) || typeof entry.name !== 'string')) {
          fail('Codex MCP list has an unsupported shape');
        }
        process.stdout.write(entries.some((entry) => entry.name === 'jarvos') ? 'present' : 'absent');
      } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
    });
    return;
  }
  const [receiptPath, profilePath, desiredFingerprint] = args;
  if (action === 'fingerprint') {
    const value = readReceipt(receiptPath, profilePath);
    if (!value) fail('MCP receipt does not exist');
    process.stdout.write(value.desiredFingerprint);
    return;
  }
  if (action === 'state') {
    const value = readReceipt(receiptPath, profilePath);
    if (value && value.desiredFingerprint !== desiredFingerprint) fail('MCP receipt does not match the intended registration');
    process.stdout.write(value ? value.state : 'missing');
  } else if (action === 'claim') {
    process.stdout.write(claimReceipt(receiptPath, profilePath, desiredFingerprint).state);
  } else if (action === 'activate') {
    process.stdout.write(updateReceiptState(receiptPath, profilePath, desiredFingerprint, 'active').state);
  } else if (action === 'clear') {
    clearReceipt(receiptPath, profilePath, desiredFingerprint);
  } else {
    fail('unknown MCP receipt action');
  }
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`jarvOS Codex MCP receipt failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_VERSION,
  claimReceipt,
  clearReceipt,
  desiredRegistration,
  fingerprintRegistration,
  normalizeRegistration,
  readReceipt,
  updateReceiptState,
};
